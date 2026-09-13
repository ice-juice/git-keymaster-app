import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

type ToastListener = (message: string) => void;
const listeners = new Set<ToastListener>();

/** 底部轻提示，不抢焦点、不挡点击。 */
export function showAppToast(message: string) {
  const text = message.trim();
  if (!text) return;
  for (const fn of listeners) fn(text);
}

export function ToastHost() {
  const [message, setMessage] = useState("");
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let hideTimer = 0;
    let clearTimer = 0;
    const onToast: ToastListener = (next) => {
      window.clearTimeout(hideTimer);
      window.clearTimeout(clearTimer);
      setMessage(next);
      setVisible(true);
      hideTimer = window.setTimeout(() => {
        setVisible(false);
        clearTimer = window.setTimeout(() => setMessage(""), 220);
      }, 1600);
    };
    listeners.add(onToast);
    return () => {
      listeners.delete(onToast);
      window.clearTimeout(hideTimer);
      window.clearTimeout(clearTimer);
    };
  }, []);

  if (!message) return null;
  return createPortal(
    <div className={"app-toast" + (visible ? " on" : "")} role="status" aria-live="polite">
      {message}
    </div>,
    document.body,
  );
}
