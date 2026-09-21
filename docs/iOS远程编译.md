# iOS 远程编译（操作手册）

Cursor 和仓库都留在 Windows，Mac 只当编译机。源码经 Tailscale 推到 Mac，编译、模拟器、日志、截图全在 Mac 上跑，结果回到 Windows 终端。

**日常开发分支：** `dev`
**Bundle ID：** `com.jeck.gitkeymaster`（与安卓同标识，不要改）
**入口脚本：** `scripts/ios-remote.ps1`
**配套文档：** `docs/移动端App开发计划.md`（M13 / iOS 增量）、`docs/安卓真机调试.md`（安卓那条线）

---

## 0. 先说清楚它不做什么

| 事情 | 行不行 |
|---|---|
| 在 Windows 上改代码，编译在 Mac 上跑 | ✅ 本文就是干这个 |
| 在 Windows 本机出 iOS 包 | ❌ Apple 不允许，没有交叉工具链这回事 |
| 无界面跑模拟器、装包、看日志、截图 | ✅ 全走 `simctl`，不需要看 Mac 屏幕 |
| 前端热更新（改 React 立刻生效） | ❌ 本脚本出的是静态包，改前端要重跑 `run`（几十秒） |
| 真机调试、Face ID 录入、Xcode 首次配置、上架 | ❌ 要看 Mac 屏幕，见第 9 节 |

模拟器**不需要签名、不需要 Apple Developer Program**，所以 `init` / `check` / `build` / `run` 现在就能用。

---

## 1. 一次性准备

### 1.1 Mac 上

```bash
# 完整 Xcode（App Store 装，不是只装 Command Line Tools）
sudo xcodebuild -license accept
xcodebuild -downloadPlatform iOS

# Rust iOS target
rustup target add aarch64-apple-ios aarch64-apple-ios-sim

# 仓库（路径要和第 1.4 步填的一致）
mkdir -p ~/src && cd ~/src
git clone <仓库地址> local-git-account-manage
cd local-git-account-manage && git checkout dev
```

Mac 要开 **远程登录**（系统设置 → 通用 → 共享 → 远程登录），或者直接用 Tailscale SSH。

### 1.2 两端装 Tailscale

进同一个 tailnet，打开 MagicDNS，确认 Windows 上 `ping mac.<tailnet>.ts.net` 通。

**不要把 SSH 暴露到公网。** ACL 收紧到只允许你这台 Windows 访问这台 Mac。

### 1.3 Windows 上

需要 OpenSSH 客户端（设置 → 应用 → 可选功能）。`tar` 和 `git` 一般已经有。

配好免密登录，否则每条命令都要输密码：

```powershell
ssh-keygen -t ed25519            # 已有就跳过
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh you@mac.tailnet.ts.net "cat >> ~/.ssh/authorized_keys"
ssh you@mac.tailnet.ts.net "echo ok"
```

### 1.4 记住连接信息

```powershell
cd D:\coding_program\local-git-account-manage
.\scripts\ios-remote.ps1 save -Remote you@mac.tailnet.ts.net -RemotePath '$HOME/src/local-git-account-manage' -Device "iPhone 16"
```

写到 `%USERPROFILE%\.gkm-ios-remote.json`。**这个文件在仓库外，不会进 git**，里面只有主机名和模拟器名，没有口令。

也可以用环境变量 `GKM_MAC_SSH` / `GKM_MAC_PATH` / `GKM_IOS_DEVICE`，或每次用 `-Remote` 覆盖。优先级：命令行参数 > 环境变量 > 配置文件。

---

## 2. 首次跑通的顺序

```powershell
.\scripts\ios-remote.ps1 doctor     # 查 Xcode / rustup target / node / 仓库 / 可用模拟器
.\scripts\ios-remote.ps1 init       # npm install + tauri ios init（只需一次）
.\scripts\ios-remote.ps1 check      # cargo check --target aarch64-apple-ios
.\scripts\ios-remote.ps1 build      # 出模拟器包
.\scripts\ios-remote.ps1 run        # 启模拟器 + 安装 + 拉起 + 截图回传
```

