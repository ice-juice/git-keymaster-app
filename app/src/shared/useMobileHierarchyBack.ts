import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { isAndroid } from "../lib/platform";
import { useApp } from "../store";
import { api } from "../lib/ipc";
import {
  decideMobileRootBack,
  tryMobileBack,
  type MobileBackDecision,
} from "./mobileBack";

function applyLeave(decision: MobileBackDecision) {
  if (decision === "stay") return;
  void api.mobileLeaveApp(decision === "home").catch(() => {});
}

export function dispatchMobileHierarchyBack(
  pathname: string,
  navigate: (to: string, opts: { replace: boolean }) => void,
  unlocked: boolean,
  backgroundRun: boolean,
): MobileBackDecision {
  const overlayConsumed = tryMobileBack();
  const { decision, goParent } = decideMobileRootBack({
    overlayConsumed,
    pathname,
    unlocked,
    backgroundRun,
    android: isAndroid(),
  });
  if (goParent) {
    navigate("/", { replace: true });
    return "stay";
  }
  applyLeave(decision);
  return decision;
}

/** 系统返回键按页面层级回退，而不是 Hash 浏览历史。 */
export function useMobileHierarchyBack() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { status } = useApp();

  useEffect(() => {
    const run = () =>
      dispatchMobileHierarchyBack(pathname, navigate, !!status?.unlocked, !!status?.mobileBackgroundRun);
    window.__kmAndroidBack = run;
    return () => {
      if (window.__kmAndroidBack === run) delete window.__kmAndroidBack;
    };
  }, [pathname, navigate, status?.unlocked, status?.mobileBackgroundRun]);
}
