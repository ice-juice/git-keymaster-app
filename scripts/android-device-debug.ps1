#Requires -Version 5.1
<#
.SYNOPSIS
  御钥师安卓真机调试。已配对且在线时直接用，不必再填配对信息。

.EXAMPLE
  .\scripts\android-device-debug.ps1
  # 先扫 adb；没有在线设备才在终端询问映射/配对

.EXAMPLE
  .\scripts\android-device-debug.ps1 -LaunchOnly
  # 已装过包：只转发端口并打开 App

.EXAMPLE
  .\scripts\android-device-debug.ps1 -InstallOnly
  # 不编译、不打包，把已有 debug APK 推到真机并启动
#>
param(
  [Alias("Host")]
  [string] $Ip,
  [int] $PairPort,
  [string] $PairCode,
  [int] $ConnectPort,
  [switch] $LaunchOnly,
  [switch] $InstallOnly,
  [switch] $SkipPair,
  [switch] $SkipNative,
  [int] $InstallTimeoutSec = 600
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$RepoRoot = Split-Path -Parent $PSScriptRoot
$AppDir = Join-Path $RepoRoot "app"
$AndroidDir = Join-Path $AppDir "src-tauri\gen\android"
$SoSrc = Join-Path $AppDir "src-tauri\target\aarch64-linux-android\debug\libapp_lib.so"
$JniDir = Join-Path $AndroidDir "app\src\main\jniLibs\arm64-v8a"
$SoDest = Join-Path $JniDir "libapp_lib.so"
$Apk = Join-Path $AndroidDir "app\build\outputs\apk\arm64\debug\app-arm64-debug.apk"
$Pkg = "com.jeck.gitkeymaster.debug"
$Activity = "com.jeck.gitkeymaster.debug/com.jeck.gitkeymaster.MainActivity"
$MaxApkBytes = 80MB

function Write-Step([string] $msg) {
  Write-Host ""
  Write-Host "==> $msg" -ForegroundColor Cyan
}

function Write-Ok([string] $msg) { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn([string] $msg) { Write-Host "    $msg" -ForegroundColor Yellow }

function Invoke-Adb([string[]] $AdbArgs) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $out = & adb @AdbArgs 2>&1 | ForEach-Object { "$_" }
    return [pscustomobject]@{
      Code = $LASTEXITCODE
      Text = ($out -join "`n")
    }
  } finally {
    $ErrorActionPreference = $old
  }
}

function Read-IfEmpty([string] $current, [string] $prompt, [switch] $Secret) {
  if (-not [string]::IsNullOrWhiteSpace($current)) { return $current.Trim() }
  $value = if ($Secret) {
    $sec = Read-Host $prompt -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
  } else {
    Read-Host $prompt
  }
  if ([string]::IsNullOrWhiteSpace($value)) { throw "未填写：$prompt" }
  return $value.Trim()
}

function Import-AndroidEnv {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
    [Environment]::GetEnvironmentVariable("Path", "User")
  foreach ($n in @("JAVA_HOME", "ANDROID_HOME", "ANDROID_SDK_ROOT", "NDK_HOME", "ANDROID_NDK_HOME")) {
    $v = [Environment]::GetEnvironmentVariable($n, "User")
    if (-not $v) { $v = [Environment]::GetEnvironmentVariable($n, "Machine") }
    if ($v) { Set-Item "Env:$n" $v }
  }
  if (-not $env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT = $env:ANDROID_HOME }
  $hk = Get-ItemProperty HKCU:\Environment
  $hk.PSObject.Properties |
    Where-Object { $_.Name -match '^(CC_|CXX_|AR_|CARGO_TARGET_).*ANDROID' } |
    ForEach-Object { Set-Item "Env:$($_.Name)" $_.Value }

  foreach ($need in @("JAVA_HOME", "ANDROID_HOME", "NDK_HOME")) {
    if (-not (Get-Item "Env:$need" -ErrorAction SilentlyContinue).Value) {
      throw "缺少环境变量 $need。先按 docs/安卓真机调试.md 配好再跑。"
    }
  }
  if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
    throw "找不到 adb，请确认 ANDROID_HOME\platform-tools 已进 PATH。"
  }
  Write-Ok "JAVA_HOME=$env:JAVA_HOME"
  Write-Ok "ANDROID_HOME=$env:ANDROID_HOME"
  Write-Ok "NDK_HOME=$env:NDK_HOME"
}

