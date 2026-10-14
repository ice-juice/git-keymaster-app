import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import type { UpdateProgress } from "../lib/ipc";
import { appUpdateNotes } from "../shared/updateNotes";

export type UpdateNotesActions = {
  canAuto: boolean;
  manualUrl: string | null;
  installing: boolean;
  busy: boolean;
  error?: string;
  note?: string;
  onAuto: () => void;
  onManual: () => void;
  onSkip: () => void;
};

function renderInline(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    const bold = part.match(/^\*\*([^*]+)\*\*$/);
    if (bold) return <strong key={i}>{bold[1]}</strong>;
    return <span key={i}>{part}</span>;
  });
}

function UpdateNotesBody({ notes }: { notes: string }) {
  const blocks = notes
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line, i, arr) => line.trim() !== "" || (i > 0 && arr[i - 1].trim() !== ""));

  return (
    <div className="update-notes">
      {blocks.map((line, i) => {
        const heading = line.match(/^#{2,3}\s+(.+)/);
        if (heading) {
          return (
            <div key={i} className="update-notes-h">
              {heading[1]}
            </div>
          );
        }
        const item = line.match(/^[-*]\s+(.+)/);
        if (item) {
          return (
            <div key={i} className="update-notes-li">
              {renderInline(item[1])}
            </div>
          );
        }
        return (
          <div key={i} className="update-notes-p">
            {renderInline(line)}
          </div>
        );
      })}
    </div>
  );
}

export function UpdateNotesDialog({
  version,
  notes,
  onClose,
  actions,
}: {
  version?: string | null;
  notes: string;
  onClose: () => void;
  actions?: UpdateNotesActions;
}) {
  const { t } = useTranslation();
  const body = appUpdateNotes(notes);
  const trackProgress = !!actions;
  const [progress, setProgress] = useState<UpdateProgress | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!trackProgress) return;
    let dead = false;
    let unlisten: (() => void) | undefined;
    listen<UpdateProgress>("update-progress", (ev) => {
      setProgress(ev.payload);
    })
      .then((fn) => {
        if (dead) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      dead = true;
      unlisten?.();
    };
  }, [trackProgress]);

  if (!body && !actions) return null;

  const title = version
    ? t("update.notesTitleVersion", { version })
    : t("update.notesTitle");
  const downloading = !!progress && progress.phase !== "finished";
  const percent =
    progress && progress.total && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null;
  const manualWide = !!actions && !actions.canAuto && !!actions.manualUrl;

  return createPortal(
    <div
      className="wizard-overlay update-notes-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="update-notes-title"
      onClick={onClose}
    >
      <div className="card dialog-card update-notes-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <div id="update-notes-title" className="card-title">
            {title}
          </div>
        </div>
        <div className="card-body">
          {body ? <UpdateNotesBody notes={body} /> : <div className="muted">{t("update.notesEmpty")}</div>}
        </div>
        <div className="card-foot update-notes-foot">
          {downloading && (
            <div className="update-notes-progress">
              <div className="update-progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? 0}>
                <span style={{ width: `${percent ?? 15}%` }} />
              </div>
              <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                {percent != null ? `${percent}%` : t("update.installing")}
              </div>
            </div>
          )}
          {actions?.error && <div className="err-text">{actions.error}</div>}
          {actions?.note && <div className="muted update-notes-note">{actions.note}</div>}
          <div className="update-notes-actions">
            {actions?.canAuto && (
              <button
                type="button"
                className="btn primary sm is-wide"
                disabled={actions.installing || actions.busy}
                onClick={actions.onAuto}
              >
                {actions.installing || downloading ? t("update.installing") : t("update.auto")}
              </button>
            )}
            {actions?.manualUrl && (
              <button
                type="button"
                className={"btn sm" + (manualWide ? " is-wide" : "")}
                disabled={!!actions.installing}
                onClick={actions.onManual}
              >
                {t("update.manualUpdate")}
              </button>
            )}
            {actions && (
              <button
                type="button"
                className="btn sm"
                disabled={actions.busy || actions.installing || !version}
                onClick={actions.onSkip}
              >
                {t("update.skip")}
              </button>
            )}
            <button
              type="button"
              className={"btn sm" + (actions ? " ghost" : " primary") + (!actions || actions.canAuto ? " is-wide" : "")}
              onClick={onClose}
              autoFocus={!actions}
            >
              {t("common.gotIt")}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
