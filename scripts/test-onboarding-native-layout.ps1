#Requires -Version 5.1
param([Parameter(Mandatory=$true)][int]$AppProcessId)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class OnboardingLayoutCapture {
 [StructLayout(LayoutKind.Sequential)] public struct RECT {public int Left,Top,Right,Bottom;}
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd,out RECT rect);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd,IntPtr dc,uint flags);
 [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr hwnd,out uint affinity);
}
'@
$p=Get-Process -Id $AppProcessId
if($p.MainWindowTitle -ne '御钥师 · 引导验收' -or $p.Path -notlike '*\gitKeyMaster\app\src-tauri\target\debug\app.exe') {throw 'Only the isolated onboarding QA window is allowed.'}
$qa=Join-Path $env:LOCALAPPDATA 'GitKeymasterDev\onboarding-qa\roaming\git-keymaster\config.json'
$configHash=(Get-FileHash -LiteralPath $qa).Hash
$root=[System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
function Find-Name([string]$name) {
 $cond=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,$name)
 $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$cond)
}
$heading=Find-Name '选择你的使用体验'
$next=Find-Name '下一步'
$navigation=Find-Name '1 使用体验'
$content=Find-Name '使用体验'
if(-not $heading -or -not $next -or -not $content) {throw 'Expected the experience step; no user settings will be changed to reach it.'}
$scroll=[System.Windows.Automation.ScrollPattern]$content.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)
$original=$scroll.Current.VerticalScrollPercent
$out='E:\juiceProgram\gitKeyMaster\docs\design\first-run-onboarding\ui-refinement'
function Save-Window([string]$file) {
 [uint32]$affinity=0
 if(-not [OnboardingLayoutCapture]::GetWindowDisplayAffinity($p.MainWindowHandle,[ref]$affinity) -or $affinity -ne 0){throw 'Capture not allowed; will not disable protection.'}
 $rect=New-Object OnboardingLayoutCapture+RECT
 [void][OnboardingLayoutCapture]::GetWindowRect($p.MainWindowHandle,[ref]$rect)
 $bitmap=New-Object System.Drawing.Bitmap(($rect.Right-$rect.Left),($rect.Bottom-$rect.Top))
 $graphics=[System.Drawing.Graphics]::FromImage($bitmap)
 $dc=$graphics.GetHdc()
 try { if(-not [OnboardingLayoutCapture]::PrintWindow($p.MainWindowHandle,$dc,2)){throw 'Window capture failed.'} }
 finally { $graphics.ReleaseHdc($dc) }
 try { $bitmap.Save((Join-Path $out $file),[System.Drawing.Imaging.ImageFormat]::Png) }
 finally {$graphics.Dispose();$bitmap.Dispose()}
}
try {
 if($scroll.Current.VerticallyScrollable){$scroll.SetScrollPercent(-1,0)}
 Start-Sleep -Milliseconds 250
 $initial=@{heading=$heading.Current.BoundingRectangle;navigation=$navigation.Current.BoundingRectangle;next=$next.Current.BoundingRectangle}
 Save-Window 'native-experience-top.png'
 if($scroll.Current.VerticallyScrollable){$scroll.SetScrollPercent(-1,100)}
 Start-Sleep -Milliseconds 250
 foreach($pair in @(@('heading',$heading),@('navigation',$navigation),@('next',$next))){
  $before=$initial[$pair[0]]; $after=$pair[1].Current.BoundingRectangle
  if([Math]::Abs($before.Y-$after.Y) -gt 1 -or $pair[1].Current.IsOffscreen){throw "Native $($pair[0]) moves or is clipped while scrolling."}
 }
 $bounds=$root.Current.BoundingRectangle
 if($next.Current.BoundingRectangle.Bottom -gt $bounds.Bottom -or $next.Current.BoundingRectangle.Height -lt 40){throw 'Native primary action does not fit.'}
 $preview=Find-Name '预览解锁动画'
 $cfg=Get-Content -LiteralPath $qa -Raw|ConvertFrom-Json
 if(-not $cfg.onboarding.draft.unlockAnimation -and $preview.Current.IsEnabled){throw 'Disabled unlock animation has enabled preview.'}
 Save-Window 'native-experience-bottom.png'
 if((Get-FileHash -LiteralPath $qa).Hash -ne $configHash){throw 'The read-only layout check unexpectedly changed preferences.'}
 @{passed=$true;windowWidth=$bounds.Width;windowHeight=$bounds.Height;headingPinned=$true;stepsPinned=$true;actionsPinned=$true;preferencesUnchanged=$true;nativePrimaryHeight=$next.Current.BoundingRectangle.Height} | ConvertTo-Json | Set-Content (Join-Path $out 'native-layout-verification.json') -Encoding utf8
 'Native layout verified; original preferences preserved.'
} finally {
 if($original -ge 0 -and $scroll.Current.VerticallyScrollable){$scroll.SetScrollPercent(-1,$original)}
}
