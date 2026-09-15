import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorSelection } from "@codemirror/state";
import { EditorView, placeholder as cmPlaceholder } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

export type NoteMarkdownEditorHandle = {
  wrapSelection: (before: string, after?: string) => void;
  insertAtCursor: (text: string) => void;
  focus: () => void;
};

const mdHighlight = HighlightStyle.define([
  { tag: t.heading1, class: "cm-md-h1" },
  { tag: t.heading2, class: "cm-md-h2" },
  { tag: t.heading3, class: "cm-md-h3" },
  { tag: t.heading, class: "cm-md-heading" },
  { tag: t.strong, class: "cm-md-strong" },
  { tag: t.emphasis, class: "cm-md-em" },
  { tag: t.strikethrough, class: "cm-md-strike" },
  { tag: t.link, class: "cm-md-link" },
  { tag: t.url, class: "cm-md-url" },
  { tag: t.monospace, class: "cm-md-mono" },
  { tag: t.processingInstruction, class: "cm-md-mark" },
  { tag: t.meta, class: "cm-md-mark" },
  { tag: t.comment, class: "cm-md-mark" },
  { tag: t.quote, class: "cm-md-quote" },
]);

const chromeTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "transparent",
    fontSize: "13.5px",
  },
  "&.cm-editor": { height: "100%" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "var(--mono)",
    lineHeight: "1.65",
  },
  ".cm-content": {
    padding: "16px 18px 28px",
    caretColor: "var(--accent)",
    minHeight: "100%",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    border: "none",
    color: "var(--text-mute)",
    paddingLeft: "6px",
  },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
  ".cm-activeLine": { backgroundColor: "var(--accent-soft)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--accent-soft)",
  },
  ".cm-cursor": { borderLeftColor: "var(--accent)" },
});

function applyInsert(view: EditorView, text: string) {
  const { from, to } = view.state.selection.main;
  view.dispatch({
    changes: { from, to, insert: text },
    selection: EditorSelection.cursor(from + text.length),
    scrollIntoView: true,
  });
  view.focus();
}

function applyWrap(view: EditorView, before: string, after: string) {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  const insert = `${before}${selected}${after}`;
  view.dispatch({
    changes: { from, to, insert },
    selection: selected
      ? EditorSelection.range(from + before.length, from + before.length + selected.length)
      : EditorSelection.cursor(from + before.length),
    scrollIntoView: true,
  });
  view.focus();
}

export const NoteMarkdownEditor = forwardRef<
  NoteMarkdownEditorHandle,
  {
    value: string;
    onChange: (next: string) => void;
    placeholder?: string;
    disabled?: boolean;
    mobile?: boolean;
    onImageFile?: (file: File) => void;
  }
>(function NoteMarkdownEditor({ value, onChange, placeholder, disabled, mobile, onImageFile }, ref) {
  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const onImageRef = useRef(onImageFile);
  useEffect(() => {
    onImageRef.current = onImageFile;
  }, [onImageFile]);

  useImperativeHandle(ref, () => ({
    wrapSelection(before, after = before) {
      const view = cmRef.current?.view;
      if (!view) return;
      applyWrap(view, before, after);
    },
    insertAtCursor(text) {
      const view = cmRef.current?.view;
      if (!view) return;
      applyInsert(view, text);
    },
    focus() {
      cmRef.current?.view?.focus();
    },
  }));

  const extensions = useMemo(
    () => [
      markdown(),
      EditorView.lineWrapping,
      syntaxHighlighting(mdHighlight),
      chromeTheme,
      cmPlaceholder(placeholder || ""),
      EditorView.domEventHandlers({
        drop(event) {
          const file = event.dataTransfer?.files?.[0];
          if (!file || !file.type.startsWith("image/")) return false;
          event.preventDefault();
          onImageRef.current?.(file);
          return true;
        },
        paste(event) {
          const item = [...(event.clipboardData?.items || [])].find((it) => it.type.startsWith("image/"));
          if (!item) return false;
          const file = item.getAsFile();
          if (!file) return false;
          event.preventDefault();
          onImageRef.current?.(file);
          return true;
        },
      }),
    ],
    [placeholder],
  );

  return (
    <CodeMirror
      ref={cmRef}
      className={"note-cm" + (mobile ? " is-mobile" : "")}
      value={value}
      height="100%"
      editable={!disabled}
      basicSetup={{
        lineNumbers: !mobile,
        foldGutter: false,
        highlightActiveLineGutter: !mobile,
        highlightActiveLine: true,
        bracketMatching: true,
        closeBrackets: true,
        autocompletion: false,
        searchKeymap: true,
      }}
      extensions={extensions}
      onChange={onChange}
    />
  );
});
