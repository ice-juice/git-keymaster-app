/**
 * 拦住会反复出现的发版低级错误：中文可见名写成 Git Keymaster、标题栏读 getName()、
 * 又按语言拆清单、prepare-lang 把语言写进会污染 `tauri dev` 的 app/.env 等。
 *
 *   node scripts/check-release-invariants.mjs
 *   node scripts/check-release-invariants.mjs --prepared unified
 *   node scripts/check-release-invariants.mjs --test
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  displayNameFor,
  EN_DISPLAY_NAME,
  INSTALLER_STEM,
  MAIN_BINARY,
  WIN_INSTALL_DIR,
  WIN_UNINSTALL_ID,
  ZH_DISPLAY_NAME,
} from "./brand.mjs";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), "..");

function read(rel) {
  return fs.readFileSync(path.join(rootDir, rel), "utf-8");
}

function exists(rel) {
  return fs.existsSync(path.join(rootDir, rel));
}

function plistString(xml, key) {
  const m = xml.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
  return m ? m[1] : null;
}

function androidString(xml, name) {
  const m = xml.match(new RegExp(`<string name="${name}">"([^"]*)"</string>`));
  return m ? m[1] : null;
}

function fail(message) {
  throw new Error(message);
}

function expectEq(actual, expected, label) {
  if (actual !== expected) {
    fail(`${label} 应为「${expected}」，实际是「${actual}」`);
  }
}

function assertChineseDefaults() {
  const tauriConf = JSON.parse(read("app/src-tauri/tauri.conf.json"));
  expectEq(tauriConf.productName, ZH_DISPLAY_NAME, "tauri.conf.json productName");
  expectEq(tauriConf.app?.windows?.[0]?.title, ZH_DISPLAY_NAME, "tauri.conf.json window title");
  expectEq(tauriConf.mainBinaryName, MAIN_BINARY, "tauri.conf.json mainBinaryName");

  const plist = read("app/src-tauri/Info.plist");
  expectEq(plistString(plist, "CFBundleDisplayName"), ZH_DISPLAY_NAME, "Info.plist CFBundleDisplayName");
  expectEq(plistString(plist, "CFBundleName"), ZH_DISPLAY_NAME, "Info.plist CFBundleName");

  const androidStringsPath = "app/src-tauri/gen/android/app/src/main/res/values/strings.xml";
  if (exists(androidStringsPath)) {
    const android = read(androidStringsPath);
    expectEq(androidString(android, "app_name"), ZH_DISPLAY_NAME, "Android strings.xml app_name");
    expectEq(
      androidString(android, "main_activity_title"),
      ZH_DISPLAY_NAME,
      "Android strings.xml main_activity_title",
    );
  }

  const iosConfPath = "app/src-tauri/tauri.ios.conf.json";
  if (!exists(iosConfPath)) {
    fail("必须提交 tauri.ios.conf.json");
  }
  const iosConf = JSON.parse(read(iosConfPath));
  if (iosConf.bundle?.createUpdaterArtifacts !== false) {
    fail("tauri.ios.conf.json 必须 createUpdaterArtifacts: false");
  }
  if (iosConf.productName && iosConf.productName !== ZH_DISPLAY_NAME) {
    fail("tauri.ios.conf.json 若写 productName 必须是「御钥师」");
  }
  if (iosConf.identifier && iosConf.identifier !== "com.jeck.gitkeymaster") {
    fail("tauri.ios.conf.json 标识符必须是 com.jeck.gitkeymaster");
  }
}

/** 仓库默认与统一包准备后都应满足：中文默认 + 外壳双语资源。 */
export function assertPreparedFiles(lang) {
  if (lang && lang !== "zh" && lang !== "unified") {
    fail(`统一包只接受 --prepared unified（收到 ${lang}）`);
  }
  assertChineseDefaults();
}

