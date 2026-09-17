import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EN_DISPLAY_NAME,
  MAIN_BINARY,
  ZH_DISPLAY_NAME,
} from "./brand.mjs";
import { assertPreparedUnified } from "./check-release-invariants.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const mode = (process.argv[2] || "unified").toLowerCase();
if (mode !== "unified") {
  console.error("usage: node scripts/prepare-lang.mjs [unified]");
  console.error("统一包不再按 zh|en 改 productName / 拆清单。");
  process.exit(1);
}

function upsertPlistString(xml, key, value) {
  const re = new RegExp(`(<key>${key}</key>\\s*<string>)([^<]*)(</string>)`);
  if (re.test(xml)) {
    return xml.replace(re, `$1${value}$3`);
  }
  return xml.replace("</dict>", `\t<key>${key}</key>\n\t<string>${value}</string>\n</dict>`);
}

function writeInfoPlistStrings(dir, displayName) {
  const camera =
    displayName === ZH_DISPLAY_NAME
      ? "用于扫描 2FA 密钥或云存储配置二维码。"
      : "Used to scan 2FA secrets or cloud-storage QR codes.";
  const face =
    displayName === ZH_DISPLAY_NAME
      ? "用于解锁工作空间并确认查看验证码或账户密码。"
      : "Used to unlock the workspace and confirm viewing codes or passwords.";
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "InfoPlist.strings"),
    [
      `CFBundleName = "${displayName}";`,
      `CFBundleDisplayName = "${displayName}";`,
      `NSCameraUsageDescription = "${camera}";`,
      `NSFaceIDUsageDescription = "${face}";`,
      "",
    ].join("\n"),
    "utf-8",
  );
}

function writeAndroidStrings(relDir, displayName) {
  const dir = path.join(rootDir, relDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "strings.xml"),
    `<resources>\n    <string name="app_name">"${displayName}"</string>\n    <string name="main_activity_title">"${displayName}"</string>\n</resources>\n`,
    "utf-8",
  );
}

const tauriConfPath = path.join(rootDir, "app", "src-tauri", "tauri.conf.json");
const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, "utf-8"));

// 仓库默认与统一包都是中文显示名。安装向导 / 系统 locale 只改 OS 外壳，不改二进制品牌。
tauriConf.mainBinaryName = MAIN_BINARY;
tauriConf.productName = ZH_DISPLAY_NAME;
if (tauriConf.app && tauriConf.app.windows && tauriConf.app.windows[0]) {
  tauriConf.app.windows[0].title = ZH_DISPLAY_NAME;
}

const infoPlistPath = path.join(rootDir, "app", "src-tauri", "Info.plist");
if (fs.existsSync(infoPlistPath)) {
  let plist = fs.readFileSync(infoPlistPath, "utf-8");
  plist = upsertPlistString(plist, "CFBundleDisplayName", ZH_DISPLAY_NAME);
  plist = upsertPlistString(plist, "CFBundleName", ZH_DISPLAY_NAME);
  fs.writeFileSync(infoPlistPath, plist, "utf-8");
}

writeInfoPlistStrings(path.join(rootDir, "app", "src-tauri", "zh_CN.lproj"), ZH_DISPLAY_NAME);
writeInfoPlistStrings(path.join(rootDir, "app", "src-tauri", "en.lproj"), EN_DISPLAY_NAME);

tauriConf.bundle = tauriConf.bundle || {};
tauriConf.bundle.resources = {
  ...(tauriConf.bundle.resources && typeof tauriConf.bundle.resources === "object"
    ? tauriConf.bundle.resources
    : {}),
  "zh_CN.lproj/InfoPlist.strings": "zh_CN.lproj/InfoPlist.strings",
  "en.lproj/InfoPlist.strings": "en.lproj/InfoPlist.strings",
};
tauriConf.bundle.macOS = {
  ...(tauriConf.bundle.macOS || {}),
  infoPlist: "Info.plist",
};
tauriConf.bundle.windows = tauriConf.bundle.windows || {};
tauriConf.bundle.windows.nsis = {
  ...(tauriConf.bundle.windows.nsis || {}),
  displayLanguageSelector: true,
  languages: ["SimpChinese", "English"],
  template: "windows/installer.nsi",
};
if (tauriConf.bundle.windows.wix) {
  delete tauriConf.bundle.windows.wix.language;
  delete tauriConf.bundle.windows.wix.languages;
}

const desktopTemplate = path.join(rootDir, "app", "src-tauri", "linux", "git-keymaster.desktop");
fs.mkdirSync(path.dirname(desktopTemplate), { recursive: true });
fs.writeFileSync(
  desktopTemplate,
  `[Desktop Entry]
Categories={{categories}}
{{#if comment}}
Comment={{comment}}
{{/if}}
Exec={{exec}}
Icon={{icon}}
Name=${EN_DISPLAY_NAME}
Name[zh_CN]=${ZH_DISPLAY_NAME}
Terminal=false
Type=Application
`,
  "utf-8",
);
tauriConf.bundle.linux = tauriConf.bundle.linux || {};
tauriConf.bundle.linux.deb = {
  ...(tauriConf.bundle.linux.deb || {}),
  desktopTemplate: "linux/git-keymaster.desktop",
};
tauriConf.bundle.linux.rpm = {
  ...(tauriConf.bundle.linux.rpm || {}),
  desktopTemplate: "linux/git-keymaster.desktop",
};

const androidValues = path.join(
  rootDir,
  "app/src-tauri/gen/android/app/src/main/res/values",
);
if (fs.existsSync(path.dirname(androidValues))) {
  writeAndroidStrings("app/src-tauri/gen/android/app/src/main/res/values", ZH_DISPLAY_NAME);
  writeAndroidStrings("app/src-tauri/gen/android/app/src/main/res/values-en", EN_DISPLAY_NAME);
}

if (tauriConf.plugins?.updater) {
  tauriConf.plugins.updater.endpoints = [
    "https://github.com/ice-juice/git-keymaster-app/releases/latest/download/latest.json",
  ];
}

fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2), "utf-8");

const envProductionPath = path.join(rootDir, "app", ".env.production");
const envPath = path.join(rootDir, "app", ".env");
for (const leftover of [envPath, envProductionPath]) {
  if (fs.existsSync(leftover)) {
    fs.unlinkSync(leftover);
  }
}

const langFile = path.join(rootDir, "app", "src-tauri", "gam-lang.txt");
if (fs.existsSync(langFile)) {
  fs.unlinkSync(langFile);
}

assertPreparedUnified();
console.log(
  `[prepare-lang] unified productName=${tauriConf.productName} nsis=SimpChinese,English endpoints=latest.json`,
);
