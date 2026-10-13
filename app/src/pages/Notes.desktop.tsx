import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { CheckSquare, ChevronLeft, Download, PanelLeft, Plus } from "lucide-react";
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
import { useItemFocus } from "../shared/hooks/useItemFocus";

export function NotesDesktop() {
  const { t } = useTranslation();
  const m = useNotesModel();
  const [editorExpanded, setEditorExpanded] = useState(false);
  const [listPhase, setListPhase] = useState<"closed" | "pre" | "armed" | "open" | "closing">("closed");
  const [chromeH, setChromeH] = useState(0);
  const chromeInnerRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef(0);
  const openRaf = useRef(0);
  useLayoutEffect(() => {
    const node = chromeInnerRef.current;
    if (!node) return;
    const apply = () => setChromeH(node.scrollHeight);
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!m.detailOpen) setEditorExpanded(false);
  }, [m.detailOpen]);
  useEffect(() => {
    if (editorExpanded) return;
    window.clearTimeout(closeTimer.current);
    window.cancelAnimationFrame(openRaf.current);
    setListPhase("closed");
  }, [editorExpanded]);
  useEffect(
    () => () => {
      window.clearTimeout(closeTimer.current);
      window.cancelAnimationFrame(openRaf.current);
    },
    [],
  );
  useEffect(() => {
    if (listPhase !== "open") return;
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        closeList();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [listPhase]);

  function openList() {
    window.clearTimeout(closeTimer.current);
    window.cancelAnimationFrame(openRaf.current);
    setListPhase("pre");
    openRaf.current = window.requestAnimationFrame(() => {
      setListPhase("armed");
      openRaf.current = window.requestAnimationFrame(() => setListPhase("open"));
    });
  }

  function closeList() {
    window.cancelAnimationFrame(openRaf.current);
    setListPhase((phase) => {
      if (phase === "pre" || phase === "armed") return "closed";
      if (phase !== "open") return phase;
      closeTimer.current = window.setTimeout(() => setListPhase("closed"), 480);
      return "closing";
    });
  }

  function onIndexClick(ev: ReactMouseEvent<HTMLElement>) {
    if (!editorExpanded || m.selectionMode) return;
    if ((ev.target as HTMLElement).closest(".note-index-main")) closeList();
  }
  useItemFocus(true, (id) => {
    m.setGroup("全部");
    m.setQ("");
    m.setSelectedTag(null);
    void m.selectNote(id);
  });

  return (
    <div
      className={
        "stack-lg notes-page" +
        (editorExpanded ? " is-editor-expanded" : "") +
        (listPhase !== "closed" ? " is-list-open" : "") +
        (listPhase === "pre" ? " is-list-pre" : "") +
        (listPhase === "open" ? " is-list-shown" : "") +
        (listPhase === "closing" ? " is-list-closing" : "")
      }
      style={{ "--notes-chrome-h": `${chromeH}px` } as CSSProperties}
    >
      <div className="notes-page-chrome">
        <div className="notes-page-chrome-inner" ref={chromeInnerRef}>
          <PageHead title={t("pages.notesTitle")} desc={t("pages.notesDesc")} />
          <NotesFilters m={m} />
        </div>
      </div>

      <div className="notes-workspace">
        <aside
          className="notes-index"
          inert={editorExpanded && listPhase === "closed"}
          onClick={onIndexClick}
        >
          <div className={"notes-index-head" + (m.selectionMode ? " is-selecting" : "")}>
            <div className="notes-index-head-title">
              {editorExpanded && listPhase !== "closed" && (
                <button
                  type="button"
                  className="note-icon-btn notes-drawer-close"
                  title={t("notes.hideNoteList")}
                  aria-label={t("notes.hideNoteList")}
                  onClick={closeList}
                >
                  <ChevronLeft size={14} />
                </button>
              )}
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
          {editorExpanded && listPhase === "closed" && (
            <button
              type="button"
              className="notes-list-edge"
              title={t("notes.showNoteList")}
              aria-label={t("notes.showNoteList")}
              onClick={openList}
            >
              <PanelLeft size={16} />
            </button>
          )}
          {m.detailOpen ? (
            <NoteEditorCard
              m={m}
              layout={m.viewLayout}
              onLayout={m.setViewLayout}
              modes={["edit", "split", "preview"]}
              onInsertImage={() => void m.uploadAndInsertAsset()}
              expanded={editorExpanded}
              onToggleExpand={() => setEditorExpanded((open) => !open)}
              listOpen={listPhase === "open"}
              onToggleList={
                editorExpanded ? () => (listPhase === "open" ? closeList() : openList()) : undefined
              }
            />
          ) : (
            <NoteEditorEmpty onCreate={m.createNote} writesLocked={m.writesLocked} />
          )}
        </section>
        {editorExpanded && listPhase !== "closed" && (
          <button
            type="button"
            className={"notes-list-backdrop" + (listPhase === "closing" ? " is-closing" : "")}
            aria-label={t("notes.hideNoteList")}
            onClick={closeList}
          />
        )}
      </div>

      <NotesDialogs m={m} />
    </div>
  );
}