export function assertUnifiedPackaging() {
  assertChineseDefaults();

  const tauriConf = JSON.parse(read("app/src-tauri/tauri.conf.json"));
  const nsis = tauriConf.bundle?.windows?.nsis || {};
  if (nsis.displayLanguageSelector !== true) {
    fail("统一包 NSIS 必须 displayLanguageSelector: true");
  }
  const languages = nsis.languages || [];
  if (!languages.includes("SimpChinese") || !languages.includes("English")) {
    fail("统一包 NSIS languages 必须同时包含 SimpChinese 与 English");
  }
  const endpoints = tauriConf.plugins?.updater?.endpoints || [];
  if (!endpoints.some((url) => String(url).endsWith("/latest.json"))) {
    fail("统一包更新地址必须是 latest.json");
  }
  if (endpoints.some((url) => /latest-(zh-CN|en-US)\.json$/.test(String(url)))) {
    fail("统一包默认 endpoints 不能再按语言拆清单");
  }

  const zhLproj = "app/src-tauri/zh_CN.lproj/InfoPlist.strings";
  const enLproj = "app/src-tauri/en.lproj/InfoPlist.strings";
  if (!exists(zhLproj) || !exists(enLproj)) {
    fail("必须提交 zh_CN.lproj / en.lproj 的 InfoPlist.strings");
  }
  const zhStrings = read(zhLproj);
  const enStrings = read(enLproj);
  if (!zhStrings.includes(ZH_DISPLAY_NAME)) {
    fail("zh_CN.lproj 必须包含「御钥师」");
  }
  if (!enStrings.includes(EN_DISPLAY_NAME)) {
    fail("en.lproj 必须包含 Git Keymaster");
  }

  const androidEn = "app/src-tauri/gen/android/app/src/main/res/values-en/strings.xml";
  if (!exists(androidEn)) {
    fail("必须存在 Android values-en/strings.xml");
  }
  const enAndroid = read(androidEn);
  expectEq(androidString(enAndroid, "app_name"), EN_DISPLAY_NAME, "Android values-en app_name");
  expectEq(
    androidString(enAndroid, "main_activity_title"),
    EN_DISPLAY_NAME,
    "Android values-en main_activity_title",
  );

  const desktop = "app/src-tauri/linux/git-keymaster.desktop";
  if (!exists(desktop)) {
    fail("必须存在 Linux desktop 模板");
  }
  const desktopText = read(desktop);
  if (!desktopText.includes(`Name=${EN_DISPLAY_NAME}`) || !desktopText.includes(`Name[zh_CN]=${ZH_DISPLAY_NAME}`)) {
    fail("Linux .desktop 必须是 Name=Git Keymaster 且 Name[zh_CN]=御钥师");
  }
}

export function assertPreparedUnified() {
  assertUnifiedPackaging();
  if (exists("app/.env")) {
    fail("prepare-lang 之后不能留下 app/.env");
  }
  if (exists("app/.env.production") && /VITE_APP_LANG=en/.test(read("app/.env.production"))) {
    fail("统一包禁止把 VITE_APP_LANG=en 写进 .env.production");
  }
  if (exists("app/src-tauri/gam-lang.txt")) {
    fail("统一包不再写 gam-lang.txt，更新器只拉 latest.json");
  }
}