`doctor` 有红字就先按它的提示补环境，不要往下走。

`init` 之后 `gen/apple/` 只在 Mac 上，**要提交进 `dev` 得先取回来**，见第 8 节。

---

## 3. 常用跑法

| 你想做什么 | 命令 |
|---|---|
| 改完 Rust，只想知道编不编得过 | `.\scripts\ios-remote.ps1 check` |
| 连模拟器 target 一起查 | `.\scripts\ios-remote.ps1 check -Sim` |
| 改完代码，装到模拟器上看一眼 | `.\scripts\ios-remote.ps1 run` |
| 验首次安装 / 初始化向导 | `.\scripts\ios-remote.ps1 run -Fresh` |
| 只想再截一张图 | `.\scripts\ios-remote.ps1 shot` |
| 看最近一分钟日志 | `.\scripts\ios-remote.ps1 log -LogSeconds 60` |
| 持续跟日志 | `.\scripts\ios-remote.ps1 log` |
| 只推代码，不编译 | `.\scripts\ios-remote.ps1 sync` |
| 上 Mac 手动敲点什么 | `.\scripts\ios-remote.ps1 shell` |

---

## 4. 参数

| 参数 | 用在 | 作用 |
|---|---|---|
| `-Remote` | 全部 | SSH 目标，`you@mac.tailnet.ts.net` |
| `-RemotePath` | 全部 | Mac 上仓库路径，可写 `$HOME/...` 或 `~/...` |
| `-Device` | run / shot / log | 模拟器名，如 `"iPhone 16"`。留空则自动挑第一台可用 iPhone |
| `-Sim` | check | 额外查 `aarch64-apple-ios-sim` |
| `-Release` | build / run | 出 release 包（默认 debug） |
| `-PhysicalDevice` | build | 出真机包。**没有开发者账号会在 codesign 处失败，属预期** |
| `-NoSync` | 多数 | 跳过同步，直接用 Mac 上现有代码 |
| `-NoPrune` | sync 及带同步的动作 | 不清理远端多余文件（排查同步问题时用） |
| `-Fresh` | run | 装之前先卸载旧包 |
| `-NoShot` | run | 跑完不自动截图 |
| `-Out` | shot | 截图落到指定本机路径 |
| `-LogSeconds` | log | 回看最近 N 秒后自动退出；`0` = 一直跟随 |
| `-ExtraArgs` | build / run | 透传给 `tauri ios build`，如 `-ExtraArgs "--verbose"` |

`-PhysicalDevice` 和 `run` 不能一起用：`run` 只驱动模拟器。

---

## 5. 同步是怎么做的

1. Windows 上用 `git ls-files --cached --others --exclude-standard` 取「已跟踪 + 未跟踪但不被 gitignore」的文件，正好等于该上机编译的源码，**包含未提交的改动**。
2. 已从工作区删掉但还在索引里的文件会被剔除（不在清单 = 远端跟着删）。
3. 打成 tar，`scp` 到 Mac，解包。
4. 清理：Mac 上同样算一份受管文件列表，凡是「远端有、本机清单没有」的就删掉，避免拿改名/删除前的陈旧文件去编译。

几条刻意的设计：

- **只同步 `app/` 和 `scripts/`。** `docs/` 不同步——里面有中文文件名，macOS 的 NFD 归一化会把它们变成看起来重复的另一份。想在 Mac 上看文档就用 git。
- **`scripts/` 必须同步**：`app/vite.config.ts` 会 `import '../scripts/brand.mjs'` 拿显示名，缺了编不过。
- **`app/src-tauri/gen/apple/` 不参与清理。** 它是 Mac 上 `tauri ios init` 生成的，提交进仓库之前本机清单里没有；要是参与清理，一次同步就把 Xcode 工程删了。
- `target/`、`node_modules/`、Gradle 产物都被 gitignore 挡住，不会来回传，也不会被清掉。

