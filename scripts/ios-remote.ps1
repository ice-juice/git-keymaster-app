#Requires -Version 5.1
<#
.SYNOPSIS
  御钥师 iOS 远程编译。Cursor 与仓库留在 Windows，Mac 只当编译机，走 Tailscale SSH。

.DESCRIPTION
  源码用 tar 增量推到 Mac（含未提交改动），编译、模拟器、日志、截图全在 Mac 上跑，
  结果回到本终端。首次使用先 `save` 记住连接信息，再 `doctor` 验环境。

.EXAMPLE
  .\scripts\ios-remote.ps1 save -Remote you@mac.tailnet.ts.net -Device "iPhone 16"
  # 把连接信息写进 %USERPROFILE%\.gkm-ios-remote.json（不入库）

.EXAMPLE
  .\scripts\ios-remote.ps1 doctor
  # 查 Xcode / rustup target / node / 仓库 / 可用模拟器

.EXAMPLE
  .\scripts\ios-remote.ps1 check
  # 同步源码 + cargo check --target aarch64-apple-ios

.EXAMPLE
  .\scripts\ios-remote.ps1 run
  # 同步 + 出模拟器包 + 启动模拟器 + 安装 + 拉起 + 截图回传

.EXAMPLE
  .\scripts\ios-remote.ps1 shot
  # 只截当前模拟器画面，图片落到本机 TEMP 并打印路径
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet("save", "doctor", "sync", "init", "check", "build", "run", "shot", "log", "shell")]
  [string] $Action = "doctor",

  # you@mac.xxx.ts.net（Tailscale MagicDNS 名或 100.x 地址）
  [string] $Remote,
  # Mac 上仓库的绝对路径，可用 $HOME / ~
  [string] $RemotePath,
  # 模拟器名，如 "iPhone 16"。留空则自动挑第一台可用 iPhone
  [string] $Device,

  [switch] $Release,
  # check 时连模拟器 target 一起查
  [switch] $Sim,
  # build / run 出真机包（需要签名，未买开发者账号会失败）
  [switch] $PhysicalDevice,
  # 跳过源码同步，直接用 Mac 上现有代码
  [switch] $NoSync,
  # 同步时不清理远端多余文件
  [switch] $NoPrune,
  # run 之前先卸载旧包，验首次安装 / 初始化向导时用
  [switch] $Fresh,
  # run 结束后不自动截图
  [switch] $NoShot,
  # shot 的本机输出路径
  [string] $Out,
  # log 回看最近 N 秒并自动退出；0 = 持续跟随（Ctrl-C 停）
  [int] $LogSeconds = 0,
  # 透传给 tauri ios build 的额外参数，如 "--verbose"
  [string] $ExtraArgs = ""
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$RepoRoot = Split-Path -Parent $PSScriptRoot
$TauriConf = Join-Path $RepoRoot "app\src-tauri\tauri.conf.json"
$ConfigPath = Join-Path $env:USERPROFILE ".gkm-ios-remote.json"

# 只同步"编得出包"所需的子树。docs 不进来：里面有中文文件名，
# macOS 的 NFD 归一化会把它们变成看起来重复的另一份文件。
$SyncPaths = @("app", "scripts")

# Mac 侧落脚点。远端脚本每次重传，改了本文件立即生效。
$RemoteHelper = "/tmp/gkm-ios-remote.sh"
$RemoteTar = "/tmp/gkm-ios-sync.tgz"
$RemoteManifest = "/tmp/gkm-ios-manifest.txt"
$RemoteShot = "/tmp/gkm-ios-shot.png"

$SshOpts = @("-o", "ConnectTimeout=15", "-o", "StrictHostKeyChecking=accept-new")

function Write-Step([string] $msg) {
  Write-Host ""
  Write-Host "==> $msg" -ForegroundColor Cyan
}

function Write-Ok([string] $msg) { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn([string] $msg) { Write-Host "    $msg" -ForegroundColor Yellow }

function Write-Utf8NoBom([string] $path, [string] $text) {
  # Mac 侧要用 bash 读，必须 LF + 无 BOM
  $lf = $text -replace "`r`n", "`n"
  [IO.File]::WriteAllText($path, $lf, (New-Object System.Text.UTF8Encoding($false)))
}

function Assert-Tool([string] $name, [string] $hint) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { throw "找不到 $name。$hint" }
}

