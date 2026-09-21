export const DEFAULT_MASK_KEEP = 3;
export const MIN_MASK_KEEP = 1;
export const MAX_MASK_KEEP = 8;

export function clampMaskKeep(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_MASK_KEEP;
  return Math.min(MAX_MASK_KEEP, Math.max(MIN_MASK_KEEP, Math.round(n)));
}

/**
 * 列表展示用：隐藏账号中间，只留头尾各 keep 个字符。
 * 规则：
 * - 关闭开关时返回原文
 * - 空串原样返回
 * - 长度 ≤ 2：全文显示，避免只剩 `***` 无法辨认
 * - 长度 ≤ keep*2：头尾各留 1 个，中间打码
 * - 其余：头尾各 keep 个 + `***`
 */
export function maskAccountMiddle(
  value: string,
  keep = DEFAULT_MASK_KEEP,
  enabled = true,
): string {
  if (!enabled) return value;
  const chars = Array.from(value ?? "");
  const n = chars.length;
  if (n === 0) return value;
  if (n <= 2) return chars.join("");

  const k = clampMaskKeep(keep);
  if (n <= k * 2) {
    return `${chars[0]}***${chars[n - 1]}`;
  }
  return `${chars.slice(0, k).join("")}***${chars.slice(n - k).join("")}`;
}
