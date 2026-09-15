import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "./ipc";
import {
  i18n,
  isUiLocale,
  persistLocaleLocally,
  peekSavedLocale,
  resolveLang,
  type UiLocale,
  type ResolvedLang,
} from "./i18n";

interface LocaleContextValue {
  uiLocale: UiLocale;
  resolvedLang: ResolvedLang;
  setUiLocale: (next: UiLocale) => Promise<void>;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [uiLocale, setUiLocaleState] = useState<UiLocale>(peekSavedLocale);

  const apply = useCallback(async (next: UiLocale) => {
    setUiLocaleState(next);
    persistLocaleLocally(next);
    await i18n.changeLanguage(resolveLang(next));
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const saved = await api.getUiLocale();
        if (!cancelled && isUiLocale(saved)) {
          await apply(saved);
        }
      } catch {
        /* 浏览器预览或尚未接入 IPC 时走本地缓存 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apply]);

  const setUiLocale = useCallback(
    async (next: UiLocale) => {
      await apply(next);
      try {
        await api.setUiLocale(next);
      } catch {
        /* 浏览器预览只写 localStorage */
      }
    },
    [apply],
  );

  const value = useMemo<LocaleContextValue>(
    () => ({
      uiLocale,
      resolvedLang: resolveLang(uiLocale),
      setUiLocale,
    }),
    [uiLocale, setUiLocale],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) {
    throw new Error("useLocale 必须包在 LocaleProvider 里");
  }
  return ctx;
}
