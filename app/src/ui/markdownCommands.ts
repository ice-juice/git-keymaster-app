import { EditorSelection, EditorState, type ChangeSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** 命令算出的变更。选区坐标是变更之后的文档。 */
export interface PlannedEdit {
  changes: ChangeSpec;
  selection: EditorSelection;
}

export type LinePrefixKind = "ul" | "ol" | "quote" | "task";

export const EMPTY_MARKDOWN_TABLE = "|  |  |  |\n| --- | --- | --- |\n|  |  |  |";

const SCROLL = { y: "nearest" as const, yMargin: 48 };

type DocLine = { from: number; to: number; text: string; number: number };

/** 选区覆盖到的行。选区刚好停在下一行行首时，不把那一行算进去。 */
function coveredLines(state: EditorState): DocLine[] {
  const sel = state.selection.main;
  let from = sel.from;
  let to = sel.to;
  if (to > from) {
    const end = state.doc.lineAt(to);
    if (to === end.from) to -= 1;
  }
  const startLine = state.doc.lineAt(from);
  const endLine = state.doc.lineAt(Math.max(from, to));
  const lines: DocLine[] = [];
  for (let n = startLine.number; n <= endLine.number; n++) {
    const line = state.doc.line(n);
    lines.push({ from: line.from, to: line.to, text: line.text, number: line.number });
  }
  return lines;
}

/** 多行选区跳过空行；光标停在空行上时仍操作这一行。 */
function targetLines(state: EditorState): DocLine[] {
  const lines = coveredLines(state);
  if (state.selection.main.empty) return lines;
  const content = lines.filter((line) => line.text.trim().length > 0);
  return content.length ? content : lines;
}

function finish(state: EditorState, changes: ChangeSpec[]): PlannedEdit {
  if (!changes.length) return { changes: [], selection: state.selection };
  const mapped = state.selection.map(state.changes(changes));
  return { changes, selection: mapped };
}

const HEADING_RE = /^(#{1,6})\s?(.*)$/;

function headingOf(text: string): { level: number; rest: string } | null {
  const matched = HEADING_RE.exec(text);
  if (!matched) return null;
  return { level: matched[1].length, rest: matched[2] };
}

/** 行内切换标题，不插入换行，因此不会把当前行劈开。 */
export function planToggleHeading(state: EditorState, level: 1 | 2 | 3): PlannedEdit {
  const lines = targetLines(state);
  const allOn = lines.length > 0 && lines.every((line) => headingOf(line.text)?.level === level);
  const mark = "#".repeat(level);
  const changes: ChangeSpec[] = [];
  for (const line of lines) {
    const parsed = headingOf(line.text);
    const rest = parsed ? parsed.rest : line.text;
    const insert = allOn ? rest : `${mark} ${rest}`;
    if (insert === line.text) continue;
    changes.push({ from: line.from, to: line.to, insert });
  }
  return finish(state, changes);
}

function hasPrefix(kind: LinePrefixKind, text: string): boolean {
  if (kind === "ul") return /^- (?!\[[ xX]\] )/.test(text);
  if (kind === "ol") return /^\d+\. /.test(text);
  if (kind === "quote") return /^>\s?/.test(text);
  return /^- \[[ xX]\] /.test(text);
}

function stripListPrefix(text: string): string {
  return text.replace(/^- \[[ xX]\] /, "").replace(/^\d+\. /, "").replace(/^- /, "");
}

function stripQuote(text: string): string {
  return text.replace(/^>\s?/, "");
}

/** 对选区覆盖的每一行加前缀；再点一次去掉。有序列表从 1 重新编号。 */
export function planToggleLinePrefix(state: EditorState, kind: LinePrefixKind): PlannedEdit {
  const lines = targetLines(state);
  const allOn = lines.length > 0 && lines.every((line) => hasPrefix(kind, line.text));
  const changes: ChangeSpec[] = [];
  let ordinal = 1;
  for (const line of lines) {
    let insert: string;
    if (allOn) {
      if (kind === "quote") insert = stripQuote(line.text);
      else if (kind === "ul") insert = line.text.replace(/^- (?!\[[ xX]\] )/, "");
      else if (kind === "ol") insert = line.text.replace(/^\d+\. /, "");
      else insert = line.text.replace(/^- \[[ xX]\] /, "");
    } else if (kind === "quote") {
      insert = `> ${stripQuote(line.text)}`;
    } else if (kind === "ol") {
      insert = `${ordinal}. ${stripListPrefix(line.text)}`;
      ordinal += 1;
    } else if (kind === "task") {
      insert = `- [ ] ${stripListPrefix(line.text)}`;
    } else {
      insert = `- ${stripListPrefix(line.text)}`;
    }
    if (insert === line.text) continue;
    changes.push({ from: line.from, to: line.to, insert });
  }
  return finish(state, changes);
}

function outsideMatch(state: EditorState, from: number, to: number, before: string, after: string): boolean {
  if (from < before.length || to + after.length > state.doc.length) return false;
  if (state.sliceDoc(from - before.length, from) !== before) return false;
  if (state.sliceDoc(to, to + after.length) !== after) return false;
  // `*` 不要把 `**` 误判成斜体包裹。
  if (before === "*" && from >= 2 && state.sliceDoc(from - 2, from) === "**") return false;
  if (after === "*" && to + 2 <= state.doc.length && state.sliceDoc(to, to + 2) === "**") return false;
  return true;
}

/** 选区已被同一对标记包住则解开；没有选区时插入标记并把光标放在中间。 */
export function planToggleWrap(state: EditorState, before: string, after = before): PlannedEdit {
  const sel = state.selection.main;
  const from = sel.from;
  const to = sel.to;
  const selected = state.sliceDoc(from, to);
  const isLink = before === "[" && after === "](url)";

  if (from === to) {
    if (outsideMatch(state, from, to, before, after)) {
      return {
        changes: [
          { from: to, to: to + after.length, insert: "" },
          { from: from - before.length, to: from, insert: "" },
        ],
        selection: EditorSelection.single(from - before.length),
      };
    }
    return {
      changes: { from, to, insert: before + after },
      selection: EditorSelection.single(from + before.length),
    };
  }

  if (outsideMatch(state, from, to, before, after)) {
    return {
      changes: [
        { from: to, to: to + after.length, insert: "" },
        { from: from - before.length, to: from, insert: "" },
      ],
      selection: EditorSelection.single(from - before.length, to - before.length),
    };
  }

  if (selected.startsWith(before) && selected.endsWith(after) && selected.length >= before.length + after.length) {
    const inner = selected.slice(before.length, selected.length - after.length);
    return {
      changes: { from, to, insert: inner },
      selection: EditorSelection.single(from, from + inner.length),
    };
  }

  if (isLink) {
    const insert = `[${selected}](url)`;
    const urlFrom = from + selected.length + 3;
    return {
      changes: { from, to, insert },
      selection: EditorSelection.single(urlFrom, urlFrom + 3),
    };
  }

  return {
    changes: { from, to, insert: before + selected + after },
    selection: EditorSelection.single(from + before.length, from + before.length + selected.length),
  };
}

export function planInsertAtSelection(state: EditorState, text: string, cursorOffset?: number): PlannedEdit {
  const { from, to } = state.selection.main;
  const offset = cursorOffset == null ? text.length : Math.max(0, Math.min(text.length, cursorOffset));
  return {
    changes: { from, to, insert: text },
    selection: EditorSelection.single(from + offset),
  };
}

/**
 * 在整行边界插入一块文本。光标在行中间时不劈开该行。
 * cursorInBlock 是块内部的光标偏移。
 */
function planInsertBlock(state: EditorState, block: string, cursorInBlock: number): PlannedEdit {
  const line = state.doc.lineAt(state.selection.main.head);
  const doc = state.doc;
  const cursorAt = Math.max(0, Math.min(block.length, cursorInBlock));

  if (line.text.length > 0) {
    const at = line.number < doc.lines ? doc.line(line.number + 1).from : doc.length;
    const atEnd = at >= doc.length;
    const insert = atEnd ? `\n\n${block}\n` : `\n${block}\n\n`;
    return {
      changes: { from: at, to: at, insert },
      selection: EditorSelection.single(at + insert.indexOf(block) + cursorAt),
    };
  }

  const from = line.from;
  const to = line.number < doc.lines ? doc.line(line.number + 1).from : doc.length;
  const prevNonEmpty = line.number > 1 && doc.line(line.number - 1).text.length > 0;
  const nextExists = to < doc.length;
  let insert = block;
  if (prevNonEmpty) insert = `\n${insert}`;
  insert = nextExists ? `${insert}\n\n` : `${insert}\n`;
  return {
    changes: { from, to, insert },
    selection: EditorSelection.single(from + insert.indexOf(block) + cursorAt),
  };
}

const CODE_FENCE = "```\n\n```";

/** 按整行插入围栏。没有选区时光标在围栏中间；有选区则包住整行。 */
export function planInsertCodeBlock(state: EditorState): PlannedEdit {
  const sel = state.selection.main;
  if (sel.empty) return planInsertBlock(state, CODE_FENCE, 4);

  const startLine = state.doc.lineAt(sel.from);
  let endPos = sel.to;
  if (endPos > sel.from) {
    const end = state.doc.lineAt(endPos);
    if (endPos === end.from) endPos -= 1;
  }
  const endLine = state.doc.lineAt(Math.max(sel.from, endPos));
  const from = startLine.from;
  const to = endLine.to;
  const inner = state.sliceDoc(from, to);
  let insert = "```\n" + inner + "\n```";
  if (startLine.number > 1 && state.doc.line(startLine.number - 1).text.length > 0) insert = `\n${insert}`;
  const atEnd = endLine.number === state.doc.lines;
  insert = atEnd ? `${insert}\n` : `${insert}\n\n`;
  return {
    changes: { from, to, insert },
    selection: EditorSelection.single(from + insert.indexOf("```\n") + 4),
  };
}

export function planInsertHr(state: EditorState): PlannedEdit {
  return planInsertBlock(state, "---", 3);
}

export function planInsertTable(state: EditorState): PlannedEdit {
  return planInsertBlock(state, EMPTY_MARKDOWN_TABLE, 2);
}

/** 派发命令，视口只跟光标，不改 scrollTop。 */
export function dispatchMarkdownEdit(view: EditorView, edit: PlannedEdit) {
  view.dispatch({
    changes: edit.changes,
    selection: edit.selection,
    effects: EditorView.scrollIntoView(edit.selection.main.head, SCROLL),
  });
  if (!view.hasFocus) view.contentDOM.focus({ preventScroll: true });
}

export function toggleHeading(view: EditorView, level: 1 | 2 | 3) {
  dispatchMarkdownEdit(view, planToggleHeading(view.state, level));
}

export function toggleLinePrefix(view: EditorView, kind: LinePrefixKind) {
  dispatchMarkdownEdit(view, planToggleLinePrefix(view.state, kind));
}

export function toggleWrap(view: EditorView, before: string, after?: string) {
  dispatchMarkdownEdit(view, planToggleWrap(view.state, before, after));
}

export function insertCodeBlock(view: EditorView) {
  dispatchMarkdownEdit(view, planInsertCodeBlock(view.state));
}

export function insertHr(view: EditorView) {
  dispatchMarkdownEdit(view, planInsertHr(view.state));
}

export function insertTable(view: EditorView) {
  dispatchMarkdownEdit(view, planInsertTable(view.state));
}
