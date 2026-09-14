/**
 * 把带语言后缀的安装包同步到 GitHub Release，并删掉未加后缀的旧文件名。
 * 用法：
 *   node scripts/sync-release-assets.mjs vX.Y.Z zh-CN|en-US
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
import { latestJsonFilename, mergeLatestJson, rewriteLatestJson } from "./rename-release-assets.mjs";

const REPO = "ice-juice/git-keymaster-app";
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

function runGh(args, { ignoreFail = false, retries = 0 } = {}) {
  let lastStatus = 1;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const result = spawnSync("gh", args, { stdio: "inherit" });
    if (result.error) {
      if (ignoreFail) {
        return 1;
      }
      throw result.error;
    }
    lastStatus = result.status ?? 1;
    if (lastStatus === 0 || ignoreFail) {
      return lastStatus;
    }
    if (attempt < retries) {
      const wait = 2000 * (attempt + 1);
      console.error(
        `[sync] gh ${args.slice(0, 2).join(" ")} exit ${lastStatus}; retry ${attempt + 1}/${retries} in ${wait}ms`,
      );
      sleepMs(wait);
    }
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
    for (const name of ["latest.json", "latest-zh-CN.json", "latest-en-US.json"]) {
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

function publishLocaleManifest(tag, locale, mapping) {
  const localPath = findLocalLatestJson();
  if (!localPath) {
    console.log("no local latest.json to merge");
    return;
  }
  const incoming = rewriteLatestJson(fs.readFileSync(localPath, "utf8"), mapping);
  const incomingData = JSON.parse(incoming);
  incomingData.notes = loadCanonicalNotes(tag.replace(/^v/, ""));
  const incomingText = `${JSON.stringify(incomingData, null, 2)}\n`;

  const localeName = latestJsonFilename(locale);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gam-latest-"));
  try {
    const existingPath = path.join(tmp, localeName);
    runGh(
      ["release", "download", tag, "--repo", REPO, "--pattern", localeName, "--dir", tmp, "--clobber"],
      { ignoreFail: true },
    );
    const existingText = fs.existsSync(existingPath) ? fs.readFileSync(existingPath, "utf8") : "";
    const merged = mergeLatestJson(existingText, incomingText);
    const outPath = path.join(tmp, localeName);
    fs.writeFileSync(outPath, merged);
    runGh(["release", "upload", tag, outPath, "--repo", REPO, "--clobber"], { retries: 4 });
    console.log(`[sync] merged ${localeName}`);

    // 旧客户端只认 latest.json。用中文清单做兼容副本，避免再被英文任务盖掉。
    if (locale === "zh-CN") {
      const legacy = path.join(tmp, "latest.json");
      fs.writeFileSync(legacy, merged);
      runGh(["release", "upload", tag, legacy, "--repo", REPO, "--clobber"], { retries: 4 });
      console.log("[sync] copied latest-zh-CN.json -> latest.json for old clients");
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function syncTag(tag, locale) {
  if (!tag || tag === "v__VERSION__") {
    console.log("skip release asset sync (no real tag)");
    return;
  }
  if (!locale || !["zh-CN", "en-US"].includes(locale)) {
    console.error("usage: node scripts/sync-release-assets.mjs vX.Y.Z zh-CN|en-US");
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

  publishLocaleManifest(tag, locale, mapping);

  for (const [oldName, newName] of mapping) {
    if (oldName && oldName !== newName) {
      runGh(["release", "delete-asset", tag, oldName, "--repo", REPO, "--yes"], { ignoreFail: true });
    }
  }
}

function pinLegacyLatest(tag) {
  if (!tag || !/^v\d/.test(tag)) {
    console.error("usage: node scripts/sync-release-assets.mjs --pin-legacy vX.Y.Z");
    process.exit(1);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gam-pin-"));
  try {
    const zhName = latestJsonFilename("zh-CN");
    const downloaded = runGh(
      ["release", "download", tag, "--repo", REPO, "--pattern", zhName, "--dir", tmp, "--clobber"],
      { ignoreFail: true },
    );
    const zhPath = path.join(tmp, zhName);
    if (downloaded !== 0 || !fs.existsSync(zhPath)) {
      console.error(`[sync] missing ${zhName}, cannot pin latest.json`);
      process.exit(1);
    }
    const legacy = path.join(tmp, "latest.json");
    fs.copyFileSync(zhPath, legacy);
    runGh(["release", "upload", tag, legacy, "--repo", REPO, "--clobber"], { retries: 4 });
    console.log(`[sync] pinned latest.json to ${zhName}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function runSelfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sync-assets-test-"));
  try {
    const bundle = path.join(tmp, "app/src-tauri/target/release/bundle/nsis");
    fs.mkdirSync(bundle, { recursive: true });
    const locale = "Git.Keymaster_1.3.0_x64_en-US-setup.exe";
    const extra = "Git.Keymaster_1.3.0_x64-setup.exe";
    fs.writeFileSync(path.join(bundle, locale), "a");
    fs.writeFileSync(path.join(bundle, extra), "b");
    const nested = path.join(tmp, "app/src-tauri/target/release/bundle/copy");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, locale), "dup");
    const uploads = collectUniqueUploads(
      [["Git.Keymaster_1.3.0_x64-setup.exe", locale]],
      tmp,
    );
    if (uploads.length !== 1 || path.basename(uploads[0]) !== locale) {
      throw new Error(`expected one unique locale file, got ${JSON.stringify(uploads)}`);
    }
    if (listInstallerBundles(tmp).length < 2) {
      throw new Error("expected installer files under bundle/");
    }
    const notes = loadCanonicalNotes("1.3.0");
    const headings = [...notes.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
    if (headings.join(",") !== "新增功能,优化功能,修复问题,下载建议") {
      throw new Error(`canonical notes headings: ${headings.join(",")}`);
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
  } else {
    syncTag(arg, process.argv[3]);
  }
}
