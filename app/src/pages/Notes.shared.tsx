import { forwardRef, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type UIEvent } from "react";
import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { ArrowUpToLine, Check, ChevronDown, Columns2, Eye, FileCode2, Pin, Plus, Rows2, Save, Tag, Trash2, Type, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ConfirmDangerDialog, Empty, ErrorDialog } from "../ui/common";
import { GroupManageDialogs, groupManageHandlers } from "../ui/GroupDialog";
import { GroupReorderButtons } from "../ui/GroupReorderButtons";
import { GroupTabs } from "../ui/GroupTabs";
import { moveGroupNames } from "../ui/groupOrder";
import { MarkdownToolbar } from "../ui/MarkdownToolbar";
import { applyScrollRatio, NoteMarkdownEditor, scrollRatioOf } from "../ui/NoteMarkdownEditor";
import {
  extractKmassetHashes,
  type NoteExportFormat,
  type NoteExportScope,
  type NotesModel,
  type NotesViewLayout,
} from "../shared/hooks/useNotesModel";
import { useOverlayBack } from "../shared/mobileBack";
import { noteTagColor } from "../shared/tagColor";
import { api } from "../lib/ipc";
import type { NoteEntry } from "../lib/ipc";

const assetCache = new Map<string, string>();

function urlTransform(url: string) {
  if (url.startsWith("kmasset://") || url.startsWith("data:image/")) return url;
  if (url.startsWith("#") || url.startsWith("mailto:")) return url;
  return "";
}

export function ingestNoteImage(m: NotesModel, file: File) {
  void file.arrayBuffer().then((buf) => {
    void m.uploadAndInsertAsset({ name: file.name || "paste.png", bytes: new Uint8Array(buf) });
  });
}

export function notePlainStats(markdown: string) {
  const chars = [...markdown].length;
  const lines = markdown ? markdown.split("\n").length : 0;
  return { chars, lines };
}

