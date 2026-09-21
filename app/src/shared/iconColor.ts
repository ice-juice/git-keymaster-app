/** 字母图标的预设色。存在账号 icon 字段里，格式为 `color:#RRGGBB`。 */
export const ICON_PRESET_COLORS = [
  "#2563eb",
  "#0284c7",
  "#0d9488",
  "#16a34a",
  "#65a30d",
  "#ca8a04",
  "#ea580c",
  "#dc2626",
  "#db2777",
  "#9333ea",
  "#4f46e5",
  "#475569",
] as const;

const COLOR_ICON = /^color:#([0-9a-fA-F]{6})$/;

export function parseIconColor(icon?: string | null): string | null {
  const match = icon?.trim().match(COLOR_ICON);
  return match ? `#${match[1].toLowerCase()}` : null;
}

export function colorIconRef(hex: string): string {
  const parsed = parseIconColor(hex.startsWith("color:") ? hex : `color:${hex}`);
  if (!parsed) throw new Error(`invalid icon color: ${hex}`);
  return `color:${parsed}`;
}

/** 没有内置图标、也没有上传图时，用平台名首字母。 */
export function isLetterIcon(icon?: string | null): boolean {
  return !icon || icon.startsWith("color:");
}

/** 平台图标：上传图优先于内置图标，再才是字母色。 */
export function pickPlatformIcon(icons: Array<string | null | undefined>): string | undefined {
  const list = icons.map((icon) => icon?.trim()).filter((icon): icon is string => !!icon);
  return (
    list.find((icon) => icon.startsWith("custom:")) ||
    list.find((icon) => icon.startsWith("builtin:")) ||
    list.find((icon) => icon.startsWith("color:")) ||
    list[0]
  );
}
