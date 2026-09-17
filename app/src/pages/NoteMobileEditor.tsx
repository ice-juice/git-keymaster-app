import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpToLine,
  Bold,
  Check,
  ChevronDown,
  ChevronLeft,
  Code,
  Download,
  Eye,
  FileCode2,
  Folder,
  FolderPlus,
  Heading1,
  Heading2,
  Heading3,
  ImagePlus,
  Italic,
  Link,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  MoreVertical,
  Pin,
  Plus,
  Quote,
  Save,
  Strikethrough,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { ingestNoteImage, NoteDraftBanner, NotePreview, notePlainStats, TAG_PALETTE, tagTone } from "./Notes.shared";
import { NoteMarkdownEditor } from "../ui/NoteMarkdownEditor";
import { useOverlayBack } from "../shared/mobileBack";
import type { NotesModel } from "../shared/hooks/useNotesModel";

export function NoteMobileEditor({
  m,
  onInsertImage,
  onBack,
}: {
  m: NotesModel;
  onInsertImage: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [groupPickerOpen, setGroupPickerOpen] = useState(false);
  const [tagAdding, setTagAdding] = useState(false);
  const [newTagVal, setNewTagVal] = useState("");
  const titleTextareaRef = useRef<HTMLTextAreaElement>(null);
  const tagInputRef = useRef<HTMLInputElement>(null);

  useOverlayBack(moreMenuOpen, () => setMoreMenuOpen(false));
  useOverlayBack(groupPickerOpen, () => setGroupPickerOpen(false));

  const stats = notePlainStats(m.draft.markdown);
  const isPreview = m.mobileTab === "preview";
  const [viewportBottomOffset, setViewportBottomOffset] = useState(0);
  const wasPreviewRef = useRef(isPreview);

  useEffect(() => {
    const root = document.documentElement;
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const offset = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
      setViewportBottomOffset(offset);
      root.style.setProperty("--km-note-ime", `${offset}px`);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      root.style.removeProperty("--km-note-ime");
    };
  }, []);

  useEffect(() => {
    if (isPreview || viewportBottomOffset <= 0) return;
    const id = window.requestAnimationFrame(() => m.editorRef.current?.revealCursor());
    return () => window.cancelAnimationFrame(id);
  }, [isPreview, viewportBottomOffset, m.editorRef]);

  useEffect(() => {
    const leftPreview = wasPreviewRef.current && !isPreview;
    wasPreviewRef.current = isPreview;
    if (!leftPreview) return;
    const id = window.requestAnimationFrame(() => {
      m.editorRef.current?.focus();
      m.editorRef.current?.revealCursor();
    });
    return () => window.cancelAnimationFrame(id);
  }, [isPreview, m.editorRef]);

  const adjustTitleHeight = useCallback(() => {
    const el = titleTextareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(96, Math.max(32, el.scrollHeight))}px`;
  }, []);

  useEffect(() => {
    adjustTitleHeight();
  }, [m.draft.title, adjustTitleHeight]);

  function commitNewTag() {
    const val = newTagVal.trim().replace(/^#/, "");
    if (val && !m.draft.tags.includes(val)) {
      m.updateDraft({ tags: [...m.draft.tags, val] });
    }
    setNewTagVal("");
    setTagAdding(false);
  }

  function handleDismissKeyboard() {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }

  return (
    <div className="m-note-mobile-editor">
      {/* 1. 顶栏：返回、保存状态、阅读/编辑切换、更多菜单 */}
      <header className="m-note-topbar">
        <button
          type="button"
          className="m-note-nav-back"
          aria-label={t("common.back")}
          onClick={onBack}
        >
          <ChevronLeft size={22} />
          <span className="m-note-nav-title">
            {m.draft.group || t("pages.notesTitle")}
          </span>
        </button>

        <div className="m-note-topbar-actions">
          {/* 保存指示与按钮 */}
          {m.isDirty ? (
            <button
              type="button"
              className="m-note-save-action dirty"
              disabled={m.writesLocked || m.saving}
              onClick={() => void m.saveCurrentNote()}
            >
              <Save size={13} />
              <span>{m.saving ? t("notes.saving") : t("notes.save")}</span>
            </button>
          ) : (
            <span className="m-note-save-action clean" title={t("notes.saved")}>
              <Check size={13} />
              <span>{t("notes.saved")}</span>
            </span>
          )}

          {/* 模式切换：预览 / 源码 */}
          <button
            type="button"
            className={"m-note-icon-action" + (isPreview ? " on" : "")}
            aria-label={isPreview ? t("notes.layoutEdit") : t("notes.layoutPreview")}
            title={isPreview ? t("notes.layoutEdit") : t("notes.layoutPreview")}
            onClick={() => {
              if (!isPreview) handleDismissKeyboard();
              m.setMobileTab(isPreview ? "edit" : "preview");
            }}
          >
            {isPreview ? <FileCode2 size={18} /> : <Eye size={18} />}
          </button>

          {/* 更多菜单 */}
          <button
            type="button"
            className="m-note-icon-action"
            aria-label={t("notes.moreOptions")}
            title={t("notes.moreOptions")}
            onClick={() => setMoreMenuOpen(true)}
          >
            <MoreVertical size={18} />
          </button>
        </div>
      </header>

      {/* 2. 页面主体：轻量属性条 + 无边框标题 + 编辑器/预览画布 */}
      <div className="m-note-canvas">
        <NoteDraftBanner m={m} />

        {/* 思源笔记风格：紧凑属性栏（单行流式布局） */}
        <div className="m-note-props-bar">
          {/* 分组胶囊 */}
          {m.draft.group ? (
            <button
              type="button"
              className="m-note-prop-pill is-group"
              onClick={() => setGroupPickerOpen(true)}
            >
              <Folder size={12} />
              <span>{m.draft.group}</span>
              <ChevronDown size={11} className="m-note-pill-arrow" />
            </button>
          ) : (
            <button
              type="button"
              className="m-note-prop-btn"
              onClick={() => setGroupPickerOpen(true)}
            >
              <FolderPlus size={13} />
              <span>{t("notes.addGroup")}</span>
            </button>
          )}

          {/* 标签列表 */}
          <div className="m-note-tags-scroll">
            {m.draft.tags.map((tag) => {
              const tone = TAG_PALETTE[tagTone(tag)];
              return (
                <span
                  key={tag}
                  className="m-note-tag-chip"
                  style={{ backgroundColor: tone.bg, color: tone.fg }}
                >
                  <span>#{tag}</span>
                  <button
                    type="button"
                    className="m-note-tag-chip-del"
                    aria-label={t("common.delete")}
                    onClick={() =>
                      m.updateDraft({ tags: m.draft.tags.filter((x) => x !== tag) })
                    }
                  >
                    <X size={10} />
                  </button>
                </span>
              );
            })}

            {tagAdding ? (
              <div className="m-note-tag-input-inline">
                <input
                  ref={tagInputRef}
                  className="m-note-tag-input"
                  placeholder={t("notes.tagsPlaceholder")}
                  value={newTagVal}
                  onChange={(e) => setNewTagVal(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault();
                      commitNewTag();
                    } else if (e.key === "Escape") {
                      setTagAdding(false);
                    }
                  }}
                  onBlur={commitNewTag}
                  autoFocus
                />
              </div>
            ) : (
              <button
                type="button"
                className="m-note-prop-btn"
                onClick={() => {
                  setTagAdding(true);
                  setNewTagVal("");
                }}
              >
                <Tag size={13} />
                <span>{t("notes.addTag")}</span>
              </button>
            )}
          </div>
        </div>

        {/* 无边框沉浸式大标题 */}
        <div className="m-note-title-wrap">
          <textarea
            ref={titleTextareaRef}
            rows={1}
            className="m-note-title-textarea"
            placeholder={t("notes.titlePlaceholder")}
            value={m.draft.title}
            autoFocus={!m.draft.id && !m.draft.title}
            onChange={(e) => {
              m.updateDraft({ title: e.target.value });
              adjustTitleHeight();
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
              e.preventDefault();
              if (isPreview) m.setMobileTab("edit");
              m.editorRef.current?.focus();
            }}
          />
        </div>

        {/* 正文主编辑区 / 预览区 */}
        <div className="m-note-content-area">
          <div
            className={"m-note-editor-host" + (isPreview ? " is-parked" : "")}
            aria-hidden={isPreview}
            onBlur={(ev) => {
              if (isPreview) return;
              const next = ev.relatedTarget as Node | null;
              if (next && ev.currentTarget.contains(next)) return;
              m.onEditorFocusLeave();
            }}
          >
            <NoteMarkdownEditor
              key={m.draft.id ?? "new"}
              ref={m.editorRef}
              value={m.draft.markdown}
              onChange={(markdown) => m.updateDraft({ markdown })}
              placeholder={t("notes.sourcePlaceholder")}
              disabled={m.writesLocked}
              mobile
              onImageFile={(file) => ingestNoteImage(m, file)}
            />
          </div>
          {isPreview && (
            <div className="m-note-preview-host">
              <NotePreview markdown={m.draft.markdown} breaks />
              <div className="m-note-preview-status">
                <span>{t("notes.statChars", { n: stats.chars })}</span>
                <span className="dot">·</span>
                <span>{t("notes.statLines", { n: stats.lines })}</span>
                {m.activeNote && (
                  <>
                    <span className="dot">·</span>
                    <span>{m.formatUpdatedAt(m.activeNote.updatedAt)}</span>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 3. 思源笔记图三风格：底部键盘吸附工具栏（Accessory Toolbar） */}
      {!isPreview && (
        <footer
          className="m-note-acc-bar"
          role="toolbar"
          style={
            viewportBottomOffset > 0
              ? { transform: `translateY(-${viewportBottomOffset}px)` }
              : undefined
          }
        >
          <div className="m-note-acc-scroll">
            {/* 插入图片 */}
            <button
              type="button"
              className="m-acc-btn is-img"
              title={t("notes.insertImage")}
              aria-label={t("notes.insertImage")}
              onPointerDown={(e) => {
                e.preventDefault();
                onInsertImage();
              }}
            >
              <ImagePlus size={16} />
            </button>

            <span className="m-acc-divider" />

            {/* 标题 */}
            <button
              type="button"
              className="m-acc-btn"
              title={t("notes.tbH1")}
              aria-label={t("notes.tbH1")}
              onPointerDown={(e) => {
                e.preventDefault();
                m.insertAtCursor("\n# ");
              }}
            >
              <Heading1 size={16} />
            </button>
            <button
              type="button"
              className="m-acc-btn"
              title={t("notes.tbH2")}
              aria-label={t("notes.tbH2")}
              onPointerDown={(e) => {
                e.preventDefault();
                m.insertAtCursor("\n## ");
              }}
            >
              <Heading2 size={16} />
            </button>
            <button
              type="button"
              className="m-acc-btn"
              title={t("notes.tbH3")}
              aria-label={t("notes.tbH3")}
              onPointerDown={(e) => {
                e.preventDefault();
                m.insertAtCursor("\n### ");
              }}
            >
              <Heading3 size={16} />
            </button>

            <span className="m-acc-divider" />

            {/* 格式 */}
            <button
              type="button"
              className="m-acc-btn"
              title={t("notes.tbBold")}
              aria-label={t("notes.tbBold")}
              onPointerDown={(e) => {
                e.preventDefault();
                m.wrapSelection("**");
              }}
            >
              <Bold size={16} />
            </button>
            <button
              type="button"
              className="m-acc-btn"
              title={t("notes.tbItalic")}
              aria-label={t("notes.tbItalic")}
              onPointerDown={(e) => {
                e.preventDefault();
                m.wrapSelection("*");
              }}
            >
              <Italic size={16} />
            </button>
            <button
              type="button"
              className="m-acc-btn"
              title={t("notes.tbStrike")}
              aria-label={t("notes.tbStrike")}
              onPointerDown={(e) => {
                e.preventDefault();
                m.wrapSelection("~~");
              }}
            >
              <Strikethrough size={16} />
            </button>

            <span className="m-acc-divider" />

            {/* 列表 */}
            <button
              type="button"
              className="m-acc-btn"
              title={t("notes.tbUl")}
              aria-label={t("notes.tbUl")}
              onPointerDown={(e) => {
                e.preventDefault();
                m.insertAtCursor("\n- ");
              }}
            >
              <List size={16} />
            </button>
            <button
              type="button"
              className="m-acc-btn"
              title={t("notes.tbOl")}
              aria-label={t("notes.tbOl")}
              onPointerDown={(e) => {
                e.preventDefault();
                m.insertAtCursor("\n1. ");
              }}
            >
              <ListOrdered size={16} />
            </button>
            <button
              type="button"
              className="m-acc-btn"
              title={t("notes.tbTask")}
              aria-label={t("notes.tbTask")}
              onPointerDown={(e) => {
                e.preventDefault();
                m.insertAtCursor("\n- [ ] ");
              }}
            >
              <ListChecks size={16} />
            </button>

            <span className="m-acc-divider" />

            {/* 引用与块 */}
            <button
              type="button"
              className="m-acc-btn"
              title={t("notes.tbQuote")}
              aria-label={t("notes.tbQuote")}
              onPointerDown={(e) => {
                e.preventDefault();
                m.insertAtCursor("\n> ");
              }}
            >
              <Quote size={16} />
            </button>
            <button
              type="button"
              className="m-acc-btn"
              title={t("notes.tbCode")}
              aria-label={t("notes.tbCode")}
              onPointerDown={(e) => {
                e.preventDefault();
                m.wrapSelection("\n```\n", "\n```\n");
              }}
            >
              <Code size={16} />
            </button>
            <button
              type="button"
              className="m-acc-btn"
              title={t("notes.tbHr")}
              aria-label={t("notes.tbHr")}
              onPointerDown={(e) => {
                e.preventDefault();
                m.insertAtCursor("\n\n---\n\n");
              }}
            >
              <Minus size={16} />
            </button>
            <button
              type="button"
              className="m-acc-btn"
              title={t("notes.tbLink")}
              aria-label={t("notes.tbLink")}
              onPointerDown={(e) => {
                e.preventDefault();
                m.wrapSelection("[", "](url)");
              }}
            >
              <Link size={16} />
            </button>
          </div>

          {/* 收起键盘按键 */}
          <button
            type="button"
            className="m-acc-dismiss-btn"
            title={t("notes.hideKeyboard")}
            aria-label={t("notes.hideKeyboard")}
            onPointerDown={(e) => {
              e.preventDefault();
              handleDismissKeyboard();
            }}
          >
            <ChevronDown size={18} />
          </button>
        </footer>
      )}

      {/* 4. 更多菜单抽屉 */}
      {moreMenuOpen && (
        <div className="wizard-overlay" onClick={() => setMoreMenuOpen(false)}>
          <div className="m-note-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="m-note-sheet-handle" />
            <div className="m-note-sheet-head">
              <div className="m-note-sheet-title">
                {m.draft.title.trim() || t("notes.untitled")}
              </div>
              <div className="m-note-sheet-meta">
                <span>{t("notes.statChars", { n: stats.chars })}</span>
                <span className="dot">·</span>
                <span>{t("notes.statLines", { n: stats.lines })}</span>
                {m.activeNote && (
                  <>
                    <span className="dot">·</span>
                    <span>{m.formatUpdatedAt(m.activeNote.updatedAt)}</span>
                  </>
                )}
              </div>
            </div>

            <div className="m-note-sheet-actions">
              <button
                type="button"
                className="m-note-sheet-item"
                onClick={() => {
                  if (m.activeNote) void m.togglePin(m.activeNote.id);
                  else m.updateDraft({ pinned: !m.draft.pinned });
                  setMoreMenuOpen(false);
                }}
              >
                {m.draft.pinned ? <ArrowUpToLine size={18} /> : <Pin size={18} />}
                <span>{m.draft.pinned ? t("notes.unpin") : t("notes.pin")}</span>
              </button>

              <button
                type="button"
                className="m-note-sheet-item"
                onClick={() => {
                  setMoreMenuOpen(false);
                  m.openExport();
                }}
              >
                <Download size={18} />
                <span>{t("notes.export")}</span>
              </button>

              <button
                type="button"
                className="m-note-sheet-item is-danger"
                disabled={!m.draft.id || m.writesLocked}
                onClick={() => {
                  setMoreMenuOpen(false);
                  if (m.activeNote) m.setPendingDelete(m.activeNote);
                }}
              >
                <Trash2 size={18} />
                <span>{t("notes.delete")}</span>
              </button>
            </div>

            <button
              type="button"
              className="btn m-note-sheet-cancel"
              onClick={() => setMoreMenuOpen(false)}
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}

      {/* 5. 分组选择抽屉 */}
      {groupPickerOpen && (
        <div className="wizard-overlay" onClick={() => setGroupPickerOpen(false)}>
          <div className="m-note-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="m-note-sheet-handle" />
            <div className="m-note-sheet-head">
              <div className="m-note-sheet-title">{t("group.title")}</div>
            </div>
            <div className="m-note-group-options">
              <button
                type="button"
                className={"m-note-group-option" + (!m.draft.group ? " on" : "")}
                onClick={() => {
                  m.updateDraft({ group: undefined });
                  setGroupPickerOpen(false);
                }}
              >
                <span>{t("group.none")}</span>
                {!m.draft.group && <Check size={16} />}
              </button>
              {m.groups.map((g) => (
                <button
                  key={g.name}
                  type="button"
                  className={"m-note-group-option" + (m.draft.group === g.name ? " on" : "")}
                  onClick={() => {
                    m.updateDraft({ group: g.name });
                    setGroupPickerOpen(false);
                  }}
                >
                  {g.color && <span className="group-tab-dot" style={{ background: g.color }} />}
                  <span>{g.name}</span>
                  {m.draft.group === g.name && <Check size={16} />}
                </button>
              ))}
              <button
                type="button"
                className="m-note-group-option is-create"
                onClick={() => {
                  setGroupPickerOpen(false);
                  m.setGroupDlg(true);
                }}
              >
                <Plus size={16} />
                <span>{t("notes.newGroup")}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
