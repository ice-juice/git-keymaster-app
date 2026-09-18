export const CLIPBOARD_WATCH_EVENT = "km-clipboard-watch-changed";

export function notifyClipboardWatchChanged() {
  window.dispatchEvent(new Event(CLIPBOARD_WATCH_EVENT));
}
