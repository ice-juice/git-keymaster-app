#Requires -Version 5.1
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class RecoveryCaptureProof {
 [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr handle, out uint affinity);
}
'@
$qa=Join-Path $env:LOCALAPPDATA 'GitKeymasterDev\onboarding-qa'
$configFile=Join-Path $qa 'roaming\git-keymaster\config.json'
$original=[IO.File]::ReadAllText($configFile)
$baseline=$original | ConvertFrom-Json
if($baseline.workspacePath -or $baseline.onboarding.status -ne 'completed'){throw 'Expected completed QA-only configuration without a workspace.'}
$env:APPDATA=Join-Path $qa 'roaming'
$env:TEMP=Join-Path $qa 'temp'
$env:TMP=$env:TEMP
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--force-renderer-accessibility'
$script:qaProcess=$null
$script:root=$null
function Wait-For([scriptblock]$check){for($i=0;$i -lt 150;$i++){try{if(& $check){return}}catch{};Start-Sleep -Milliseconds 100};throw 'Native recovery check timed out.'}
function Find-Name([string]$name){
 $condition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,$name)
 $script:root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$condition)
}
function Start-QA {
 $script:qaProcess=Start-Process -FilePath 'E:\juiceProgram\gitKeyMaster\app\src-tauri\target\debug\app.exe' -WorkingDirectory 'E:\juiceProgram\gitKeyMaster\app' -WindowStyle Hidden -PassThru
 Wait-For {$script:qaProcess.Refresh();$script:qaProcess.MainWindowHandle -ne 0}
 if($script:qaProcess.MainWindowTitle -ne '御钥师 · 引导验收'){throw 'Unexpected app; refusing to operate it.'}
 $script:root=[System.Windows.Automation.AutomationElement]::FromHandle($script:qaProcess.MainWindowHandle)
}
function Stop-QA {
 if($script:qaProcess -and -not $script:qaProcess.HasExited){Stop-Process -Id $script:qaProcess.Id; $script:qaProcess.WaitForExit(5000) | Out-Null}
 $script:qaProcess=$null
}
function Affinity {
 [uint32]$v=0
 if(-not [RecoveryCaptureProof]::GetWindowDisplayAffinity($script:qaProcess.MainWindowHandle,[ref]$v)){throw 'Capture state unavailable'}
 $v
}
function Wait-WorkspaceEntry {
 Wait-For {
  $nodes=$script:root.FindAll([System.Windows.Automation.TreeScope]::Descendants,(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button)))
  @($nodes | Where-Object {$_.Current.Name -match '创建.*工作空间|新建.*工作空间'}).Count -gt 0
 }
 if(Find-Name '选择你的使用体验'){throw 'Existing configuration unexpectedly reopened onboarding.'}
}
function Click-QA([string]$name){
 Wait-For {$b=Find-Name $name;$b -and $b.Current.IsEnabled}
 $b=Find-Name $name
 ([System.Windows.Automation.InvokePattern]$b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke()
}
$results=@()
try {
 Start-QA; Wait-WorkspaceEntry
 if((Affinity) -ne 17){throw 'Saved protection did not survive restart'}
 $results+='completed settings survive restart'; Stop-QA

 $legacy=$original | ConvertFrom-Json
 $legacy.PSObject.Properties.Remove('onboarding')
 $legacy.PSObject.Properties.Remove('allowScreenshots')
 $legacyJson=$legacy | ConvertTo-Json -Depth 20
 [IO.File]::WriteAllText($configFile,$legacyJson,[Text.UTF8Encoding]::new($false))
 Start-QA; Wait-WorkspaceEntry
 if((Affinity) -ne 17){throw 'Legacy missing capture field must remain protected'}
 $results+='legacy missing fields keep capture protection'; Stop-QA

 [IO.File]::WriteAllText($configFile,'{invalid-json',[Text.UTF8Encoding]::new($false))
 Start-QA
 Wait-For {Find-Name '本机配置无法读取。已保留原文件，不会创建空配置或进入工作空间创建流程。请先恢复本机配置，再重试。'}
 if([IO.File]::ReadAllText($configFile) -ne '{invalid-json'){throw 'Corrupt config was overwritten'}
 if((Affinity) -ne 17){throw 'Corrupt config must fail closed'}
 [IO.File]::WriteAllText($configFile,$legacyJson,[Text.UTF8Encoding]::new($false))
 Click-QA '重新读取'; Wait-WorkspaceEntry
 $results+='corrupt config preserved and recovered through retry'; Stop-QA

 $fresh=$original | ConvertFrom-Json
 $fresh.allowScreenshots=$true; $fresh.autoLockMinutes=15; $fresh.revealGraceMinutes=5
 $fresh.onboarding.status='notStarted'; $fresh.onboarding.step=0; $fresh.onboarding.revision=0
 $fresh.onboarding.pending=$null; $fresh.onboarding.lastRequestId=$null; $fresh.onboarding.lastError=$null; $fresh.onboarding.uiPending=$false
 [IO.File]::WriteAllText($configFile,($fresh|ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false))
 Start-QA; Wait-For {Find-Name '选择你的使用体验'}
 Click-QA '稍后设置'
 Wait-For {(Get-Content $configFile -Raw|ConvertFrom-Json).onboarding.status -eq 'skipped'}
 Wait-WorkspaceEntry
 $skipped=Get-Content $configFile -Raw|ConvertFrom-Json
 if((Affinity) -ne 0 -or -not $skipped.allowScreenshots -or $skipped.autoLockMinutes -ne 15){throw 'Skip unexpectedly applied recommendations'}
 $results+='skip preserves real defaults and screenshot permission'; Stop-QA
 @{passed=$true;results=$results}|ConvertTo-Json|Set-Content 'E:\juiceProgram\gitKeyMaster\docs\design\first-run-onboarding\implementation\native-recovery-verification.json' -Encoding utf8
 $results
} finally {
 Stop-QA
 [IO.File]::WriteAllText($configFile,$original,[Text.UTF8Encoding]::new($false))
}
