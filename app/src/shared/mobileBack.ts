import { useEffect } from "react";

export type MobileBackDecision = "stay" | "home" | "exit";

type BackFn = () => boolean;

const stack: BackFn[] = [];

/** 移动端子页 / 弹层覆盖返回。返回 true 表示已消费当前层。 */
export function setMobileBackHandler(fn: (() => boolean) | null) {
  stack.length = 0;
  if (fn) stack.push(fn);
}

/** 注册一层返回处理，卸载时自动弹出。 */
export function pushMobileBack(fn: BackFn): () => void {
  stack.push(fn);
  return () => {
    const i = stack.lastIndexOf(fn);
    if (i >= 0) stack.splice(i, 1);
  };
}

export function tryMobileBack(): boolean {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i]()) return true;
  }
  return false;
}

export function decideMobileRootBack(opts: {
  overlayConsumed: boolean;
  pathname: string;
  unlocked: boolean;
  backgroundRun: boolean;
  android: boolean;
}): { decision: MobileBackDecision; goParent: boolean } {
  if (opts.overlayConsumed) return { decision: "stay", goParent: false };
  if (!opts.unlocked) {
    if (!opts.android) return { decision: "stay", goParent: false };
    return { decision: opts.backgroundRun ? "home" : "exit", goParent: false };
  }
  if (opts.pathname !== "/") return { decision: "stay", goParent: true };
  if (!opts.android) return { decision: "stay", goParent: false };
  return { decision: opts.backgroundRun ? "home" : "exit", goParent: false };
}

/** 弹层打开时拦截返回，关闭当前层。 */
export function useOverlayBack(active: boolean, close: () => void) {
  useEffect(() => {
    if (!active) return;
    return pushMobileBack(() => {
      close();
      return true;
    });
  }, [active, close]);
}

declare global {
  interface Window {
    __kmAndroidBack?: () => MobileBackDecision;
  }
}
