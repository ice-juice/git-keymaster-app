import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorSelection, Transaction, type EditorState } from "@codemirror/state";
import { EditorView, ViewPlugin, drawSelection, placeholder as cmPlaceholder } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useApp } from "../store";
import { editorStateReplacingDoc, isWholesaleReplace, planMinimalReplace } from "./markdownDocSync";
import {
  dispatchMarkdownEdit,
  insertCodeBlock,
  insertHr,
  insertTable,
  planInsertAtSelection,
  planToggleWrap,
  toggleHeading,
  toggleLinePrefix,
  toggleWrap,
  type LinePrefixKind,
  type PlannedEdit,
} from "./markdownCommands";

export type { LinePrefixKind, PlannedEdit };

export type NoteMarkdownEditorHandle = {
  wrapSelection: (before: string, after?: string) => void;
  insertAtCursor: (text: string, cursorOffset?: number) => void;
  focus: () => void;
  setScrollRatio: (ratio: number) => void;
  isComposing: () => boolean;
  setMarkdown: (text: string) => void;
  revealCursor: () => void;
  applyEdit: (plan: (state: EditorState) => PlannedEdit) => boolean;
  toggleHeading: (level: 1 | 2 | 3) => void;
  toggleLinePrefix: (kind: LinePrefixKind) => void;
  toggleWrap: (before: string, after?: string) => void;
  insertCodeBlock: () => void;
  insertHr: () => void;
  insertTable: () => void;
  /** 源码可视区顶部对应的行号（从 1 开始）。 */
  sourceLineAtTop: () => number;
  /** 把指定源码行滚到可视区顶部。 */
  scrollToSourceLine: (line: number) => void;
};

