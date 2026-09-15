import { useEffect, useRef } from "react";
import { ChevronLeft, Pin, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Empty } from "../ui/common";
import { MobileListToolbar } from "../ui/MobileListToolbar";
import { pushMobileBack } from "../shared/mobileBack";
import { useNotesModel } from "../shared/hooks/useNotesModel";
import { ingestNoteImage, NoteEditorCard, NotesDialogs, NotesFilters } from "./Notes.shared";

export function NotesMobile() {
  const { t } = useTranslation();
  const m = useNotesModel();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!m.detailOpen) return;
    return pushMobileBack(() => {
      void m.selectNote(null);
      return true;
    });
  }, [m.detailOpen]);

  function pickImage() {
    inputRef.current?.click();
  }

  if (m.detailOpen) {
    return (
      <div className="notes-mobile-detail">
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            ingestNoteImage(m, file);
          }}
        />
        <NoteEditorCard
          m={m}
          layout={m.mobileTab === "preview" ? "preview" : "edit"}
          onLayout={(v) => m.setMobileTab(v === "preview" ? "preview" : "edit")}
          modes={["edit", "preview"]}
          onInsertImage={pickImage}
          mobile
          leading={
            <button type="button" className="m-icon-btn" aria-label={t("common.back")} onClick={() => void m.selectNote(null)}>
              <ChevronLeft size={22} />
            </button>
          }
        />
        <NotesDialogs m={m} />
      </div>
    );
  }

  return (
    <div className="stack-lg">
      <MobileListToolbar
        query={m.q}
        onQueryChange={m.setQ}
        placeholder={t("notes.search")}
        addLabel={t("pages.notesNew")}
        addDisabled={m.writesLocked}
        onAdd={m.createNote}
      />
      <NotesFilters m={m} hideSearch />
      {m.filteredEntries.length === 0 ? (
        <div className="card" style={{ padding: "30px 10px" }}>
          <Empty icon="📝" text={m.q ? t("notes.emptySearch") : t("notes.empty")} />
        </div>
      ) : (
        <div className="m-note-list">
          {m.filteredEntries.map((e) => (
            <button key={e.id} type="button" className="m-note-card" onClick={() => void m.selectNote(e.id)}>
              <div className="m-note-card-title">
                {e.pinned && <Pin size={13} />}
                <span>{e.title.trim() || t("notes.untitled")}</span>
              </div>
              <div className="m-note-card-sub">
                {(e.tags || []).slice(0, 3).map((tag) => `#${tag}`).join(" ")}
                {(e.tags || []).length ? " · " : ""}
                {m.formatUpdatedAt(e.updatedAt)}
              </div>
              {e.excerpt && <div className="m-note-card-excerpt">{e.excerpt}</div>}
            </button>
          ))}
        </div>
      )}
      <button type="button" className="m-file-fab" disabled={m.writesLocked} aria-label={t("pages.notesNew")} onClick={m.createNote}>
        <Plus size={22} />
      </button>
      <NotesDialogs m={m} />
    </div>
  );
}