function Test-PortListen([int] $port) {
  return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

function Get-AdbRecords {
  $text = (Invoke-Adb @("devices", "-l")).Text
  $rows = @()
  foreach ($line in ($text -split "`r?`n")) {
    if ($line -notmatch '^\s*(\S+)\s+(device|offline|unauthorized)\b') { continue }
    $serial = $Matches[1]
    $state = $Matches[2]
    $model = ""
    if ($line -match 'model:(\S+)') { $model = $Matches[1] }
    $rows += [pscustomobject]@{
      Serial = $serial
      State  = $state
      Model  = $model
      IsEmulator = $serial -like "emulator-*"
    }
  }
  return $rows
}

function Get-DeviceState([string] $serial) {
  $hit = Get-AdbRecords | Where-Object { $_.Serial -eq $serial } | Select-Object -First 1
  if ($hit) { return $hit.State }
  return "missing"
}

function Show-Device([object] $row) {
  $extra = @($row.State)
  if ($row.Model) { $extra += $row.Model }
  if ($row.IsEmulator) { $extra += "模拟器" }
  Write-Ok ("{0}  ({1})" -f $row.Serial, ($extra -join " / "))
}

function Test-ConnectQuiet([string] $serial) {
  Invoke-Adb @("disconnect", $serial) | Out-Null
  Start-Sleep -Milliseconds 400
  Invoke-Adb @("connect", $serial) | Out-Null
  Start-Sleep -Seconds 1
  return (Get-DeviceState $serial) -eq "device"
}

function Find-ReadyDevice {
  $rows = @(Get-AdbRecords)
  if ($rows.Count -gt 0) {
    Write-Step "当前 adb 设备"
    foreach ($row in $rows) { Show-Device $row }
  }

  $online = @($rows | Where-Object { $_.State -eq "device" -and -not $_.IsEmulator })
  if ($online.Count -eq 0) {
    $online = @($rows | Where-Object { $_.State -eq "device" })
  }
  if ($online.Count -eq 1) { return $online[0].Serial }
  if ($online.Count -gt 1) {
    Write-Warn "有多台在线设备，使用第一台真机/非模拟器。"
    return $online[0].Serial
  }

  $offline = @($rows | Where-Object { $_.State -eq "offline" -and $_.Serial -match ":\d+$" })
  foreach ($row in $offline) {
    Write-Warn "尝试重连已出现过的 $($row.Serial)（不配对）"
    if (Test-ConnectQuiet $row.Serial) { return $row.Serial }
  }
  return $null
}

function Invoke-AdbPair([string] $deviceIp, [int] $port, [string] $code) {
  Write-Step "配对 ${deviceIp}:${port}"
  $r = Invoke-Adb @("pair", "${deviceIp}:${port}", $code)
  if ($r.Code -eq 0 -and $r.Text -match "Successfully paired") {
    Write-Ok "配对成功"
    return
  }
  if ($r.Text -match "already paired|Successfully paired") {
    Write-Ok "此前已配对，继续连接"
    return
  }
  Write-Warn "配对未成功（可能早已配对或配对码已过期），继续尝试映射端口。"
  if ($r.Text.Trim()) { Write-Warn $r.Text.Trim() }
}

function Connect-Device([string] $serial) {
  Write-Step "连接 $serial"
  Invoke-Adb @("disconnect", $serial) | Out-Null
  Start-Sleep -Seconds 1
  $r = Invoke-Adb @("connect", $serial)
  if ($r.Text.Trim()) { Write-Host $r.Text.Trim() }
  for ($i = 0; $i -lt 8; $i++) {
    $state = Get-DeviceState $serial
    if ($state -eq "device") {
      $model = (Invoke-Adb @("-s", $serial, "shell", "getprop", "ro.product.model")).Text.Trim()
      $abi = (Invoke-Adb @("-s", $serial, "shell", "getprop", "ro.product.cpu.abi")).Text.Trim()
      Write-Ok "已在线：$model ($abi)"
      return $true
    }
    Write-Warn "状态=$state，重试 $($i + 1)/8"
    Invoke-Adb @("disconnect", $serial) | Out-Null
    Start-Sleep -Seconds 2
    Invoke-Adb @("connect", $serial) | Out-Null
    Start-Sleep -Seconds 2
  }
  return $false
}

function Read-ConnectTarget {
  $ip = Read-IfEmpty $Ip "无线调试主界面上的 IP（不是配对页）"
  $port = $ConnectPort
  if ($port -le 0) { $port = [int](Read-IfEmpty "" "映射 / 连接端口") }
  return [pscustomobject]@{ Ip = $ip; Port = $port; Serial = "${ip}:${port}" }
}

function Request-PairingThenConnect {
  Write-Host ""
  Write-Host "需要配对。请打开手机：设置 → 开发者选项 → 无线调试" -ForegroundColor Yellow
  Write-Host "1) 主界面看映射 IP:端口   2)「使用配对码配对」看配对端口和 6 位码" -ForegroundColor Yellow

  $target = Read-ConnectTarget
  $pairIp = Read-IfEmpty $target.Ip "配对 IP（一般和映射 IP 相同）"
  $pairPort = $PairPort
  if ($pairPort -le 0) { $pairPort = [int](Read-IfEmpty "" "配对端口") }
  $code = Read-IfEmpty $PairCode "配对码"
  Invoke-AdbPair $pairIp $pairPort $code
  if (-not (Connect-Device $target.Serial)) {
    throw "配对后仍连不上 $($target.Serial)。请确认映射端口没变、无线调试仍开着。"
  }
  return $target.Serial
}

function Resolve-Device {
  if ($Ip -and $ConnectPort -gt 0) {
    $serial = "${Ip}:${ConnectPort}"
    if ((Get-DeviceState $serial) -eq "device") { return $serial }
    if (Connect-Device $serial) { return $serial }
    if (-not $SkipPair) { return Request-PairingThenConnect }
    throw "指定设备 $serial 不在线，且已跳过配对。"
  }

  $ready = Find-ReadyDevice
  if ($ready) {
    Write-Ok "使用已在线设备 $ready，跳过配对"
    return $ready
  }

  Write-Step "没有在线设备，先试映射端口重连（不必配对）"
  $target = Read-ConnectTarget
  if (Connect-Device $target.Serial) { return $target.Serial }

  if ($SkipPair) { throw "重连失败，且已指定跳过配对。" }
  return Request-PairingThenConnect
}

function Set-AdbReverse([string] $serial) {
  Write-Step "转发 5173 / 5174"
  Invoke-Adb @("-s", $serial, "reverse", "--remove-all") | Out-Null
  Invoke-Adb @("-s", $serial, "reverse", "tcp:5173", "tcp:5173") | Out-Null
  Invoke-Adb @("-s", $serial, "reverse", "tcp:5174", "tcp:5174") | Out-Null
  $list = (Invoke-Adb @("-s", $serial, "reverse", "--list")).Text
  if ($list -notmatch "tcp:5173") { throw "adb reverse 5173 失败，设备可能已掉线。" }
  Write-Ok (($list.Trim() -replace "\s+", " "))
}

function Start-ViteIfNeeded {
  Write-Step "前端 Vite :5173"
  if (Test-PortListen 5173) {
    Write-Ok "已在运行，复用现有服务"
    return
  }
  Write-Ok "未检测到 5173，正在后台启动 npm run dev"
  $npm = if (Get-Command npm.cmd -ErrorAction SilentlyContinue) { "npm.cmd" } else { "npm" }
  Start-Process -FilePath $npm -ArgumentList @("run", "dev") -WorkingDirectory $AppDir -WindowStyle Minimized
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 1
    if (Test-PortListen 5173) {
      Write-Ok "Vite 已监听 127.0.0.1:5173"
      return
    }
  }
  throw "Vite 60 秒内没有起来。请到 app 目录手动 npm run dev 后重试。"
}

