import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";

export function useItemFocus(ready: boolean, onFocus?: (id: string) => void) {
  const [params] = useSearchParams();
  const focusId = params.get("focus");
  const onFocusRef = useRef(onFocus);
  useEffect(() => {
    onFocusRef.current = onFocus;
  }, [onFocus]);

  useEffect(() => {
    if (!focusId || !ready) return;
    onFocusRef.current?.(focusId);
    let tries = 0;
    let timer = 0;
    const highlight = () => {
      const el = document.querySelector(`[data-focus-id="${CSS.escape(focusId)}"]`);
      if (el instanceof HTMLElement) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        el.classList.add("is-focus-target");
        window.setTimeout(() => el.classList.remove("is-focus-target"), 2400);
        return;
      }
      if (tries++ < 24) timer = window.setTimeout(highlight, 50);
    };
    timer = window.setTimeout(highlight, 0);
    return () => window.clearTimeout(timer);
  }, [focusId, ready]);

  return focusId;
}
