/**
 * Build the maintained, vendored Worker source and both migrations into Tauri.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const assetsDir = path.join(repoRoot, "app", "src-tauri", "assets");
const workerDir = path.resolve(repoRoot, "services", "file-locker-worker");

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" && cmd === "npm" });
  if (r.status !== 0) {
    fail(`${cmd} ${args.join(" ")} 失败（exit ${r.status ?? "null"}）`);
  }
}

if (!fs.existsSync(path.join(workerDir, "src", "index.ts"))) {
  fail(`未找到内置 Worker 源码：${workerDir}`);
}

const requireFromWorker = createRequire(path.join(workerDir, "package.json"));
let esbuild;
try {
  esbuild = requireFromWorker("esbuild");
} catch {
  console.log("file-locker-worker 缺少 esbuild，先 npm ci");
  run("npm", ["ci"], workerDir);
  esbuild = requireFromWorker("esbuild");
}

run(process.execPath, ["scripts/build-page.mjs"], workerDir);

const wranglerToml = fs.readFileSync(path.join(workerDir, "wrangler.toml"), "utf8");
const dateMatch = wranglerToml.match(/compatibility_date\s*=\s*"([^"]+)"/);
if (!dateMatch) {
  fail("wrangler.toml 没有 compatibility_date");
}
const compatibilityDate = dateMatch[1].trim();

const result = await esbuild.build({
  absWorkingDir: workerDir,
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  write: false,
  logLevel: "silent",
});
const js = result.outputFiles[0].text;
if (!js.includes("file-locker") || js.length < 1000) {
  fail("打包结果不像 file-locker Worker");
}

const sqlSrc = path.join(workerDir, "migrations", "0001_locker.sql");
const sql = fs.readFileSync(sqlSrc, "utf8");
if (/IF\s+NOT\s+EXISTS/i.test(sql)) {
  fail("0001_locker.sql 含 IF NOT EXISTS，与第 5 步先探后建约定不符");
}

fs.mkdirSync(assetsDir, { recursive: true });
fs.writeFileSync(path.join(assetsDir, "file-locker.js"), js);
fs.writeFileSync(path.join(assetsDir, "0001_locker.sql"), sql);
fs.copyFileSync(path.join(workerDir, "migrations", "0002_locker_v2.sql"), path.join(assetsDir, "0002_locker_v2.sql"));
fs.writeFileSync(path.join(assetsDir, "compatibility_date.txt"), `${compatibilityDate}\n`);
console.log(`embedded worker ${js.length} bytes, compatibility_date=${compatibilityDate}`);
