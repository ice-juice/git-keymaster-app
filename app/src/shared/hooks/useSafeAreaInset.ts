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

function measureCssEnvInset(side: "top" | "bottom" | "left" | "right"): number {
  const el = document.createElement("div");
  el.style.position = "fixed";
  el.style.visibility = "hidden";
  el.style.pointerEvents = "none";
  const prop =
    side === "top"
      ? "paddingTop"
      : side === "bottom"
        ? "paddingBottom"
        : side === "left"
          ? "paddingLeft"
          : "paddingRight";
  el.style[prop] = `env(safe-area-inset-${side}, 0px)`;
  document.documentElement.appendChild(el);
  const v = toCssPx(getComputedStyle(el)[prop]);
  el.remove();
  return v;
}

function iosWebViewAlreadyInset(envTop: number, envBottom: number): boolean {
  if (envBottom <= 0 && envTop <= 0) return false;
  const visible = window.visualViewport?.height ?? window.innerHeight;
  const screenH = window.screen.height || 0;
  if (screenH <= 0) return false;
  // 全屏铺满时 innerHeight ≈ screen.height；若系统已把 WebView 裁进安全区，差值会接近 inset。
  const missing = screenH - visible;
  return missing >= Math.max(20, envBottom) - 4;
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

function applyIosSafeAreaGuard() {
  if (!isIOS()) return;
  const envTop = measureCssEnvInset("top");
  const envBottom = measureCssEnvInset("bottom");
  if (!iosWebViewAlreadyInset(envTop, envBottom)) return;
  const root = document.documentElement;
  // WebView 已经避开 Home Indicator / 刘海时，CSS 不再叠加 env()。
  root.style.setProperty("--km-safe-top", "0px");
  root.style.setProperty("--km-safe-bottom", "0px");
  root.style.setProperty(VARS.top, "0px");
  root.style.setProperty(VARS.bottom, "0px");
}

/** 把 Android WindowInsets 写到 `--km-safe-*-from-native`，供 CSS 与 env() 取 max。 */
export function useSafeAreaInset(enabled: boolean) {
  useEffect(() => {
    if (!enabled) {
      clearNativeInsets();
      return;
    }

    const apply = () => {
      applyNativeInsets(readNativeInsets());
      applyIosSafeAreaGuard();
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
