import { useEffect, useRef, type PointerEvent } from "react";
import { ArrowUpToLine, CheckSquare, Download, Pin, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Empty } from "../ui/common";
import { MobileListToolbar } from "../ui/MobileListToolbar";
import { pushMobileBack } from "../shared/mobileBack";
import { useNotesModel, type NotesModel } from "../shared/hooks/useNotesModel";
import { ingestNoteImage, NoteIndexTags, NoteSelectedMark, NotesDialogs, NotesFilters } from "./Notes.shared";
import { NoteMobileEditor } from "./NoteMobileEditor";
import type { NoteEntry } from "../lib/ipc";
import { useItemFocus } from "../shared/hooks/useItemFocus";

const LONG_PRESS_MS = 500;
const MOVE_CANCEL_PX = 10;

export function NotesMobile() {
  const { t } = useTranslation();
  const m = useNotesModel();
  const inputRef = useRef<HTMLInputElement>(null);
  useItemFocus(true, (id) => {
    m.setGroup("全部");
    m.setQ("");
    m.setSelectedTag(null);
    void m.selectNote(id);
  });

  useEffect(() => {
    if (!m.detailOpen) return;
    return pushMobileBack(() => {
      void m.selectNote(null);
      return true;
    });
  }, [m.detailOpen]);

  useEffect(() => {
    if (m.detailOpen || !m.selectionMode) return;
    return pushMobileBack(() => {
      m.exitSelectionMode();
      return true;
    });
  }, [m.detailOpen, m.selectionMode]);

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
        <NoteMobileEditor
          m={m}
          onInsertImage={pickImage}
          onBack={() => void m.selectNote(null)}
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
        beforeAdd={
          <button
            type="button"
            className="m-list-side-btn"
            disabled={m.filteredEntries.length === 0}
            aria-label={t("notes.export")}
            onClick={m.openExport}
          >
            <Download size={16} />
            <span>{t("notes.export")}</span>
          </button>
        }
      />
      <NotesFilters m={m} hideSearch />
      {m.filteredEntries.length === 0 ? (
        <div className="card" style={{ padding: "30px 10px" }}>
          <Empty icon="📝" text={m.q ? t("notes.emptySearch") : t("notes.empty")} />
        </div>
      ) : (
        <div className="m-note-list">
          {m.selectionMode && (
            <div className="m-note-select-bar">
              <span className="m-note-select-count">{t("notes.selectedCount", { n: m.selectedCount })}</span>
              <button type="button" className="m-note-select-all" onClick={m.toggleSelectAllFiltered}>
                {m.allFilteredSelected ? t("notes.deselectAll") : t("notes.selectAllShort")}
              </button>
              <button type="button" className="m-note-select-done" onClick={m.exitSelectionMode}>
                <CheckSquare size={14} />
                {t("notes.multiSelectDone")}
              </button>
            </div>
          )}
          {m.filteredEntries.map((e) => (
            <NoteMobileCard key={e.id} e={e} m={m} />
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

function NoteMobileCard({ e, m }: { e: NoteEntry; m: NotesModel }) {
  const { t } = useTranslation();
  const timerRef = useRef<number | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);

  function clearPress() {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startRef.current = null;
  }

  function onPointerDown(ev: PointerEvent) {
    if (m.selectionMode) return;
    if (ev.pointerType === "mouse") return;
    startRef.current = { x: ev.clientX, y: ev.clientY };
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      m.markSkipNextOpen();
      m.enterSelectionMode(e.id);
    }, LONG_PRESS_MS);
  }

  function onPointerMove(ev: PointerEvent) {
    const start = startRef.current;
    if (!start || timerRef.current == null) return;
    if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > MOVE_CANCEL_PX) clearPress();
  }

  return (
    <div
      className={
        "m-note-card" + (m.selectedSet.has(e.id) ? " is-checked" : "") + (m.selectionMode ? " is-selecting" : "")
      }
      data-focus-id={e.id}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={clearPress}
      onPointerCancel={clearPress}
      onContextMenu={(ev) => ev.preventDefault()}
    >
      <button
        type="button"
        className="m-note-card-main"
        aria-pressed={m.selectionMode ? m.selectedSet.has(e.id) : undefined}
        onClick={() => m.activateNote(e.id)}
      >
        <div className="m-note-card-title">
          <span>{e.title.trim() || t("notes.untitled")}</span>
        </div>
        <div className="m-note-card-sub">
          <NoteIndexTags tags={e.tags} />
          <span className="m-note-card-time">{m.formatUpdatedAt(e.updatedAt)}</span>
        </div>
        {e.excerpt && <div className="m-note-card-excerpt">{e.excerpt}</div>}
      </button>
      <div className="m-note-card-actions">
        <button
          type="button"
          className={"note-icon-btn" + (e.pinned ? " on" : "")}
          title={e.pinned ? t("notes.unpin") : t("notes.pin")}
          aria-label={e.pinned ? t("notes.unpin") : t("notes.pin")}
          disabled={m.writesLocked}
          onPointerDown={(ev) => ev.stopPropagation()}
          onClick={() => void m.togglePin(e.id)}
        >
          {e.pinned ? <ArrowUpToLine size={14} /> : <Pin size={14} />}
        </button>
      </div>
      {m.selectedSet.has(e.id) && <NoteSelectedMark />}
    </div>
  );
}