用的是系统自带的 `System32\tar.exe`（bsdtar）。**PATH 上那个 Git for Windows 带的 GNU tar 不能用**：它把 `C:\Users\...` 当成 `host:path` 远程语法，直接报 `Cannot execute remote shell`。脚本已经写死走 bsdtar，退回 GNU tar 时会自动加 `--force-local`；`doctor` 会打印实际用的是哪个。

---

## 6. 改前端 vs 改原生

| 改了什么 | 要跑什么 | 大概多久 |
|---|---|---|
| 只改 `app/src` 的 React / CSS | `run` | 快，Vite 构建 + 增量 xcodebuild |
| 改 `app/src-tauri` 的 Rust | `run` | 慢，要重编 Rust |
| 想先确认编得过再说 | `check` | 最快 |
| 改了 Swift / `Info.plist` / 权限 / 工程设置 | `run`，改动大时先 `shell` 上去看 Xcode 报什么 | — |

这里**没有热更新**。`tauri ios build` 把前端打进包里，不是连 Vite。要热更新只能在 Mac 上跑 `tauri ios dev`，那条路要看屏幕，见第 9 节。

---

## 7. `tauri ios build` 的参数要第一次自己确认一次

脚本用的是：

```bash
npx tauri ios build --target aarch64-sim --debug
```

不同 Tauri CLI 版本的 `--target` 取值可能不一样。第一次跑 `build` 如果它嫌参数不对，上去看一眼实际支持什么：

```powershell
.\scripts\ios-remote.ps1 shell
# 然后在 Mac 上：
cd app && npx tauri ios build --help
```

对上之后用 `-ExtraArgs` 补，或者改 `scripts/ios-remote.ps1` 里 `cmd_build` 那一行。这是整套流程里唯一需要你人工对一次的地方。

---

## 8. `gen/apple` 的回传与提交纪律

`gen/apple/` 和 `gen/android/` 一样**要进 git**，否则别人（和 CI）拿不到 Xcode 工程。但它只能在 Mac 上生成，所以：

```powershell
# 从 Mac 取回来
scp -r you@mac.tailnet.ts.net:'$HOME/src/local-git-account-manage/app/src-tauri/gen/apple' app\src-tauri\gen\
git add app/src-tauri/gen/apple
git commit -m "chore(ios): 纳入 Xcode 工程"
```

三条纪律：

1. **分支只走 `dev`。** iOS 是新功能，按仓库约定在 `dev` 上开发联调，测过再合 `release`。
2. **改 Swift / `Info.plist` / 签名只在 Mac 那份目录里改，改完取回 Windows 再提交。** 不要两边各改一半。
3. **显示名必须是「御钥师」。** 中文包的 `CFBundleDisplayName` / `CFBundleName` 不能写成 `Git Keymaster` / `GitKeymaster`（那是安装标识，不是显示名）。改完打包相关的东西先跑 `node scripts/check-release-invariants.mjs --test`。

证书、描述文件、`.p12`、登录钥匙串**只留在 Mac，绝不进 git、也不要拷到 Windows**。和安卓 keystore 同一条规矩。

---

## 9. 哪些事仍然必须看 Mac 屏幕

都是一次性或低频的：

| 场景 | 说明 |
|---|---|
| `tauri ios init` 之后 Xcode 首次打开、AppIcon、工程设置 | 一次 |
| 证书 / Provisioning Profile / TestFlight | 买了 Apple Developer Program 之后 |
| 真机调试（USB 配对） | iPhone 只能连 Mac。Hyper-V 那台 Windows 插不到 |
| Face ID 录入、`Features → Face ID` 菜单 | 模拟器的生物识别菜单在 GUI 上 |
| `tauri ios dev` 的前端热更新 | 它要开 Simulator.app |
| 上架截图 | 发版时 |

要看屏幕就开一条只绑 Tailscale 网卡的通道：macOS 自带「屏幕共享」（VNC），或 RustDesk。**不要让它听 `0.0.0.0`。**

