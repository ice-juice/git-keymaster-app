/**
 * 把 Tauri 安装包改成 ASCII 主干「Git.Keymaster_{版本}_{架构}」，不再盖语言后缀。
 * 用法：
 *   node scripts/rename-release-assets.mjs
 *   node scripts/rename-release-assets.mjs --android
 *   node scripts/rename-release-assets.mjs --test
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { INSTALLER_STEM as BRAND } from "./brand.mjs";
import { signFileWithTauri } from "./sign-update-manifest.mjs";

export const LEGACY_MANIFEST_NAMES = ["latest-zh-CN.json", "latest-en-US.json"];
export const ANDROID_PLATFORM_KEY = "android-aarch64";
const RELEASE_REPO = "ice-juice/git-keymaster-app";

const COMPOUND_SUFFIXES = [
  ".app.tar.gz.sig",
  ".app.tar.gz",
  ".tar.gz.sig",
  ".tar.gz",
  "-setup.exe.sig",
  "-setup.exe",
  ".msi.sig",
  ".msi",
  ".dmg.sig",
  ".dmg",
  ".deb.sig",
  ".deb",
  ".rpm.sig",
  ".rpm",
  ".AppImage.sig",
  ".AppImage",
  ".exe.sig",
  ".exe",
  ".apk.sig",
  ".apk",
];

export function androidApkFilename(version) {
  if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`invalid android version: ${version}`);
  }
  return `${BRAND}_${version}_arm64-v8a.apk`;
}

export function androidReleaseTag(version, refName = process.env.GITHUB_REF_NAME) {
  const ref = String(refName || "");
  if (/^v\d/.test(ref) && ref !== "v__VERSION__") {
    return ref;
  }
  return `v${version}`;
}

export function androidReleaseDownloadUrl(tag, version) {
  const normalized = String(tag || `v${version}`).replace(/^v/, "");
  return `https://github.com/${RELEASE_REPO}/releases/download/v${normalized}/${androidApkFilename(version)}`;
}

/** 给 latest.json 写入 android-aarch64，不碰桌面 platforms。平台变了就丢掉旧 manifestSignature。 */
export function injectAndroidAarch64(text, tag, version, signature) {
  const data = text && String(text).trim() ? JSON.parse(text) : {};
  const ver = String(version || data.version || String(tag || "").replace(/^v/, "")).replace(/^v/, "");
  if (!ver || !/^\d+\.\d+\.\d+/.test(ver)) {
    throw new Error(`invalid android version for latest.json: ${ver}`);
  }
  const platforms =
    data.platforms && typeof data.platforms === "object" ? { ...data.platforms } : {};
  const existing = platforms[ANDROID_PLATFORM_KEY];
  const existingSig = existing && typeof existing.signature === "string" ? existing.signature : "";
  const nextSig =
    typeof signature === "string" && signature.trim() ? signature.replace(/\s+$/, "") : existingSig;
  platforms[ANDROID_PLATFORM_KEY] = {
    signature: nextSig,
    url: androidReleaseDownloadUrl(tag || androidReleaseTag(ver), ver),
  };
  return `${JSON.stringify(
    {
      version: data.version || ver,
      notes: data.notes || "",
      pub_date: data.pub_date || new Date().toISOString(),
      platforms,
    },
    null,
    2,
  )}\n`;
}

export function buildAndroidLatestJson(version, tag) {
  return injectAndroidAarch64("{}", tag || androidReleaseTag(version), version);
}

export function androidApkOutputRoot(cwd = process.cwd()) {
  return path.join(cwd, "app", "src-tauri", "gen", "android", "app", "build", "outputs", "apk");
}

function listApkFiles(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...listApkFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".apk")) {
      found.push(full);
    }
  }
  return found;
}

