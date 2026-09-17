import { useEffect, useRef } from "react";
import { pushMobileBack } from "../shared/mobileBack";
import { Download, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge, Empty } from "../ui/common";
import { MobileListToolbar } from "../ui/MobileListToolbar";
import { editFromEntry, FilesDialogs, FilesFilters } from "./Files.shared";
import { formatBytes, formatUpdatedAt, useFilesModel, type FilesModel } from "../shared/hooks/useFilesModel";
import { entryAttachments, type FileEntry } from "../lib/ipc";
import { FileMobileEditor } from "./FileMobileEditor";

function FileMobileCard({ e, m }: { e: FileEntry; m: FilesModel }) {
  const { t } = useTranslation();
  return (
    <div className="m-file-card">
      <div className="m-file-card-main">
        <div className="m-file-card-name">{e.name}</div>
        <div className="m-file-card-sub">
          {entryAttachments(e).length > 1
            ? t("files.fileCount", { n: entryAttachments(e).length })
            : e.originalName}{" "}
          · {formatBytes(e.size)} · {formatUpdatedAt(e.updatedAt)}
        </div>
      </div>
      <div className="m-file-card-side">
        {e.group && <Badge kind="info">{e.group}</Badge>}
        <button type="button" className="m-icon-btn" aria-label={t("files.more")} onClick={() => m.setSheetEntry(e)}>
          <MoreHorizontal size={18} />
        </button>
      </div>
    </div>
  );
}

export function FilesMobile() {
  const { t } = useTranslation();
  const m = useFilesModel();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!m.sheetEntry) return;
    return pushMobileBack(() => {
      m.setSheetEntry(null);
      return true;
    });
  }, [m.sheetEntry]);

  function pickMobileFile() {
    inputRef.current?.click();
  }

  return (
    <div className="stack-lg">
      <input
        ref={inputRef}
        type="file"
        hidden
        multiple
        onChange={(e) => {
          const files = [...(e.target.files || [])];
          e.target.value = "";
          if (files.length) m.acceptPickedFiles(files);
        }}
      />

      <MobileListToolbar
        query={m.q}
        onQueryChange={m.setQ}
        placeholder={t("files.search")}
        addLabel={t("files.upload")}
        addDisabled={m.writesLocked || m.busy}
        onAdd={pickMobileFile}
      />

      <div className="muted" style={{ fontSize: 12 }}>
        {t("files.usage", { count: m.totalCount, size: formatBytes(m.usageBytes) })}
      </div>

      <FilesFilters m={m} hideSearch />

      {m.filteredEntries.length === 0 ? (
        <div className="card" style={{ padding: "30px 10px" }}>
          <Empty icon="🗄️" text={m.q ? t("files.emptySearch") : t("files.empty")} />
        </div>
      ) : (
        <div className="m-file-list">
          {m.filteredEntries.map((e) => (
            <FileMobileCard key={e.id} e={e} m={m} />
          ))}
        </div>
      )}

      <button
        type="button"
        className="m-file-fab"
        disabled={m.writesLocked}
        aria-label={t("files.uploadAria")}
        onClick={pickMobileFile}
      >
        <Plus size={22} />
      </button>

      {m.sheetEntry && (
        <div className="m-list-sheet-overlay" role="presentation" onClick={() => m.setSheetEntry(null)}>
          <div className="m-list-sheet" role="menu" onClick={(ev) => ev.stopPropagation()}>
            <div className="m-list-sheet-handle" />
            <div className="m-list-sheet-title">{m.sheetEntry.name}</div>
            <div className="muted" style={{ padding: "0 16px 8px", fontSize: 12 }}>
              {t("files.originalName", { name: m.sheetEntry.originalName })}
              <br />
              {formatBytes(m.sheetEntry.size)} · {m.sheetEntry.updatedAt.slice(0, 19).replace("T", " ")}
              {m.sheetEntry.note?.trim() ? (
                <>
                  <br />
                  {m.sheetEntry.note}
                </>
              ) : null}
            </div>
            <button
              type="button"
              className="m-list-sheet-item"
              disabled={!!m.exportingId}
              onClick={() => void m.exportFile(m.sheetEntry!)}
            >
              <span className="m-list-sheet-icon">
                <Download size={18} />
              </span>
              <span className="m-list-sheet-copy">
                <span className="m-list-sheet-label">{t("files.export")}</span>
                <span className="m-list-sheet-hint">{t("files.exportHint")}</span>
              </span>
            </button>
            <button
              type="button"
              className="m-list-sheet-item"
              disabled={m.writesLocked}
              onClick={() => {
                m.setEditor(editFromEntry(m.sheetEntry!));
                m.setSheetEntry(null);
              }}
            >
              <span className="m-list-sheet-icon">
                <Pencil size={18} />
              </span>
              <span className="m-list-sheet-copy">
                <span className="m-list-sheet-label">{t("files.editMeta")}</span>
              </span>
            </button>
            <button
              type="button"
              className="m-list-sheet-item"
              disabled={m.writesLocked}
              onClick={() => {
                m.setPendingDelete(m.sheetEntry);
                m.setSheetEntry(null);
              }}
            >
              <span className="m-list-sheet-icon" style={{ color: "var(--red)" }}>
                <Trash2 size={18} />
              </span>
              <span className="m-list-sheet-copy">
                <span className="m-list-sheet-label" style={{ color: "var(--red)" }}>
                  {t("files.delete")}
                </span>
              </span>
            </button>
            <button type="button" className="m-list-sheet-cancel" onClick={() => m.setSheetEntry(null)}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}

      <FilesDialogs m={m} skipEditor />

      {m.editor && (
        <FileMobileEditor
          m={m}
          onClose={() => m.setEditor(null)}
        />
      )}
    </div>
  );
}
