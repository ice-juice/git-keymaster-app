/**
 * 多终端样式隔离护栏。拦住「改移动端样式，误伤 PC」这类复发问题。
 *
 *   node scripts/check-style-isolation.mjs
 *
 * 约定（见 app/src/styles/mobile.css 顶部）：
 * 1. 共享 + 桌面样式表 app/src/index.css 禁止出现任何移动端专属标记；
 * 2. 移动端样式一律写进 app/src/styles/mobile.css，且不得再用
 *    `@media (max-width: …)` 按窗口宽度切布局（改用 html[data-platform="mobile"]）；
 * 3. mobile.css 里凡是覆盖共享类（.btn/.card/.input/.row/.page-head/.grid…）的规则，
 *    必须裹在 html[data-platform="mobile"] 作用域下。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(rootDir, rel), "utf-8");
// 剥掉 /* … */ 注释，避免注释里的示例字样（如说明「过去藏在 @media」）触发误报。
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const errors = [];
const fail = (m) => errors.push(m);

const SHARED_SHEET = "app/src/index.css";
const MOBILE_SHEET = "app/src/styles/mobile.css";

// —— 规则 1：共享/桌面表里不许出现移动端标记 ——
const MOBILE_MARKERS = [
  ".m-shell", ".m-topbar", ".m-tabbar", ".m-tab", ".m-seg", ".m-icon-btn",
  ".m-content", ".id-key-line", ".init-wizard-mobile", ".init-main-mobile",
  ".init-mobile", ".init-stepper", 'data-platform="mobile"', "data-layout",
];
{
  const css = stripComments(read(SHARED_SHEET));
  for (const marker of MOBILE_MARKERS) {
    if (css.includes(marker)) {
      fail(`${SHARED_SHEET} 不应包含移动端标记「${marker}」，请移到 ${MOBILE_SHEET}。`);
    }
  }
  // 只禁移动断点 640px（桌面自身 860/960 等响应式断点允许保留）
  if (/max-width:\s*640px/.test(css)) {
    fail(`${SHARED_SHEET} 不应出现移动断点 max-width:640px；移动样式请放 ${MOBILE_SHEET} 并用 html[data-platform="mobile"]。`);
  }
}

// —— 规则 2 & 3：移动表内的共享类覆盖必须带平台作用域，且不看窗口宽度 ——
{
  if (!fs.existsSync(path.join(rootDir, MOBILE_SHEET))) {
    fail(`缺少 ${MOBILE_SHEET}。`);
  } else {
    const css = stripComments(read(MOBILE_SHEET));
    if (/@media[^{]*max-width/.test(css)) {
      fail(`${MOBILE_SHEET} 不应用 @media(max-width) 判定移动端，请改用 html[data-platform="mobile"]。`);
    }
    // 粗粒度扫描：逐条 selector（{ 之前的部分），若命中共享类却没带平台作用域，报错。
    const SHARED_CLASSES = /(^|[\s,>])\.(btn|card|input|row|stack|grid|page-head|badge|callout|stat-card|identity-card|totp-card|settings-nav|group-tab|unlock-card|unlock-stage|sync-action|startup-lock-bar|nav-item|content|body|main|titlebar|window|sidebar|path-clip|tb-)/;
    const SELF_SCOPED = /^\s*\.(m-|id-key-line|init-)/; // 移动端专属类名，天然不冲突
    for (const block of css.split("}")) {
      const sel = block.split("{")[0];
      if (!sel || !sel.trim() || !block.includes("{")) continue;
      const line = sel.trim();
      if (line.startsWith("/*") || line.startsWith("*")) continue;
      if (line.includes('data-platform="mobile"')) continue; // 已带平台作用域
      if (SELF_SCOPED.test(line)) continue;                  // 移动端专属类
      if (SHARED_CLASSES.test(line)) {
        fail(`${MOBILE_SHEET} 里「${line}」覆盖了共享类却未裹 html[data-platform="mobile"]，可能泄漏到桌面。`);
      }
    }
  }
}

if (errors.length) {
  console.error("样式隔离检查未通过：\n" + errors.map((e) => "  ✗ " + e).join("\n"));
  process.exit(1);
}
console.log("✓ 样式隔离检查通过：移动端样式与桌面互不干扰。");
