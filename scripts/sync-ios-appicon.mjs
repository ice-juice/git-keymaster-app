/**
 * 把仓库里的品牌 iOS 图标写进 Xcode AppIcon.appiconset。
 *
 * `npx tauri icon` 只在 `src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset`
 * 恰好存在时才覆盖；`tauri ios init` 常把目录放在 `gen/apple/<Name>/Assets.xcassets`，
 * CLI 就会退回写 `icons/ios/`，打包仍用默认 Tauri 标。
 *
 *   node scripts/sync-ios-appicon.mjs
 *   node scripts/sync-ios-appicon.mjs --test
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), "..");

const REQUIRED = [
  "AppIcon-20x20@1x.png",
  "AppIcon-20x20@2x.png",
  "AppIcon-20x20@2x-1.png",
  "AppIcon-20x20@3x.png",
  "AppIcon-29x29@1x.png",
  "AppIcon-29x29@2x.png",
  "AppIcon-29x29@2x-1.png",
  "AppIcon-29x29@3x.png",
  "AppIcon-40x40@1x.png",
  "AppIcon-40x40@2x.png",
  "AppIcon-40x40@2x-1.png",
  "AppIcon-40x40@3x.png",
  "AppIcon-60x60@2x.png",
  "AppIcon-60x60@3x.png",
  "AppIcon-76x76@1x.png",
  "AppIcon-76x76@2x.png",
  "AppIcon-83.5x83.5@2x.png",
  "AppIcon-512@2x.png",
];

const CONTENTS = {
  images: [
    { filename: "AppIcon-20x20@2x.png", idiom: "iphone", scale: "2x", size: "20x20" },
    { filename: "AppIcon-20x20@3x.png", idiom: "iphone", scale: "3x", size: "20x20" },
    { filename: "AppIcon-29x29@2x.png", idiom: "iphone", scale: "2x", size: "29x29" },
    { filename: "AppIcon-29x29@3x.png", idiom: "iphone", scale: "3x", size: "29x29" },
    { filename: "AppIcon-40x40@2x.png", idiom: "iphone", scale: "2x", size: "40x40" },
    { filename: "AppIcon-40x40@3x.png", idiom: "iphone", scale: "3x", size: "40x40" },
    { filename: "AppIcon-60x60@2x.png", idiom: "iphone", scale: "2x", size: "60x60" },
    { filename: "AppIcon-60x60@3x.png", idiom: "iphone", scale: "3x", size: "60x60" },
    { filename: "AppIcon-20x20@1x.png", idiom: "ipad", scale: "1x", size: "20x20" },
    { filename: "AppIcon-20x20@2x-1.png", idiom: "ipad", scale: "2x", size: "20x20" },
    { filename: "AppIcon-29x29@1x.png", idiom: "ipad", scale: "1x", size: "29x29" },
    { filename: "AppIcon-29x29@2x-1.png", idiom: "ipad", scale: "2x", size: "29x29" },
    { filename: "AppIcon-40x40@1x.png", idiom: "ipad", scale: "1x", size: "40x40" },
    { filename: "AppIcon-40x40@2x-1.png", idiom: "ipad", scale: "2x", size: "40x40" },
    { filename: "AppIcon-76x76@1x.png", idiom: "ipad", scale: "1x", size: "76x76" },
    { filename: "AppIcon-76x76@2x.png", idiom: "ipad", scale: "2x", size: "76x76" },
    { filename: "AppIcon-83.5x83.5@2x.png", idiom: "ipad", scale: "2x", size: "83.5x83.5" },
    { filename: "AppIcon-512@2x.png", idiom: "ios-marketing", scale: "1x", size: "1024x1024" },
  ],
  info: { author: "xcode", version: 1 },
};

function sourceDir(projectRoot = rootDir) {
  return path.join(projectRoot, "app", "src-tauri", "icons", "ios");
}

function appleDir(projectRoot = rootDir) {
  return path.join(projectRoot, "app", "src-tauri", "gen", "apple");
}

function walkAppIconSets(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (!stat.isDirectory()) continue;
    if (name === "Pods" || name === "build" || name === "node_modules") continue;
    if (name === "AppIcon.appiconset") out.push(full);
    else walkAppIconSets(full, out);
  }
  return out;
}

function assertSourceIcons(src) {
  if (!fs.existsSync(src)) {
    throw new Error(`找不到品牌图标目录 ${src}`);
  }
  for (const name of REQUIRED) {
    const file = path.join(src, name);
    if (!fs.existsSync(file) || fs.statSync(file).size < 200) {
      throw new Error(`缺少品牌图标 ${name}`);
    }
  }
}

export function syncIosAppIcon(projectRoot = rootDir) {
  const src = sourceDir(projectRoot);
  assertSourceIcons(src);

  const apple = appleDir(projectRoot);
  if (!fs.existsSync(apple)) {
    throw new Error("找不到 gen/apple（先跑 npx tauri ios init）");
  }

  let sets = walkAppIconSets(apple);
  if (sets.length === 0) {
    const fallback = path.join(apple, "Assets.xcassets", "AppIcon.appiconset");
    fs.mkdirSync(fallback, { recursive: true });
    sets = [fallback];
  }

  for (const dest of sets) {
    for (const name of REQUIRED) {
      fs.copyFileSync(path.join(src, name), path.join(dest, name));
    }
    fs.writeFileSync(path.join(dest, "Contents.json"), `${JSON.stringify(CONTENTS, null, 2)}\n`);
    const copied = fs.readFileSync(path.join(dest, "AppIcon-60x60@3x.png"));
    const brand = fs.readFileSync(path.join(src, "AppIcon-60x60@3x.png"));
    if (Buffer.compare(copied, brand) !== 0) {
      throw new Error(`${dest} 的 AppIcon-60x60@3x.png 没有写成品牌图`);
    }
  }
  return sets.map((p) => path.relative(projectRoot, p));
}

function selfTest() {
  assertSourceIcons(sourceDir());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gam-ios-appicon-"));
  const nested = path.join(tmp, "app", "src-tauri", "gen", "apple", "GitKeymaster", "Assets.xcassets", "AppIcon.appiconset");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, "Contents.json"), '{"images":[{"filename":"old.png"}]}');
  fs.writeFileSync(path.join(nested, "old.png"), "tauri-default");
  fs.cpSync(path.join(rootDir, "app", "src-tauri", "icons"), path.join(tmp, "app", "src-tauri", "icons"), {
    recursive: true,
  });
  const synced = syncIosAppIcon(tmp);
  if (synced.length !== 1 || !synced[0].replaceAll("\\", "/").endsWith("AppIcon.appiconset")) {
    throw new Error(`应同步嵌套 AppIcon，实际 ${synced.join(",")}`);
  }
  const destIcon = path.join(tmp, synced[0], "AppIcon-60x60@3x.png");
  const srcIcon = path.join(tmp, "app", "src-tauri", "icons", "ios", "AppIcon-60x60@3x.png");
  if (Buffer.compare(fs.readFileSync(destIcon), fs.readFileSync(srcIcon)) !== 0) {
    throw new Error("嵌套目录没有覆盖成品牌图");
  }
  const json = JSON.parse(fs.readFileSync(path.join(tmp, synced[0], "Contents.json"), "utf8"));
  if (!json.images.some((img) => img.filename === "AppIcon-60x60@3x.png" && img.size === "60x60")) {
    throw new Error("Contents.json 必须指向品牌 AppIcon-60x60@3x.png");
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("[sync-ios-appicon] self-test ok");
}

const invoked = process.argv[1] && path.basename(process.argv[1]) === "sync-ios-appicon.mjs";
if (invoked) {
  try {
    if (process.argv[2] === "--test") {
      selfTest();
    } else {
      const files = syncIosAppIcon();
      console.log(`[sync-ios-appicon] ${files.join(", ")}`);
    }
  } catch (err) {
    console.error(`[sync-ios-appicon] ${err.message}`);
    process.exit(1);
  }
}
