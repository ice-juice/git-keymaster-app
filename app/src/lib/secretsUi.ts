import { api, errCode, errMessage, type ClipboardWriteResult } from "./ipc";
import { clearClipboard, writeClipboard } from "./clipboard";
import { resolvePlatform } from "../platform/resolve";
import { showAppToast } from "../ui/Toast";
import { i18n } from "./i18n";

const customCache = new Map<string, string>();
let clearTimer: number | null = null;

export async function copyWithClear(text: string, seconds?: number, secret = true) {
  let result: ClipboardWriteResult;
  try {
    result = await writeClipboard(text, secret);
  } catch (e) {
    if (resolvePlatform() === "mobile") showAppToast(i18n.t("common.copyFailed"));
    throw e;
  }
  if (resolvePlatform() === "mobile") showAppToast(i18n.t("common.copied"));
  let wait = seconds;
  if (wait === undefined) {
    try {
      wait = (await api.getRevealSettings()).clipboardClearSeconds;
    } catch {
      wait = 20;
    }
  }
  if (clearTimer !== null) {
    window.clearTimeout(clearTimer);
    clearTimer = null;
  }
  if (wait && wait > 0) {
    clearTimer = window.setTimeout(() => {
      clearTimer = null;
      clearClipboard().catch(() => {});
    }, wait * 1000);
  }
  return result;
}

export function isNeedReauth(e: unknown): boolean {
  return errCode(e) === "NEED_REAUTH" || errMessage(e).includes("访问密码");
}

export function isBiometricCancelled(e: unknown): boolean {
  return errCode(e) === "BIOMETRIC_CANCELLED";
}

/** 已开启指纹重认证时先刷系统指纹，成功后调用方可免密。失败/取消返回 false。 */
export async function tryBiometricReauth(): Promise<boolean> {
  try {
    const bio = await api.biometricStatus();
    if (!bio.enabled || !bio.revealEnabled || !bio.available) return false;
    await api.revealAuthorizeBiometric();
    return true;
  } catch (e) {
    if (isBiometricCancelled(e)) return false;
    return false;
  }
}

export function rememberCustomIcon(iconRef: string, dataUrl: string) {
  if (iconRef.startsWith("custom:") && dataUrl) customCache.set(iconRef, dataUrl);
}

export async function customIconUrl(iconRef: string | null | undefined): Promise<string | null> {
  if (!iconRef?.startsWith("custom:")) return null;
  const hit = customCache.get(iconRef);
  if (hit) return hit;
  const url = await api.iconGetCustom(iconRef);
  customCache.set(iconRef, url);
  return url;
}
