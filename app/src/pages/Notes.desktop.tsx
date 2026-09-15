import { CheckSquare, Download, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PageHead } from "../ui/common";
import { useNotesModel } from "../shared/hooks/useNotesModel";
import {
  NoteEditorCard,
  NoteEditorEmpty,
  NoteIndexItem,
  NotesDialogs,
  NotesEmpty,
  NotesFilters,
} from "./Notes.shared";

export function NotesDesktop() {
  const { t } = useTranslation();
  const m = useNotesModel();

  return (
    <div className="stack-lg notes-page">
      <PageHead title={t("pages.notesTitle")} desc={t("pages.notesDesc")} />
      <NotesFilters m={m} />

      <div className="notes-workspace">
        <aside className="notes-index">
          <div className={"notes-index-head" + (m.selectionMode ? " is-selecting" : "")}>
            <div className="notes-index-head-title">
              {m.selectionMode ? (
                <>
                  <span className="notes-index-head-count">{t("notes.selectedCount", { n: m.selectedCount })}</span>
                  <button type="button" className="notes-index-text-btn" onClick={m.toggleSelectAllFiltered}>
                    {m.allFilteredSelected ? t("notes.deselectAll") : t("notes.selectAllShort")}
                  </button>
                </>
              ) : (
                <span>{t("notes.listTitle")}</span>
              )}
            </div>
            <div className="notes-index-head-actions">
              {!m.selectionMode && (
                <button
                  type="button"
                  className="btn sm"
                  disabled={m.filteredEntries.length === 0}
                  onClick={() => m.enterSelectionMode()}
                >
                  <CheckSquare size={13} /> {t("notes.multiSelect")}
                </button>
              )}
              <button
                type="button"
                className="btn sm"
                disabled={m.filteredEntries.length === 0}
                onClick={m.openExport}
              >
                <Download size={13} /> {t("notes.export")}
              </button>
              {m.selectionMode ? (
                <button type="button" className="btn sm" onClick={m.exitSelectionMode}>
                  <CheckSquare size={13} /> {t("notes.multiSelectDone")}
                </button>
              ) : (
                <button type="button" className="btn primary sm" disabled={m.writesLocked} onClick={m.createNote}>
                  <Plus size={13} /> {t("pages.notesNew")}
                </button>
              )}
            </div>
          </div>
          <div className="notes-index-list">
            {m.filteredEntries.length === 0 ? (
              <NotesEmpty m={m} />
            ) : (
              m.filteredEntries.map((e) => <NoteIndexItem key={e.id} e={e} m={m} />)
            )}
          </div>
        </aside>

        <section className="notes-editor-host">
          {m.detailOpen ? (
            <NoteEditorCard
              m={m}
              layout={m.viewLayout}
              onLayout={m.setViewLayout}
              modes={["edit", "split", "preview"]}
              onInsertImage={() => void m.uploadAndInsertAsset()}
            />
          ) : (
            <NoteEditorEmpty onCreate={m.createNote} writesLocked={m.writesLocked} />
          )}
        </section>
      </div>

      <NotesDialogs m={m} />
    </div>
  );
}
