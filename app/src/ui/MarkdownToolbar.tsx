import {
  Bold,
  Code,
  ChevronDown,
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
  Quote,
  Strikethrough,
  Table2,
} from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { NoteMarkdownEditorHandle } from "./NoteMarkdownEditor";

export function MarkdownToolbar({
  editorRef,
  onInsertImage,
  disabled,
}: {
  editorRef: RefObject<NoteMarkdownEditorHandle | null>;
  onInsertImage: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [headingsOpen, setHeadingsOpen] = useState(false);
  const headingsRef = useRef<HTMLDivElement>(null);
  const headingButtonRef = useRef<HTMLButtonElement>(null);
  const focusHeadingMenu = useRef(false);
  const headingsId = useId();
  useLayoutEffect(() => {
    if (!headingsOpen || !focusHeadingMenu.current) return;
    focusHeadingMenu.current = false;
    headingsRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
  }, [headingsOpen]);
  useEffect(() => {
    if (!headingsOpen) return;
    const outside = (event: PointerEvent) => {
      if (!headingsRef.current?.contains(event.target as Node)) setHeadingsOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setHeadingsOpen(false);
      headingButtonRef.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [headingsOpen]);
  const run = (fn: (editor: NoteMarkdownEditorHandle) => void) => {
    const editor = editorRef.current;
    if (!editor || disabled) return;
    fn(editor);
  };
  const btn = (title: string, onClick: () => void, icon: ReactNode) => (
    <button
      type="button"
      className="md-tb-btn"
      title={title}
      aria-label={title}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {icon}
    </button>
  );
  return (
    <div className="md-toolbar">
      <div className="md-tb-group">
        {btn(t("notes.tbBold"), () => run((editor) => editor.toggleWrap("**")), <Bold size={14} />)}
        {btn(t("notes.tbItalic"), () => run((editor) => editor.toggleWrap("*")), <Italic size={14} />)}
        {btn(t("notes.tbStrike"), () => run((editor) => editor.toggleWrap("~~")), <Strikethrough size={14} />)}
      </div>
      <div className="md-tb-group">
        {btn(t("notes.tbH1"), () => run((editor) => editor.toggleHeading(1)), <Heading1 size={14} />)}
        {btn(t("notes.tbH2"), () => run((editor) => editor.toggleHeading(2)), <Heading2 size={14} />)}
        {btn(t("notes.tbH3"), () => run((editor) => editor.toggleHeading(3)), <Heading3 size={14} />)}
        <div className="md-tb-heading-more" ref={headingsRef} onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHeadingsOpen(false);
        }}>
          <button
            ref={headingButtonRef}
            type="button"
            className="md-tb-btn md-tb-more-btn"
            title={t("notes.tbMoreHeadings")}
            aria-label={t("notes.tbMoreHeadings")}
            aria-haspopup="menu"
            aria-expanded={headingsOpen && !disabled}
            aria-controls={headingsId}
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setHeadingsOpen((open) => !open)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown") return;
              event.preventDefault();
              if (headingsOpen) headingsRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
              else { focusHeadingMenu.current = true; setHeadingsOpen(true); }
            }}
          >
            <span>{t("notes.tbMore")}</span><ChevronDown size={12} />
          </button>
          {headingsOpen && !disabled && (
            <div id={headingsId} className="md-tb-heading-menu" role="menu" aria-label={t("notes.tbMoreHeadings")}
              onKeyDown={(event) => {
                const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]"));
                const index = items.indexOf(document.activeElement as HTMLButtonElement);
                const next = event.key === "ArrowDown" ? (index + 1) % items.length
                  : event.key === "ArrowUp" ? (index + items.length - 1) % items.length
                  : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : -1;
                if (next >= 0) { event.preventDefault(); items[next]?.focus(); }
              }}
            >
              {([4, 5, 6] as const).map((level) => (
                <button key={level} type="button" role="menuitem" aria-label={t(`notes.tbH${level}`)} onMouseDown={(event) => event.preventDefault()}
                  onClick={() => { setHeadingsOpen(false); run((editor) => editor.toggleHeading(level)); }}>
                  <span className="md-tb-heading-number">H{level}</span><span>{t(`notes.tbH${level}`)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="md-tb-group">
        {btn(t("notes.tbUl"), () => run((editor) => editor.toggleLinePrefix("ul")), <List size={14} />)}
        {btn(t("notes.tbOl"), () => run((editor) => editor.toggleLinePrefix("ol")), <ListOrdered size={14} />)}
        {btn(t("notes.tbTask"), () => run((editor) => editor.toggleLinePrefix("task")), <ListChecks size={14} />)}
      </div>
      <div className="md-tb-group">
        {btn(t("notes.tbQuote"), () => run((editor) => editor.toggleLinePrefix("quote")), <Quote size={14} />)}
        {btn(t("notes.tbCode"), () => run((editor) => editor.insertCodeBlock()), <Code size={14} />)}
        {btn(t("notes.tbHr"), () => run((editor) => editor.insertHr()), <Minus size={14} />)}
      </div>
      <div className="md-tb-group">
        {btn(t("notes.tbTable"), () => run((editor) => editor.insertTable()), <Table2 size={14} />)}
        {btn(t("notes.tbLink"), () => run((editor) => editor.toggleWrap("[", "](url)")), <Link size={14} />)}
        {btn(t("notes.insertImage"), onInsertImage, <ImagePlus size={14} />)}
      </div>
    </div>
  );
}
