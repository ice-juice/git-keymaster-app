import i18n from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";
import { displayNameFor } from "../../../scripts/brand.mjs";
import zh from "../locales/zh.json" with { type: "json" };
import en from "../locales/en.json" with { type: "json" };

export type UiLocale = "system" | "zh" | "en";
export type ResolvedLang = "zh" | "en";

const STORAGE_KEY = "gam.uiLocale";

export function isUiLocale(raw: unknown): raw is UiLocale {
  return raw === "system" || raw === "zh" || raw === "en";
}

export function detectSystemLang(): ResolvedLang {
  const nav =
    typeof navigator !== "undefined"
      ? `${navigator.language} ${(navigator.languages ?? []).join(" ")}`
      : "zh";
  return nav.toLowerCase().includes("zh") ? "zh" : "en";
}

export function resolveLang(uiLocale: UiLocale): ResolvedLang {
  return uiLocale === "system" ? detectSystemLang() : uiLocale;
}

export function peekSavedLocale(): UiLocale {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (isUiLocale(raw)) return raw;
  } catch {
    /* ignore */
  }
  return "system";
}

export function persistLocaleLocally(locale: UiLocale) {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    /* ignore */
  }
}

/** 跟 scripts/brand.mjs 对齐；禁止再读运行时 productName / getName()。 */
export function displayNameForLocale(lang: string): string {
  return displayNameFor(lang);
}

export function useAppName(): string {
  const { i18n: i18nInst } = useTranslation();
  return displayNameFor(i18nInst.language);
}

void i18n.use(initReactI18next).init({
  resources: {
    zh: { translation: zh },
    en: { translation: en },
  },
  lng: resolveLang(peekSavedLocale()),
  fallbackLng: "zh",
  interpolation: { escapeValue: false },
});

export { i18n };
