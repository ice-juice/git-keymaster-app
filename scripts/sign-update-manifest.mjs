/**
 * 用现有 TAURI_SIGNING_PRIVATE_KEY（同一把 minisign）签规范化清单或任意文件。
 * 产物格式与桌面 updater 的 `.sig` 相同：minisign 文本再包一层 Base64。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const APP_DIR = path.join(REPO_ROOT, "app");

export function canonicalManifestPayload(data) {
  const version = String(data?.version || "").trim();
  const platforms = data?.platforms && typeof data.platforms === "object" ? data.platforms : {};
  const keys = Object.keys(platforms).sort();
  const lines = ["git-keymaster-update-manifest-v1", `version:${version}`];
  for (const key of keys) {
    const p = platforms[key] && typeof platforms[key] === "object" ? platforms[key] : {};
    lines.push(`${key}\t${String(p.url || "").trim()}\t${String(p.signature || "").trim()}`);
  }
  return lines.join("\n");
}

export function serializeLatestJson(data) {
  const out = {
    version: data.version,
    notes: data.notes || "",
    pub_date: data.pub_date,
    platforms: data.platforms || {},
  };
  if (data.manifestSignature) {
    out.manifestSignature = data.manifestSignature;
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

export function attachManifestSignature(text, signBytes) {
  const data = JSON.parse(text);
  const payload = canonicalManifestPayload(data);
  data.manifestSignature = String(signBytes(Buffer.from(payload, "utf8")) || "").replace(/\s+$/, "");
  if (!data.manifestSignature) {
    throw new Error("清单签名结果为空");
  }
  return serializeLatestJson(data);
}

export function requireSigningEnv() {
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
    throw new Error("缺少 TAURI_SIGNING_PRIVATE_KEY，无法用现有 minisign 私钥签名");
  }
}

function resolveTauriCli() {
  const local = path.join(APP_DIR, "node_modules", "@tauri-apps", "cli", "tauri.js");
  if (fs.existsSync(local)) {
    return { cmd: process.execPath, args: [local], cwd: APP_DIR };
  }
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  return { cmd: npx, args: ["--yes", "@tauri-apps/cli@2.11.4"], cwd: APP_DIR };
}

export function signFileWithTauri(filePath) {
  requireSigningEnv();
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`待签名文件不存在：${abs}`);
  }
  const cli = resolveTauriCli();
  const result = spawnSync(cli.cmd, [...cli.args, "signer", "sign", abs], {
    cwd: cli.cwd,
    env: process.env,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `tauri signer sign 失败：${(result.stderr || result.stdout || "").trim() || `exit ${result.status}`}`,
    );
  }
  const sigPath = `${abs}.sig`;
  if (!fs.existsSync(sigPath)) {
    throw new Error(`签名完成但找不到 ${sigPath}`);
  }
  return fs.readFileSync(sigPath, "utf8").replace(/\s+$/, "");
}

export function signBufferWithTauri(buf) {
  const tmp = path.join(os.tmpdir(), `gam-minisign-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, buf);
  try {
    return signFileWithTauri(tmp);
  } finally {
    fs.rmSync(tmp, { force: true });
    fs.rmSync(`${tmp}.sig`, { force: true });
  }
}

export function signLatestJsonText(text) {
  return attachManifestSignature(text, (bytes) => signBufferWithTauri(bytes));
}

export function signLatestJsonFile(filePath) {
  const signed = signLatestJsonText(fs.readFileSync(filePath, "utf8"));
  fs.writeFileSync(filePath, signed);
  return signed;
}

function runSelfTest() {
  const payload = canonicalManifestPayload({
    version: "1.5.1",
    platforms: {
      "windows-x86_64": { signature: "old-pkg-sig", url: "https://example.com/old.exe" },
      "android-aarch64": { signature: "apk-sig", url: "https://example.com/old.apk" },
    },
  });
  const expected =
    "git-keymaster-update-manifest-v1\nversion:1.5.1\nandroid-aarch64\thttps://example.com/old.apk\tapk-sig\nwindows-x86_64\thttps://example.com/old.exe\told-pkg-sig";
  if (payload !== expected) {
    throw new Error(`canonical payload mismatch:\n${payload}`);
  }
  const signed = attachManifestSignature(
    JSON.stringify({
      version: "1.5.1",
      notes: "n",
      pub_date: "2026-01-01T00:00:00Z",
      platforms: { "windows-x86_64": { url: "https://e/a.exe", signature: "s" } },
    }),
    () => "MANIFEST_SIG",
  );
  const parsed = JSON.parse(signed);
  if (parsed.manifestSignature !== "MANIFEST_SIG" || parsed.version !== "1.5.1") {
    throw new Error("attachManifestSignature must keep version/platforms and add manifestSignature");
  }
  const replay = canonicalManifestPayload({ ...parsed, version: "99.0.0" });
  if (replay.includes("version:1.5.1")) {
    throw new Error("replay version must change the canonical payload");
  }
  console.log("[sign-update-manifest] self-test ok");
}

const invoked = process.argv[1] && path.basename(process.argv[1]) === "sign-update-manifest.mjs";
if (invoked && process.argv[2] === "--test") {
  runSelfTest();
}
