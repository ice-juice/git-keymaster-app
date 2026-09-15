import { useAppName } from "./i18n";

function parseAppLang(raw: unknown): "zh" | "en" {
  const s = String(raw ?? "zh").trim().toLowerCase();
  if (s === "en" || s.startsWith("en-")) return "en";
  return "zh";
}

export const APP_LANG = parseAppLang(import.meta.env.VITE_APP_LANG);

/**
 * 编译期回退显示名。标题栏 / 顶栏请用 useAppName()，按运行时 uiLocale 取 brand.mjs。
 * 禁止再用 getName() 覆盖。字面量必须与 scripts/brand.mjs 一致。
 */
export const APP_NAME =
  String(import.meta.env.VITE_APP_NAME || "").trim() ||
  (APP_LANG === "en" ? "Git Keymaster" : "御钥师");

export { useAppName };
