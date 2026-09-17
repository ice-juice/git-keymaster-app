import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorSelection } from "@codemirror/state";
import { EditorView, ViewPlugin, drawSelection, placeholder as cmPlaceholder } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useApp } from "../store";

export type NoteMarkdownEditorHandle = {
  wrapSelection: (before: string, after?: string) => void;
  insertAtCursor: (text: string, cursorOffset?: number) => void;
  focus: () => void;
  setScrollRatio: (ratio: number) => void;
  getMarkdown: () => string | undefined;
  isComposing: () => boolean;
  setMarkdown: (text: string) => void;
  revealCursor: () => void;
};

function revealSelection(view: EditorView) {
  view.dispatch({
    effects: EditorView.scrollIntoView(view.state.selection.main.head, {
      y: "nearest",
      yMargin: 48,
    }),
  });
}

function clampPos(docLen: number, pos: number) {
  return Math.max(0, Math.min(docLen, pos));
}

/** 局部改字并保住选区；视口只跟光标行，禁止被拉到文档末尾。 */
function applyEditorChange(
  view: EditorView,
  spec: {
    changes: { from: number; to: number; insert: string };
    selection: EditorSelection;
  },
) {
  const scrollEl = view.scrollDOM;
  const prevTop = scrollEl.scrollTop;
  const prevMax = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
  const wasAtEnd = prevMax > 0 && prevTop >= prevMax - 4;

  view.dispatch({
    changes: spec.changes,
    selection: spec.selection,
    effects: EditorView.scrollIntoView(spec.selection.main.head, {
      y: "nearest",
      yMargin: 48,
    }),
  });

  if (!view.hasFocus) {
    view.contentDOM.focus({ preventScroll: true });
  }

  const head = view.state.selection.main.head;
  const nearDocEnd = head >= view.state.doc.length - 1;

  requestAnimationFrame(() => {
    const max = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
    const nowAtEnd = max > 0 && scrollEl.scrollTop >= max - 8;
    if (nowAtEnd && !nearDocEnd && !wasAtEnd) {
      scrollEl.scrollTop = prevTop;
    }
    revealSelection(view);
  });
}

export function scrollRatioOf(el: HTMLElement) {
  const max = el.scrollHeight - el.clientHeight;
  return max <= 0 ? 0 : el.scrollTop / max;
}

export function applyScrollRatio(el: HTMLElement | null | undefined, ratio: number) {
  if (!el) return;
  const max = el.scrollHeight - el.clientHeight;
  if (max <= 0) return;
  el.scrollTop = Math.min(1, Math.max(0, ratio)) * max;
}

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
    width: "100%",
    color: "var(--text)",
    backgroundColor: "transparent",
    fontSize: "15px",
    outline: "none !important",
  },
  "&.cm-editor": {
    height: "100%",
    width: "100%",
    outline: "none !important",
    border: "none !important",
  },
  "&.cm-focused": {
    outline: "none !important",
    border: "none !important",
    boxShadow: "none !important",
  },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "var(--mono)",
    lineHeight: "1.75",
    minWidth: "0",
    outline: "none !important",
    border: "none !important",
  },
  ".cm-content": {
    color: "var(--text)",
    padding: "16px 18px 28px",
    caretColor: "var(--accent) !important",
    minHeight: "100%",
    minWidth: "0",
    outline: "none !important",
    border: "none !important",
  },
  ".cm-line": {
    color: "var(--text)",
    caretColor: "var(--accent) !important",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    border: "none",
    color: "var(--text-mute)",
    paddingLeft: "6px",
  },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--accent-soft)",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeft: "2.5px solid var(--accent) !important",
    marginLeft: "-1px",
    opacity: "1 !important",
    visibility: "visible !important",
  },
});

const mobileScrollTheme = EditorView.theme({
  "&": {
    height: "100%",
    maxHeight: "100%",
    backgroundColor: "transparent",
  },
  "&.cm-editor": {
    height: "100%",
    maxHeight: "100%",
    overflow: "hidden",
  },
  ".cm-scroller": {
    overflowX: "hidden",
    overflowY: "auto",
    maxHeight: "100%",
    touchAction: "pan-y",
  },
  ".cm-content": {
    touchAction: "pan-y",
  },
});

function applyInsert(view: EditorView, text: string, cursorOffset?: number) {
  const { from, to } = view.state.selection.main;
  const offset = cursorOffset == null ? text.length : Math.max(0, Math.min(text.length, cursorOffset));
  applyEditorChange(view, {
    changes: { from, to, insert: text },
    selection: EditorSelection.single(from + offset),
  });
}