function Build-NativeLib {
  Write-Step "编译 aarch64 native 库"
  Push-Location $AppDir
  try {
    & npx tauri android android-studio-script --target aarch64
    if ($LASTEXITCODE -ne 0) { throw "tauri android android-studio-script 失败（退出码 $LASTEXITCODE）" }
  } finally {
    Pop-Location
  }
  if (-not (Test-Path $SoSrc)) { throw "未找到 $SoSrc" }
  Write-Ok "已生成 $SoSrc ($([int]((Get-Item $SoSrc).Length / 1MB)) MB)"
}

function Copy-StrippedSo {
  Write-Step "剥离调试符号并写入 jniLibs"
  $strip = Join-Path $env:NDK_HOME "toolchains\llvm\prebuilt\windows-x86_64\bin\llvm-strip.exe"
  if (-not (Test-Path $strip)) { throw "找不到 llvm-strip：$strip" }
  New-Item -ItemType Directory -Force -Path $JniDir | Out-Null
  if (Test-Path $SoDest) { Remove-Item $SoDest -Force }
  Copy-Item $SoSrc $SoDest -Force
  & $strip --strip-unneeded $SoDest
  $len = (Get-Item $SoDest).Length
  $link = (Get-Item $SoDest).LinkType
  if ($link) { throw "jniLibs 仍是符号链接，Gradle 会打进未剥离的大库。" }
  if ($len -gt 80MB) { throw "剥离后仍有 $([int]($len / 1MB)) MB，请检查是否拷到了未剥离文件。" }
  Write-Ok "libapp_lib.so = $([int]($len / 1MB)) MB"
}