function NoteImg({ src, alt }: { src?: string; alt?: string }) {
  const [url, setUrl] = useState<string | null>(() => {
    if (!src) return null;
    if (src.startsWith("data:")) return src;
    if (src.startsWith("kmasset://")) {
      const hash = src.slice("kmasset://".length, "kmasset://".length + 64).toLowerCase();
      return assetCache.get(hash) || null;
    }
    return null;
  });

  useEffect(() => {
    if (!src?.startsWith("kmasset://")) return;
    const hash = src.slice("kmasset://".length, "kmasset://".length + 64).toLowerCase();
    if (assetCache.has(hash)) {
      setUrl(assetCache.get(hash) || null);
      return;
    }
    let cancelled = false;
    api
      .noteAssetGet(hash)
      .then((data) => {
        assetCache.set(hash, data);
        if (!cancelled) setUrl(data);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [src]);

  if (!url) return <span className="note-img-ph">{alt || "image"}</span>;
  return <img src={url} alt={alt || ""} className="note-preview-img" />;
}

export const NotePreview = forwardRef<
  HTMLDivElement,
  { markdown: string; onScroll?: (event: UIEvent<HTMLDivElement>) => void; breaks?: boolean }
>(function NotePreview({ markdown, onScroll, breaks }, ref) {
  const { t } = useTranslation();

  useEffect(() => {
    for (const hash of extractKmassetHashes(markdown)) {
      if (assetCache.has(hash)) continue;
      api
        .noteAssetGet(hash)
        .then((data) => assetCache.set(hash, data))
        .catch(() => {});
    }
  }, [markdown]);

  if (!markdown.trim()) {
    return (
      <div ref={ref} className="note-preview note-preview-empty" onScroll={onScroll}>
        {t("notes.previewEmpty")}
      </div>
    );
  }

  return (
    <div ref={ref} className={"note-preview" + (breaks ? " is-hard-breaks" : "")} onScroll={onScroll}>
      <Markdown
        remarkPlugins={breaks ? [remarkGfm, remarkBreaks] : [remarkGfm]}
        urlTransform={urlTransform}
        components={{ img: ({ src, alt }) => <NoteImg src={src} alt={alt} /> }}
      >
        {markdown}
      </Markdown>
    </div>
  );
});

export function NotesFilters({ m, hideSearch }: { m: NotesModel; hideSearch?: boolean }) {
  const { t } = useTranslation();
  const manage = groupManageHandlers(m);
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="group-filter-row">
        <GroupTabs
          value={m.group}
          onChange={m.setGroup}
          items={m.tabs.map((g) => ({
            key: g,
            label: g === "全部" ? t("notes.all") : g === "未分组" ? t("notes.ungrouped") : g,
            count: g === "全部" ? m.entries.length : m.entries.filter((e) => (e.group || "未分组") === g).length,
            color: m.groups.find((item) => item.name === g)?.color,
            sortable: g !== "全部" && g !== "未分组",
          }))}
          onCreate={manage.onCreate}
          onEdit={manage.onEdit}
          onDelete={manage.onDelete}
          onReorder={m.writesLocked ? undefined : m.reorderGroups}
          createLabel={t("notes.newGroup")}
          createDisabled={m.writesLocked}
        />
        {!hideSearch && (
          <input className="input" style={{ maxWidth: 260 }} placeholder={t("notes.search")} value={m.q} onChange={(e) => m.setQ(e.target.value)} />
        )}
      </div>
      {m.allTags.length > 0 && (
        <div className="note-tag-row">
          {m.allTags.map((tag) => {
            const selected = m.selectedTag === tag;
            const color = noteTagColor(tag, selected);
            return (
              <button
                key={tag}
                type="button"
                className={"note-tag" + (selected ? " on" : "")}
                style={{ color: color.fg, background: color.bg, borderColor: color.border }}
                onClick={() => m.setSelectedTag(selected ? null : tag)}
              >
                #{tag}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function NoteSelectedMark() {
  return (
    <span className="note-selected-mark" aria-hidden>
      <Check size={12} strokeWidth={2.6} />
    </span>
  );
}


export function NoteIndexTags({ tags }: { tags?: string[] }) {
  const shown = (tags || []).map((tag) => tag.trim()).filter(Boolean).slice(0, 3);
  if (!shown.length) return null;
  return (
    <div className="note-index-tags">
      {shown.map((tag) => {
        const color = noteTagColor(tag);
        return (
          <span key={tag} className="note-index-tag" style={{ backgroundColor: color.bg, color: color.fg }}>
            #{tag}
          </span>
        );
      })}
    </div>
  );
}

export function NoteIndexItem({ e, m }: { e: NoteEntry; m: NotesModel }) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const checked = m.selectedSet.has(e.id);
  return (
    <div
      className={
        "note-index-item" +
        (m.activeId === e.id ? " on" : "") +
        (checked ? " is-checked" : "") +
        (m.selectionMode ? " is-selecting" : "")
      }
      data-focus-id={e.id}
      onContextMenu={(ev) => {
        ev.preventDefault();
        setMenu({ x: ev.clientX, y: ev.clientY });
      }}
    >
      <button
        type="button"
        className="note-index-main"
        aria-pressed={m.selectionMode ? checked : undefined}
        onClick={() => m.activateNote(e.id)}
      >
        <div className="note-index-title">
          <span>{e.title.trim() || t("notes.untitled")}</span>
        </div>
        <NoteIndexTags tags={e.tags} />
        {e.excerpt && <div className="note-index-excerpt">{e.excerpt}</div>}
        <div className="note-index-time">{m.formatUpdatedAt(e.updatedAt)}</div>
      </button>
      <div className="note-index-actions">
        <button
          type="button"
          className={"note-icon-btn" + (e.pinned ? " on" : "")}
          title={e.pinned ? t("notes.unpin") : t("notes.pin")}
          aria-label={e.pinned ? t("notes.unpin") : t("notes.pin")}
          disabled={m.writesLocked}
          onClick={(ev) => {
            ev.stopPropagation();
            void m.togglePin(e.id);
          }}
        >
          {e.pinned ? <ArrowUpToLine size={13} /> : <Pin size={13} />}
        </button>
      </div>
      {checked && <NoteSelectedMark />}
      {menu && (
        <>
          <div
            className="note-ctx-backdrop"
            onClick={() => setMenu(null)}
            onContextMenu={(ev) => {
              ev.preventDefault();
              setMenu(null);
            }}
          />
          <div className="note-ctx-menu" style={{ left: menu.x, top: menu.y }} role="menu">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                m.enterSelectionMode(e.id);
                setMenu(null);
              }}
            >
              {t("notes.ctxMultiSelect")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function NoteGroupField({ m }: { m: NotesModel }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const current = (m.draft.group || "").trim();
  const matched = m.groups.find((g) => g.name.toLowerCase() === current.toLowerCase());
  const q = query.trim().toLowerCase();
  const groupNames = m.groups.map((g) => g.name);
  const showOrder = !m.writesLocked && !q && groupNames.length > 1;
  const items = [
    { key: "", label: t("group.none"), color: null as string | null | undefined, sortable: false },
    ...m.groups.map((g) => ({ key: g.name, label: g.name, color: g.color, sortable: true })),
  ].filter((item) => !q || item.label.toLowerCase().includes(q) || item.key.toLowerCase().includes(q));

  function apply(name: string) {
    m.updateDraft({ group: name || undefined });
    setOpen(false);
    setQuery("");
  }

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    function onPointer(ev: PointerEvent) {
      if (wrapRef.current && ev.target instanceof Node && !wrapRef.current.contains(ev.target)) {
        setOpen(false);
        setQuery("");
      }
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") {
        setOpen(false);
        setQuery("");
      }
    }
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="note-group-picker" ref={wrapRef}>
      <button
        type="button"
        className={"note-group-select" + (open ? " is-open" : "")}
        title={t("notes.groupPlaceholder")}
        onClick={() => setOpen((v) => !v)}
      >
        {matched?.color ? <span className="group-tab-dot" style={{ background: matched.color }} /> : null}
        <span className={"note-group-select-label" + (!current ? " is-none" : "")}>
          {matched?.name || current || t("group.none")}
        </span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="note-group-menu" role="listbox">
          <input
            ref={inputRef}
            className="note-group-menu-input"
            placeholder={m.groups.length ? t("group.orNew") : t("group.newPh")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && query.trim()) {
                e.preventDefault();
                apply(query.trim());
              }
            }}
          />
          <div className="note-group-menu-list">
            {items.length === 0 ? (
              <div className="note-group-menu-empty">{t("group.noMatch")}</div>
            ) : (
              items.map((item) => {
                const on = item.key === (matched?.name || "");
                const sortIndex = item.sortable ? groupNames.indexOf(item.key) : -1;
                const rowOrder = showOrder && item.sortable && sortIndex >= 0;
                return (
                  <div
                    key={item.key || "none"}
                    role="option"
                    aria-selected={on}
                    className={"note-group-menu-item" + (on ? " on" : "")}
                  >
                    <button
                      type="button"
                      className="group-menu-item-pick"
                      onClick={() => apply(item.key)}
                    >
                      <span className="note-group-menu-main">
                        {item.color ? <span className="group-tab-dot" style={{ background: item.color }} /> : null}
                        <span>{item.label}</span>
                      </span>
                      {on && !rowOrder ? <Check size={12} /> : null}
                    </button>
                    {rowOrder ? (
                      <GroupReorderButtons
                        canUp={sortIndex > 0}
                        canDown={sortIndex < groupNames.length - 1}
                        onMove={(action) => {
                          const next = moveGroupNames(groupNames, item.key, action);
                          if (next) void m.reorderGroups(next);
                        }}
                      />
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function NoteTagEditor({ m }: { m: NotesModel }) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const [raw, setRaw] = useState("");
  const [overflows, setOverflows] = useState(false);
  const [dragTag, setDragTag] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rawRef = useRef(raw);
  const tagsRef = useRef(m.draft.tags);
  rawRef.current = raw;
  tagsRef.current = m.draft.tags;

  const suggestions = useMemo(() => {
    const q = raw.trim().replace(/^#/, "").toLowerCase();
    return (m.allTags || [])
      .filter((tag) => !m.draft.tags.includes(tag))
      .filter((tag) => !q || tag.toLowerCase().includes(q))
      .slice(0, 8);
  }, [m.allTags, m.draft.tags, raw]);

  function commit(value: string) {
    const tag = value.trim().replace(/^#/, "");
    if (!tag || m.draft.tags.includes(tag)) {
      setRaw("");
      return;
    }
    m.updateDraft({ tags: [...m.draft.tags, tag] });
    setRaw("");
  }

  function closeAdd() {
    const pending = rawRef.current;
    if (pending.trim()) commit(pending);
    setAdding(false);
    setRaw("");
  }

  function moveByIndex(from: number, to: number) {
    if (from === to || from < 0 || to < 0) return;
    const tags = tagsRef.current;
    if (from >= tags.length || to >= tags.length) return;
    const next = [...tags];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    tagsRef.current = next;
    m.updateDraft({ tags: next });
  }

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const check = () => setOverflows(track.scrollWidth > track.clientWidth + 2);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(track);
    return () => ro.disconnect();
  }, [m.draft.tags, adding]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const track = trackRef.current;
    if (!wrap || !track) return;
    const onWheel = (e: WheelEvent) => {
      if (track.scrollWidth <= track.clientWidth) return;
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!delta) return;
      e.preventDefault();
      track.scrollLeft += delta;
    };
    wrap.addEventListener("wheel", onWheel, { passive: false });
    return () => wrap.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    if (!adding) return;
    inputRef.current?.focus();
    const track = trackRef.current;
    if (track) track.scrollLeft = track.scrollWidth;
  }, [adding, m.draft.tags.length]);

  useEffect(() => {
    if (!adding) return;
    function onPointer(ev: PointerEvent) {
      const wrap = wrapRef.current;
      if (wrap && ev.target instanceof Node && !wrap.contains(ev.target)) {
        closeAdd();
      }
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") {
        setAdding(false);
        setRaw("");
      }
    }
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [adding, m.draft.tags]);

  function onTrackPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".note-tag")) return;
    const node = trackRef.current;
    if (!node || node.scrollWidth <= node.clientWidth) return;
    const scroller = node;
    e.preventDefault();
    const startX = e.clientX;
    const startScroll = scroller.scrollLeft;
    scroller.setPointerCapture(e.pointerId);
    scroller.classList.add("is-panning");

    function move(ev: PointerEvent) {
      scroller.scrollLeft = startScroll - (ev.clientX - startX);
    }
    function up() {
      scroller.classList.remove("is-panning");
      scroller.releasePointerCapture(e.pointerId);
      scroller.removeEventListener("pointermove", move);
      scroller.removeEventListener("pointerup", up);
      scroller.removeEventListener("pointercancel", up);
    }
    scroller.addEventListener("pointermove", move);
    scroller.addEventListener("pointerup", up);
    scroller.addEventListener("pointercancel", up);
  }

  function onChipPointerDown(index: number, e: ReactPointerEvent<HTMLSpanElement>) {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".note-tag-x")) return;
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const startY = e.clientY;
    const draggingName = tagsRef.current[index];
    let from = index;
    let started = false;

    function insertIndexAt(clientX: number) {
      const scroller = trackRef.current;
      if (!scroller) return from;
      const chips = [...scroller.querySelectorAll<HTMLElement>("[data-note-index]")];
      if (chips.length === 0) return from;
      for (let i = 0; i < chips.length; i++) {
        const rect = chips[i].getBoundingClientRect();
        if (clientX < rect.left + rect.width / 2) return i;
      }
      return chips.length - 1;
    }

    function onMove(ev: PointerEvent) {
      if (!started) {
        if (Math.abs(ev.clientX - startX) < 3 && Math.abs(ev.clientY - startY) < 3) return;
        started = true;
        setDragTag(draggingName);
        document.body.style.cursor = "grabbing";
        document.body.style.userSelect = "none";
      }
      ev.preventDefault();
      const scroller = trackRef.current;
      if (scroller) {
        const rect = scroller.getBoundingClientRect();
        if (ev.clientX > rect.right - 24) scroller.scrollLeft += 12;
        else if (ev.clientX < rect.left + 24) scroller.scrollLeft -= 12;
      }
      const to = insertIndexAt(ev.clientX);
      if (to !== from) {
        moveByIndex(from, to);
        from = to;
      }
    }

    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setDragTag(null);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  return (
    <div
      className={"note-tag-editor" + (overflows ? " is-overflow" : "") + (dragTag ? " is-sorting" : "")}
      ref={wrapRef}
    >
      <div
        className={"note-tag-track" + (overflows ? " can-pan" : "")}
        ref={trackRef}
        onPointerDown={onTrackPointerDown}
      >
        {m.draft.tags.map((tag, index) => {
          const color = noteTagColor(tag);
          return (
            <span
              key={tag}
              data-note-index={index}
              className={"note-tag on" + (dragTag === tag ? " is-dragging" : "")}
              style={{ backgroundColor: color.bg, color: color.fg, borderColor: color.border }}
              title={t("notes.dragTag")}
              draggable={false}
              onDragStart={(e) => e.preventDefault()}
              onPointerDown={(e) => onChipPointerDown(index, e)}
            >
              #{tag}
              <button
                type="button"
                className="note-tag-x"
                aria-label={t("common.delete")}
                onClick={() => m.updateDraft({ tags: m.draft.tags.filter((x) => x !== tag) })}
              >
                <X size={10} />
              </button>
            </span>
          );
        })}
      </div>

      {adding ? (
        <div className="note-tag-add-box">
          <input
            ref={inputRef}
            className="note-chip-input"
            placeholder={t("notes.tagsPlaceholder")}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                commit(raw);
              } else if (e.key === "Backspace" && !raw && m.draft.tags.length) {
                e.preventDefault();
                m.updateDraft({ tags: m.draft.tags.slice(0, -1) });
              }
            }}
          />
          {suggestions.length > 0 && (
            <div className="note-tag-suggest" role="listbox">
              {suggestions.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className="note-tag-suggest-item"
                  style={{ color: noteTagColor(tag).fg }}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => commit(tag)}
                >
                  #{tag}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <button type="button" className="note-tag-add" onClick={() => setAdding(true)}>
          <Tag size={11} />
          <span>{t("notes.addTag")}</span>
        </button>
      )}
    </div>
  );
}

export function NotesEmpty({ m }: { m: NotesModel }) {
  const { t } = useTranslation();
  return <Empty icon="📝" text={m.q || m.selectedTag ? t("notes.emptySearch") : t("notes.empty")} />;
}

export function NoteEditorEmpty({ onCreate, writesLocked }: { onCreate: () => void; writesLocked: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="note-editor-empty">
      <div className="note-editor-empty-mark">✎</div>
      <div className="note-editor-empty-title">{t("notes.editorEmpty")}</div>
      <div className="note-editor-empty-hint">{t("notes.editorEmptyHint")}</div>
      <button type="button" className="btn primary sm" disabled={writesLocked} onClick={onCreate}>
        <Plus size={13} /> {t("pages.notesNew")}
      </button>
    </div>
  );
}

export function NoteExportModal({ m }: { m: NotesModel }) {
  const { t } = useTranslation();
  const [scope, setScope] = useState<NoteExportScope>(m.selectedCount > 0 ? "selected" : "filtered");
  const [format, setFormat] = useState<NoteExportFormat>("md_raw");

  useEffect(() => {
    if (!m.exportModal) return;
    setScope(m.selectedCount > 0 ? "selected" : "filtered");
    setFormat("md_raw");
  }, [m.exportModal, m.selectedCount]);

  if (!m.exportModal) return null;
  const selectedN = m.selectedCount;
  const filteredN = m.filteredEntries.length;
  const targetN = scope === "selected" ? selectedN : filteredN;
  const formats: { id: NoteExportFormat; label: string }[] = [
    { id: "md_raw", label: t("notes.exportRaw") },
    { id: "md_inline", label: t("notes.exportInline") },
    { id: "pdf", label: t("notes.exportPdf") },
  ];

  return (
    <div className="wizard-overlay">
      <div className="card" style={{ width: 440, maxWidth: "96vw" }}>
        <div className="card-head">
          <div className="card-title">{t("notes.exportTitle")}</div>
        </div>
        <div className="card-body stack">
          <fieldset className="note-export-fieldset">
            <legend className="note-export-legend">{t("notes.exportScope")}</legend>
            <label className={"note-export-option" + (selectedN === 0 ? " is-disabled" : "")}>
              <input
                type="radio"
                name="note-export-scope"
                checked={scope === "selected"}
                disabled={selectedN === 0}
                onChange={() => setScope("selected")}
              />
              <span>{t("notes.exportSelected", { n: selectedN })}</span>
            </label>
            <label className={"note-export-option" + (filteredN === 0 ? " is-disabled" : "")}>
              <input
                type="radio"
                name="note-export-scope"
                checked={scope === "filtered"}
                disabled={filteredN === 0}
                onChange={() => setScope("filtered")}
              />
              <span>{t("notes.exportFiltered", { n: filteredN })}</span>
            </label>
          </fieldset>
          <fieldset className="note-export-fieldset">
            <legend className="note-export-legend">{t("notes.exportFormat")}</legend>
            {formats.map((item) => (
              <label key={item.id} className="note-export-option">
                <input
                  type="radio"
                  name="note-export-format"
                  checked={format === item.id}
                  onChange={() => setFormat(item.id)}
                />
                <span>{item.label}</span>
              </label>
            ))}
          </fieldset>
        </div>
        <div className="card-foot" style={{ justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn ghost sm" disabled={m.exporting} onClick={() => m.setExportModal(false)}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn primary sm"
            disabled={m.exporting || targetN === 0}
            onClick={() => void m.exportNotes(format, scope)}
          >
            {m.exporting ? t("notes.exporting") : t("notes.exportConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function NotesDialogs({ m }: { m: NotesModel }) {
  const { t } = useTranslation();
  useOverlayBack(!!m.groupDlg, () => m.setGroupDlg(null));
  useOverlayBack(!!m.pendingDeleteGroup, () => m.setPendingDeleteGroup(null));
  useOverlayBack(!!m.exportModal, () => m.setExportModal(false));
  useOverlayBack(!!m.pendingDelete, () => m.setPendingDelete(null));
  useOverlayBack(!!m.leaveConfirm, () => m.setLeaveConfirm(null));
  return (
    <>
      <ErrorDialog message={m.err} onClose={() => m.setErr("")} />
      <GroupManageDialogs
        groups={m.groups}
        groupDlg={m.groupDlg}
        pendingDeleteGroup={m.pendingDeleteGroup}
        busy={m.busy}
        onCancel={() => m.setGroupDlg(null)}
        onConfirm={m.saveGroup}
        onCancelDelete={() => m.setPendingDeleteGroup(null)}
        onConfirmDelete={() => void m.confirmDeleteGroup()}
        deleteCount={m.entries.filter((e) => e.group === m.pendingDeleteGroup).length}
      />
      <NoteExportModal m={m} />
      {m.pendingDelete && (
        <ConfirmDangerDialog
          title={t("notes.deleteTitle")}
          message={
            <>
              {t("notes.deleteMsg", { title: m.pendingDelete.title.trim() || t("notes.untitled") })}
            </>
          }
          detail={t("notes.deleteDetail")}
          busy={m.busy}
          onCancel={() => m.setPendingDelete(null)}
          onConfirm={() => void m.deleteNote(m.pendingDelete!.id)}
        />
      )}
      {m.leaveConfirm && (
        <div className="wizard-overlay">
          <div className="card" style={{ width: 400, maxWidth: "96vw" }}>
            <div className="card-head">
              <div className="card-title">{t("notes.leaveDirty")}</div>
            </div>
            <div className="card-foot" style={{ justifyContent: "flex-end", gap: 8 }}>
              <button type="button" className="btn ghost sm" onClick={() => void m.confirmLeave(false)}>
                {t("notes.discardAndLeave")}
              </button>
              <button type="button" className="btn primary sm" onClick={() => void m.confirmLeave(true)}>
                {t("notes.saveAndLeave")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export function NoteDraftBanner({ m }: { m: NotesModel }) {
  const { t } = useTranslation();
  if (!m.offlineDraft) return null;
  return (
    <div className="note-draft-banner">
      <span>{t("notes.draftBanner")}</span>
      <button type="button" className="btn sm primary" onClick={m.restoreOfflineDraft}>
        {t("notes.restoreDraft")}
      </button>
      <button type="button" className="btn sm" onClick={m.discardOfflineDraft}>
        {t("notes.discardDraft")}
      </button>
    </div>
  );
}

export function NoteLayoutSwitch({
  layout,
  onLayout,
  modes,
  splitStacked,
}: {
  layout: NotesViewLayout;
  onLayout: (v: NotesViewLayout) => void;
  modes: NotesViewLayout[];
  splitStacked?: boolean;
}) {
  const { t } = useTranslation();
  const items: { id: NotesViewLayout; label: string; icon: ReactNode }[] = [
    { id: "edit", label: t("notes.layoutEdit"), icon: <FileCode2 size={13} /> },
    { id: "split", label: t("notes.layoutSplit"), icon: splitStacked ? <Rows2 size={13} /> : <Columns2 size={13} /> },
    { id: "preview", label: t("notes.layoutPreview"), icon: <Eye size={13} /> },
  ];
  return (
    <div className="view-switcher note-layout-switch">
      {items
        .filter((item) => modes.includes(item.id))
        .map((item) => (
          <button
            key={item.id}
            type="button"
            className={"view-btn" + (layout === item.id ? " on" : "")}
            onClick={() => onLayout(item.id)}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
    </div>
  );
}

export function NoteEditorCard({
  m,
  layout,
  onLayout,
  modes,
  onInsertImage,
  leading,
  mobile,
}: {
  m: NotesModel;
  layout: NotesViewLayout;
  onLayout: (v: NotesViewLayout) => void;
  modes: NotesViewLayout[];
  onInsertImage: () => void;
  leading?: ReactNode;
  mobile?: boolean;
}) {
  const { t } = useTranslation();
  const stats = notePlainStats(m.draft.markdown);
  const showSource = layout !== "preview";
  const showPreview = layout !== "edit";
  const previewRef = useRef<HTMLDivElement>(null);
  const sourcePaneRef = useRef<HTMLDivElement>(null);
  const scrollLock = useRef<"source" | "preview" | null>(null);
  const scrollUnlock = useRef(0);
  const syncScroll = layout === "split" && !mobile;

  function lockScroll(side: "source" | "preview") {
    scrollLock.current = side;
    window.clearTimeout(scrollUnlock.current);
    scrollUnlock.current = window.setTimeout(() => {
      scrollLock.current = null;
    }, 80);
  }

  useEffect(() => {
    if (!syncScroll) return;
    const root = sourcePaneRef.current;
    if (!root) return;
    const onScroll = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || scrollLock.current === "preview") return;
      if (target.scrollHeight <= target.clientHeight) return;
      lockScroll("source");
      applyScrollRatio(previewRef.current, scrollRatioOf(target));
    };
    root.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => root.removeEventListener("scroll", onScroll, true);
  }, [syncScroll]);

  return (
    <div className={"note-editor-card" + (mobile ? " is-mobile" : "")}>
      <NoteDraftBanner m={m} />
      <div className="note-editor-chrome">
        <div className="note-editor-title-row">
          {leading}
          <label className={"note-title-field" + (m.draft.title.trim() ? "" : " is-empty")}>
            <span className="note-title-label">{t("notes.titleLabel")}</span>
            <span className="note-title-control">
              <Type size={14} className="note-title-icon" aria-hidden />
              <input
                className="note-title-input"
                placeholder={t("notes.titlePlaceholder")}
                value={m.draft.title}
                autoFocus={!m.draft.id && !m.draft.title}
                onChange={(e) => m.updateDraft({ title: e.target.value })}
              />
            </span>
          </label>
        </div>
        <div className="note-editor-meta">
          <NoteGroupField m={m} />
          <NoteTagEditor m={m} />
        </div>
        <div className="note-editor-tools">
          <div className="note-editor-tools-row">
            <NoteLayoutSwitch layout={layout} onLayout={onLayout} modes={modes} />
            <div className="note-editor-tool-actions">
              {m.isDirty && !m.saving && <span className="note-save-state dirty">{t("notes.dirty")}</span>}
              {m.saving && <span className="note-save-state saving">{t("notes.saving")}</span>}
              <button
                type="button"
                className="btn primary sm"
                disabled={m.writesLocked || m.saving || !m.isDirty}
                onClick={() => void m.saveCurrentNote()}
              >
                <Save size={13} /> {m.saving ? t("notes.saving") : t("notes.save")}
              </button>
              <button
                type="button"
                className="note-icon-btn danger"
                title={t("notes.delete")}
                aria-label={t("notes.delete")}
                disabled={!m.draft.id || m.writesLocked}
                onClick={() => m.activeNote && m.setPendingDelete(m.activeNote)}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
          {showSource && (
            <MarkdownToolbar
              onWrap={m.wrapSelection}
              onInsert={m.insertAtCursor}
              onInsertImage={onInsertImage}
              disabled={m.writesLocked || m.assetUploading}
            />
          )}
        </div>
      </div>
      <div className={"notes-panes" + (layout === "split" ? " split" : "")}>
        {showSource && (
          <div
            ref={sourcePaneRef}
            className="note-pane"
            onBlur={(ev) => {
              const next = ev.relatedTarget as Node | null;
              if (next && ev.currentTarget.contains(next)) return;
              m.onEditorFocusLeave();
            }}
          >
            {layout === "split" && <div className="note-pane-label">{t("notes.paneSource")}</div>}
            <NoteMarkdownEditor
              key={m.draft.id ?? "new"}
              ref={m.editorRef}
              value={m.draft.markdown}
              onChange={(markdown) => m.updateDraft({ markdown })}
              placeholder={t("notes.sourcePlaceholder")}
              disabled={m.writesLocked}
              mobile={mobile}
              onImageFile={(file) => ingestNoteImage(m, file)}
              onScrollRatio={
                syncScroll
                  ? (ratio) => {
                      if (scrollLock.current === "preview") return;
                      lockScroll("source");
                      applyScrollRatio(previewRef.current, ratio);
                    }
                  : undefined
              }
            />
          </div>
        )}
        {showPreview && (
          <div className="note-pane note-pane-preview">
            {layout === "split" && <div className="note-pane-label">{t("notes.panePreview")}</div>}
            <NotePreview
              ref={previewRef}
              markdown={m.draft.markdown}
              onScroll={
                syncScroll
                  ? () => {
                      const el = previewRef.current;
                      if (!el || scrollLock.current === "source") return;
                      lockScroll("preview");
                      m.editorRef.current?.setScrollRatio(scrollRatioOf(el));
                    }
                  : undefined
              }
            />
          </div>
        )}
      </div>
      <div className="note-editor-status">
        <span>{t("notes.statChars", { n: stats.chars })}</span>
        <span className="note-status-dot" />
        <span>{t("notes.statLines", { n: stats.lines })}</span>
        {m.activeNote && (
          <>
            <span className="note-status-dot" />
            <span>{m.formatUpdatedAt(m.activeNote.updatedAt)}</span>
          </>
        )}
      </div>
    </div>
  );
}
