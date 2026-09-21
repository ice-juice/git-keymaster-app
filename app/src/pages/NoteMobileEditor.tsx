import { useEffect, useRef, useState } from "react";
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
  Heading,
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
  Rows2,
  Save,
  Strikethrough,
  Table2,
  Trash2,
  Type,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { ingestNoteImage, NoteDraftBanner, NotePreview, notePlainStats, NoteTagEditor } from "./Notes.shared";
import { GroupMenuList } from "../ui/GroupMenu";
import { NoteMarkdownEditor } from "../ui/NoteMarkdownEditor";
import { useOverlayBack } from "../shared/mobileBack";
import type { NotesModel, NotesViewLayout } from "../shared/hooks/useNotesModel";

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
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [headingOpen, setHeadingOpen] = useState(false);
  const [headingMenuLeft, setHeadingMenuLeft] = useState(8);
  const accBarRef = useRef<HTMLElement | null>(null);
  const headingBtnRef = useRef<HTMLButtonElement>(null);

  useOverlayBack(moreMenuOpen, () => setMoreMenuOpen(false));
  useOverlayBack(groupPickerOpen, () => setGroupPickerOpen(false));
  useOverlayBack(layoutOpen, () => setLayoutOpen(false));
  useOverlayBack(headingOpen, () => setHeadingOpen(false));

  const stats = notePlainStats(m.draft.markdown);
  const layout = m.mobileTab;
  const isPreview = layout === "preview";
  const isSplit = layout === "split";
  const showSource = layout !== "preview";
  const showPreview = layout !== "edit";
  const currentGroup = (m.draft.group || "").trim();
  const matchedGroup = m.groups.find((g) => g.name === currentGroup);
  const [imeInset, setImeInset] = useState(0);
  const wasPreviewRef = useRef(isPreview);
  const layoutOptions: { id: NotesViewLayout; label: string; icon: typeof FileCode2 }[] = [
    { id: "edit", label: t("notes.layoutEdit"), icon: FileCode2 },
    { id: "split", label: t("notes.layoutSplit"), icon: Rows2 },
    { id: "preview", label: t("notes.layoutPreview"), icon: Eye },
  ];
  const currentLayout = layoutOptions.find((item) => item.id === layout) || layoutOptions[0];
  const CurrentLayoutIcon = currentLayout.icon;

  useEffect(() => {
    const read = () => {
      const raw = getComputedStyle(document.documentElement).getPropertyValue("--km-ime-inset");
      setImeInset(Number.parseFloat(raw) || 0);
    };
    read();
    const vv = window.visualViewport;
    vv?.addEventListener("resize", read);
    vv?.addEventListener("scroll", read);
    window.addEventListener("resize", read);
    window.addEventListener("km-android-ime", read);
    window.addEventListener("focusin", read);
    window.addEventListener("focusout", read);
    return () => {
      vv?.removeEventListener("resize", read);
      vv?.removeEventListener("scroll", read);
      window.removeEventListener("resize", read);
      window.removeEventListener("km-android-ime", read);
      window.removeEventListener("focusin", read);
      window.removeEventListener("focusout", read);
    };
  }, []);

  useEffect(() => {
    if (!showSource || imeInset <= 0) return;
    const id = window.requestAnimationFrame(() => m.editorRef.current?.revealCursor());
    return () => window.cancelAnimationFrame(id);
  }, [showSource, imeInset, m.editorRef]);

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

  function handleDismissKeyboard() {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }

  const headingOptions: { id: "h1" | "h2" | "h3"; label: string; icon: typeof Heading1; insert: string }[] = [
    { id: "h1", label: t("notes.tbH1"), icon: Heading1, insert: "\n# " },
    { id: "h2", label: t("notes.tbH2"), icon: Heading2, insert: "\n## " },
    { id: "h3", label: t("notes.tbH3"), icon: Heading3, insert: "\n### " },
  ];

  function placeHeadingMenu() {
    const bar = accBarRef.current;
    const btn = headingBtnRef.current;
    if (!bar || !btn) return 8;
    const barRect = bar.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    const menuMin = 132;
    const maxLeft = Math.max(8, barRect.width - menuMin - 8);
    return Math.min(maxLeft, Math.max(8, btnRect.left - barRect.left));
  }

  function toggleHeadingMenu() {
    setHeadingOpen((open) => {
      if (open) return false;
      setHeadingMenuLeft(placeHeadingMenu());
      return true;
    });
  }

  function insertHeading(text: string) {
    m.insertAtCursor(text);
    setHeadingOpen(false);
  }

  const MD_TABLE = "|  |  |  |\n| --- | --- | --- |\n|  |  |  |";

  return (
    <div className="m-note-mobile-editor">
      {/* 1. 顶栏：返回、模式下拉、保存状态、更多菜单 */}
      <header className="m-note-topbar">
        <button
          type="button"
          className="m-note-nav-back"
          aria-label={t("common.back")}
          onClick={onBack}
        >
          <ChevronLeft size={22} />
          <span className="m-note-nav-title">
            {t("pages.notesTitle")}
          </span>
        </button>

        <div className="m-note-topbar-actions">
          <div className="m-note-layout-wrap">
            <button
              type="button"
              className={"m-note-layout-select" + (layoutOpen ? " is-open" : "")}
              aria-expanded={layoutOpen}
              aria-haspopup="listbox"
              title={t("notes.layoutSwitch")}
              onClick={() => setLayoutOpen((v) => !v)}
            >
              <CurrentLayoutIcon size={13} />
              <span>{currentLayout.label}</span>
              <ChevronDown size={12} />
            </button>
            {layoutOpen && (
              <>
                <div className="m-note-layout-backdrop" onClick={() => setLayoutOpen(false)} />
                <div className="m-note-layout-menu" role="listbox">
                  {layoutOptions.map((item) => {
                    const Icon = item.icon;
                    const on = item.id === layout;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        role="option"
                        aria-selected={on}
                        className={"m-note-layout-item" + (on ? " on" : "")}
                        onClick={() => {
                          if (item.id === "preview") handleDismissKeyboard();
                          m.setMobileTab(item.id);
                          setLayoutOpen(false);
                        }}
                      >
                        <Icon size={14} />
                        <span>{item.label}</span>
                        {on ? <Check size={14} /> : null}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
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

      {/* 2. 页面主体：与桌面端一致的标题栏 + 分组/标签 + 编辑器/预览画布 */}
      <div className="m-note-canvas">
        <NoteDraftBanner m={m} />

        <div className="m-note-chrome">
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
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
                  e.preventDefault();
                  if (isPreview) m.setMobileTab("edit");
                  m.editorRef.current?.focus();
                }}
              />
            </span>
          </label>
          <div className="note-editor-meta">
            <button
              type="button"
              className={"note-group-select" + (groupPickerOpen ? " is-open" : "")}
              title={t("notes.groupPlaceholder")}
              onClick={() => setGroupPickerOpen(true)}
            >
              {matchedGroup?.color ? (
                <span className="group-tab-dot" style={{ background: matchedGroup.color }} />
              ) : null}
              <span className={"note-group-select-label" + (!currentGroup ? " is-none" : "")}>
                {currentGroup || t("group.none")}
              </span>
              <ChevronDown size={12} />
            </button>
            <NoteTagEditor m={m} />
          </div>
        </div>

        {/* 正文主编辑区 / 预览区；对比模式上下分层 */}
        <div className={"m-note-content-area" + (isSplit ? " is-split" : "")}>
          <div
            className={"m-note-editor-host" + (isPreview ? " is-parked" : "")}
            aria-hidden={isPreview}
            onBlur={(ev) => {
              if (!showSource) return;
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
          {isSplit && <div className="m-note-split-rule" aria-hidden />}
          {showPreview && (
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
      {showSource && (
        <footer ref={accBarRef} className="m-note-acc-bar" role="toolbar">
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

            <button
              ref={headingBtnRef}
              type="button"
              className={"m-acc-btn" + (headingOpen ? " is-open" : "")}
              title={t("notes.tbHeading")}
              aria-label={t("notes.tbHeading")}
              aria-expanded={headingOpen}
              aria-haspopup="listbox"
              onPointerDown={(e) => {
                e.preventDefault();
                toggleHeadingMenu();
              }}
            >
              <Heading size={16} />
            </button>
            <button
              type="button"
              className="m-acc-btn"
              title={t("notes.tbTable")}
              aria-label={t("notes.tbTable")}
              onPointerDown={(e) => {
                e.preventDefault();
                m.insertAtCursor(`\n${MD_TABLE}`, 3);
              }}
            >
              <Table2 size={16} />
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

          {headingOpen && (
            <>
              <div
                className="m-acc-heading-backdrop"
                onPointerDown={(e) => {
                  e.preventDefault();
                  setHeadingOpen(false);
                }}
              />
              <div className="m-acc-heading-menu" role="listbox" style={{ left: headingMenuLeft }}>
                {headingOptions.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="option"
                      className="m-acc-heading-item"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        insertHeading(item.insert);
                      }}
                    >
                      <Icon size={14} />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
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
            <GroupMenuList
              items={[
                { key: "", label: t("group.none") },
                ...m.groups.map((g) => ({
                  key: g.name,
                  label: g.name,
                  color: g.color,
                  sortable: true,
                })),
              ]}
              value={m.draft.group || ""}
              onSelect={(key) => {
                m.updateDraft({ group: key || undefined });
                setGroupPickerOpen(false);
              }}
              onReorder={
                m.writesLocked
                  ? undefined
                  : (names) => {
                      if (names.length) void m.reorderGroups(names);
                    }
              }
            />
            <div className="m-note-group-options">
              <button
                type="button"
                className="m-note-group-option is-create"
                onClick={() => {
                  setGroupPickerOpen(false);
                  m.setGroupDlg({ mode: "create" });
                }}
              >
                <Plus size={16} />
                <span>{t("notes.newGroup").replace(/^\+\s*/, "")}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
