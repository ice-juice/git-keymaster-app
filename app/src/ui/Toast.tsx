import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

type ToastPayload = { message: string; dismissible: boolean };
type ToastListener = (payload: ToastPayload) => void;
const listeners = new Set<ToastListener>();

/** 底部轻提示，不抢焦点、不挡点击。dismissible 时留到用户关掉。 */
export function showAppToast(message: string, options?: { dismissible?: boolean }) {
  const text = message.trim();
  if (!text) return;
  const payload = { message: text, dismissible: !!options?.dismissible };
  for (const fn of listeners) fn(payload);
}

export function ToastHost() {
  const { t } = useTranslation();
  const [message, setMessage] = useState("");
  const [visible, setVisible] = useState(false);
  const [dismissible, setDismissible] = useState(false);
  const clearTimer = useRef(0);

  useEffect(() => {
    let hideTimer = 0;
    const onToast: ToastListener = (next) => {
      window.clearTimeout(hideTimer);
      window.clearTimeout(clearTimer.current);
      setMessage(next.message);
      setDismissible(next.dismissible);
      setVisible(true);
      if (!next.dismissible) {
        hideTimer = window.setTimeout(() => {
          setVisible(false);
          clearTimer.current = window.setTimeout(() => setMessage(""), 220);
        }, 1600);
      }
    };
    listeners.add(onToast);
    return () => {
      listeners.delete(onToast);
      window.clearTimeout(hideTimer);
      window.clearTimeout(clearTimer.current);
    };
  }, []);

  function dismiss() {
    setVisible(false);
    window.clearTimeout(clearTimer.current);
    clearTimer.current = window.setTimeout(() => setMessage(""), 220);
  }

  if (!message) return null;
  return createPortal(
    <div
      className={"app-toast" + (visible ? " on" : "") + (dismissible ? " dismissible" : "")}
      role="status"
      aria-live="polite"
    >
      <span>{message}</span>
      {dismissible && (
        <button type="button" className="app-toast-close" aria-label={t("common.close")} onClick={dismiss}>
          ×
        </button>
      )}
    </div>,
    document.body,
  );
}