function Build-Apk {
  Write-Step "打包 ARM64 debug APK（跳过 rustBuild）"
  foreach ($p in @(
      $Apk,
      (Join-Path $AndroidDir "app\build\intermediates\incremental\packageArm64Debug"),
      (Join-Path $AndroidDir "app\build\intermediates\merged_native_libs\arm64Debug"),
      (Join-Path $AndroidDir "app\build\intermediates\stripped_native_libs\arm64Debug")
    )) {
    if (Test-Path $p) { Remove-Item $p -Recurse -Force }
  }
  $gradlew = Join-Path $AndroidDir "gradlew.bat"
  Push-Location $AndroidDir
  try {
    & $gradlew --no-daemon :app:packageArm64Debug -x rustBuildArm64Debug
    if ($LASTEXITCODE -ne 0) { throw "Gradle 打包失败（退出码 $LASTEXITCODE）" }
  } finally {
    Pop-Location
  }
  if (-not (Test-Path $Apk)) { throw "未生成 $Apk" }
  $len = (Get-Item $Apk).Length
  if ($len -gt $MaxApkBytes) {
    throw "APK 有 $([int]($len / 1MB)) MB，超过 80MB。多半又打进了未剥离 .so，已中止以免无线安装卡死。"
  }
  Write-Ok "APK = $([int]($len / 1MB)) MB"
}

function Wait-AdbChild([System.Diagnostics.Process] $proc, [int] $timeoutSec, [string] $what) {
  if ($proc.WaitForExit($timeoutSec * 1000)) { return $proc.ExitCode }
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  throw "$what 超过 ${timeoutSec}s。看设备是否还是 device：adb devices"
}