/** 没加 --split-per-abi 时 Tauri 打的是 universal；加了才是 arm64。 */
export function findSignedReleaseApk(apkRoot) {
  const preferred = [
    path.join(apkRoot, "arm64", "release", "app-arm64-release.apk"),
    path.join(apkRoot, "universal", "release", "app-universal-release.apk"),
  ];
  for (const candidate of preferred) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  const fallback = listApkFiles(apkRoot).filter((file) => {
    const name = path.basename(file);
    return name.includes("release") && !name.includes("unsigned") && name.endsWith(".apk");
  });
  if (fallback.length === 1) {
    return fallback[0];
  }
  const listing = listApkFiles(apkRoot).map((file) => path.relative(apkRoot, file));
  throw new Error(
    `missing signed APK under ${apkRoot} (looked for app-arm64-release.apk / app-universal-release.apk); found: ${
      listing.length ? listing.join(", ") : "(none)"
    }`,
  );
}

export function normalizeInstallerFilename(name) {
  if (!name || name === "latest.json" || LEGACY_MANIFEST_NAMES.includes(name)) {
    return name;
  }

  const suffix = COMPOUND_SUFFIXES.find((s) => name.endsWith(s));
  if (!suffix) {
    return name;
  }

  let stem = name.slice(0, -suffix.length);
  stem = stem.replace(/ /g, ".");
  if (stem.startsWith("-") || stem.startsWith("_") || /^\d/.test(stem)) {
    stem = `${BRAND}_${stem.replace(/^[-_]+/, "")}`;
  }
  stem = stem.replace(/^御钥师[._]?/, `${BRAND}_`);
  stem = stem.replace(/^Git\.?Keymaster\.?/i, `${BRAND}_`);
  stem = stem.replace(/_+/g, "_").replace(/_$/g, "");
  stem = stem.replace(/_(zh-CN|en-US)$/i, "");
  return `${stem}${suffix}`;
}

function rewriteFilenames(text, mapping) {
  let out = text;
  for (const [from, to] of mapping) {
    if (!from || from === to) continue;
    out = out.split(from).join(to);
  }
  return out;
}

export function latestJsonFilename(locale) {
  if (locale === "en-US") {
    return "latest-en-US.json";
  }
  if (locale === "zh-CN") {
    return "latest-zh-CN.json";
  }
  if (locale === "latest" || locale === "unified" || !locale) {
    return "latest.json";
  }
  throw new Error(`unsupported locale: ${locale}`);
}

/** 不同平台的 latest.json 按 platforms 合并；后写入的同名平台覆盖。 */
export function mergeLatestJson(existingText, incomingText) {
  const incoming = JSON.parse(incomingText);
  let existing = {};
  if (existingText && String(existingText).trim()) {
    existing = JSON.parse(existingText);
  }
  const platforms = {
    ...(existing.platforms && typeof existing.platforms === "object" ? existing.platforms : {}),
    ...(incoming.platforms && typeof incoming.platforms === "object" ? incoming.platforms : {}),
  };
  // platforms 变了，旧 manifestSignature 不再覆盖这份内容，由发版脚本重新签。
  return `${JSON.stringify(
    {
      version: incoming.version || existing.version,
      notes: incoming.notes || existing.notes,
      pub_date: incoming.pub_date || existing.pub_date,
      platforms,
    },
    null,
    2,
  )}\n`;
}

export function rewriteLatestJson(text, mapping) {
  try {
    const data = JSON.parse(text);
    if (data && typeof data === "object") {
      if (typeof data.notes === "string") {
        data.notes = rewriteFilenames(data.notes, mapping);
      }
      if (data.platforms && typeof data.platforms === "object") {
        for (const platform of Object.values(data.platforms)) {
          if (platform && typeof platform.url === "string") {
            platform.url = rewriteFilenames(platform.url, mapping);
            platform.url = platform.url.replace(/_(zh-CN|en-US)(?=(-setup)?\.(exe|msi|dmg|AppImage|deb|rpm|apk|sig)|((-setup)?\.app\.tar\.gz))/g, "");
          }
        }
      }
      return `${JSON.stringify(data, null, 2)}\n`;
    }
  } catch {
    // latest.json 以外的文本仍按文件名替换
  }
  return rewriteFilenames(text, mapping);
}

