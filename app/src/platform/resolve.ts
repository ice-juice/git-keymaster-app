/**
 * 平台判定：整个前端「桌面 vs 移动」的**单一真源**。
 *
 * 关键设计：结果只取决于「构建目标 / 运行平台 / 开发期显式覆盖」，
 * **绝不看窗口宽度**。这样：
 * - 打包后的桌面端永远是 desktop，把窗口拉多窄都不会变形成手机布局；
 * - 想在电脑上验收手机界面，用 `?platform=mobile` 或 localStorage 显式进入，
 *   而不是靠拖窄窗口（那正是过去「改移动端误伤 PC」的温床）。
 *
 * 判定一旦解析即锁定（模块级缓存），全应用只读这一个来源，
 * 由 `main.tsx` 在首帧前写入 `<html data-platform="…">`，样式据此分流。
 */

export type Platform = "desktop" | "mobile";

function ua(): string {
  return typeof navigator === "undefined" ? "" : navigator.userAgent;
}

export function isAndroid(): boolean {
  return /Android/i.test(ua());
}

export function isIOS(): boolean {
  // iPadOS 13+ 的 Safari UA 里不再有 iPad，退化成 Macintosh + 触摸点。
  const s = ua();
  if (/iPhone|iPad|iPod/i.test(s)) return true;
  return /Macintosh/i.test(s) && typeof navigator !== "undefined" && navigator.maxTouchPoints > 1;
}

/** 是否真实移动平台（决定「能力」，不决定「布局」）。 */
export function isMobilePlatform(): boolean {
  return isAndroid() || isIOS();
}

/** 开发期显式覆盖：`?platform=mobile|desktop` 或 localStorage `gam.platform`。 */
function devForcedPlatform(): Platform | null {
  if (typeof window === "undefined") return null;
  try {
    const q = new URLSearchParams(window.location.search).get("platform");
    if (q === "mobile" || q === "desktop") return q;
    const ls = window.localStorage?.getItem("gam.platform");
    if (ls === "mobile" || ls === "desktop") return ls;
  } catch {
    /* 忽略：无 window / 隐私模式禁 storage */
  }
  return null;
}

let cached: Platform | null = null;

/** 解析当前平台（带模块级缓存，进程内稳定不变）。 */
export function resolvePlatform(): Platform {
  if (cached) return cached;
  // 1) 构建期注入，最高优先级：分端打包时 vite 写入 VITE_PLATFORM
  const build = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_PLATFORM;
  if (build === "mobile" || build === "desktop") return (cached = build);
  // 2) 真机
  if (isMobilePlatform()) return (cached = "mobile");
  // 3) 开发期显式覆盖，否则桌面
  return (cached = devForcedPlatform() ?? "desktop");
}

/** 读当前平台（组件里用）。 */
export function usePlatform(): Platform {
  return resolvePlatform();
}
