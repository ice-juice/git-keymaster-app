import { forwardRef, useEffect, useRef, useState, type ReactNode, type UIEvent } from "react";
import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { ArrowUpToLine, Check, Columns2, Eye, FileCode2, Pin, Plus, Save, Trash2, Type, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ConfirmDangerDialog, Empty, ErrorDialog } from "../ui/common";
import { GroupDialog } from "../ui/GroupDialog";
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
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row between">
        <div className="group-tabs">
          {m.tabs.map((g) => {
            const count = g === "全部" ? m.entries.length : m.entries.filter((e) => (e.group || "未分组") === g).length;
            const color = m.groups.find((item) => item.name === g)?.color;
            const label = g === "全部" ? t("notes.all") : g === "未分组" ? t("notes.ungrouped") : g;
            return (
              <button key={g} type="button" className={"group-tab" + (m.group === g ? " on" : "")} onClick={() => m.setGroup(g)}>
                {color && <span className="group-tab-dot" style={{ background: color }} />}
                <span>{label}</span>
                <span className="group-tab-count">{count}</span>
              </button>
            );
          })}
          <button type="button" className="group-tab dashed" disabled={m.writesLocked} onClick={() => m.setGroupDlg(true)}>
            {t("notes.newGroup")}
          </button>
        </div>
        {!hideSearch && (
          <input className="input" style={{ maxWidth: 260 }} placeholder={t("notes.search")} value={m.q} onChange={(e) => m.setQ(e.target.value)} />
        )}
      </div>
      {m.allTags.length > 0 && (
        <div className="note-tag-row">
          {m.allTags.map((tag) => (
            <button
              key={tag}
              type="button"
              className={"note-tag" + (m.selectedTag === tag ? " on" : "")}
              onClick={() => m.setSelectedTag(m.selectedTag === tag ? null : tag)}
            >
              #{tag}
            </button>
          ))}
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

export const TAG_PALETTE = [
  { bg: "rgba(79, 70, 229, 0.16)", fg: "#3730a3" },
  { bg: "rgba(219, 39, 119, 0.16)", fg: "#9d174d" },
  { bg: "rgba(5, 150, 105, 0.16)", fg: "#065f46" },
  { bg: "rgba(217, 119, 6, 0.18)", fg: "#92400e" },
  { bg: "rgba(2, 132, 199, 0.16)", fg: "#075985" },
  { bg: "rgba(124, 58, 237, 0.16)", fg: "#5b21b6" },
  { bg: "rgba(225, 29, 72, 0.16)", fg: "#9f1239" },
  { bg: "rgba(13, 148, 136, 0.16)", fg: "#115e59" },
] as const;

export function tagTone(tag: string) {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = (hash * 31 + tag.charCodeAt(i)) | 0;
  return Math.abs(hash) % TAG_PALETTE.length;
}

export function NoteIndexTags({ tags }: { tags?: string[] }) {
  const shown = (tags || []).map((tag) => tag.trim()).filter(Boolean).slice(0, 3);
  if (!shown.length) return null;
  return (
    <div className="note-index-tags">
      {shown.map((tag) => {
        const tone = TAG_PALETTE[tagTone(tag)];
        return (
          <span key={tag} className="note-index-tag" style={{ backgroundColor: tone.bg, color: tone.fg }}>
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

export function NoteTagEditor({ m }: { m: NotesModel }) {
  const { t } = useTranslation();
  const [raw, setRaw] = useState("");

  function commit(value: string) {
    const tag = value.trim().replace(/^#/, "");
    if (!tag || m.draft.tags.includes(tag)) {
      setRaw("");
      return;
    }
    m.updateDraft({ tags: [...m.draft.tags, tag] });
    setRaw("");
  }

  return (
    <div className="note-tag-editor">
      {m.draft.tags.map((tag) => (
        <span key={tag} className="note-tag on">
          #{tag}
          <button
            type="button"
            className="note-tag-x"
            onClick={() => m.updateDraft({ tags: m.draft.tags.filter((x) => x !== tag) })}
          >
            <X size={10} />
          </button>
        </span>
      ))}
      <input
        className="note-chip-input"
        placeholder={t("notes.tagsPlaceholder")}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit(raw);
          }
        }}
        onBlur={() => {
          if (raw.trim()) commit(raw);
        }}
      />
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
  useOverlayBack(!!m.groupDlg, () => m.setGroupDlg(false));
  useOverlayBack(!!m.exportModal, () => m.setExportModal(false));
  useOverlayBack(!!m.pendingDelete, () => m.setPendingDelete(null));
  useOverlayBack(!!m.leaveConfirm, () => m.setLeaveConfirm(null));
  return (
    <>
      <ErrorDialog message={m.err} onClose={() => m.setErr("")} />
      {m.groupDlg && (
        <GroupDialog existing={m.groups.map((g) => g.name)} onCancel={() => m.setGroupDlg(false)} onConfirm={m.saveGroup} />
      )}
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
}: {
  layout: NotesViewLayout;
  onLayout: (v: NotesViewLayout) => void;
  modes: NotesViewLayout[];
}) {
  const { t } = useTranslation();
  const items: { id: NotesViewLayout; label: string; icon: ReactNode }[] = [
    { id: "edit", label: t("notes.layoutEdit"), icon: <FileCode2 size={13} /> },
    { id: "split", label: t("notes.layoutSplit"), icon: <Columns2 size={13} /> },
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
          <input
            className="note-chip-input note-group-input"
            list="note-group-options"
            placeholder={t("notes.groupPlaceholder")}
            value={m.draft.group || ""}
            onChange={(e) => m.updateDraft({ group: e.target.value || undefined })}
          />
          <datalist id="note-group-options">
            {m.groups.map((g) => (
              <option key={g.name} value={g.name} />
            ))}
          </datalist>
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