function revealSelection(view: EditorView) {
  view.dispatch({
    effects: EditorView.scrollIntoView(view.state.selection.main.head, {
      y: "nearest",
      yMargin: 48,
    }),
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

export function sourceLineAtScrollTop(view: EditorView): number {
  const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
  return view.state.doc.lineAt(block.from).number;
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
    backgroundColor: "var(--bg)",
    color: "var(--text-mute)",
    border: "none",
    borderRight: "1px solid var(--border-strong)",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif",
    fontSize: "11px",
    fontVariantNumeric: "tabular-nums",
    minHeight: "100%",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    padding: "0 12px 0 10px",
    minWidth: "2.8em",
    textAlign: "right",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--step-bg)",
    color: "var(--text-soft)",
    fontWeight: "650",
  },
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

/**
 * 把外部正文写进编辑器。
 * 切换笔记时重建状态，撤销不能回到上一篇；同一篇里的小改动走最小替换，保留撤销和选区。
 */
function applyExternalDocument(view: EditorView, next: string, noteChanged: boolean) {
  const current = view.state.doc.toString();
  if (noteChanged) {
    view.setState(editorStateReplacingDoc(view.state, next, EditorSelection.single(0)));
    return;
  }
  const spec = planMinimalReplace(current, next);
  if (!spec) return;
  const changes = view.state.changes(spec);
  const selection = view.state.selection.map(changes);
  if (isWholesaleReplace(current, next, spec)) {
    view.setState(editorStateReplacingDoc(view.state, next, selection));
    return;
  }
  view.dispatch({
    changes,
    selection,
    annotations: Transaction.addToHistory.of(false),
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
    /** 打开另一篇笔记时递增，用来清空撤销栈。保存后拿到 id 不要变这个值。 */
    syncEpoch?: number;
    onImageFile?: (file: File) => void;
    onScrollRatio?: (ratio: number) => void;
    onScrollLine?: (line: number) => void;
  }
>(function NoteMarkdownEditor(
  { value, onChange, placeholder, disabled, mobile, syncEpoch = 0, onImageFile, onScrollRatio, onScrollLine },
  ref,
) {
  const theme = useApp((s) => s.theme);
  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const onImageRef = useRef(onImageFile);
  const onScrollRatioRef = useRef(onScrollRatio);
  const onScrollLineRef = useRef(onScrollLine);
  const composingRef = useRef(false);
  const onChangeRef = useRef(onChange);
  const emittedRef = useRef(value);
  const epochRef = useRef(syncEpoch);
  const initialDocRef = useRef(value);
  onChangeRef.current = onChange;

  useEffect(() => {
    onImageRef.current = onImageFile;
  }, [onImageFile]);
  useEffect(() => {
    onScrollRatioRef.current = onScrollRatio;
  }, [onScrollRatio]);
  useEffect(() => {
    onScrollLineRef.current = onScrollLine;
  }, [onScrollLine]);

  const stableOnChange = useCallback((next: string) => {
    emittedRef.current = next;
    onChangeRef.current(next);
  }, []);

  const withView = useCallback((fn: (view: EditorView) => void) => {
    const view = cmRef.current?.view;
    if (!view) return false;
    fn(view);
    return true;
  }, []);

  useImperativeHandle(ref, () => ({
    wrapSelection(before, after = before) {
      withView((view) => dispatchMarkdownEdit(view, planToggleWrap(view.state, before, after)));
    },
    insertAtCursor(text, cursorOffset) {
      withView((view) => dispatchMarkdownEdit(view, planInsertAtSelection(view.state, text, cursorOffset)));
    },
    focus() {
      cmRef.current?.view?.focus();
    },
    setScrollRatio(ratio: number) {
      applyScrollRatio(cmRef.current?.view?.scrollDOM, ratio);
    },
    isComposing() {
      return composingRef.current;
    },
    setMarkdown(text) {
      const view = cmRef.current?.view;
      if (!view) return;
      emittedRef.current = text;
      applyExternalDocument(view, text, false);
    },
    revealCursor() {
      const view = cmRef.current?.view;
      if (!view) return;
      revealSelection(view);
    },
    applyEdit(plan) {
      return withView((view) => dispatchMarkdownEdit(view, plan(view.state)));
    },
    toggleHeading(level) {
      withView((view) => toggleHeading(view, level));
    },
    toggleLinePrefix(kind) {
      withView((view) => toggleLinePrefix(view, kind));
    },
    toggleWrap(before, after) {
      withView((view) => toggleWrap(view, before, after));
    },
    insertCodeBlock() {
      withView((view) => insertCodeBlock(view));
    },
    insertHr() {
      withView((view) => insertHr(view));
    },
    insertTable() {
      withView((view) => insertTable(view));
    },
    sourceLineAtTop() {
      const view = cmRef.current?.view;
      if (!view) return 1;
      return sourceLineAtScrollTop(view);
    },
    scrollToSourceLine(line: number) {
      const view = cmRef.current?.view;
      if (!view) return;
      const safe = Math.max(1, Math.min(view.state.doc.lines, Math.floor(line) || 1));
      const top = view.lineBlockAt(view.state.doc.line(safe).from).top;
      if (Math.abs(view.scrollDOM.scrollTop - top) < 1) return;
      view.scrollDOM.scrollTop = top;
    },
  }));

  useEffect(() => {
    const view = cmRef.current?.view;
    if (!view) return;
    const noteChanged = syncEpoch !== epochRef.current;
    epochRef.current = syncEpoch;
    const current = view.state.doc.toString();
    if (!noteChanged && value === current) return;
    // 父级还停在编辑器刚发出的文本，而文档已经又变了，不能把旧文本盖回去。
    if (!noteChanged && value === emittedRef.current) return;
    emittedRef.current = value;
    applyExternalDocument(view, value, noteChanged);
  }, [value, syncEpoch]);

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
            this.onScroll = () => {
              onScrollRatioRef.current?.(scrollRatioOf(this.scrollEl));
              const line = view.state.doc.lineAt(view.lineBlockAtHeight(this.scrollEl.scrollTop).from).number;
              onScrollLineRef.current?.(line);
            };
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
          return false;
        },
        compositionend() {
          composingRef.current = false;
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

  return (
    <CodeMirror
      ref={cmRef}
      className={"note-cm" + (mobile ? " is-mobile" : "")}
      value={initialDocRef.current}
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
