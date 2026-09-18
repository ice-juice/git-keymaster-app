/**
 * 把 gen/apple 里的 Xcode 工程改成未签名构建。
 *
 * `tauri ios build -- CODE_SIGNING_ALLOWED=NO` 不会把参数交给 xcodebuild
 *（`--` 后面进 cargo runner）。Tauri 2.11.4 要用 `--no-sign` 才会走
 * cargo-mobile2 的 skip_codesign。本脚本再改 pbxproj，避免 Automatic
 * signing 在命令行覆盖之前就报 “requires a development team”。
 *
 * 用法：
 *   node scripts/disable-ios-signing.mjs
 *   node scripts/disable-ios-signing.mjs --wrap /tmp/xcodebuild-unsigned
 *   node scripts/disable-ios-signing.mjs --test
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), "..");

const UNSIGNED_SETTINGS = [
  ["CODE_SIGNING_ALLOWED", "NO"],
  ["CODE_SIGNING_REQUIRED", "NO"],
  ["CODE_SIGN_IDENTITY", '""'],
  ["DEVELOPMENT_TEAM", '""'],
  ["CODE_SIGN_STYLE", "Manual"],
  ["CODE_SIGN_ENTITLEMENTS", '""'],
  ["PROVISIONING_PROFILE_SPECIFIER", '""'],
];

const SDK_OVERRIDE_KEYS = [
  "CODE_SIGN_IDENTITY",
  "DEVELOPMENT_TEAM",
  "PROVISIONING_PROFILE_SPECIFIER",
  "CODE_SIGN_STYLE",
];

function walkPbxproj(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      if (name === "Pods" || name === "build" || name === "node_modules") continue;
      walkPbxproj(full, out);
    } else if (name === "project.pbxproj") {
      out.push(full);
    }
  }
  return out;
}

function patchBuildSettingsBlock(block) {
  let next = block.replace(
    new RegExp(
      `^[ \\t]*"(?:${SDK_OVERRIDE_KEYS.join("|")})\\[sdk=[^\\]]+\\]"\\s*=\\s*[^;]*;[ \\t]*\\n?`,
      "gm",
    ),
    "",
  );

  for (const [key, value] of UNSIGNED_SETTINGS) {
    const existing = new RegExp(`^([ \\t]*)${key}\\s*=\\s*[^;]*;`, "m");
    if (existing.test(next)) {
      next = next.replace(existing, `$1${key} = ${value};`);
      continue;
    }
    next = next.replace(
      /(buildSettings = \{[ \t]*\r?\n)/,
      `$1\t\t\t\t${key} = ${value};\n`,
    );
  }
  return next;
}

export function patchPbxproj(source) {
  if (!source.includes("buildSettings = {")) {
    throw new Error("pbxproj 里没有 buildSettings，无法关掉签名");
  }
  return source.replace(/buildSettings = \{[\s\S]*?\n[ \t]*\};/g, patchBuildSettingsBlock);
}

export function assertUnsignedPbxproj(source) {
  for (const [key, value] of UNSIGNED_SETTINGS) {
    const re = new RegExp(`^\\s*${key}\\s*=\\s*${value.replace(/"/g, '"')}\\s*;`, "m");
    if (!re.test(source)) {
      throw new Error(`缺少 ${key} = ${value}`);
    }
  }
  if (/DEVELOPMENT_TEAM\s*=\s*[A-Z0-9]{6,};/.test(source)) {
    throw new Error("DEVELOPMENT_TEAM 仍是真实 Team ID");
  }
}

function appleDir(projectRoot = rootDir) {
  return path.join(projectRoot, "app", "src-tauri", "gen", "apple");
}

const UNSIGNED_XCODEBUILD_ARGS = [
  "CODE_SIGNING_ALLOWED=NO",
  "CODE_SIGNING_REQUIRED=NO",
  'CODE_SIGN_IDENTITY=""',
  'DEVELOPMENT_TEAM=""',
  'CODE_SIGN_ENTITLEMENTS=""',
];

export function writeXcodebuildWrapper(
  wrapDir,
  realXcodebuild = "/usr/bin/xcodebuild",
  patcher = __filename,
) {
  if (path.basename(realXcodebuild) === "xcodebuild" && /xcodebuild-unsigned/i.test(realXcodebuild)) {
    throw new Error("XCODEBUILD 不能指向包装脚本自己");
  }
  fs.mkdirSync(wrapDir, { recursive: true });
  const dest = path.join(wrapDir, "xcodebuild");
  const shQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
  const args = UNSIGNED_XCODEBUILD_ARGS.map((a) => `  ${shQuote(a)}`).join(" \\\n");
  const patchLine = patcher
    ? `${shQuote(process.execPath)} ${shQuote(patcher)} >/dev/null || true\n`
    : "";
  const iconSync = path.join(rootDir, "scripts", "sync-ios-appicon.mjs");
  const iconLine = fs.existsSync(iconSync)
    ? `${shQuote(process.execPath)} ${shQuote(iconSync)}\n`
    : "";
  const script = `#!/bin/bash
${patchLine}${iconLine}exec ${shQuote(realXcodebuild)} "$@" \\
${args}
`;
  fs.writeFileSync(dest, script, { encoding: "utf8", mode: 0o755 });
  return dest;
}

export function disableIosSigning(projectRoot = rootDir) {
  const dir = appleDir(projectRoot);
  const files = walkPbxproj(dir);
  if (files.length === 0) {
    throw new Error(`找不到 ${path.relative(projectRoot, dir)}/**/project.pbxproj（先跑 npx tauri ios init）`);
  }
  const patched = [];
  for (const file of files) {
    const before = fs.readFileSync(file, "utf8");
    const after = patchPbxproj(before);
    assertUnsignedPbxproj(after);
    if (after !== before) {
      fs.writeFileSync(file, after, "utf8");
    }
    patched.push(path.relative(projectRoot, file));
  }
  return patched;
}

function selfTest() {
  const sample = `// !$*UTF8*$!
{
	83B8E123 /* Release */ = {
		isa = XCBuildConfiguration;
		buildSettings = {
			CODE_SIGN_STYLE = Automatic;
			DEVELOPMENT_TEAM = ABCDE12345;
			"CODE_SIGN_IDENTITY[sdk=iphoneos*]" = "Apple Development";
			PRODUCT_BUNDLE_IDENTIFIER = com.jeck.gitkeymaster;
			PRODUCT_NAME = "御钥师";
		};
		name = Release;
	};
}
`;
  const patched = patchPbxproj(sample);
  assertUnsignedPbxproj(patched);
  if (!patched.includes("PRODUCT_BUNDLE_IDENTIFIER = com.jeck.gitkeymaster;")) {
    throw new Error("补丁误伤了 bundle id");
  }
  if (!patched.includes('PRODUCT_NAME = "御钥师";')) {
    throw new Error("补丁误伤了显示名");
  }
  if (patched.includes("ABCDE12345") || patched.includes("Apple Development")) {
    throw new Error("旧的签名字段没清干净");
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gam-ios-signing-"));
  const proj = path.join(tmp, "app", "src-tauri", "gen", "apple", "app.xcodeproj");
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, "project.pbxproj"), sample, "utf8");
  const files = disableIosSigning(tmp);
  if (files.length !== 1) {
    throw new Error(`应改 1 个 pbxproj，实际 ${files.length}`);
  }
  const wrap = writeXcodebuildWrapper(path.join(tmp, "wrap"), "/usr/bin/xcodebuild");
  const wrapText = fs.readFileSync(wrap, "utf8");
  if (!wrapText.startsWith("#!/bin/bash\n")) {
    throw new Error("xcodebuild 包装脚本 shebang 不对");
  }
  if (!UNSIGNED_XCODEBUILD_ARGS.every((a) => wrapText.includes(a))) {
    throw new Error("xcodebuild 包装脚本少了未签名参数");
  }
  if (!wrapText.includes("disable-ios-signing.mjs")) {
    throw new Error("xcodebuild 包装脚本应在调用前再打一次 pbxproj");
  }
  if (!wrapText.includes("sync-ios-appicon.mjs")) {
    throw new Error("xcodebuild 包装脚本必须在编译前再同步品牌 AppIcon");
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("[disable-ios-signing] self-test ok");
}

const invoked = process.argv[1] && path.basename(process.argv[1]) === "disable-ios-signing.mjs";
if (invoked) {
  try {
    if (process.argv[2] === "--test") {
      selfTest();
    } else if (process.argv[2] === "--wrap") {
      const dest = process.argv[3];
      if (!dest) {
        throw new Error("usage: node scripts/disable-ios-signing.mjs --wrap <dir>");
      }
      const real = process.env.XCODEBUILD || "/usr/bin/xcodebuild";
      const file = writeXcodebuildWrapper(dest, real);
      console.log(`[disable-ios-signing] wrapper ${file}`);
    } else {
      const files = disableIosSigning();
      console.log(`[disable-ios-signing] patched ${files.join(", ")}`);
    }
  } catch (err) {
    console.error(`[disable-ios-signing] ${err.message}`);
    process.exit(1);
  }
}
