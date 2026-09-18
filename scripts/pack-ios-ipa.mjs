/**
 * 把未签名的 iOS .app 打成 Payload zip（.ipa），供 NB 助手重签。
 *
 * 用法：node scripts/pack-ios-ipa.mjs
 *
 * Windows 本机出不了 iOS 包。请在 macOS CI（release.yml 的 ios job）跑本脚本。
 *
 * 真机装机（需用户自己的 iPhone + NB 助手，本脚本不代做；当前 blocked）：
 * 1. 电脑装 iTunes 驱动 + NB 助手桌面版，数据线连 iPhone 并信任。
 * 2. 手机 NB 助手「证书」导入 Apple ID，生成免费签名证书（7 天，最多 3 个 app）。
 * 3. 从 CI artifact 下载 御钥师_x.y.z.ipa，传到手机「文件」，NB 助手「应用」导入后签名安装。
 * 4. 首次打开：设置 → 通用 → VPN 与设备管理，信任开发者。
 * 5. 验收：建库/解锁、Face ID、账号/PAT/TOTP/SSH 密钥复制、笔记/文件、S3、后台遮罩；
 *    确认克隆 / ssh-agent / 实时扫码 / 打开本地目录入口已隐藏。到期用 NB 助手续签。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { IOS_BUNDLE_EXEC, ZH_DISPLAY_NAME } from "./brand.mjs";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), "..");

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, rel), "utf-8"));
}

function version() {
  const tauri = readJson("app/src-tauri/tauri.conf.json");
  const v = String(tauri.version || "").trim();
  if (!/^\d+\.\d+\.\d+/.test(v)) {
    throw new Error(`tauri.conf.json version 无效：${v}`);
  }
  return v;
}

function walkApps(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name.endsWith(".app")) {
        out.push(full);
        continue;
      }
      if (e.name === "Pods" || e.name === "node_modules" || e.name === ".git") continue;
      walkApps(full, out);
    }
  }
  return out;
}

function pickApp() {
  const roots = [
    path.join(rootDir, "app/src-tauri/gen/apple"),
    path.join(rootDir, "app/src-tauri/target"),
  ];
  const apps = roots.flatMap((dir) => walkApps(dir));
  const preferred = apps.filter((p) => /iphoneos|Release|arm64/i.test(p) && !/iphonesimulator|Debug/i.test(p));
  const pool = preferred.length ? preferred : apps.filter((p) => !/iphonesimulator/i.test(p));
  if (pool.length === 0) {
    throw new Error("找不到未签名的 .app（先在 macOS 上跑 npx tauri ios build）");
  }
  pool.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return pool[0];
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} 失败：${(r.stderr || r.stdout || "").trim()}`);
  }
  return (r.stdout || "").trim();
}

function guessExecutable(appDir) {
  const skip = new Set([
    "Info.plist",
    "PkgInfo",
    "embedded.mobileprovision",
    "Assets.car",
  ]);
  const names = fs.readdirSync(appDir);
  const bins = names.filter((name) => {
    if (skip.has(name) || name.endsWith(".png") || name.endsWith(".plist")) return false;
    const full = path.join(appDir, name);
    return fs.statSync(full).isFile();
  });
  if (bins.includes(IOS_BUNDLE_EXEC)) return IOS_BUNDLE_EXEC;
  if (bins.length === 1) return bins[0];
  throw new Error(`无法判断 .app 内可执行文件：${bins.join(", ") || "(空)"}`);
}

/**
 * 显示名保持「御钥师」，包内 Mach-O / .app 目录改成 ASCII GitKeymaster。
 * 中文可执行路径会让 CFBundle 在查 WebKit 时 CFRelease(NULL)。
 */
