/**
 * iOS 真机启动时，wry 会 NSBundle::bundleWithIdentifier("com.apple.WebKit")，
 * 在 __CFBundleCopyFrameworkURLForExecutablePath 里对空指针 CFRelease（tauri#14675）。
 *
 * 本脚本把 crates.io 的 wry 拷到 app/src-tauri/vendor/wry，给 platform_webview_version
 * 加上 iOS 早返回，并写入 [patch.crates-io]。只应在 iOS 构建前跑；不要把 vendor 入库。
 *
 *   node scripts/patch-wry-ios.mjs
 *   node scripts/patch-wry-ios.mjs --test
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), "..");
const tauriDir = path.join(rootDir, "app/src-tauri");
const vendorDir = path.join(tauriDir, "vendor/wry");
const PATCH_MARK = "# --- ios-wry-patch ---";

export function patchWkwebviewMod(src) {
  if (src.includes("skip WebKit bundle lookup on iOS")) {
    return { text: src, changed: false };
  }
  const re = /pub fn platform_webview_version\(\)[^{]*\{/;
  if (!re.test(src)) {
    throw new Error("wry 源码里找不到 platform_webview_version");
  }
  const text = src.replace(
    re,
    (m) => `${m}
  // skip WebKit bundle lookup on iOS — NSBundle::bundleWithIdentifier("com.apple.WebKit")
  // trips CFRelease(NULL) in __CFBundleCopyFrameworkURLForExecutablePath (tauri#14675).
  #[cfg(target_os = "ios")]
  {
    return Ok("ios".into());
  }
  #[cfg(not(target_os = "ios"))]
`,
  );
  return { text, changed: true };
}

function wryVersionFromLock() {
  const lock = fs.readFileSync(path.join(tauriDir, "Cargo.lock"), "utf8");
  const m = lock.match(/name = "wry"\r?\nversion = "([^"]+)"/);
  if (!m) {
    throw new Error("Cargo.lock 里没有 wry");
  }
  return m[1];
}

function findRegistryWry(version) {
  const cargoHome = process.env.CARGO_HOME || path.join(os.homedir(), ".cargo");
  const srcRoot = path.join(cargoHome, "registry", "src");
  if (!fs.existsSync(srcRoot)) {
    return "";
  }
  const want = `wry-${version}`;
  const stacks = [srcRoot];
  while (stacks.length) {
    const dir = stacks.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      if (e.name === want && fs.existsSync(path.join(full, "src"))) {
        return full;
      }
      if (dir === srcRoot || path.relative(srcRoot, full).split(path.sep).length < 3) {
        stacks.push(full);
      }
    }
  }
  return "";
}

function cargoFetch() {
  const r = spawnSync("cargo", ["fetch", "--manifest-path", path.join(tauriDir, "Cargo.toml")], {
    stdio: "inherit",
  });
  if (r.status !== 0) {
    throw new Error("cargo fetch 失败，无法取出 wry 源码");
  }
}

function ensureCargoPatch() {
  const cargoToml = path.join(tauriDir, "Cargo.toml");
  const text = fs.readFileSync(cargoToml, "utf8");
  if (text.includes(PATCH_MARK)) {
    return;
  }
  fs.appendFileSync(
    cargoToml,
    `\n${PATCH_MARK}\n[patch.crates-io]\nwry = { path = "vendor/wry" }\n`,
  );
}

function apply() {
  const version = wryVersionFromLock();
  cargoFetch();
  const src = findRegistryWry(version);
  if (!src) {
    throw new Error(`cargo registry 里找不到 wry-${version}`);
  }
  fs.rmSync(vendorDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(vendorDir), { recursive: true });
  fs.cpSync(src, vendorDir, { recursive: true });
  const modPath = path.join(vendorDir, "src/wkwebview/mod.rs");
  if (!fs.existsSync(modPath)) {
    throw new Error(`vendor/wry 缺少 ${modPath}`);
  }
  const { text, changed } = patchWkwebviewMod(fs.readFileSync(modPath, "utf8"));
  fs.writeFileSync(modPath, text);
  ensureCargoPatch();
  console.log(`[patch-wry-ios] wry ${version} -> vendor/wry (${changed ? "patched" : "already patched"})`);
}

function selfTest() {
  const sample = `pub fn platform_webview_version() -> Result {
  unsafe {
    let Some(bundle) = NSBundle::bundleWithIdentifier(ns_string!("com.apple.WebKit")) else {
      return Err(Error::Io(std::io::Error::other("missing")));
    };
  }
}
`;
  const once = patchWkwebviewMod(sample);
  if (!once.changed || !once.text.includes("skip WebKit bundle lookup on iOS")) {
    throw new Error("第一次补丁没写上 iOS 早返回");
  }
  if (!once.text.includes('#[cfg(not(target_os = "ios"))]')) {
    throw new Error("WebKit 查询必须编出 iOS");
  }
  const twice = patchWkwebviewMod(once.text);
  if (twice.changed) {
    throw new Error("补丁必须幂等");
  }
  console.log("[patch-wry-ios] self-test ok");
}

const invoked = process.argv[1] && path.basename(process.argv[1]) === "patch-wry-ios.mjs";
if (invoked) {
  try {
    if (process.argv[2] === "--test") {
      selfTest();
    } else {
      apply();
    }
  } catch (err) {
    console.error(`[patch-wry-ios] ${err.message}`);
    process.exit(1);
  }
}