function applyWrap(view: EditorView, before: string, after: string) {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  const insert = `${before}${selected}${after}`;
  applyEditorChange(view, {
    changes: { from, to, insert },
    selection: selected
      ? EditorSelection.single(from + before.length, from + before.length + selected.length)
      : EditorSelection.single(from + before.length),
  });
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
    onScrollRatio?: (ratio: number) => void;
  }
>(function NoteMarkdownEditor({ value, onChange, placeholder, disabled, mobile, onImageFile, onScrollRatio }, ref) {
  const theme = useApp((s) => s.theme);
  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const onImageRef = useRef(onImageFile);
  const onScrollRatioRef = useRef(onScrollRatio);
  const composingRef = useRef(false);
  const focusedRef = useRef(false);
  const bumpImeRef = useRef(() => {});
  const [, setImeTick] = useState(0);
  bumpImeRef.current = () => setImeTick((n) => n + 1);
  useEffect(() => {
    onImageRef.current = onImageFile;
  }, [onImageFile]);
  useEffect(() => {
    onScrollRatioRef.current = onScrollRatio;
  }, [onScrollRatio]);

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const stableOnChange = useCallback((next: string) => {
    onChangeRef.current(next);
  }, []);

  useImperativeHandle(ref, () => ({
    wrapSelection(before, after = before) {
      const view = cmRef.current?.view;
      if (!view) return;
      applyWrap(view, before, after);
    },
    insertAtCursor(text, cursorOffset) {
      const view = cmRef.current?.view;
      if (!view) return;
      applyInsert(view, text, cursorOffset);
    },
    focus() {
      cmRef.current?.view?.focus();
    },
    setScrollRatio(ratio: number) {
      applyScrollRatio(cmRef.current?.view?.scrollDOM, ratio);
    },
    getMarkdown() {
      return cmRef.current?.view?.state.doc.toString();
    },
    isComposing() {
      return composingRef.current;
    },
    setMarkdown(text) {
      const view = cmRef.current?.view;
      if (!view) return;
      const current = view.state.doc.toString();
      if (current === text) return;
      const { from, to } = view.state.selection.main;
      const nextLen = text.length;
      applyEditorChange(view, {
        changes: { from: 0, to: current.length, insert: text },
        selection: EditorSelection.single(clampPos(nextLen, from), clampPos(nextLen, to)),
      });
    },
    revealCursor() {
      const view = cmRef.current?.view;
      if (!view) return;
      revealSelection(view);
    },
  }));

  const extensions = useMemo(
    () => [
      markdown(),
      EditorView.lineWrapping,
      drawSelection(),
      syntaxHighlighting(mdHighlight),
      chromeTheme,
      ...(mobile ? [mobileScrollTheme] : []),
      cmPlaceholder(placeholder || ""),
      ...(mobile
        ? [
            EditorView.scrollMargins.of(() => {
              return { top: 12, bottom: 72 };
            }),
          ]
        : []),
      ViewPlugin.fromClass(
        class {
          private readonly onScroll: () => void;
          private readonly scrollEl: HTMLElement;
          constructor(view: EditorView) {
            this.scrollEl = view.scrollDOM;
            this.onScroll = () => onScrollRatioRef.current?.(scrollRatioOf(this.scrollEl));
            this.scrollEl.addEventListener("scroll", this.onScroll, { passive: true });
          }
          destroy() {
            this.scrollEl.removeEventListener("scroll", this.onScroll);
          }
        },
      ),
      EditorView.domEventHandlers({
        compositionstart() {
          composingRef.current = true;
          bumpImeRef.current();
          return false;
        },
        compositionend() {
          composingRef.current = false;
          bumpImeRef.current();
          return false;
        },
        focus() {
          focusedRef.current = true;
          return false;
        },
        blur() {
          focusedRef.current = false;
          return false;
        },
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
    [placeholder, mobile],
  );

  const viewText = cmRef.current?.view?.state.doc.toString();
  const lockExternal = composingRef.current || focusedRef.current;
  const cmValue = lockExternal ? (viewText ?? value) : value;

  return (
    <CodeMirror
      ref={cmRef}
      className={"note-cm" + (mobile ? " is-mobile" : "")}
      value={cmValue}
      height="100%"
      theme={theme === "light" ? "light" : "dark"}
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
      onChange={stableOnChange}
    />
  );
});
