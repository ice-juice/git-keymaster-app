import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { CircleHelp, Trash2, AlertTriangle } from "lucide-react";
import { useIsCompact } from "../lib/platform";

function placeTooltip(icon: HTMLElement, pop: HTMLElement) {
  const r = icon.getBoundingClientRect();
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  const gap = 8;
  const pad = 10;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let left = r.left;
  let top = r.bottom + gap;

  if (left + pw > vw - pad) left = r.right - pw;
  if (left < pad) left = pad;
  if (left + pw > vw - pad) left = Math.max(pad, vw - pad - pw);

  if (top + ph > vh - pad) top = r.top - gap - ph;
  if (top < pad) top = pad;
  if (top + ph > vh - pad) top = Math.max(pad, vh - pad - ph);

  pop.style.top = `${Math.round(top)}px`;
  pop.style.left = `${Math.round(left)}px`;
}

export function FieldLabel({ name, tip }: { name: string; tip: string }) {
  const [open, setOpen] = useState(false);
  const iconRef = useRef<HTMLSpanElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const icon = iconRef.current;
    const pop = popRef.current;
    if (!icon || !pop) return;
    placeTooltip(icon, pop);
    pop.dataset.visible = "1";

    const onMove = () => {
      if (iconRef.current && popRef.current) placeTooltip(iconRef.current, popRef.current);
    };
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open, tip]);

  return (
    <label className="field-label">
      <span>{name}</span>
      <span
        ref={iconRef}
        className="field-help"
        tabIndex={0}
        aria-label={tip}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        <CircleHelp size={14} strokeWidth={2} />
      </span>
      {open &&
        createPortal(
          <div ref={popRef} className="field-help-pop" role="tooltip">
            {tip}
          </div>,
          document.body,
        )}
    </label>
  );
}

export function PageHead({ title, desc, actions }: { title: string; desc?: string; actions?: ReactNode }) {
  const compact = useIsCompact();
  if (compact && !actions) return null;
  return (
    <div className={"page-head" + (compact ? " is-compact" : "")}>
      {!compact && (
        <div>
          <div className="title-lg">{title}</div>
          {desc && <div className="muted">{desc}</div>}
        </div>
      )}
      {actions && <div className={compact ? "page-head-actions" : "row"}>{actions}</div>}
    </div>
  );
}

export function Card({ title, actions, children }: { title?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="card">
      {(title || actions) && (
        <div className="card-head">
          <div className="card-title">{title}</div>
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      <div className="card-body">{children}</div>
    </div>
  );
}

export function Empty({ icon = "📭", text }: { icon?: string; text: string }) {
  return (
    <div className="empty">
      <div className="empty-ic">{icon}</div>
      <div>{text}</div>
    </div>
  );
}

export function Badge({ kind = "muted", children }: { kind?: string; children: ReactNode }) {
  return <span className={"badge " + kind}>{children}</span>;
}

/** 设置等页面的错误提示：居中弹窗，避免顶部一行红字被忽略。 */
export function ErrorDialog({
  title,
  message,
  onClose,
}: {
  title?: string;
  message: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const heading = title || t("common.errorTitle");
  useEffect(() => {
    if (!message) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [message, onClose]);

  if (!message) return null;
  return createPortal(
    <div
      className="close-overlay"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="error-dialog-title"
      onClick={onClose}
    >
      <div className="close-dialog settings-error-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="close-dialog-titlebar">
          <span id="error-dialog-title">{heading}</span>
          <button type="button" className="close-dialog-x" onClick={onClose} aria-label={t("common.close")}>
            ×
          </button>
        </div>
        <div className="close-dialog-body">
          <div className="close-dialog-content">
            <div className="settings-error-text">{message}</div>
          </div>
        </div>
        <div className="close-dialog-footer settings-error-actions">
          <button type="button" className="btn primary sm" onClick={onClose} autoFocus>
            {t("common.gotIt")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** 破坏性操作的应用内二次确认。不用 window.confirm，避免手机 WebView 弹不出来。 */
export function ConfirmDangerDialog({
  title,
  message,
  detail,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  message: ReactNode;
  detail?: ReactNode;
  confirmLabel?: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  return createPortal(
    <div
      className="close-overlay"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-danger-title"
    >
      <div className="card" style={{ width: 400, maxWidth: "95%", border: "1px solid var(--red)" }}>
        <div className="card-head" style={{ background: "var(--red-soft)" }}>
          <div className="row" style={{ gap: 6, color: "var(--red)" }}>
            <Trash2 size={16} />
            <div id="confirm-danger-title" className="card-title" style={{ color: "var(--red)", fontWeight: 700 }}>
              {title}
            </div>
          </div>
        </div>
        <div className="card-body stack" style={{ gap: 10, padding: "14px 16px" }}>
          <div>{message}</div>
          {detail && <div className="callout danger sm">{detail}</div>}
        </div>
        <div
          className="card-head"
          style={{ justifyContent: "flex-end", gap: 8, borderTop: "1px solid var(--border)", borderBottom: "none" }}
        >
          <button type="button" className="btn ghost sm" disabled={busy} onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn danger sm" disabled={busy} onClick={onConfirm} autoFocus>
            {busy ? t("common.deleting") : confirmLabel || t("common.confirmDelete")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** 应用内二次确认，替代 WebView 的 window.confirm（避免弹出「tauri.localhost」系统框）。 */
export function ConfirmDialog({
  title,
  message,
  detail,
  confirmLabel,
  cancelLabel,
  tone = "default",
  busy,
  busyLabel,
  onCancel,
  onConfirm,
}: {
  title: string;
  message: ReactNode;
  detail?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  busy?: boolean;
  busyLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const danger = tone === "danger";
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  return createPortal(
    <div
      className="close-overlay"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
    >
      <div
        className="card"
        style={{
          width: 400,
          maxWidth: "95%",
          border: danger ? "1px solid var(--red)" : "1px solid var(--border-strong)",
        }}
      >
        <div className="card-head" style={danger ? { background: "var(--red-soft)" } : undefined}>
          <div className="row" style={{ gap: 6, color: danger ? "var(--red)" : "var(--text)" }}>
            <AlertTriangle size={16} />
            <div
              id="confirm-dialog-title"
              className="card-title"
              style={{ color: danger ? "var(--red)" : undefined, fontWeight: 700 }}
            >
              {title}
            </div>
          </div>
        </div>
        <div className="card-body stack" style={{ gap: 10, padding: "14px 16px" }}>
          <div>{message}</div>
          {detail && <div className={"callout sm " + (danger ? "danger" : "info")}>{detail}</div>}
        </div>
        <div
          className="card-head"
          style={{ justifyContent: "flex-end", gap: 8, borderTop: "1px solid var(--border)", borderBottom: "none" }}
        >
          <button type="button" className="btn ghost sm" disabled={busy} onClick={onCancel}>
            {cancelLabel || t("common.cancel")}
          </button>
          <button
            type="button"
            className={"btn sm " + (danger ? "danger" : "primary")}
            disabled={busy}
            onClick={onConfirm}
            autoFocus
          >
            {busy ? busyLabel || t("common.busy") : confirmLabel || t("common.ok")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
