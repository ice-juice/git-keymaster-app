import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { appUpdateNotes } from "../shared/updateNotes";

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
}: {
  version?: string | null;
  notes: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const body = appUpdateNotes(notes);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!body) return null;

  const title = version
    ? t("update.notesTitleVersion", { version })
    : t("update.notesTitle");

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
          <UpdateNotesBody notes={body} />
        </div>
        <div className="card-foot">
          <button type="button" className="btn primary sm" onClick={onClose} autoFocus>
            {t("common.gotIt")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