export function normalizeIosAppBundle(appDir, { usePlutil = process.platform === "darwin" } = {}) {
  const plist = path.join(appDir, "Info.plist");
  if (!fs.existsSync(plist)) {
    throw new Error("Info.plist 不存在");
  }

  let execName = "";
  if (usePlutil) {
    execName = run("plutil", ["-extract", "CFBundleExecutable", "raw", "-o", "-", plist]);
  }
  if (!execName) {
    execName = guessExecutable(appDir);
  }

  const oldBin = path.join(appDir, execName);
  const newBin = path.join(appDir, IOS_BUNDLE_EXEC);
  if (execName !== IOS_BUNDLE_EXEC) {
    if (!fs.existsSync(oldBin)) {
      throw new Error(`找不到可执行文件 ${execName}`);
    }
    if (fs.existsSync(newBin)) fs.rmSync(newBin);
    fs.renameSync(oldBin, newBin);
  }

  if (usePlutil) {
    run("plutil", ["-replace", "CFBundleExecutable", "-string", IOS_BUNDLE_EXEC, plist]);
    run("plutil", ["-replace", "CFBundleDisplayName", "-string", ZH_DISPLAY_NAME, plist]);
    run("plutil", ["-replace", "CFBundleName", "-string", ZH_DISPLAY_NAME, plist]);
  }

  const dest = path.join(path.dirname(appDir), `${IOS_BUNDLE_EXEC}.app`);
  if (path.basename(appDir) !== `${IOS_BUNDLE_EXEC}.app`) {
    if (fs.existsSync(dest) && dest !== appDir) {
      fs.rmSync(dest, { recursive: true, force: true });
    }
    fs.renameSync(appDir, dest);
    return dest;
  }
  return appDir;
}

function zipIpa(payloadDir, destIpa) {
  if (process.platform === "win32") {
    const ps = spawnSync(
      "powershell",
      ["-NoProfile", "-Command", `Compress-Archive -Path (Join-Path '${payloadDir}' 'Payload') -DestinationPath '${destIpa}' -Force`],
      { stdio: "inherit" },
    );
    if (ps.status !== 0) throw new Error("Compress-Archive 失败");
    return;
  }
  const zip = spawnSync("ditto", ["-c", "-k", "--keepParent", "Payload", destIpa], {
    cwd: payloadDir,
    stdio: "inherit",
  });
  if (zip.status !== 0) {
    const fallback = spawnSync("zip", ["-qry", destIpa, "Payload"], {
      cwd: payloadDir,
      stdio: "inherit",
    });
    if (fallback.status !== 0) throw new Error("打包 ipa 失败（需要 ditto 或 zip）");
  }
}

function main() {
  const ver = version();
  const appPath = pickApp();
  const destName = `${ZH_DISPLAY_NAME}_${ver}.ipa`;
  const destIpa = path.join(rootDir, "app/src-tauri/gen/apple", destName);
  fs.mkdirSync(path.dirname(destIpa), { recursive: true });
  if (fs.existsSync(destIpa)) fs.rmSync(destIpa);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gam-ios-ipa-"));
  const payload = path.join(tmp, "Payload");
  fs.mkdirSync(payload, { recursive: true });
  const destApp = path.join(payload, path.basename(appPath));
  fs.cpSync(appPath, destApp, { recursive: true });
  normalizeIosAppBundle(destApp);
  zipIpa(tmp, destIpa);
  fs.rmSync(tmp, { recursive: true, force: true });

  const stat = fs.statSync(destIpa);
  if (stat.size < 1024) {
    throw new Error(`ipa 过小：${destIpa} (${stat.size} bytes)`);
  }
  console.log(`[pack-ios-ipa] ${path.relative(rootDir, destIpa)} from ${path.relative(rootDir, appPath)} (${stat.size} bytes)`);
}

function selfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gam-ios-ipa-"));
  const appDir = path.join(tmp, `${ZH_DISPLAY_NAME}.app`);
  fs.mkdirSync(appDir);
  fs.writeFileSync(path.join(appDir, ZH_DISPLAY_NAME), "mach-o");
  fs.writeFileSync(path.join(appDir, "Info.plist"), "bplist-placeholder");
  const dest = normalizeIosAppBundle(appDir, { usePlutil: false });
  if (path.basename(dest) !== `${IOS_BUNDLE_EXEC}.app`) {
    throw new Error(`.app 应改名为 ${IOS_BUNDLE_EXEC}.app`);
  }
  if (!fs.existsSync(path.join(dest, IOS_BUNDLE_EXEC))) {
    throw new Error("包内可执行文件必须是 ASCII GitKeymaster");
  }
  if (fs.existsSync(path.join(dest, ZH_DISPLAY_NAME))) {
    throw new Error("中文可执行文件名还在");
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("[pack-ios-ipa] self-test ok");
}

const invoked = process.argv[1] && path.basename(process.argv[1]) === "pack-ios-ipa.mjs";
if (invoked) {
  try {
    if (process.argv[2] === "--test") {
      selfTest();
    } else {
      main();
    }
  } catch (err) {
    console.error(`[pack-ios-ipa] ${err.message}`);
    process.exit(1);
  }
}

export { version, pickApp };
