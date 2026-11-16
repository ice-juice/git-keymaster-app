#Requires -Version 5.1
param([int]$AppProcessId)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class OnboardingNativeCapture {
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetWindowDisplayAffinity(IntPtr window, out uint affinity);
}
'@
$qaRoot = Join-Path $env:LOCALAPPDATA 'GitKeymasterDev\onboarding-qa'
$configFile = Join-Path $qaRoot 'roaming\git-keymaster\config.json'
$process = Get-Process -Id $AppProcessId
if ($process.MainWindowTitle -ne '御钥师 · 引导验收' -or $process.Path -notlike '*\gitKeyMaster\app\src-tauri\target\debug\app.exe') {
  throw 'This script only operates the dedicated onboarding QA application.'
}
$appWindow = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
function Read-QAConfig { Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json }
function Wait-Until([scriptblock]$check) {
  for ($i = 0; $i -lt 100; $i++) {
    try { if (& $check) { return } } catch {}
    Start-Sleep -Milliseconds 100
  }
  throw 'QA condition timed out.'
}
function Find-Button([string]$name) {
  $condition = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,$name)),
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button))
  )
  $appWindow.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$condition)
}
function Click-Button([string]$name) {
  Wait-Until { $b=Find-Button $name; $b -and $b.Current.IsEnabled }
  $button = Find-Button $name
  ([System.Windows.Automation.InvokePattern]$button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke()
}
function Capture-Affinity {
  [uint32]$affinity=0
  if (-not [OnboardingNativeCapture]::GetWindowDisplayAffinity($process.MainWindowHandle,[ref]$affinity)) { throw 'Cannot query native capture affinity.' }
  return $affinity
}
if ((Read-QAConfig).onboarding.status -ne 'notStarted') { throw 'Use a fresh QA profile; this test does not reset existing data.' }
$before = Capture-Affinity
if ($before -ne 0 -or -not (Read-QAConfig).allowScreenshots) { throw 'Fresh profile must allow screenshots.' }
Click-Button '下一步'
Wait-Until { (Read-QAConfig).onboarding.step -eq 1 }
$checkbox = $appWindow.FindAll([System.Windows.Automation.TreeScope]::Descendants,
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::CheckBox))) |
  Where-Object { $_.Current.Name -like '开启截图与录屏防护*' } | Select-Object -First 1
if (-not $checkbox) { throw 'Capture checkbox not found.' }
$toggle = [System.Windows.Automation.TogglePattern]$checkbox.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
if ($toggle.Current.ToggleState -ne [System.Windows.Automation.ToggleState]::On) { throw 'Recommendation should be checked.' }
if ((Capture-Affinity) -ne 0) { throw 'Draft recommendation applied too early.' }
$toggle.Toggle()
Wait-Until { -not (Read-QAConfig).onboarding.draft.screenProtection }
if ((Capture-Affinity) -ne 0 -or -not (Read-QAConfig).allowScreenshots) { throw 'Draft mutation changed actual capture state.' }
$toggle.Toggle()
Wait-Until { (Read-QAConfig).onboarding.draft.screenProtection }
Click-Button '下一步'
Wait-Until { (Read-QAConfig).onboarding.step -eq 2 }
Click-Button '保存并继续'
Wait-Until { $cfg=Read-QAConfig; $cfg.onboarding.status -eq 'completed' -and -not $cfg.onboarding.uiPending }
$after = Capture-Affinity
$saved = Read-QAConfig
if ($after -ne 17 -or $saved.allowScreenshots) { throw 'Expected WDA_EXCLUDEFROMCAPTURE after saving.' }
if ($saved.workspacePath) { throw 'Onboarding must not create or attach a workspace.' }
$evidence = [ordered]@{
  passed=$true; beforeCaptureAffinity=$before; afterCaptureAffinity=$after
  checkedDraftDidNotApply=$true; completed=$true; uiAcknowledged=$true
  autoLockMinutes=$saved.autoLockMinutes; clipboardClearSeconds=$saved.clipboardClearSeconds
  revealGraceMinutes=$saved.revealGraceMinutes; workspaceCreated=$false
}
$evidence | ConvertTo-Json | Set-Content -LiteralPath 'E:\juiceProgram\gitKeyMaster\docs\design\first-run-onboarding\implementation\native-verification.json' -Encoding utf8
$evidence | ConvertTo-Json