function checkCommittedDefaults() {
  assertUnifiedPackaging();

  const nsi = read("app/src-tauri/windows/installer.nsi");
  if (!nsi.includes(`!define INSTALLDIRNAME "${WIN_INSTALL_DIR}"`)) {
    fail(`installer.nsi 的默认安装目录必须是 ASCII「${WIN_INSTALL_DIR}」，不要用显示名当路径`);
  }
  if (nsi.includes("Uninstall\\${PRODUCTNAME}") || nsi.includes("Uninstall\\${PRODUCTNAME}\"")) {
    fail("installer.nsi 的 UNINSTKEY 不能跟 PRODUCTNAME 走，否则中英文包装完会并排出两个卸载项");
  }
  if (!nsi.includes(`!define INSTALLIDENTITY "${WIN_UNINSTALL_ID}"`)) {
    fail(`installer.nsi 的卸载项身份必须是 ASCII「${WIN_UNINSTALL_ID}」`);
  }
  if (!nsi.includes("LEGACY_UNINSTKEY_ZH") || !nsi.includes("LEGACY_UNINSTKEY_EN")) {
    fail("installer.nsi 必须在安装时清掉旧中英文卸载键");
  }
  if (!nsi.includes("RemoveCrossLanguageShortcuts")) {
    fail("installer.nsi 必须清掉另一种语言留下的开始菜单 / 桌面快捷方式");
  }
  if (!nsi.includes("ShellDisplayName") || !nsi.includes("$LANGUAGE")) {
    fail("installer.nsi 必须按 $LANGUAGE 选择 DisplayName / 开始菜单，不能只用编译期 PRODUCTNAME");
  }
  if (nsi.includes('WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${PRODUCTNAME}"')) {
    fail("DisplayName 必须写 $ShellDisplayName，禁止跟编译期 PRODUCTNAME 走");
  }

  const source = read("app/src-tauri/src/update/source.rs");
  if (!source.includes('"latest.json"')) {
    fail("更新器必须固定拉 latest.json");
  }
  if (source.includes("GAM_APP_LANG") || /"(latest-zh-CN|latest-en-US)\.json"/.test(source)) {
    fail("更新器不得再读 GAM_APP_LANG 或按语言拆 latest-zh-CN / latest-en-US");
  }

  const buildRs = read("app/src-tauri/build.rs");
  if (buildRs.includes("GAM_APP_LANG") || buildRs.includes("gam-lang.txt")) {
    fail("build.rs 必须停止注入 GAM_APP_LANG");
  }

  const sync = read("scripts/sync-release-assets.mjs");
  if (!sync.includes("mergeLatestJson") || !sync.includes("latest.json")) {
    fail("sync-release-assets.mjs 必须按平台合并唯一的 latest.json");
  }
  if (!sync.includes("--pin-legacy") || !sync.includes("LEGACY_MANIFEST_NAMES") || !sync.includes("writeLegacyManifestAliases")) {
    fail("sync-release-assets.mjs 必须提供 --pin-legacy，把 latest.json 复制成旧名别名");
  }
  if (sync.includes("copied latest-zh-CN.json -> latest.json")) {
    fail("pin-legacy 不能再把 latest.json 钉成中文清单；三份文件必须字节级相同");
  }
  if (!sync.includes("injectAndroidAarch64") || !sync.includes("android-aarch64")) {
    fail("sync-release-assets.mjs 必须把 android-aarch64 写进唯一 latest.json");
  }
  if (!sync.includes("--merge-android") || !sync.includes("mergeAndroidManifest")) {
    fail("sync-release-assets.mjs 必须提供 --merge-android，只注入 android-aarch64，不得整份替换");
  }
  if (!sync.includes("evaluateManifestUpload") || !sync.includes("evaluatePinCanonical")) {
    fail("sync-release-assets.mjs 必须拒绝安卓-only 覆盖桌面清单，pin 不得接受无桌面 platforms");
  }
  if (!sync.includes("collectBundleUploads")) {
    fail("sync-release-assets.mjs 在 rename 映射为空时仍须上传安装包和 .sig");
  }
  if (!sync.includes("missingUpdaterSignatures") || !sync.includes("ensureSignedAsset")) {
    fail("pin 在 Release 缺安装包 .sig 时必须下载安装包并用同一把 minisign 补签");
  }
  if (!sync.includes("signLatestJsonFile") || !sync.includes("readAndroidApkSignature")) {
    fail("sync-release-assets.mjs 必须用同一把 minisign 私钥签 latest.json，并写入 APK signature");
  }

  const signManifest = read("scripts/sign-update-manifest.mjs");
  if (!signManifest.includes("canonicalManifestPayload") || !signManifest.includes("manifestSignature")) {
    fail("必须用确定性文本签清单，字段名跟现有 camelCase 走");
  }
  if (!signManifest.includes("tauri") || !signManifest.includes("signer")) {
    fail("清单/APK 必须走现有 tauri signer / minisign，不要另造哈希协议");
  }

  const manifestRs = read("app/src-tauri/src/update/manifest.rs");
  if (!manifestRs.includes("https_only(true)")) {
    fail("自研拉清单的 reqwest 必须 https_only，不要跟随到 http");
  }
  if (!manifestRs.includes("manifestSignature") || !manifestRs.includes("canonical_manifest_payload")) {
    fail("新客户端必须验 latest.json 的 manifestSignature");
  }
  if (!manifestRs.includes("require_signed_manifest") && !read("app/src-tauri/src/update/watermark.rs").includes("require_signed_manifest")) {
    fail("本机成功验过带签清单后必须要求后续清单带签");
  }

  const androidManifest = "app/src-tauri/gen/android/app/src/main/AndroidManifest.xml";
  if (exists(androidManifest)) {
    const manifest = read(androidManifest);
    if (!manifest.includes('android:allowBackup="false"')) {
      fail("AndroidManifest 必须 allowBackup=false，保险库不能进 Google 备份");
    }
    if (manifest.includes("Git Keymaster") || manifest.includes("GitKeymaster")) {
      fail("AndroidManifest 用户可见名称不能写死 Git Keymaster / GitKeymaster");
    }
    if (!manifest.includes("REQUEST_INSTALL_PACKAGES") || !manifest.includes("FileProvider")) {
      fail("Android 侧载更新必须声明 REQUEST_INSTALL_PACKAGES 与 FileProvider");
    }
  }

  const cargo = read("app/src-tauri/Cargo.toml");
  const defaultDeps = cargo.split("[target")[0];
  if (defaultDeps.includes("tauri-plugin-updater")) {
    fail("tauri-plugin-updater 不能进默认依赖，否则会编进 Android");
  }
  if (!cargo.includes("tauri-plugin-updater") || !cargo.includes('target_os = "windows"')) {
    fail("桌面三端必须继续依赖 tauri-plugin-updater");
  }

  const updateCmd = read("app/src-tauri/src/commands/update.rs");
  if (updateCmd.includes('Unsupported("应用内更新")')) {
    fail("安卓 check_update / 下载不能再直接 Unsupported");
  }
  if (!read("app/src-tauri/src/lib.rs").includes("mobile::update::init")) {
    fail("必须注册安卓侧载更新插件，且官方 updater 仍按 target_os 排除移动端");
  }
}