# PATH 上的 tar 可能是 Git for Windows 带的 GNU tar，它会把 `C:\...` 当成
# `host:path` 远程语法，直接报 "Cannot execute remote shell"。优先用系统自带
# 的 bsdtar；退回 GNU tar 时必须加 --force-local。
function Get-TarCommand {
  $sys = Join-Path $env:SystemRoot "System32\tar.exe"
  $exe = if (Test-Path $sys) { $sys } else { (Get-Command tar -ErrorAction SilentlyContinue).Source }
  if (-not $exe) { throw "找不到 tar。Windows 10 1803+ 自带 System32\tar.exe。" }

  $banner = ""
  try { $banner = (& $exe --version 2>&1 | Select-Object -First 1) } catch { }
  $extra = @()
  if ($banner -match "GNU tar") { $extra += "--force-local" }

  return [pscustomobject]@{ Exe = $exe; Extra = $extra; Banner = "$banner" }
}

function Assert-ShellSafe([string] $value, [string] $what) {
  if ([string]::IsNullOrWhiteSpace($value)) { return }
  # 这些字符串会拼进远端 shell 命令，挡住引号、变量展开与命令分隔符
  if ($value -match "['`"``;|&<>()`$\r\n]") {
    throw "$what 含有不能出现在远端命令里的字符：$value"
  }
}

function Get-SavedConfig {
  if (-not (Test-Path $ConfigPath)) { return @{} }
  try {
    $raw = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    Write-Warn "配置文件读不出来，已忽略：$ConfigPath"
    return @{}
  }
  $map = @{}
  foreach ($p in $raw.PSObject.Properties) { $map[$p.Name] = $p.Value }
  return $map
}

function Resolve-Settings {
  $saved = Get-SavedConfig

  $remote = $Remote
  if (-not $remote) { $remote = $env:GKM_MAC_SSH }
  if (-not $remote) { $remote = $saved["Remote"] }

  $path = $RemotePath
  if (-not $path) { $path = $env:GKM_MAC_PATH }
  if (-not $path) { $path = $saved["RemotePath"] }
  if (-not $path) { $path = '$HOME/src/local-git-account-manage' }
  # 远端用双引号包，`~/` 不会展开，换成 $HOME
  if ($path -like "~/*") { $path = '$HOME/' + $path.Substring(2) }

  $device = $Device
  if (-not $device) { $device = $env:GKM_IOS_DEVICE }
  if (-not $device) { $device = $saved["Device"] }

  if (-not $remote) {
    throw "不知道要连哪台 Mac。先跑：.\scripts\ios-remote.ps1 save -Remote you@mac.tailnet.ts.net"
  }

  Assert-ShellSafe $remote "SSH 目标"
  Assert-ShellSafe $device "模拟器名"
  # 路径要允许 $HOME 展开，所以单独校验，只挡引号与命令分隔符
  if ($path -match "[`"';|&<>()\r\n]") { throw "远端仓库路径含非法字符：$path" }
  # ExtraArgs 会被单引号包住传给远端，出现单引号就会破开引号
  if ($ExtraArgs -match "['\r\n]") { throw "-ExtraArgs 不能包含单引号或换行：$ExtraArgs" }

  return [pscustomobject]@{
    Remote     = $remote.Trim()
    RemotePath = $path.Trim()
    Device     = if ($device) { $device.Trim() } else { "" }
  }
}

function Get-BundleId {
  if (-not (Test-Path $TauriConf)) { throw "找不到 $TauriConf" }
  $id = (Get-Content $TauriConf -Raw -Encoding UTF8 | ConvertFrom-Json).identifier
  if (-not $id) { throw "tauri.conf.json 里没有 identifier" }
  return $id
}

# --- 远端执行 ---

