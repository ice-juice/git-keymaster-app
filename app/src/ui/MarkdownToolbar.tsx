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
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

export function MarkdownToolbar({
  onWrap,
  onInsert,
  onInsertImage,
  disabled,
}: {
  onWrap: (before: string, after?: string) => void;
  onInsert: (text: string) => void;
  onInsertImage: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const btn = (title: string, onClick: () => void, icon: ReactNode) => (
    <button type="button" className="md-tb-btn" title={title} aria-label={title} disabled={disabled} onClick={onClick}>
      {icon}
    </button>
  );
  return (
    <div className="md-toolbar">
      <div className="md-tb-group">
        {btn(t("notes.tbBold"), () => onWrap("**"), <Bold size={14} />)}
        {btn(t("notes.tbItalic"), () => onWrap("*"), <Italic size={14} />)}
        {btn(t("notes.tbStrike"), () => onWrap("~~"), <Strikethrough size={14} />)}
      </div>
      <div className="md-tb-group">
        {btn(t("notes.tbH1"), () => onInsert("\n# "), <Heading1 size={14} />)}
        {btn(t("notes.tbH2"), () => onInsert("\n## "), <Heading2 size={14} />)}
        {btn(t("notes.tbH3"), () => onInsert("\n### "), <Heading3 size={14} />)}
      </div>
      <div className="md-tb-group">
        {btn(t("notes.tbUl"), () => onInsert("\n- "), <List size={14} />)}
        {btn(t("notes.tbOl"), () => onInsert("\n1. "), <ListOrdered size={14} />)}
        {btn(t("notes.tbTask"), () => onInsert("\n- [ ] "), <ListChecks size={14} />)}
      </div>
      <div className="md-tb-group">
        {btn(t("notes.tbQuote"), () => onInsert("\n> "), <Quote size={14} />)}
        {btn(t("notes.tbCode"), () => onWrap("\n```\n", "\n```\n"), <Code size={14} />)}
        {btn(t("notes.tbHr"), () => onInsert("\n\n---\n\n"), <Minus size={14} />)}
      </div>
      <div className="md-tb-group">
        {btn(t("notes.tbLink"), () => onWrap("[", "](url)"), <Link size={14} />)}
        {btn(t("notes.insertImage"), onInsertImage, <ImagePlus size={14} />)}
      </div>
    </div>
  );
}
