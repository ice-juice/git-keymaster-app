import { useEffect } from "react";

const VAR = "--km-ime-inset";
const ATTR = "data-km-ime";
/** 小于这个高度多半是系统栏，不当成输入法。 */
const IME_MIN = 80;

function readVisualInset(): number {
  const vv = window.visualViewport;
  if (!vv) return 0;
  const raw = Math.round(window.innerHeight - vv.height - vv.offsetTop);
  return raw >= IME_MIN ? raw : 0;
}

function readAndroidInset(): number {
  const w = window as Window & {
    __kmAndroidImeInset?: number;
    kmIme?: { getInset?: () => number };
  };
  let n = 0;
  try {
    if (typeof w.kmIme?.getInset === "function") n = Number(w.kmIme.getInset());
  } catch {
    n = 0;
  }
  if (!Number.isFinite(n) || n <= 0) n = Number(w.__kmAndroidImeInset || 0);
  return Number.isFinite(n) && n >= IME_MIN ? Math.round(n) : 0;
}

function readInset(): number {
  return Math.max(readVisualInset(), readAndroidInset());
}

function applyInset(px: number) {
  const root = document.documentElement;
  root.style.setProperty(VAR, `${px}px`);
  if (px >= IME_MIN) root.setAttribute(ATTR, "1");
  else root.removeAttribute(ATTR);
}

/** 把输入法占去的底部高度写到 `--km-ime-inset`，供移动端弹层上移。 */
export function useImeInset(enabled: boolean) {
  useEffect(() => {
    const root = document.documentElement;
    if (!enabled) {
      root.style.removeProperty(VAR);
      root.removeAttribute(ATTR);
      return;
    }

    const apply = () => {
      applyInset(readInset());
    };
    apply();

    const vv = window.visualViewport;
    vv?.addEventListener("resize", apply);
    vv?.addEventListener("scroll", apply);
    window.addEventListener("resize", apply);
    window.addEventListener("km-android-ime", apply);
    window.addEventListener("focusin", apply);
    window.addEventListener("focusout", apply);
    return () => {
      vv?.removeEventListener("resize", apply);
      vv?.removeEventListener("scroll", apply);
      window.removeEventListener("resize", apply);
      window.removeEventListener("km-android-ime", apply);
      window.removeEventListener("focusin", apply);
      window.removeEventListener("focusout", apply);
      root.style.removeProperty(VAR);
      root.removeAttribute(ATTR);
    };
  }, [enabled]);
}