function Invoke-Ssh([string] $CommandLine, [switch] $AllowFail, [switch] $Interactive) {
  $sshArgs = @()
  $sshArgs += $SshOpts
  if ($Interactive) { $sshArgs += "-t" }
  $sshArgs += $Cfg.Remote
  $sshArgs += $CommandLine

  & ssh @sshArgs
  $code = $LASTEXITCODE
  if ($code -ne 0 -and -not $AllowFail) {
    throw "远端命令失败（退出码 $code）：$CommandLine"
  }
  return $code
}

# 参数名不叫 $Args：那是 PowerShell 的自动变量，会被遮蔽
function Invoke-Helper([string] $HelperArgs, [switch] $AllowFail) {
  # 所有远端逻辑都在 helper 脚本里，这里只传参数，避免多层引号打架
  $env_ = 'GKM_REPO="' + $Cfg.RemotePath + '"'
  if ($ExtraArgs) { $env_ += " GKM_EXTRA_ARGS='" + $ExtraArgs + "'" }
  return Invoke-Ssh "$env_ bash $RemoteHelper $HelperArgs" -AllowFail:$AllowFail
}

function Send-Helper {
  $script = Get-RemoteHelperScript
  $tmp = Join-Path $env:TEMP "gkm-ios-remote.sh"
  Write-Utf8NoBom $tmp $script
  & scp @($SshOpts + @("-q", $tmp, ($Cfg.Remote + ":" + $RemoteHelper)))
  if ($LASTEXITCODE -ne 0) { throw "上传远端脚本失败。先确认 ssh $($Cfg.Remote) 能免密登录。" }
}

# --- 源码同步 ---

