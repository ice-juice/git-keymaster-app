/** 标签色按名称固定。同一标签在列表、筛选和编辑建议里颜色相同。 */
const TAG_PALETTE = [
  "#7c3aed",
  "#db2777",
  "#ea580c",
  "#ca8a04",
  "#16a34a",
  "#0d9488",
  "#0284c7",
  "#4f46e5",
  "#e11d48",
  "#65a30d",
  "#9333ea",
  "#0891b2",
] as const;

export type TagColor = {
  fg: string;
  bg: string;
  border: string;
};

function hashTag(tag: string): number {
  let hash = 2166136261;
  for (const ch of tag.trim().toLowerCase()) {
    hash ^= ch.codePointAt(0) || 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function rgba(hex: string, alpha: number): string {
  const h = hex.slice(1);
  const r = Number.parseInt(h.slice(0, 2), 16);
  const g = Number.parseInt(h.slice(2, 4), 16);
  const b = Number.parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function tagColor(tag: string): TagColor {
  const fg = TAG_PALETTE[hashTag(tag) % TAG_PALETTE.length];
  return { fg, bg: rgba(fg, 0.12), border: rgba(fg, 0.4) };
}

/** 备忘录标签按名称取一个固定的低饱和色相。选中只加深底色，不铺实心色。 */
export function noteTagColor(tag: string, selected = false): TagColor {
  const hue = hashTag(tag) % 360;
  return {
    fg: `hsl(${hue} 28% 38%)`,
    bg: `hsl(${hue} 32% 46% / ${selected ? 0.2 : 0.11})`,
    border: `hsl(${hue} 22% 44% / ${selected ? 0.36 : 0.2})`,
  };
}