function walkFiles(dir, out = []) {
  if (!fs.existsSync(dir)) {
    return out;
  }
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walkFiles(p, out);
    } else {
      out.push(p);
    }
  }
  return out;
}

function renameBundles(roots) {
  const mapping = [];
  for (const root of roots) {
    for (const file of walkFiles(root)) {
      const base = path.basename(file);
      if (base === "latest.json" || LEGACY_MANIFEST_NAMES.includes(base)) {
        continue;
      }
      const next = normalizeInstallerFilename(base);
      if (next === base) {
        continue;
      }
      const dest = path.join(path.dirname(file), next);
      if (fs.existsSync(dest) && dest !== file) {
        fs.unlinkSync(dest);
      }
      fs.renameSync(file, dest);
      mapping.push([base, next]);
      console.log(`[rename] ${base} -> ${next}`);
    }
  }
  return mapping;
}

function patchLatestJsonFiles(cwd, mapping) {
  const candidates = [
    path.join(cwd, "latest.json"),
    path.join(cwd, "app", "src-tauri", "target", "release", "latest.json"),
    path.join(cwd, "app", "src-tauri", "target", "universal-apple-darwin", "release", "latest.json"),
  ];
  for (const file of walkFiles(path.join(cwd, "app", "src-tauri", "target"))) {
    if (path.basename(file) === "latest.json") {
      candidates.push(file);
    }
  }
  const seen = new Set();
  for (const file of candidates) {
    if (!fs.existsSync(file) || seen.has(file)) {
      continue;
    }
    seen.add(file);
    const before = fs.readFileSync(file, "utf-8");
    const after = rewriteLatestJson(before, mapping);
    if (after !== before) {
      fs.writeFileSync(file, after, "utf-8");
      console.log(`[rename] patched ${path.relative(cwd, file)}`);
    }
  }
}

