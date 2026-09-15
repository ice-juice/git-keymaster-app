/**
 * 平台判定的**兼容门面**。
 *
 * 单一真源已上移到 `src/platform/`：
 * - `platform/resolve.ts` 负责判定 desktop | mobile（不看窗口宽度）；
 * - `platform/capabilities.ts` 负责能力矩阵。
 *
 * 本文件只做转发 + 保留存量页面用惯的名字，避免一次性改动所有 import。
 * 新代码请直接 import `../platform/resolve` 与 `../platform/capabilities`。
 */
import {
  resolvePlatform,
  usePlatform,
  isMobilePlatform,
  isAndroid,
  isIOS,
  type Platform,
} from "../platform/resolve";
import { can } from "../platform/capabilities";

export { resolvePlatform, usePlatform, isMobilePlatform, isAndroid, isIOS };
export type { Platform };

/**
 * 当前是否走紧凑（移动）布局。
 *
 * 已改为「平台判定」的同义词——不再随窗口宽度变化。桌面永远为 false，
 * 手机（或 `?platform=mobile`）永远为 true。保留此名字仅为兼容存量调用。
 * @deprecated 新代码请用 `usePlatform() === "mobile"`。
 */
export function useIsCompact(): boolean {
  return resolvePlatform() === "mobile";
}

/** 本机 Git / SSH 工具链能力（移动端无）。 */
export function supportsLocalGitTools(): boolean {
  return can("localGitTools");
}

/** 是否自绘窗口控制按钮（仅桌面）。 */
export function supportsWindowControls(): boolean {
  return can("windowControls");
}
