签名和 CI 是两件事：**钥匙只在你本机生成并保管，仓库只接读钥匙的配置和打包任务。** 钥匙不能进 git。

官方依据是 [Tauri Android 签名](https://v2.tauri.app/distribute/sign/android/)。下面按本仓库的路径写。

---

## 1. 你先做：生成并备份钥匙

在本机 PowerShell 执行（`keytool` 在 JDK 里，本机已装过安卓调试环境）：

```powershell
$outDir = "D:\gitKeyMasterWorkSpace\android-signing"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
keytool -genkey -v `
  -keystore "$outDir\upload-keystore.jks" `
  -storetype JKS `
  -keyalg RSA -keysize 2048 -validity 10000 `
  -alias upload
```

提示时设 **store 口令** 和 **key 口令**（建议相同，CI 更好配）。姓名/组织可以随便填，用户看不见。

然后立刻做两件事：

1. **离线备份两份** `upload-keystore.jks`（例如加密 U 盘 + 另一台不联网的盘）。这是计划里的 P4。丢了这把钥匙，`com.jeck.gitkeymaster` 的正式包就无法覆盖更新，只能换包名重来。
2. **不要**把 `.jks`、口令、`keystore.properties` 放进仓库。`gen/android/.gitignore` 已经忽略了 `keystore.properties`。

导出给 GitHub 用的 Base64（不要把输出贴到聊天里）：

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$outDir\upload-keystore.jks")) |
  Set-Clipboard
```

到仓库 **Settings → Secrets and variables → Actions** 新增：

| Secret | 值 |
|---|---|
| `ANDROID_KEY_BASE64` | 剪贴板里那整段 Base64 |
| `ANDROID_KEY_ALIAS` | `upload` |
| `ANDROID_KEY_PASSWORD` | 刚才设的口令 |

桌面更新签名 `TAURI_SIGNING_*` 继续留给 Windows/macOS/Linux，安卓不用那套，也没有应用内自更新。

---

## 2. 仓库要改：Gradle 认这把钥匙

`app/src-tauri/gen/android/app/build.gradle.kts` 里，release 目前只开了混淆，**没有 `signingConfig`**。要按官方方式加上：存在 `keystore.properties` 才签名，没有文件时本地 debug 照常能打。

CI 在打包前现写这份文件（不入库）：

```text
app/src-tauri/gen/android/keystore.properties
```

内容由 Secrets 拼出来：`keyAlias`、`password`、`storeFile` 指向 runner 上解码出来的 `.jks`。

本地若要自己打正式包，可以在同一位置手写 `keystore.properties`，`storeFile` 用绝对路径；Windows 路径里的 `\` 要写成 `\\`。

`versionName` / `versionCode` 不用手改：`tauri android build` 会按 `tauri.conf.json` 的版本写入 `tauri.properties`。桌面升到 `1.5.0`，安卓就是同一个版本名，整数 `versionCode` 跟着涨。以后每次发版这个整数必须比上一版大，否则手机拒绝覆盖安装。

---

## 3. CI：在现有 `Release packages` 里加一路安卓

现在 `release.yml` 打标签后是 2 路测试 + 6 路桌面。安卓应再加 **2 个 job**（中文 / 英文），和桌面一样先 `prepare-lang`，这样顶栏是「御钥师」或 `Git Keymaster`。

每个 job 大致是：

1. 检出 `release` 上的 `v*` 提交（沿用现有分支检查）
2. Node 22、`npm ci`、Rust，并加 target `aarch64-linux-android`
3. JDK 17、Android SDK Platform 36、Build-Tools、NDK
4. 用 Secrets 写出 `keystore.properties`
5. `node scripts/prepare-lang.mjs zh|en`（已会改 `strings.xml` 里的显示名）
6. 在 `app` 下：`npx tauri android build --apk --target aarch64`
7. 把产物改名为  
   `Git.Keymaster_{版本}_arm64-v8a_zh-CN.apk` / `_en-US.apk`
8. 上传到同一份草稿 Release，并写进 `docs/release-download-guide.md`

输出一般在：

`app/src-tauri/gen/android/app/build/outputs/apk/arm64/release/app-arm64-release.apk`

只打 **arm64** 即可，现在的手机都是这个架构；universal 会大很多。AAB 留给以后上 Play，GitHub 侧载用 APK。

`ci.yml`（推 `dev` 时的 Test）**不要**打正式包。最多以后加一行 `cargo check --target aarch64-linux-android` 防编译回归，和出包分开。

---

## 4. 和 debug 包的关系

| | Debug（你现在真机用的） | Release（给用户的） |
|---|---|---|
| 包名 | `com.jeck.gitkeymaster.debug` | `com.jeck.gitkeymaster` |
| 签名 | 本机 debug 证书 | 上面那把 upload keystore |
| 更新 | 互不覆盖 | 只有同一把钥匙的新 APK 能覆盖 |

所以正式包不会冲掉你手机上的调试包，两边可以并存。用户手里如果先装过别人用别的钥匙签的同名包，必须先卸载再装。

---

## 5. 接 CI 之前还缺的工程文件

上次提交只收了插件和 Manifest。CI 还要能编完整工程，至少还要把这些纳入 git（不要 `.gradle`、`build/`、截图、`*.jks`）：

- `MainActivity.kt`、资源、`gradlew` / wrapper
- `build.gradle.kts`、`settings.gradle`、`buildSrc/`、`gradle.properties`

扫码用的 `CameraPermPlugin.kt` 若正式包也要扫码，必须一起进。

---

## 分工

**只有你能做的：** 第 1 步生成 `.jks`、备份两份、把 3 个 Secrets 配进 GitHub。配好后跟我说一声，**不要**把钥匙或 Base64 发到对话里。

**我可以做的：** Gradle 签名块、补齐并提交 `gen/android` 工程、改 `release.yml` / 改名脚本 / 下载建议 / 发版手册。

钥匙配好之后我就可以在 `dev` 上接线；没钥匙时 CI 也能先合代码，但打 `v*` 时安卓 job 会在签名步失败。