import {
  Bold,
  Code,
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
} from "lucide-react";
import type { ReactNode, RefObject } from "react";
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
        {btn(t("notes.tbLink"), () => run((editor) => editor.toggleWrap("[", "](url)")), <Link size={14} />)}
        {btn(t("notes.insertImage"), onInsertImage, <ImagePlus size={14} />)}
      </div>
    </div>
  );
}