function runSelfTest() {
  const cases = [
    ["Git.Keymaster_1.2.0_x64-setup.exe", "Git.Keymaster_1.2.0_x64-setup.exe"],
    ["Git.Keymaster_1.2.0_x64_en-US-setup.exe", "Git.Keymaster_1.2.0_x64-setup.exe"],
    ["Git.Keymaster_1.2.0_x64_zh-CN-setup.exe", "Git.Keymaster_1.2.0_x64-setup.exe"],
    ["Git.Keymaster_1.2.0_x64_en-US.msi", "Git.Keymaster_1.2.0_x64.msi"],
    ["Git.Keymaster_1.2.0_x64_zh-CN.msi", "Git.Keymaster_1.2.0_x64.msi"],
    ["Git Keymaster_1.2.0_x64-setup.exe.sig", "Git.Keymaster_1.2.0_x64-setup.exe.sig"],
    ["_1.2.0_amd64.AppImage", "Git.Keymaster_1.2.0_amd64.AppImage"],
    ["-1.2.0-1.x86_64.rpm", "Git.Keymaster_1.2.0-1.x86_64.rpm"],
    ["Git.Keymaster_1.2.0_amd64.deb", "Git.Keymaster_1.2.0_amd64.deb"],
    ["Git.Keymaster_1.2.0_amd64_en-US.deb", "Git.Keymaster_1.2.0_amd64.deb"],
    ["Git.Keymaster_1.2.0_universal.dmg", "Git.Keymaster_1.2.0_universal.dmg"],
    ["Git.Keymaster_1.2.0_universal_zh-CN.dmg", "Git.Keymaster_1.2.0_universal.dmg"],
    ["Git.Keymaster_universal.app.tar.gz", "Git.Keymaster_universal.app.tar.gz"],
    ["Git.Keymaster_1.2.0_universal.app.tar.gz.sig", "Git.Keymaster_1.2.0_universal.app.tar.gz.sig"],
    ["Git.Keymaster_1.2.0_universal_zh-CN.app.tar.gz.sig", "Git.Keymaster_1.2.0_universal.app.tar.gz.sig"],
    ["御钥师_1.3.0_universal.dmg", "Git.Keymaster_1.3.0_universal.dmg"],
    ["御钥师_1.3.0_x64-setup.exe", "Git.Keymaster_1.3.0_x64-setup.exe"],
    ["Git Keymaster_1.3.0_universal.dmg", "Git.Keymaster_1.3.0_universal.dmg"],
    ["app-arm64-release.apk", "app-arm64-release.apk"],
    ["latest.json", "latest.json"],
    ["latest-zh-CN.json", "latest-zh-CN.json"],
  ];
  const apkCases = [
    ["1.5.0", "Git.Keymaster_1.5.0_arm64-v8a.apk"],
    ["1.5.1", "Git.Keymaster_1.5.1_arm64-v8a.apk"],
  ];
  for (const [version, expected] of apkCases) {
    const got = androidApkFilename(version);
    if (got !== expected) {
      throw new Error(`android apk ${version} => ${got}, expected ${expected}`);
    }
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gkm-apk-"));
  try {
    const uni = path.join(tmp, "universal", "release");
    fs.mkdirSync(uni, { recursive: true });
    fs.writeFileSync(path.join(uni, "app-universal-release.apk"), "apk");
    const found = findSignedReleaseApk(tmp);
    if (path.basename(found) !== "app-universal-release.apk") {
      throw new Error(`findSignedReleaseApk should pick universal APK, got ${found}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  for (const [input, expected] of cases) {
    const got = normalizeInstallerFilename(input);
    if (got !== expected) {
      throw new Error(`normalize ${input} => ${got}, expected ${expected}`);
    }
  }
  const rewritten = rewriteLatestJson(
    "https://example/御钥师_1.2.0_x64-setup.exe",
    [["御钥师_1.2.0_x64-setup.exe", "Git.Keymaster_1.2.0_x64-setup.exe"]],
  );
  if (!rewritten.includes("Git.Keymaster_1.2.0_x64-setup.exe")) {
    throw new Error("latest.json rewrite failed");
  }
  const jsonRewritten = rewriteLatestJson(
    JSON.stringify({
      notes: "### 优化功能\n- 见 Git.Keymaster_1.2.0_x64-setup.exe",
      platforms: { win: { url: "https://example/Git.Keymaster_1.2.0_x64-setup.exe" } },
    }),
    [["Git.Keymaster_1.2.0_x64-setup.exe", "Git.Keymaster_1.2.0_x64-setup.exe"]],
  );
  const parsed = JSON.parse(jsonRewritten);
  if (!parsed.notes.startsWith("### 优化功能")) {
    throw new Error("latest.json notes heading was rewritten");
  }
  if (parsed.platforms.win.url.includes("_zh-CN") || parsed.platforms.win.url.includes("_en-US")) {
    throw new Error("unified latest.json must not keep locale suffixes");
  }
  if (latestJsonFilename("zh-CN") !== "latest-zh-CN.json" || latestJsonFilename("en-US") !== "latest-en-US.json") {
    throw new Error("legacy manifest alias names");
  }
  if (latestJsonFilename("unified") !== "latest.json") {
    throw new Error("canonical manifest must be latest.json");
  }
  const merged = JSON.parse(
    mergeLatestJson(
      JSON.stringify({
        version: "1.0.0",
        platforms: { "windows-x86_64": { url: "win.exe" }, "linux-x86_64": { url: "old.AppImage" } },
      }),
      JSON.stringify({
        version: "1.5.0",
        notes: "n",
        platforms: { "linux-x86_64": { url: "new.AppImage" } },
      }),
    ),
  );
  if (merged.version !== "1.5.0" || merged.platforms["windows-x86_64"].url !== "win.exe") {
    throw new Error("merge should keep other platforms");
  }
  if (merged.platforms["linux-x86_64"].url !== "new.AppImage") {
    throw new Error("merge should replace same platform");
  }
  const androidLatest = JSON.parse(buildAndroidLatestJson("1.5.1", "v1.5.1"));
  if (
    androidLatest.platforms[ANDROID_PLATFORM_KEY].url !==
    "https://github.com/ice-juice/git-keymaster-app/releases/download/v1.5.1/Git.Keymaster_1.5.1_arm64-v8a.apk"
  ) {
    throw new Error("android-aarch64 url");
  }
  const mergedAndroid = JSON.parse(
    mergeLatestJson(
      JSON.stringify({
        version: "1.5.0",
        platforms: { "windows-x86_64": { url: "win.exe", signature: "s" } },
      }),
      buildAndroidLatestJson("1.5.1", "v1.5.1"),
    ),
  );
  if (mergedAndroid.platforms["windows-x86_64"].url !== "win.exe") {
    throw new Error("android inject must keep desktop platforms");
  }
  if (!mergedAndroid.platforms[ANDROID_PLATFORM_KEY].url.endsWith("_arm64-v8a.apk")) {
    throw new Error("merge should add android-aarch64");
  }
  const withSig = JSON.parse(injectAndroidAarch64("{}", "v1.5.1", "1.5.1", "apk-minisign"));
  if (withSig.platforms[ANDROID_PLATFORM_KEY].signature !== "apk-minisign") {
    throw new Error("injectAndroidAarch64 must write APK minisign");
  }
  console.log("[rename] self-test ok");
}

function renameAndroidApk() {
  const cwd = process.cwd();
  const version = JSON.parse(fs.readFileSync(path.join(cwd, "app", "src-tauri", "tauri.conf.json"), "utf8")).version;
  const apkRoot = androidApkOutputRoot(cwd);
  const src = findSignedReleaseApk(apkRoot);
  const destDir = path.join(apkRoot, "arm64", "release");
  fs.mkdirSync(destDir, { recursive: true });
  const destName = androidApkFilename(version);
  const dest = path.join(destDir, destName);
  if (fs.existsSync(dest) && dest !== src) {
    fs.unlinkSync(dest);
  }
  fs.copyFileSync(src, dest);
  const apkSig = signFileWithTauri(dest);
  const mapping = [[path.basename(src), destName]];
  fs.writeFileSync(path.join(cwd, "renamed-release-assets.json"), JSON.stringify(mapping, null, 2), "utf-8");
  const tag = androidReleaseTag(version);
  const latestPath = path.join(cwd, "latest.json");
  const existing = fs.existsSync(latestPath) ? fs.readFileSync(latestPath, "utf8") : "";
  fs.writeFileSync(latestPath, injectAndroidAarch64(existing, tag, version, apkSig), "utf8");
  console.log(`[rename] ${path.relative(apkRoot, src)} -> arm64/release/${destName}`);
  console.log(`[rename] signed APK and wrote ${ANDROID_PLATFORM_KEY} into latest.json`);
  return dest;
}

function renameDesktopBundles() {
  const cwd = process.cwd();
  const roots = [
    path.join(cwd, "app", "src-tauri", "target", "release", "bundle"),
    path.join(cwd, "app", "src-tauri", "target", "universal-apple-darwin", "release", "bundle"),
  ];
  const mapping = renameBundles(roots);
  fs.writeFileSync(path.join(cwd, "renamed-release-assets.json"), JSON.stringify(mapping, null, 2), "utf-8");
  patchLatestJsonFiles(cwd, mapping);
}

const invoked = process.argv[1] && path.basename(process.argv[1]) === "rename-release-assets.mjs";
if (invoked) {
  const arg = process.argv[2];
  if (arg === "--test") {
    runSelfTest();
  } else if (arg === "--android") {
    renameAndroidApk();
  } else if (!arg || arg === "--desktop") {
    renameDesktopBundles();
  } else {
    console.error("usage: node scripts/rename-release-assets.mjs [--desktop|--android|--test]");
    process.exit(1);
  }
}
