import { useEffect, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Columns2, Download, Eye, FileCode2, Pin, Plus, Trash2, Type, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ConfirmDangerDialog, Empty, ErrorDialog } from "../ui/common";
import { GroupDialog } from "../ui/GroupDialog";
import { MarkdownToolbar } from "../ui/MarkdownToolbar";
import { NoteMarkdownEditor } from "../ui/NoteMarkdownEditor";
import { extractKmassetHashes, type NotesModel, type NotesViewLayout } from "../shared/hooks/useNotesModel";
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

export function NotePreview({ markdown }: { markdown: string }) {
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
    return <div className="note-preview note-preview-empty">{t("notes.previewEmpty")}</div>;
  }

  return (
    <div className="note-preview">
      <Markdown
        remarkPlugins={[remarkGfm]}
        urlTransform={urlTransform}
        components={{ img: ({ src, alt }) => <NoteImg src={src} alt={alt} /> }}
      >
        {markdown}
      </Markdown>
    </div>
  );
}

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

export function NoteIndexItem({ e, m }: { e: NoteEntry; m: NotesModel }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className={"note-index-item" + (m.activeId === e.id ? " on" : "")}
      onClick={() => void m.selectNote(e.id)}
    >
      <div className="note-index-title">
        {e.pinned && <Pin size={12} />}
        <span>{e.title.trim() || t("notes.untitled")}</span>
      </div>
      {(e.tags || []).length > 0 && (
        <div className="note-index-tags">{e.tags.slice(0, 3).map((tag) => `#${tag}`).join(" ")}</div>
      )}
      {e.excerpt && <div className="note-index-excerpt">{e.excerpt}</div>}
      <div className="note-index-time">{m.formatUpdatedAt(e.updatedAt)}</div>
    </button>
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
  if (!m.exportModal) return null;
  return (
    <div className="wizard-overlay">
      <div className="card" style={{ width: 420, maxWidth: "96vw" }}>
        <div className="card-head">
          <div className="card-title">{t("notes.exportTitle")}</div>
        </div>
        <div className="card-body stack">
          <button type="button" className="btn" onClick={() => void m.exportNote("md_raw")}>
            {t("notes.exportRaw")}
          </button>
          <button type="button" className="btn" onClick={() => void m.exportNote("md_inline")}>
            {t("notes.exportInline")}
          </button>
        </div>
        <div className="card-foot" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn ghost sm" onClick={() => m.setExportModal(false)}>
            {t("common.cancel")}
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

export function NoteSaveState({ m }: { m: NotesModel }) {
  const { t } = useTranslation();
  return (
    <span className={"note-save-state" + (m.saving ? " saving" : m.isDirty ? " dirty" : " saved")}>
      {m.saving ? t("notes.saving") : m.isDirty ? t("notes.dirty") : t("notes.saved")}
    </span>
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

  return (
    <div className={"note-editor-card" + (mobile ? " is-mobile" : "")}>
      <NoteDraftBanner m={m} />
      <div className="note-editor-chrome">
        <div className="note-editor-title-row">
          {leading}
          <label className={"note-title-field" + (m.draft.title.trim() ? "" : " is-empty")}>
            <span className="note-title-label">{t("notes.titleLabel")}</span>
            <span className="note-title-control">
              <Type size={16} className="note-title-icon" aria-hidden />
              <input
                className="note-title-input"
                placeholder={t("notes.titlePlaceholder")}
                value={m.draft.title}
                autoFocus={!m.draft.id && !m.draft.title}
                onChange={(e) => m.updateDraft({ title: e.target.value })}
              />
            </span>
          </label>
          <NoteSaveState m={m} />
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
          <button
            type="button"
            className={"note-icon-btn" + (m.draft.pinned ? " on" : "")}
            title={m.draft.pinned ? t("notes.unpin") : t("notes.pin")}
            aria-label={m.draft.pinned ? t("notes.unpin") : t("notes.pin")}
            onClick={() => m.updateDraft({ pinned: !m.draft.pinned })}
          >
            <Pin size={14} />
          </button>
          <button
            type="button"
            className="note-icon-btn"
            title={t("notes.export")}
            aria-label={t("notes.export")}
            disabled={!m.draft.id}
            onClick={() => m.setExportModal(true)}
          >
            <Download size={14} />
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
        <div className="note-editor-tools">
          {showSource ? (
            <MarkdownToolbar
              onWrap={m.wrapSelection}
              onInsert={m.insertAtCursor}
              onInsertImage={onInsertImage}
              disabled={m.writesLocked || m.assetUploading}
            />
          ) : (
            <div className="md-toolbar" />
          )}
          <NoteLayoutSwitch layout={layout} onLayout={onLayout} modes={modes} />
        </div>
      </div>
      <div className={"notes-panes" + (layout === "split" ? " split" : "")}>
        {showSource && (
          <div className="note-pane">
            {layout === "split" && <div className="note-pane-label">{t("notes.paneSource")}</div>}
            <NoteMarkdownEditor
              ref={m.editorRef}
              value={m.draft.markdown}
              onChange={(markdown) => m.updateDraft({ markdown })}
              placeholder={t("notes.sourcePlaceholder")}
              disabled={m.writesLocked}
              mobile={mobile}
              onImageFile={(file) => ingestNoteImage(m, file)}
            />
          </div>
        )}
        {showPreview && (
          <div className="note-pane note-pane-preview">
            {layout === "split" && <div className="note-pane-label">{t("notes.panePreview")}</div>}
            <NotePreview markdown={m.draft.markdown} />
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
