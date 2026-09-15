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

/** 走系统剪贴板，避免 WebView 弹出 localhost 权限框。机密路径传 `secret: true`。 */
export async function writeClipboard(text: string, secret = false): Promise<ClipboardWriteResult> {
  const syncOk = copyTextSync(text);
  if (isTauri()) {
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
  if (syncOk || (await copyTextWeb(text))) return PLAIN;
  throw new Error(i18n.t("common.copyFailedPerm"));
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
