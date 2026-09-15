import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PageHead } from "../ui/common";
import { useNotesModel } from "../shared/hooks/useNotesModel";
import { NoteEditorCard, NoteEditorEmpty, NoteIndexItem, NotesDialogs, NotesEmpty, NotesFilters } from "./Notes.shared";

export function NotesDesktop() {
  const { t } = useTranslation();
  const m = useNotesModel();

  return (
    <div className="stack-lg notes-page">
      <PageHead title={t("pages.notesTitle")} desc={t("pages.notesDesc")} />
      <NotesFilters m={m} />

      <div className="notes-workspace">
        <aside className="notes-index">
          <div className="notes-index-head">
            <span className="notes-index-head-title">{t("notes.listTitle")}</span>
            <button type="button" className="btn primary sm" disabled={m.writesLocked} onClick={m.createNote}>
              <Plus size={13} /> {t("pages.notesNew")}
            </button>
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