function Sync-Source {
  Write-Step "同步源码到 $($Cfg.Remote)"

  Push-Location $RepoRoot
  try {
    # 已跟踪 + 未跟踪但不被 gitignore 的文件，正好等于"应当上机编译的源码"
    $files = & git -c core.quotepath=false ls-files --cached --others --exclude-standard -- $SyncPaths
    if ($LASTEXITCODE -ne 0) { throw "git ls-files 失败" }
  } finally {
    Pop-Location
  }

  # `--cached` 会带上"已从工作区删掉、但还在索引里"的文件（例如删了还没 commit 的）。
  # 这类路径打 tar 会报错，也不该出现在清单里——不在清单 = 远端跟着删，正是想要的。
  $listed = @($files | Where-Object { $_ -and $_.Trim() })
  $files = @($listed | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
  $gone = $listed.Count - $files.Count
  if ($files.Count -eq 0) { throw "没有要同步的文件，检查 -- $($SyncPaths -join ' ') 是否还在仓库里" }
  if ($gone -gt 0) { Write-Warn "$gone 个文件已在本机删除，远端会一并清掉" }

  $listPath = Join-Path $env:TEMP "gkm-ios-filelist.txt"
  $tarPath = Join-Path $env:TEMP "gkm-ios-sync.tgz"
  Write-Utf8NoBom $listPath (($files -join "`n") + "`n")

  $tar = Get-TarCommand
  Push-Location $RepoRoot
  try {
    if (Test-Path $tarPath) { Remove-Item $tarPath -Force }
    & $tar.Exe @($tar.Extra + @("-czf", $tarPath, "-T", $listPath))
    if ($LASTEXITCODE -ne 0) { throw "打 tar 失败（退出码 $LASTEXITCODE，用的是 $($tar.Exe)）" }
  } finally {
    Pop-Location
  }
  Write-Ok ("{0} 个文件，{1:N1} MB" -f $files.Count, ((Get-Item $tarPath).Length / 1MB))

  & scp @($SshOpts + @("-q", $tarPath, ($Cfg.Remote + ":" + $RemoteTar)))
  if ($LASTEXITCODE -ne 0) { throw "scp 源码包失败" }
  & scp @($SshOpts + @("-q", $listPath, ($Cfg.Remote + ":" + $RemoteManifest)))
  if ($LASTEXITCODE -ne 0) { throw "scp 文件清单失败" }

  $prune = if ($NoPrune) { "0" } else { "1" }
  Invoke-Helper "unpack $prune" | Out-Null
}

function Sync-IfNeeded {
  if ($NoSync) {
    Write-Warn "已指定 -NoSync，直接用 Mac 上现有代码"
    return
  }
  Sync-Source
}

# --- 动作 ---

function Invoke-Save {
  if (-not $Remote) { throw "save 需要 -Remote，例如 -Remote you@mac.tailnet.ts.net" }
  Assert-ShellSafe $Remote "SSH 目标"
  Assert-ShellSafe $Device "模拟器名"

  $saved = Get-SavedConfig
  $saved["Remote"] = $Remote.Trim()
  if ($RemotePath) { $saved["RemotePath"] = $RemotePath.Trim() }
  if ($Device) { $saved["Device"] = $Device.Trim() }

  $json = [pscustomobject]$saved | ConvertTo-Json
  Write-Utf8NoBom $ConfigPath $json
  Write-Ok "已写入 $ConfigPath"
  Write-Ok "这个文件在仓库外，不会进 git。里面只有连接信息，没有口令。"
  Write-Host ""
  Write-Host "下一步：.\scripts\ios-remote.ps1 doctor" -ForegroundColor DarkGray
}

function Invoke-Doctor {
  Write-Step "本机工具"
  Assert-Tool "ssh" "Windows 10+ 在 设置 → 应用 → 可选功能 里装 OpenSSH 客户端。"
  Assert-Tool "scp" "同上，随 OpenSSH 客户端一起装。"
  Assert-Tool "git" "同步靠 git ls-files 决定要传哪些文件。"
  $tar = Get-TarCommand
  Write-Ok "ssh / scp / git 就位"
  Write-Ok "tar $($tar.Exe)"
  if ($tar.Extra.Count -gt 0) { Write-Warn "用的是 GNU tar，已自动加 $($tar.Extra -join ' ')" }
  Write-Ok "目标 $($Cfg.Remote)"
  Write-Ok "远端仓库 $($Cfg.RemotePath)"
  if ($Cfg.Device) { Write-Ok "模拟器 $($Cfg.Device)" } else { Write-Warn "未指定模拟器，远端会自动挑第一台可用 iPhone" }

  Send-Helper
  Invoke-Helper "doctor" | Out-Null
}

function Invoke-Init {
  Send-Helper
  Sync-IfNeeded
  Write-Step "生成 Xcode 工程（只需一次）"
  Invoke-Helper "init" | Out-Null
  Write-Host ""
  Write-Warn "gen/apple 生成在 Mac 上。要提交进 dev 的话，先从 Mac 取回来："
  # 远端路径用单引号，避免 $HOME 被本机 PowerShell 展开成 Windows 的家目录
  Write-Warn ("  scp -r '{0}:{1}/app/src-tauri/gen/apple' app\src-tauri\gen\" -f $Cfg.Remote, $Cfg.RemotePath)
}

function Invoke-Check {
  Send-Helper
  Sync-IfNeeded
  Write-Step "cargo check --target aarch64-apple-ios"
  Invoke-Helper "check aarch64-apple-ios" | Out-Null
  if ($Sim) {
    Write-Step "cargo check --target aarch64-apple-ios-sim"
    Invoke-Helper "check aarch64-apple-ios-sim" | Out-Null
  }
}

function Invoke-Build {
  Send-Helper
  Sync-IfNeeded
  $profile_ = if ($Release) { "release" } else { "debug" }
  $target = if ($PhysicalDevice) { "aarch64" } else { "aarch64-sim" }
  Write-Step "tauri ios build --target $target ($profile_)"
  if ($PhysicalDevice) {
    Write-Warn "真机包要签名。没有 Apple Developer Program 时这一步会在 codesign 处失败，属预期。"
  }
  Invoke-Helper "build $profile_ $target" | Out-Null
}

function Invoke-Run {
  if ($PhysicalDevice) {
    throw "run 只驱动模拟器。真机要在 Mac 上用 Xcode 或 tauri ios dev 装，见 docs/iOS远程编译.md。"
  }
  Invoke-Build

  $bundle = Get-BundleId
  $fresh = if ($Fresh) { "1" } else { "0" }
  Write-Step "模拟器安装并启动 $bundle"
  Invoke-Helper "run `"$($Cfg.Device)`" $bundle $fresh" | Out-Null

  if (-not $NoShot) {
    Start-Sleep -Seconds 4
    Invoke-Shot
  }

  Write-Host ""
  Write-Host "看日志：.\scripts\ios-remote.ps1 log -LogSeconds 60" -ForegroundColor DarkGray
  Write-Host "再截图：.\scripts\ios-remote.ps1 shot" -ForegroundColor DarkGray
}

function Invoke-Shot {
  Send-Helper
  $local_ = $Out
  if (-not $local_) {
    $dir = Join-Path $env:TEMP "gkm-ios"
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $local_ = Join-Path $dir ("shot-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".png")
  }

  Write-Step "截图"
  Invoke-Helper "shot `"$($Cfg.Device)`" $RemoteShot" | Out-Null
  & scp @($SshOpts + @("-q", ($Cfg.Remote + ":" + $RemoteShot), $local_))
  if ($LASTEXITCODE -ne 0) { throw "取回截图失败" }
  Write-Ok $local_
}

function Invoke-Log {
  Send-Helper
  $bundle = Get-BundleId
  if ($LogSeconds -gt 0) {
    Write-Step "回看最近 $LogSeconds 秒日志"
  } else {
    Write-Step "跟随日志（Ctrl-C 停止）"
  }
  Invoke-Helper "log `"$($Cfg.Device)`" $bundle $LogSeconds" -AllowFail | Out-Null
}

function Invoke-Shell {
  Write-Step "登录 $($Cfg.Remote)"
  Invoke-Ssh "cd `"$($Cfg.RemotePath)`" && exec `$SHELL -l" -Interactive -AllowFail | Out-Null
}

# --- 远端 helper（bash 3.2 兼容：macOS 自带的就是 3.2，别用数组展开与 [[ ]] 新语法） ---

function Get-RemoteHelperScript {
  return @'
#!/usr/bin/env bash
# 由 scripts/ios-remote.ps1 自动上传，不要在 Mac 上手改：下次同步就被覆盖。
set -eu

REPO="${GKM_REPO:-$HOME/src/local-git-account-manage}"
APP="$REPO/app"
TAURI="$APP/src-tauri"
GEN="$TAURI/gen/apple"
MANIFEST=/tmp/gkm-ios-manifest.txt
TARBALL=/tmp/gkm-ios-sync.tgz

step() { printf '\n--> %s\n' "$*"; }
log()  { printf '    %s\n' "$*"; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

need_repo() {
  if [ ! -d "$REPO/.git" ]; then
    die "远端仓库不在 $REPO。先在 Mac 上 git clone，或用 -RemotePath 指定实际路径。"
  fi
}

need_gen() {
  if [ ! -d "$GEN" ]; then
    die "gen/apple 不存在。先跑：ios-remote.ps1 init"
  fi
}

# 解析模拟器 UDID。$1 为空则自动挑第一台可用 iPhone。
sim_udid() {
  name="${1:-}"
  if [ -n "$name" ]; then
    line=$(xcrun simctl list devices available | grep -F "$name (" | head -1 || true)
  else
    line=$(xcrun simctl list devices available | grep -E '^ *iPhone' | head -1 || true)
  fi
  if [ -z "$name" ] && [ -z "$line" ]; then
    die "没有可用的 iPhone 模拟器。先在 Mac 上用 Xcode 装一个运行时。"
  fi
  if [ -z "$line" ]; then
    die "找不到模拟器 '$name'。可用列表：xcrun simctl list devices available"
  fi
  printf '%s' "$line" | sed -E 's/.*\(([0-9A-Fa-f-]{36})\).*/\1/'
}

# 挑 mtime 最新的 .app。$1 非空时只看路径含该关键字的。
# 不用 `xargs ls -dt`：BSD xargs 在无输入时仍会执行一次 ls，结果是当前目录。
pick_newest_app() {
  filter="${1:-}"
  best=""
  best_t=0
  while IFS= read -r d; do
    if [ -z "$d" ]; then continue; fi
    if [ -n "$filter" ]; then
      case "$d" in
        *"$filter"*) ;;
        *) continue ;;
      esac
    fi
    t=$(stat -f '%m' "$d" 2>/dev/null || echo 0)
    if [ "$t" -gt "$best_t" ]; then
      best_t="$t"
      best="$d"
    fi
  done <<EOF
$(find "$GEN" -type d -name '*.app' 2>/dev/null)
EOF
  printf '%s' "$best"
}

# 找最近构建出来的 .app，优先模拟器产物
find_app() {
  hit=$(pick_newest_app iphonesimulator)
  if [ -z "$hit" ]; then hit=$(pick_newest_app ""); fi
  if [ -z "$hit" ]; then
    die "gen/apple 下没有 .app。先跑：ios-remote.ps1 build"
  fi
  printf '%s' "$hit"
}

cmd_doctor() {
  set +e
  step "主机"
  sw_vers 2>/dev/null || uname -a
  step "Xcode"
  xcode-select -p || log "xcode-select 没指向 Xcode.app"
  xcodebuild -version 2>/dev/null || log "xcodebuild 不可用：多半只装了 Command Line Tools，要从 App Store 装完整 Xcode"
  step "Rust iOS target"
  if command -v rustup >/dev/null 2>&1; then
    installed=$(rustup target list --installed | grep 'apple-ios' || true)
    if [ -n "$installed" ]; then
      printf '%s\n' "$installed" | sed 's/^/    /'
    else
      log "没装：rustup target add aarch64-apple-ios aarch64-apple-ios-sim"
    fi
  else
    log "没有 rustup"
  fi
  step "Node"
  node -v 2>/dev/null || log "没有 node"
  npm -v 2>/dev/null || log "没有 npm"
  step "仓库 $REPO"
  if [ -d "$REPO/.git" ]; then
    log "分支 $(git -C "$REPO" rev-parse --abbrev-ref HEAD 2>/dev/null)"
    if [ -d "$GEN" ]; then log "gen/apple 已生成"; else log "gen/apple 不存在（跑 init）"; fi
    if [ -d "$APP/node_modules" ]; then log "node_modules 就绪"; else log "node_modules 缺失（init 会装）"; fi
  else
    log "不存在。先 git clone 到这个路径。"
  fi
  step "可用模拟器"
  xcrun simctl list devices available 2>/dev/null | grep -E '^ *(iPhone|iPad)' | head -8 | sed 's/^ */    /' \
    || log "simctl 读不到设备"
  set -e
  return 0
}

# 解包 + 按清单清理陈旧文件。$1=1 时才清理。
cmd_unpack() {
  need_repo
  do_prune="${1:-1}"
  if [ ! -f "$TARBALL" ]; then die "缺少 $TARBALL"; fi
  cd "$REPO"
  tar -xzf "$TARBALL"
  log "已解包"

  if [ "$do_prune" != "1" ]; then
    log "跳过清理（-NoPrune）"
    return 0
  fi
  if [ ! -f "$MANIFEST" ]; then die "缺少 $MANIFEST"; fi

  # 远端自己认的受管文件：gitignore 掉的（target / node_modules / build）天然不在里面
  git -c core.quotepath=false ls-files --cached --others --exclude-standard -- app scripts \
    > /tmp/gkm-ios-remote-list.txt
  # sort 与 comm 必须用同一套排序规则，否则差集会算错
  LC_ALL=C sort "$MANIFEST" > /tmp/gkm-ios-a.txt
  LC_ALL=C sort /tmp/gkm-ios-remote-list.txt > /tmp/gkm-ios-b.txt

  # 远端有、本机清单没有 = 本机已删除/改名 → 删掉，避免拿陈旧文件参与编译。
  # gen/apple 例外：它由 Mac 上的 tauri ios init 生成，未提交前本机清单里没有。
  LC_ALL=C comm -13 /tmp/gkm-ios-a.txt /tmp/gkm-ios-b.txt \
    | grep -v '^app/src-tauri/gen/apple/' > /tmp/gkm-ios-stale.txt || true

  count=$(wc -l < /tmp/gkm-ios-stale.txt | tr -d ' ')
  if [ "$count" = "0" ]; then
    log "无陈旧文件"
  else
    while IFS= read -r f; do
      if [ -n "$f" ]; then
        rm -f -- "$f"
        log "删除 $f"
      fi
    done < /tmp/gkm-ios-stale.txt
    log "清理 $count 个陈旧文件"
  fi
}

cmd_init() {
  need_repo
  step "npm install"
  cd "$APP"
  npm install
  if [ -d "$GEN" ]; then
    log "gen/apple 已存在，跳过 tauri ios init（要重建就在 Mac 上手动删掉再跑）"
  else
    step "tauri ios init"
    npx tauri ios init
  fi
  step "tauri icon（必须在 init 之后，覆盖默认 Tauri AppIcon）"
  npx tauri icon public/logo.svg
  step "sync iOS AppIcon into Xcode catalog"
  node "$REPO/scripts/sync-ios-appicon.mjs"
  log "生成完毕：$GEN"
}

cmd_check() {
  need_repo
  target="$1"
  cd "$TAURI"
  cargo check --target "$target"
}

cmd_build() {
  need_repo
  need_gen
  profile="$1"
  target="$2"
  cd "$APP"
  step "tauri icon（覆盖默认 AppIcon）"
  npx tauri icon public/logo.svg
  step "sync iOS AppIcon into Xcode catalog"
  node "$REPO/scripts/sync-ios-appicon.mjs"
  step "patch wry iOS WebKit lookup"
  node "$REPO/scripts/patch-wry-ios.mjs"
  flags=""
  if [ "$profile" = "debug" ]; then flags="--debug"; fi
  # shellcheck disable=SC2086
  npx tauri ios build --target "$target" $flags ${GKM_EXTRA_ARGS:-}
  app=$(find_app)
  log "产物 $app"
}

cmd_run() {
  need_gen
  name="${1:-}"
  bundle="$2"
  fresh="${3:-0}"

  udid=$(sim_udid "$name")
  step "启动模拟器 $udid"
  xcrun simctl bootstatus "$udid" -b

  app=$(find_app)
  log "安装 $app"
  if [ "$fresh" = "1" ]; then
    xcrun simctl uninstall "$udid" "$bundle" >/dev/null 2>&1 || true
    log "已卸载旧包（-Fresh）"
  fi
  xcrun simctl install "$udid" "$app"

  step "拉起 $bundle"
  xcrun simctl launch "$udid" "$bundle"
}

cmd_shot() {
  name="${1:-}"
  out="$2"
  udid=$(sim_udid "$name")
  rm -f "$out"
  xcrun simctl io "$udid" screenshot "$out"
  log "$out"
}

cmd_log() {
  need_gen
  name="${1:-}"
  bundle="$2"
  seconds="${3:-0}"
  udid=$(sim_udid "$name")

  app=$(find_app)
  proc=$(plutil -extract CFBundleExecutable raw "$app/Info.plist" 2>/dev/null || true)
  if [ -z "$proc" ]; then proc="git-keymaster"; fi
  log "进程 $proc（bundle $bundle）"

  if [ "$seconds" -gt 0 ]; then
    xcrun simctl spawn "$udid" log show --last "${seconds}s" --style compact \
      --predicate "process == \"$proc\""
  else
    xcrun simctl spawn "$udid" log stream --style compact \
      --predicate "process == \"$proc\""
  fi
}

action="${1:-doctor}"
shift || true
case "$action" in
  doctor) cmd_doctor ;;
  unpack) cmd_unpack "$@" ;;
  init)   cmd_init ;;
  check)  cmd_check "$@" ;;
  build)  cmd_build "$@" ;;
  run)    cmd_run "$@" ;;
  shot)   cmd_shot "$@" ;;
  log)    cmd_log "$@" ;;
  *)      die "未知动作 $action" ;;
esac
'@
}

# --- main ---

Write-Host "御钥师 · iOS 远程编译" -ForegroundColor White
Write-Host "本机仓库 $RepoRoot" -ForegroundColor DarkGray

if ($Action -eq "save") {
  Invoke-Save
  return
}

$Cfg = Resolve-Settings

switch ($Action) {
  "doctor" { Invoke-Doctor }
  "sync" { Send-Helper; Sync-Source }
  "init" { Invoke-Init }
  "check" { Invoke-Check }
  "build" { Invoke-Build }
  "run" { Invoke-Run }
  "shot" { Invoke-Shot }
  "log" { Invoke-Log }
  "shell" { Invoke-Shell }
}

Write-Host ""
Write-Host "完成。" -ForegroundColor Green