function checkPrepareLangSource() {
  const src = read("scripts/prepare-lang.mjs");
  if (!src.includes("from \"./brand.mjs\"") && !src.includes("from './brand.mjs'")) {
    fail("prepare-lang.mjs 必须从 scripts/brand.mjs 取显示名，不要再复制一份");
  }
  if (!src.includes("unified")) {
    fail("prepare-lang.mjs 必须提供 unified 模式");
  }
  if (!src.includes('upsertPlistString(plist, "CFBundleDisplayName", ZH_DISPLAY_NAME)')) {
    fail("prepare-lang.mjs 必须把默认 CFBundleDisplayName 写成「御钥师」");
  }
  if (!src.includes('upsertPlistString(plist, "CFBundleName", ZH_DISPLAY_NAME)')) {
    fail("prepare-lang.mjs 必须把默认 CFBundleName 写成「御钥师」，禁止写死 GitKeymaster / Git Keymaster");
  }
  if (/upsertPlistString\(\s*plist\s*,\s*["']CFBundleName["']\s*,\s*["']/.test(src)) {
    fail("prepare-lang.mjs 把 CFBundleName 写成了字符串字面量；必须跟 brand.mjs 走");
  }
  if (src.includes("VITE_APP_LANG=")) {
    fail("prepare-lang.mjs 禁止再写 VITE_APP_LANG（会污染开发或拆清单）");
  }
  if (/writeFileSync\(\s*envPath\s*,/.test(src) || /writeFileSync\(\s*envProductionPath\s*,/.test(src)) {
    fail("prepare-lang.mjs 不得写 app/.env 或 .env.production");
  }
  if (!src.includes("unlinkSync") && !src.includes("rmSync")) {
    fail("prepare-lang.mjs 必须删掉残留的 app/.env，避免 VITE_APP_LANG=en 留在本地开发");
  }
  if (!src.includes("values-en") || !src.includes("en.lproj") || !src.includes("zh_CN.lproj")) {
    fail("prepare-lang.mjs 必须确保 Android values-en 与 macOS lproj 存在");
  }
  if (/writeFileSync\(\s*[^)]*gam-lang\.txt/.test(src) || /writeFileSync\(\s*langFile/.test(src)) {
    fail("prepare-lang.mjs 禁止再写拆清单用的 gam-lang.txt");
  }
  if (!src.includes("SimpChinese") || !src.includes("English") || !src.includes("displayLanguageSelector: true")) {
    fail("prepare-lang.mjs 必须打开 NSIS 双语 + 语言选择器");
  }
}

function checkUiSource() {
  const config = read("app/src/lib/config.ts");
  if (!config.includes("VITE_APP_NAME") && !config.includes(ZH_DISPLAY_NAME)) {
    fail("config.ts 必须能得到中文显示名「御钥师」");
  }
  if (!config.includes(ZH_DISPLAY_NAME) || !config.includes(EN_DISPLAY_NAME)) {
    fail(`config.ts 回退显示名必须与 brand.mjs 一致（${ZH_DISPLAY_NAME} / ${EN_DISPLAY_NAME}）`);
  }
  if (!config.includes("useAppName")) {
    fail("config.ts 必须导出 useAppName，按运行时 uiLocale 取 brand.mjs 显示名");
  }

  const i18n = read("app/src/lib/i18n.ts");
  if (!i18n.includes("brand.mjs") || !i18n.includes("displayNameFor")) {
    fail("i18n.ts 必须从 scripts/brand.mjs 取 displayNameFor，禁止前端再抄一份品牌字面量当运行时源");
  }

  const titleBar = read("app/src/ui/TitleBar.tsx");
  if (titleBar.includes("getName") || titleBar.includes("@tauri-apps/api/app")) {
    fail("TitleBar 禁止调用 getName() 或引用 @tauri-apps/api/app。左上角只渲染 {APP_NAME}");
  }
  if (!titleBar.includes("{APP_NAME}")) {
    fail("TitleBar 左上角必须直接渲染 {APP_NAME}，不要用 productName / 运行时窗口名覆盖");
  }

  const mobile = read("app/src/ui/MobileShell.tsx");
  if (mobile.includes("getName")) {
    fail("MobileShell 禁止调用 getName()");
  }
  if (!mobile.includes("{APP_NAME}")) {
    fail("MobileShell 顶栏必须渲染 {APP_NAME}");
  }

  const settingsMobile = read("app/src/pages/Settings.mobile.tsx");
  if (settingsMobile.includes("御钥师 · Git Keymaster") || settingsMobile.includes("御钥师 · Git Keymaster")) {
    fail("Settings.mobile 禁止写死「御钥师 · Git Keymaster」；品牌名必须跟 uiLocale 走");
  }
  if (settingsMobile.includes("Git Keymaster") || settingsMobile.includes("GitKeymaster")) {
    fail("Settings.mobile 中文可见表面不能写死 Git Keymaster / GitKeymaster");
  }

  const vite = read("app/vite.config.ts");
  if (!vite.includes("from '../scripts/brand.mjs'") && !vite.includes('from "../scripts/brand.mjs"')) {
    fail("vite.config.ts 必须从 scripts/brand.mjs 注入显示名，禁止前端再抄一份");
  }
  if (!vite.includes("VITE_APP_NAME")) {
    fail("vite.config.ts 必须 define import.meta.env.VITE_APP_NAME");
  }
}

function checkRenameStem() {
  const src = read("scripts/rename-release-assets.mjs");
  if (!src.includes("from \"./brand.mjs\"") && !src.includes("from './brand.mjs'")) {
    fail("rename-release-assets.mjs 必须从 scripts/brand.mjs 取安装包文件名主干");
  }
  if (!src.includes("INSTALLER_STEM")) {
    fail(`安装包文件名主干必须使用 brand.mjs 的 INSTALLER_STEM（${INSTALLER_STEM}）`);
  }
  if (!src.includes("normalizeInstallerFilename") || !src.includes("mergeLatestJson")) {
    fail("rename-release-assets.mjs 必须规范化 ASCII 主干并合并唯一 latest.json");
  }
  if (src.includes("stampLocaleFilename") || src.includes("_${locale}")) {
    fail("rename-release-assets.mjs 不能再给安装包盖 zh-CN / en-US 后缀");
  }
  if (!src.includes("androidApkFilename") || !src.includes("arm64-v8a.apk") || src.includes("arm64-v8a_${locale}")) {
    fail("rename-release-assets.mjs 必须把安卓 APK 改成 Git.Keymaster_{版本}_arm64-v8a.apk");
  }
  if (!src.includes("findSignedReleaseApk") || !src.includes("app-universal-release.apk")) {
    fail("rename-release-assets.mjs 必须能识别 universal 和 arm64 两种正式 APK");
  }
  if (!src.includes("LEGACY_MANIFEST_NAMES")) {
    fail("rename-release-assets.mjs 必须保留旧清单别名 latest-zh-CN.json / latest-en-US.json");
  }
  if (!src.includes("android-aarch64") || !src.includes("injectAndroidAarch64")) {
    fail("rename-release-assets.mjs 必须把正式 APK 写进 latest.json 的 android-aarch64");
  }
  if (!src.includes("signFileWithTauri")) {
    fail("rename-release-assets.mjs 必须用同一把 minisign 私钥签 APK");
  }

  const yml = read(".github/workflows/release.yml");
  if (!yml.includes("tauri android build --apk --target aarch64 --split-per-abi")) {
    fail("安卓正式包必须加 --split-per-abi，否则产出的是 universal APK，改名会找不到文件");
  }
  if (yml.includes("matrix.lang") || /lang:\s*zh/.test(yml) || /lang:\s*en/.test(yml)) {
    fail("release.yml 桌面/安卓不得再按 zh/en 矩阵出包");
  }
  if (!yml.includes("prepare-lang.mjs unified") || !yml.includes("--prepared unified")) {
    fail("release.yml 必须走 prepare-lang unified");
  }
  if (!yml.includes("sync-release-assets.mjs \"${{ steps.meta.outputs.tag }}\"")) {
    fail("release.yml 同步 Release 资产时不得再带 zh-CN / en-US");
  }
  if (!yml.includes("--pin-legacy")) {
    fail("release.yml 必须在全部桌面任务结束后把 latest.json 复制成旧名别名");
  }
  if (!/pin-updater-json[\s\S]*npm ci/.test(yml)) {
    fail("pin latest.json 必须 npm ci，否则签不了清单、也补不了缺失的安装包 .sig");
  }
  if (!yml.includes("needs: [build, build-android]")) {
    fail("pin-updater-json 必须等安卓 job 写入 android-aarch64 后再复制别名");
  }
  if (!yml.includes("Merge Android APK into latest.json")) {
    fail("release.yml 安卓 job 必须把 APK 合并进 latest.json 的 android-aarch64");
  }
  if (!yml.includes("--merge-android")) {
    fail("release.yml 安卓 job 必须用 --merge-android 只注入 android-aarch64，不得整份替换 latest.json");
  }
  if (!yml.includes("TAURI_SIGNING_PRIVATE_KEY") || !yml.includes("${apks[0]}.sig")) {
    fail("release.yml 必须把同一把 minisign 私钥交给安卓/pin，并上传 APK .sig");
  }
  if (!yml.includes("name: ios") || !yml.includes("pack-ios-ipa.mjs") || !yml.includes("aarch64-apple-ios")) {
    fail("release.yml 必须有 ios job：macos-latest + aarch64-apple-ios + pack-ios-ipa.mjs");
  }
  if (yml.includes("gh release upload") && /gh release upload[\s\S]{0,200}\.ipa/.test(yml)) {
    fail("联调阶段未签名 ipa 只 upload-artifact，不要挂到 GitHub Release");
  }
}

function checkAndroidSigningSource() {
  const gradle = read("app/src-tauri/gen/android/app/build.gradle.kts");
  if (!gradle.includes("keystore.properties") || !gradle.includes("signingConfigs")) {
    fail("Android release 必须在存在 keystore.properties 时配置 signingConfigs");
  }
  if (!gradle.includes("keystorePropertiesFile.exists()")) {
    fail("Android 签名必须在缺少 keystore.properties 时跳过，不能挡住本地 debug");
  }
  const ignore = read("app/src-tauri/gen/android/.gitignore");
  if (!ignore.includes("keystore.properties") || !ignore.includes("*.jks")) {
    fail("gen/android/.gitignore 必须忽略 keystore.properties 和 *.jks");
  }
}

export function checkSourceInvariants() {
  checkCommittedDefaults();
  checkPrepareLangSource();
  checkUiSource();
  checkRenameStem();
  checkAndroidSigningSource();
}

function runSelfTest() {
  if (displayNameFor("zh") !== ZH_DISPLAY_NAME || displayNameFor("en") !== EN_DISPLAY_NAME) {
    fail("displayNameFor 语言映射错了");
  }
  if (displayNameFor("en-US") !== EN_DISPLAY_NAME) {
    fail("en-US 应映射到英文显示名");
  }
  const xml = `<key>CFBundleName</key>\n\t<string>${ZH_DISPLAY_NAME}</string>`;
  if (plistString(xml, "CFBundleName") !== ZH_DISPLAY_NAME) {
    fail("plist 解析自测失败");
  }
  const badPrepare = `upsertPlistString(plist, "CFBundleName", "GitKeymaster");`;
  if (!/upsertPlistString\(\s*plist\s*,\s*["']CFBundleName["']\s*,\s*["']/.test(badPrepare)) {
    fail("没能识别把 CFBundleName 写死成英文的旧写法");
  }
  checkSourceInvariants();
  const signTest = spawnSync(process.execPath, [path.join(rootDir, "scripts", "sign-update-manifest.mjs"), "--test"], {
    encoding: "utf8",
  });
  if (signTest.status !== 0) {
    fail(signTest.stderr || signTest.stdout || "sign-update-manifest self-test failed");
  }
  console.log("[invariants] self-test ok");
}

const invoked = process.argv[1] && path.basename(process.argv[1]) === "check-release-invariants.mjs";
if (invoked) {
  try {
    const arg = process.argv[2];
    if (arg === "--test") {
      runSelfTest();
    } else if (arg === "--prepared") {
      const mode = process.argv[3];
      if (mode !== "unified") {
        fail("usage: node scripts/check-release-invariants.mjs --prepared unified");
      }
      assertPreparedUnified();
      console.log(`[invariants] prepared unified displayName=${ZH_DISPLAY_NAME}`);
    } else if (!arg) {
      checkSourceInvariants();
      console.log("[invariants] source ok");
    } else {
      console.error("usage: node scripts/check-release-invariants.mjs [--prepared unified|--test]");
      process.exit(1);
    }
  } catch (err) {
    console.error(`[invariants] ${err.message}`);
    process.exit(1);
  }
}