function Install-AndLaunch([string] $serial) {
  Write-Step "安装并启动"
  $state = Get-DeviceState $serial
  if ($state -ne "device") {
    Write-Warn "安装前设备状态=$state，尝试重连"
    if (-not (Connect-Device $serial)) {
      throw "安装前设备掉线。请保持无线调试开启后重跑脚本。"
    }
  }
  Set-AdbReverse $serial

  $adb = (Get-Command adb).Source
  $remote = "/data/local/tmp/gkm-debug.apk"
  Write-Ok "无线安装改走 push + pm install（避免 Streamed Install 卡住）"
  Write-Ok "正在推送 $([int]((Get-Item $Apk).Length / 1MB)) MB ..."

  $push = Start-Process -FilePath $adb -ArgumentList @("-s", $serial, "push", $Apk, $remote) -NoNewWindow -PassThru -Wait:$false
  $pushCode = Wait-AdbChild $push $InstallTimeoutSec "adb push"
  if ($pushCode -ne 0) { throw "adb push 失败（退出码 $pushCode）" }
  Write-Ok "已推到手机 $remote"

  $pm = Start-Process -FilePath $adb -ArgumentList @(
    "-s", $serial, "shell", "pm", "install", "-r", "-d", $remote
  ) -NoNewWindow -PassThru -Wait:$false
  $pmCode = Wait-AdbChild $pm 120 "pm install"
  if ($pmCode -ne 0) {
    Invoke-Adb @("-s", $serial, "shell", "rm", "-f", $remote) | Out-Null
    throw "pm install 失败（退出码 $pmCode）"
  }
  Invoke-Adb @("-s", $serial, "shell", "rm", "-f", $remote) | Out-Null
  Write-Ok "安装成功"

  Set-AdbReverse $serial
  Invoke-Adb @("-s", $serial, "shell", "am", "force-stop", $Pkg) | Out-Null
  Invoke-Adb @("-s", $serial, "shell", "am", "start", "-n", $Activity) | Out-Null
  Start-Sleep -Seconds 3
  $pidof = (Invoke-Adb @("-s", $serial, "shell", "pidof", $Pkg)).Text.Trim()
  if (-not $pidof) { throw "进程没有起来。看 Logcat：adb -s $serial logcat -s AndroidRuntime:E" }
  Write-Ok "已启动 pid=$pidof"
}

# --- main ---
Write-Host "御钥师 · 安卓真机调试" -ForegroundColor White
Write-Host "仓库 $RepoRoot" -ForegroundColor DarkGray

Import-AndroidEnv
$serial = Resolve-Device
Write-Ok "设备序列号 $serial"

Start-ViteIfNeeded
Set-AdbReverse $serial

if ($LaunchOnly -and $InstallOnly) {
  throw "-LaunchOnly 和 -InstallOnly 不能一起用：前者只打开已装的 App，后者会重新推 APK。"
}

$needNative = -not ($LaunchOnly -or $SkipNative -or $InstallOnly)
if ($needNative) {
  Build-NativeLib
  Copy-StrippedSo
  Build-Apk
  Install-AndLaunch $serial
} elseif ($InstallOnly) {
  Write-Step "跳过编译打包，安装已有 APK"
  if (-not (Test-Path $Apk)) {
    throw "找不到 $Apk。先完整跑一遍脚本生成包，或去掉 -InstallOnly。"
  }
  $len = (Get-Item $Apk).Length
  if ($len -gt $MaxApkBytes) {
    throw "现有 APK 有 $([int]($len / 1MB)) MB，超过 80MB。请去掉 -InstallOnly 重新打瘦身包。"
  }
  Write-Ok "使用 $Apk ($([int]($len / 1MB)) MB)"
  Install-AndLaunch $serial
} else {
  Write-Step "跳过编译，只拉起已装的 debug 包"
  $installed = (Invoke-Adb @("-s", $serial, "shell", "pm", "path", $Pkg)).Text
  if ($installed -notmatch $Pkg) { throw "手机上还没有 $Pkg，请去掉 -LaunchOnly / -SkipNative 先完整跑一遍，或改用 -InstallOnly 推已有 APK。" }
  Invoke-Adb @("-s", $serial, "shell", "am", "force-stop", $Pkg) | Out-Null
  Invoke-Adb @("-s", $serial, "shell", "am", "start", "-n", $Activity) | Out-Null
  Start-Sleep -Seconds 2
  $pidof = (Invoke-Adb @("-s", $serial, "shell", "pidof", $Pkg)).Text.Trim()
  Write-Ok "已启动 pid=$pidof"
}

Write-Host ""
Write-Host "完成。改前端会热更新；改 Rust 再跑一遍本脚本即可，已在线则不会再要配对码。" -ForegroundColor Green
Write-Host "Logcat: adb -s $serial logcat -s RustStdoutStderr:V AndroidRuntime:E" -ForegroundColor DarkGray
