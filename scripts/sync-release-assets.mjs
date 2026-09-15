/**
 * 把规范化后的安装包同步到 GitHub Release，并按平台合并唯一的 latest.json。
 * 用法：
 *   node scripts/sync-release-assets.mjs vX.Y.Z
 *   node scripts/sync-release-assets.mjs --merge-android vX.Y.Z
 *   node scripts/sync-release-assets.mjs --fix-notes vX.Y.Z
 *   node scripts/sync-release-assets.mjs --pin-legacy vX.Y.Z
 *   node scripts/sync-release-assets.mjs --require-bundles
 *   node scripts/sync-release-assets.mjs --test
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildReleaseNotes } from "./build-release-notes.mjs";
import {
  ANDROID_PLATFORM_KEY,
  LEGACY_MANIFEST_NAMES,
  androidApkFilename,
  buildAndroidLatestJson,
  injectAndroidAarch64,
  mergeLatestJson,
  rewriteLatestJson,
} from "./rename-release-assets.mjs";
import { signLatestJsonFile } from "./sign-update-manifest.mjs";

const REPO = "ice-juice/git-keymaster-app";
export const REQUIRED_DESKTOP_PLATFORM_KEYS = [
  "windows-x86_64",
  "darwin-aarch64",
  "darwin-x86_64",
  "linux-x86_64",
];
const BUNDLE_ROOTS = [
  "app/src-tauri/target/release/bundle",
  "app/src-tauri/target/universal-apple-darwin/release/bundle",
];
const INSTALLER_SUFFIXES = [
  ".app.tar.gz",
  ".dmg",
  "-setup.exe",
  ".msi",
  ".deb",
  ".rpm",
  ".AppImage",
];

export function walkFiles(dir, out = []) {
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

export function collectUniqueUploads(mapping, cwd = process.cwd()) {
  const names = new Set(mapping.map(([, to]) => to));
  for (const to of [...names]) {
    if (!to.endsWith(".sig")) {
      names.add(`${to}.sig`);
    }
  }
  const byBasename = new Map();
  for (const root of BUNDLE_ROOTS) {
    for (const file of walkFiles(path.join(cwd, root))) {
      const base = path.basename(file);
      if (names.has(base)) {
        byBasename.set(base, file);
      }
    }
  }
  return [...byBasename.values()];
}

export function findLocalLatestJson(cwd = process.cwd()) {
  const candidates = [
    path.join(cwd, "latest.json"),
    path.join(cwd, "app", "src-tauri", "target", "release", "latest.json"),
    path.join(cwd, "app", "src-tauri", "target", "universal-apple-darwin", "release", "latest.json"),
  ];
  for (const file of walkFiles(path.join(cwd, "app/src-tauri/target"))) {
    if (path.basename(file) === "latest.json") {
      candidates.push(file);
    }
  }
  return candidates.find((file) => fs.existsSync(file)) ?? null;
}

export function listInstallerBundles(cwd = process.cwd()) {
  return BUNDLE_ROOTS.flatMap((root) => walkFiles(path.join(cwd, root))).filter((file) =>
    INSTALLER_SUFFIXES.some((suffix) => file.endsWith(suffix) && !file.endsWith(`${suffix}.sig`)),
  );
}

function loadCanonicalNotes(version) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  return buildReleaseNotes(version, {
    changelog: fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"),
    guide: fs.readFileSync(path.join(root, "docs/release-download-guide.md"), "utf8"),
  }).replace(/\s+$/, "\n");
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function parseManifestText(text) {
  if (!text || !String(text).trim()) {
    return { platforms: {} };
  }
  const data = JSON.parse(text);
  if (!data || typeof data !== "object") {
    return { platforms: {} };
  }
  return data;
}

export function missingDesktopPlatforms(platforms) {
  const keys = platforms && typeof platforms === "object" ? Object.keys(platforms) : [];
  return REQUIRED_DESKTOP_PLATFORM_KEYS.filter((key) => !keys.includes(key));
}

export function evaluateManifestUpload({ existingText, incomingText, mergedText, downloaded }) {
  const incoming = parseManifestText(incomingText);
  const existing = parseManifestText(existingText);
  const merged = parseManifestText(mergedText);
  const incomingMissing = missingDesktopPlatforms(incoming.platforms);
  if (!downloaded) {
    if (incomingMissing.length > 0) {
      return {
        ok: false,
        reason: `refusing to upload: latest.json download failed and incoming lacks desktop platforms (${incomingMissing.join(", ")})`,
      };
    }
  }
  const existingDesktop = Object.keys(existing.platforms || {}).filter(
    (key) => REQUIRED_DESKTOP_PLATFORM_KEYS.includes(key) || key.startsWith("darwin-"),
  );
  const dropped = existingDesktop.filter((key) => !(merged.platforms && merged.platforms[key]));
  if (dropped.length > 0) {
    return {
      ok: false,
      reason: `refusing to upload: merge dropped existing desktop platforms (${dropped.join(", ")})`,
    };
  }
  return { ok: true };
}

export function evaluatePinCanonical(text) {
  const missing = missingDesktopPlatforms(parseManifestText(text).platforms);
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `refusing to pin: latest.json missing desktop platforms (${missing.join(", ")})`,
    };
  }
  return { ok: true };
}

export function pickUpdaterAsset(names, kind) {
  const list = (names || []).filter((name) => name && !name.startsWith("_") && !name.startsWith("-"));
  if (kind === "windows") {
    return list.find((name) => name.endsWith("_x64-setup.exe") && name.startsWith("Git.Keymaster_")) ?? null;
  }
  if (kind === "linux") {
    return list.find((name) => name.endsWith(".AppImage") && name.startsWith("Git.Keymaster_")) ?? null;
  }
  if (kind === "darwin") {
    return (
      list.find((name) => name.endsWith(".app.tar.gz") && name.includes("universal") && name.startsWith("Git.Keymaster_")) ??
      list.find((name) => name === "Git.Keymaster.app.tar.gz") ??
      list.find((name) => name.endsWith(".app.tar.gz") && name.startsWith("Git.Keymaster_")) ??
      null
    );
  }
  throw new Error(`unknown updater asset kind: ${kind}`);
}

export function rebuildDesktopPlatforms(tag, manifestText, names, readSignature) {
  const data = parseManifestText(manifestText);
  const platforms = { ...(data.platforms && typeof data.platforms === "object" ? data.platforms : {}) };
  const base = `https://github.com/${REPO}/releases/download/${tag}`;
  const assignments = [
    { keys: ["windows-x86_64"], filename: pickUpdaterAsset(names, "windows") },
    { keys: ["linux-x86_64"], filename: pickUpdaterAsset(names, "linux") },
    { keys: ["darwin-aarch64", "darwin-x86_64", "darwin-universal"], filename: pickUpdaterAsset(names, "darwin") },
  ];
  for (const { keys, filename } of assignments) {
    if (!filename) {
      continue;
    }
    const sigName = `${filename}.sig`;
    if (!names.includes(sigName)) {
      continue;
    }
    const signature = String(readSignature(sigName) || "").replace(/\s+$/, "");
    if (!signature) {
      continue;
    }
    for (const key of keys) {
      platforms[key] = { signature, url: `${base}/${filename}` };
    }
  }
  return `${JSON.stringify(
    {
      version: data.version,
      notes: data.notes || "",
      pub_date: data.pub_date,
      platforms,
    },
    null,
    2,
  )}\n`;
}

function runGh(args, { ignoreFail = false, retries = 0 } = {}) {
  let lastStatus = 1;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const result = spawnSync("gh", args, { stdio: "inherit" });
    if (result.error) {
      lastStatus = 1;
      if (attempt >= retries) {
        if (ignoreFail) {
          return 1;
        }
        throw result.error;
      }
    } else {
      lastStatus = result.status ?? 1;
      if (lastStatus === 0) {
        return 0;
      }
      if (attempt >= retries) {
        break;
      }
    }
    const wait = 2000 * (attempt + 1);
    console.error(
      `[sync] gh ${args.slice(0, 2).join(" ")} exit ${lastStatus}; retry ${attempt + 1}/${retries} in ${wait}ms`,
    );
    sleepMs(wait);
  }
  if (ignoreFail) {
    return lastStatus;
  }
  process.exit(lastStatus);
}

function rewriteNotesFile(file, notes) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.notes = notes;
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function fixPublishedNotes(tag) {
  if (!tag || !/^v\d/.test(tag)) {
    console.error("usage: node scripts/sync-release-assets.mjs --fix-notes vX.Y.Z");
    process.exit(1);
  }
  const notes = loadCanonicalNotes(tag.replace(/^v/, ""));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gam-latest-"));
  try {
    for (const name of ["latest.json", ...LEGACY_MANIFEST_NAMES]) {
      const downloaded = runGh(
        ["release", "download", tag, "--repo", REPO, "--pattern", name, "--dir", tmp, "--clobber"],
        { ignoreFail: true },
      );
      const latestPath = path.join(tmp, name);
      if (downloaded !== 0 || !fs.existsSync(latestPath)) {
        continue;
      }
      rewriteNotesFile(latestPath, notes);
      runGh(["release", "upload", tag, latestPath, "--repo", REPO, "--clobber"], { retries: 4 });
      console.log(`[sync] restored notes headings for ${tag} ${name}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function requireBundles() {
  const files = listInstallerBundles();
  if (files.length === 0) {
    console.error("tauri-action produced no installers");
    process.exit(1);
  }
  for (const file of files) {
    console.log(`[bundle] ${path.relative(process.cwd(), file)}`);
  }
}

function publishUnifiedManifest(tag, mapping) {
  const localPath = findLocalLatestJson();
  if (!localPath) {
    console.log("no local latest.json to merge");
    return;
  }
  const incoming = rewriteLatestJson(fs.readFileSync(localPath, "utf8"), mapping);
  const incomingData = JSON.parse(incoming);
  incomingData.notes = loadCanonicalNotes(tag.replace(/^v/, ""));
  const incomingText = `${JSON.stringify(incomingData, null, 2)}\n`;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gam-latest-"));
  try {
    const existingPath = path.join(tmp, "latest.json");
    const downloadedPath = downloadReleaseFile(tag, "latest.json", tmp);
    const downloaded = Boolean(downloadedPath);
    const existingText = downloaded ? fs.readFileSync(downloadedPath, "utf8") : "";
    const merged = injectAndroidAarch64(mergeLatestJson(existingText, incomingText), tag);
    const verdict = evaluateManifestUpload({
      existingText,
      incomingText,
      mergedText: merged,
      downloaded,
    });
    if (!verdict.ok) {
      console.error(`[sync] ${verdict.reason}`);
      process.exit(1);
    }
    fs.writeFileSync(existingPath, merged);
    signLatestJsonFile(existingPath);
    runGh(["release", "upload", tag, existingPath, "--repo", REPO, "--clobber"], { retries: 4 });
    console.log("[sync] merged and signed latest.json");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function mergeAndroidManifest(tag) {
  if (!tag || tag === "v__VERSION__") {
    console.log("skip android latest.json merge (no real tag)");
    return;
  }
  if (!/^v\d/.test(tag)) {
    console.error("usage: node scripts/sync-release-assets.mjs --merge-android vX.Y.Z");
    process.exit(1);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gam-android-latest-"));
  try {
    const downloadedPath = downloadReleaseFile(tag, "latest.json", tmp);
    if (!downloadedPath) {
      console.error("[sync] --merge-android requires existing latest.json; download failed, not clobbering");
      process.exit(1);
    }
    const existingText = fs.readFileSync(downloadedPath, "utf8");
    const version = tag.replace(/^v/, "");
    const incomingText = buildAndroidLatestJson(version, tag);
    const apkSig = readAndroidApkSignature(tag, version, tmp);
    const merged = injectAndroidAarch64(existingText, tag, version, apkSig);
    const verdict = evaluateManifestUpload({
      existingText,
      incomingText,
      mergedText: merged,
      downloaded: true,
    });
    if (!verdict.ok) {
      console.error(`[sync] ${verdict.reason}`);
      process.exit(1);
    }
    if (!JSON.parse(merged).platforms?.[ANDROID_PLATFORM_KEY]?.signature) {
      console.error("[sync] android-aarch64 缺少 minisign，拒绝写入 latest.json");
      process.exit(1);
    }
    fs.writeFileSync(downloadedPath, merged);
    signLatestJsonFile(downloadedPath);
    runGh(["release", "upload", tag, downloadedPath, "--repo", REPO, "--clobber"], { retries: 4 });
    console.log(`[sync] injected signed ${ANDROID_PLATFORM_KEY} into latest.json`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function syncTag(tag) {
  if (!tag || tag === "v__VERSION__") {
    console.log("skip release asset sync (no real tag)");
    return;
  }
  if (!/^v\d/.test(tag)) {
    console.error("usage: node scripts/sync-release-assets.mjs vX.Y.Z");
    process.exit(1);
  }

  const mappingPath = path.join(process.cwd(), "renamed-release-assets.json");
  if (!fs.existsSync(mappingPath)) {
    console.log("no renamed-release-assets.json, nothing to sync");
    return;
  }

  const mapping = JSON.parse(fs.readFileSync(mappingPath, "utf8"));
  if (!Array.isArray(mapping) || mapping.length === 0) {
    console.log("rename mapping empty");
    return;
  }

  const uploads = collectUniqueUploads(mapping);
  if (uploads.length > 0) {
    for (const file of uploads) {
      console.log(`[upload] ${path.basename(file)}`);
    }
    runGh(["release", "upload", tag, ...uploads, "--repo", REPO, "--clobber"], { retries: 4 });
  }

  publishUnifiedManifest(tag, mapping);

  for (const [oldName, newName] of mapping) {
    if (oldName && oldName !== newName) {
      runGh(["release", "delete-asset", tag, oldName, "--repo", REPO, "--yes"], { ignoreFail: true });
    }
  }
}

function readAndroidApkSignature(tag, version, tmp) {
  const name = `${androidApkFilename(version)}.sig`;
  const localCandidates = [
    path.join(
      process.cwd(),
      "app",
      "src-tauri",
      "gen",
      "android",
      "app",
      "build",
      "outputs",
      "apk",
      "arm64",
      "release",
      name,
    ),
    path.join(process.cwd(), name),
  ];
  for (const file of localCandidates) {
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, "utf8").replace(/\s+$/, "");
      if (text) {
        return text;
      }
    }
  }
  const downloaded = downloadReleaseFile(tag, name, tmp);
  if (downloaded && fs.existsSync(downloaded)) {
    return fs.readFileSync(downloaded, "utf8").replace(/\s+$/, "");
  }
  return "";
}

function downloadReleaseFile(tag, name, dir) {
  const dest = path.join(dir, name);
  const attempts = [
    ["release", "download", tag, name, "--repo", REPO, "--dir", dir, "--clobber"],
    ["release", "download", tag, "--repo", REPO, "--pattern", name, "--dir", dir, "--clobber"],
  ];
  for (const args of attempts) {
    const status = runGh(args, { ignoreFail: true, retries: 4 });
    if (status === 0 && fs.existsSync(dest)) {
      return dest;
    }
  }
  return null;
}

function listReleaseAssetNames(tag) {
  const result = spawnSync(
    "gh",
    ["release", "view", tag, "--repo", REPO, "--json", "assets", "--jq", ".assets[].name"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    return [];
  }
  return String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function writeLegacyManifestAliases(canonicalText, dir) {
  const written = [];
  for (const name of LEGACY_MANIFEST_NAMES) {
    const dest = path.join(dir, name);
    fs.writeFileSync(dest, canonicalText);
    written.push(dest);
  }
  return written;
}

function pinLegacyLatest(tag) {
  if (!tag || !/^v\d/.test(tag)) {
    console.error("usage: node scripts/sync-release-assets.mjs --pin-legacy vX.Y.Z");
    process.exit(1);
  }
  runGh(["release", "view", tag, "--repo", REPO], { ignoreFail: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gam-pin-"));
  try {
    const source = downloadReleaseFile(tag, "latest.json", tmp);
    if (!source) {
      console.error("[sync] missing latest.json; cannot copy legacy aliases");
      process.exit(1);
    }
    const version = tag.replace(/^v/, "");
    const apkSig = readAndroidApkSignature(tag, version, tmp);
    let pinned = injectAndroidAarch64(fs.readFileSync(source, "utf8"), tag, version, apkSig);
    let verdict = evaluatePinCanonical(pinned);
    if (!verdict.ok) {
      const names = listReleaseAssetNames(tag);
      pinned = rebuildDesktopPlatforms(tag, pinned, names, (sigName) => {
        const sigPath = downloadReleaseFile(tag, sigName, tmp);
        return sigPath ? fs.readFileSync(sigPath, "utf8") : "";
      });
      pinned = injectAndroidAarch64(pinned, tag, version, apkSig);
      verdict = evaluatePinCanonical(pinned);
    }
    if (!verdict.ok) {
      console.error(`[sync] ${verdict.reason}`);
      process.exit(1);
    }
    if (!JSON.parse(pinned).platforms?.[ANDROID_PLATFORM_KEY]?.signature) {
      console.error("[sync] pin 时 android-aarch64 缺少 minisign");
      process.exit(1);
    }
    fs.writeFileSync(source, pinned);
    const signed = signLatestJsonFile(source);
    runGh(["release", "upload", tag, source, "--repo", REPO, "--clobber"], { retries: 4 });
    const aliases = writeLegacyManifestAliases(signed, tmp);
    for (const file of aliases) {
      runGh(["release", "upload", tag, file, "--repo", REPO, "--clobber"], { retries: 4 });
      console.log(`[sync] copied latest.json -> ${path.basename(file)} (byte-identical alias)`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function runSelfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sync-assets-test-"));
  try {
    const bundle = path.join(tmp, "app/src-tauri/target/release/bundle/nsis");
    fs.mkdirSync(bundle, { recursive: true });
    const unified = "Git.Keymaster_1.3.0_x64-setup.exe";
    const extra = "御钥师_1.3.0_x64-setup.exe";
    fs.writeFileSync(path.join(bundle, unified), "a");
    fs.writeFileSync(path.join(bundle, extra), "b");
    const nested = path.join(tmp, "app/src-tauri/target/release/bundle/copy");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, unified), "dup");
    const uploads = collectUniqueUploads(
      [["御钥师_1.3.0_x64-setup.exe", unified]],
      tmp,
    );
    if (uploads.length !== 1 || path.basename(uploads[0]) !== unified) {
      throw new Error(`expected one unique installer, got ${JSON.stringify(uploads)}`);
    }
    if (listInstallerBundles(tmp).length < 2) {
      throw new Error("expected installer files under bundle/");
    }
    const notes = loadCanonicalNotes("1.3.0");
    const headings = [...notes.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
    if (headings.join(",") !== "新增功能,优化功能,修复问题,下载建议") {
      throw new Error(`canonical notes headings: ${headings.join(",")}`);
    }
    const aliasDir = path.join(tmp, "aliases");
    fs.mkdirSync(aliasDir, { recursive: true });
    const body = '{"version":"1.5.1","platforms":{}}\n';
    const aliases = writeLegacyManifestAliases(body, aliasDir);
    if (aliases.length !== 2) {
      throw new Error("expected two legacy aliases");
    }
    for (const file of aliases) {
      if (fs.readFileSync(file, "utf8") !== body) {
        throw new Error(`${path.basename(file)} must be byte-identical to latest.json`);
      }
    }
    const injected = JSON.parse(injectAndroidAarch64(body, "v1.5.1", "1.5.1", "apk-sig"));
    if (!injected.platforms[ANDROID_PLATFORM_KEY]?.url.endsWith("Git.Keymaster_1.5.1_arm64-v8a.apk")) {
      throw new Error("pin/sync must inject android-aarch64 into latest.json");
    }
    if (injected.platforms[ANDROID_PLATFORM_KEY].signature !== "apk-sig") {
      throw new Error("pin/sync must write android-aarch64 minisign");
    }
    fs.writeFileSync(path.join(bundle, `${unified}.sig`), "sig");
    const uploadsWithSig = collectUniqueUploads([["御钥师_1.3.0_x64-setup.exe", unified]], tmp);
    if (!uploadsWithSig.some((file) => path.basename(file) === `${unified}.sig`)) {
      throw new Error("collectUniqueUploads must also pick sibling .sig files");
    }
    const androidOnly = `${JSON.stringify({
      version: "1.7.0",
      notes: "n",
      platforms: { [ANDROID_PLATFORM_KEY]: { signature: "", url: "apk" } },
    }, null, 2)}\n`;
    const desktop = `${JSON.stringify({
      version: "1.7.0",
      notes: "n",
      platforms: {
        "windows-x86_64": { signature: "s", url: "win.exe" },
        "darwin-aarch64": { signature: "s", url: "mac.app.tar.gz" },
        "darwin-x86_64": { signature: "s", url: "mac.app.tar.gz" },
        "linux-x86_64": { signature: "s", url: "app.AppImage" },
      },
    }, null, 2)}\n`;
    const downloadFail = evaluateManifestUpload({
      existingText: "",
      incomingText: androidOnly,
      mergedText: androidOnly,
      downloaded: false,
    });
    if (downloadFail.ok) {
      throw new Error("android-only incoming + download fail must not clobber latest.json");
    }
    const dropped = evaluateManifestUpload({
      existingText: desktop,
      incomingText: androidOnly,
      mergedText: androidOnly,
      downloaded: true,
    });
    if (dropped.ok) {
      throw new Error("merge must not upload if existing desktop platforms were dropped");
    }
    const androidInjected = injectAndroidAarch64(desktop, "v1.7.0");
    const androidMerge = evaluateManifestUpload({
      existingText: desktop,
      incomingText: androidOnly,
      mergedText: androidInjected,
      downloaded: true,
    });
    if (!androidMerge.ok) {
      throw new Error(`--merge-android should keep desktop platforms: ${androidMerge.reason}`);
    }
    const pinBad = evaluatePinCanonical(androidOnly);
    if (pinBad.ok) {
      throw new Error("pin must reject latest.json without desktop platforms");
    }
    const pinOk = evaluatePinCanonical(androidInjected);
    if (!pinOk.ok) {
      throw new Error(`pin should accept complete desktop platforms: ${pinOk.reason}`);
    }
    const rebuilt = JSON.parse(
      rebuildDesktopPlatforms(
        "v1.7.0",
        androidOnly,
        [
          "Git.Keymaster_1.7.0_x64-setup.exe",
          "Git.Keymaster_1.7.0_x64-setup.exe.sig",
          "Git.Keymaster.app.tar.gz",
          "Git.Keymaster.app.tar.gz.sig",
          "Git.Keymaster_1.7.0_amd64.AppImage",
          "Git.Keymaster_1.7.0_amd64.AppImage.sig",
        ],
        (name) => `sig-for-${name}`,
      ),
    );
    if (
      rebuilt.platforms["windows-x86_64"]?.url !==
        "https://github.com/ice-juice/git-keymaster-app/releases/download/v1.7.0/Git.Keymaster_1.7.0_x64-setup.exe" ||
      rebuilt.platforms["windows-x86_64"]?.signature !== "sig-for-Git.Keymaster_1.7.0_x64-setup.exe.sig" ||
      rebuilt.platforms["darwin-aarch64"]?.url !==
        "https://github.com/ice-juice/git-keymaster-app/releases/download/v1.7.0/Git.Keymaster.app.tar.gz" ||
      rebuilt.platforms["darwin-x86_64"]?.url !== rebuilt.platforms["darwin-aarch64"]?.url ||
      rebuilt.platforms["linux-x86_64"]?.url !==
        "https://github.com/ice-juice/git-keymaster-app/releases/download/v1.7.0/Git.Keymaster_1.7.0_amd64.AppImage"
    ) {
      throw new Error("rebuildDesktopPlatforms should restore desktop keys from .sig + installer names");
    }
    console.log("[sync] self-test ok");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const invoked = process.argv[1] && path.basename(process.argv[1]) === "sync-release-assets.mjs";
if (invoked) {
  const arg = process.argv[2];
  if (arg === "--test") {
    runSelfTest();
  } else if (arg === "--require-bundles") {
    requireBundles();
  } else if (arg === "--fix-notes") {
    fixPublishedNotes(process.argv[3]);
  } else if (arg === "--pin-legacy") {
    pinLegacyLatest(process.argv[3]);
  } else if (arg === "--merge-android") {
    mergeAndroidManifest(process.argv[3]);
  } else {
    syncTag(arg);
  }
}
