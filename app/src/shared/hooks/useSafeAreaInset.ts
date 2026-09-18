import { useEffect } from "react";
import { isIOS } from "../../lib/platform";

const VARS = {
  top: "--km-safe-top-from-native",
  bottom: "--km-safe-bottom-from-native",
  left: "--km-safe-left-from-native",
  right: "--km-safe-right-from-native",
} as const;

type SafeInsets = { top: number; bottom: number; left: number; right: number };

function toCssPx(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

function readNativeInsets(): SafeInsets {
  const w = window as Window & {
    __kmAndroidSafeInsets?: Partial<SafeInsets>;
    kmSafe?: {
      getTop?: () => number;
      getBottom?: () => number;
      getLeft?: () => number;
      getRight?: () => number;
    };
  };
  let top = 0;
  let bottom = 0;
  let left = 0;
  let right = 0;
  try {
    if (w.kmSafe) {
      top = toCssPx(w.kmSafe.getTop?.());
      bottom = toCssPx(w.kmSafe.getBottom?.());
      left = toCssPx(w.kmSafe.getLeft?.());
      right = toCssPx(w.kmSafe.getRight?.());
    }
  } catch {
    /* WebView 桥未就绪时走缓存 */
  }
  const cached = w.__kmAndroidSafeInsets;
  if (cached) {
    top = Math.max(top, toCssPx(cached.top));
    bottom = Math.max(bottom, toCssPx(cached.bottom));
    left = Math.max(left, toCssPx(cached.left));
    right = Math.max(right, toCssPx(cached.right));
  }
  return { top, bottom, left, right };
}

function applyNativeInsets(insets: SafeInsets) {
  const root = document.documentElement;
  root.style.setProperty(VARS.top, `${insets.top}px`);
  root.style.setProperty(VARS.bottom, `${insets.bottom}px`);
  root.style.setProperty(VARS.left, `${insets.left}px`);
  root.style.setProperty(VARS.right, `${insets.right}px`);
}

function clearNativeInsets() {
  const root = document.documentElement;
  root.style.removeProperty(VARS.top);
  root.style.removeProperty(VARS.bottom);
  root.style.removeProperty(VARS.left);
  root.style.removeProperty(VARS.right);
  root.style.removeProperty("--km-safe-bottom");
  root.style.removeProperty("--km-safe-top");
}

/** 把 Android WindowInsets 写到 `--km-safe-*-from-native`，供 CSS 与 env() 取 max。
 *  iOS 不再在 JS 里把 env() 清零：安全区只由底栏 padding 吃一次，原生 inset 已关掉。 */
export function useSafeAreaInset(enabled: boolean) {
  useEffect(() => {
    if (!enabled) {
      clearNativeInsets();
      return;
    }

    const apply = () => {
      applyNativeInsets(readNativeInsets());
      if (isIOS()) {
        document.documentElement.style.removeProperty("--km-safe-top");
        document.documentElement.style.removeProperty("--km-safe-bottom");
      }
    };
    apply();
    window.addEventListener("km-android-safe-insets", apply);
    window.addEventListener("resize", apply);
    window.visualViewport?.addEventListener("resize", apply);
    return () => {
      window.removeEventListener("km-android-safe-insets", apply);
      window.removeEventListener("resize", apply);
      window.visualViewport?.removeEventListener("resize", apply);
    };
  }, [enabled]);
}
