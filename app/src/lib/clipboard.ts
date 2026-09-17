import { api, type ClipboardWriteResult } from "./ipc";
import { i18n } from "./i18n";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

const PLAIN: ClipboardWriteResult = { excluded: false, fallback: false };

/** 在用户手势同步栈里写入，避免 await 之后 WebView 丢掉点击授权。 */
function copyTextSync(text: string): boolean {
  if (typeof document === "undefined") return false;
  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "");
  el.setAttribute("aria-hidden", "true");
  el.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none";
  document.body.appendChild(el);
  el.focus();
  el.select();
  el.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(el);
  return ok;
}

async function copyTextWeb(text: string): Promise<boolean> {
  if (copyTextSync(text)) return true;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * 走系统剪贴板，避免 WebView 弹出 localhost 权限框。机密路径传 `secret: true`。
 *
 * **机密路径禁止先用 WebView 写一遍**。`copyTextSync` 是普通剪贴板写入，不带排除格式；
 * Windows 剪贴板历史/云剪贴板在那一刻就已经把内容抓走了，后面原生路径再打排除标记
 * 也追不回来——等于把排除功能自己旁路掉。原生写入是 Win32 直调，本就不需要用户手势。
 */
export async function writeClipboard(text: string, secret = false): Promise<ClipboardWriteResult> {
  if (isTauri()) {
    // 只有非机密内容（公钥等）才保留同步预写，用来兜住手势过期导致的复制失败。
    const syncOk = secret ? false : copyTextSync(text);
    try {
      const result = await api.clipboardWrite(text, secret);
      if (result.notice) {
        console.warn(result.notice);
      }
      return result;
    } catch (e) {
      if (syncOk || (await copyTextWeb(text))) {
        return { excluded: false, fallback: true };
      }
      throw e;
    }
  }
  if (copyTextSync(text) || (await copyTextWeb(text))) return PLAIN;
  throw new Error(i18n.t("common.copyFailedPerm"));
}

/** 优先走原生通道（Android WebView 的 navigator.clipboard.readText 经常被拒）。 */
export async function readClipboard(): Promise<string> {
  let lastErr: unknown;
  if (isTauri()) {
    try {
      const text = (await api.clipboardRead()).trim();
      if (text) return text;
    } catch (e) {
      lastErr = e;
    }
  }
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (text) return text;
  } catch (e) {
    lastErr = e;
  }
  throw new Error(i18n.t(lastErr ? "common.pasteFailed" : "common.pasteEmpty"));
}

export async function clearClipboard() {
  if (isTauri()) {
    try {
      await api.clipboardClear();
      return;
    } catch {
      /* 移动端未接入时忽略 */
    }
  }
  try {
    await navigator.clipboard.writeText("");
  } catch {
    /* ignore */
  }
}