Face ID 在模拟器上也能用命令行触发（社区做法是往 `com.apple.BiometricKit` 发 `notifyutil` 信号切换「已录入 / 匹配 / 不匹配」）。这一条依赖 Xcode 版本，第一次要在 Mac 上确认能用，之后才好写进脚本去验 M13 的 `stale` 流程。

---

## 10. 排错

| 现象 | 处理 |
|---|---|
| `上传远端脚本失败` | `ssh you@mac...` 本身不通。先查 Tailscale 在线、Mac 开了远程登录、公钥已写进 `authorized_keys` |
| `Cannot execute remote shell` | 用到了 GNU tar。跑 `doctor` 看它报的 tar 路径，应该是 `C:\WINDOWS\System32\tar.exe` |
| `远端仓库不在 ...` | Mac 上还没 clone，或 `-RemotePath` 填错。用 `shell` 上去 `pwd` 对一下 |
| `xcodebuild 不可用` | 只装了 Command Line Tools。要从 App Store 装完整 Xcode，再 `sudo xcode-select -s /Applications/Xcode.app` |
| `没装 iOS target` | Mac 上 `rustup target add aarch64-apple-ios aarch64-apple-ios-sim` |
| `gen/apple 不存在` | 先跑 `init` |
| `找不到模拟器 'xxx'` | Mac 上 `xcrun simctl list devices available` 看真实名字，再 `save -Device` 改掉 |
| `gen/apple 下没有 .app` | `build` 没成功。带 `-ExtraArgs "--verbose"` 再跑，或用 `shell` 上去手敲 |
| 装上了但白屏 | 看日志：`log -LogSeconds 120`。多半是前端没构建进包，或 Rust 侧 panic |
| 编译结果和预期不符 | 同步可能带了陈旧文件。`sync` 一次看它删了什么；别加 `-NoPrune` |
| 截图是黑的 | 模拟器刚启动没渲染完。等几秒再 `shot` |
| 改了代码但行为没变 | 确认没带 `-NoSync`；`sync` 的输出里应该有文件数 |

验收要看的几件事：

| 检查 | 预期 |
|---|---|
| 沙箱路径 | vault 落在 `Library/Application Support/<bundle>/workspace`，**不在 tmp** |
| 显示名 | 主屏幕图标下是「御钥师」 |
| 自更新 | 移动端不给应用内更新入口（`self_update_supported()` 返回 false） |
| 桌面回归 | Windows 上 `cargo test` 仍全绿 |

---

## 11. 不要做的事

```powershell
# 1. Windows 上编 iOS —— 没有这条路
cargo build --target aarch64-apple-ios

# 2. 用网络共享盘当工作区在 Mac 上编 —— IO 会把增量编译拖死
#    源码走 git / tar，target 和 DerivedData 留在 Mac 本地盘

# 3. 把 target/ 或 node_modules/ 同步过去 —— 两端 triple 不同，传了也没用
#    （gitignore 已经挡住，别手动绕过）

# 4. 在 Mac 上另开一条功能分支 —— 只走 dev，改完取回 Windows 提交
```

另外：安卓那条线继续用 `adb reverse` 走 Windows 上的 Vite（见 `docs/安卓真机调试.md`），和 iOS 这条互不干扰。**不要为了 iOS 去设 `TAURI_DEV_HOST`**，那会让 Windows 的 Vite 绑到 Tailscale 网卡上，把安卓调试的首屏拖慢。

---

## 12. 一次抄完

```powershell
cd D:\coding_program\local-git-account-manage

# 只需一次
.\scripts\ios-remote.ps1 save -Remote you@mac.tailnet.ts.net -Device "iPhone 16"
.\scripts\ios-remote.ps1 doctor
.\scripts\ios-remote.ps1 init

# 日常
.\scripts\ios-remote.ps1 check          # 快速确认编得过
.\scripts\ios-remote.ps1 run            # 装到模拟器并截图
.\scripts\ios-remote.ps1 log -LogSeconds 60
```
