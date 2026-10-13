import { EditorSelection, EditorState, type Extension } from "@codemirror/state";

/** 前后缀对齐出的一段替换。两边完全不同时自然退化成整篇替换。 */
export function planMinimalReplace(current: string, next: string): { from: number; to: number; insert: string } | null {
  if (current === next) return null;
  let start = 0;
  const aLen = current.length;
  const bLen = next.length;
  const min = Math.min(aLen, bLen);
  while (start < min && current.charCodeAt(start) === next.charCodeAt(start)) start += 1;
  if (start > 0 && start < aLen && isLowSurrogate(current.charCodeAt(start))) start -= 1;
  let aEnd = aLen;
  let bEnd = bLen;
  while (aEnd > start && bEnd > start && current.charCodeAt(aEnd - 1) === next.charCodeAt(bEnd - 1)) {
    aEnd -= 1;
    bEnd -= 1;
  }
  if (aEnd < aLen && isLowSurrogate(current.charCodeAt(aEnd))) aEnd += 1;
  if (bEnd < bLen && isLowSurrogate(next.charCodeAt(bEnd))) bEnd += 1;
  return { from: start, to: aEnd, insert: next.slice(start, bEnd) };
}

function isLowSurrogate(code: number) {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * 改动覆盖大半篇时，最小 diff 已经接近整篇替换。
 * 这种替换留在旧撤销栈里，撤销会把上一篇正文映射回来。
 */
export function isWholesaleReplace(current: string, next: string, spec: { from: number; to: number; insert: string }): boolean {
  const changed = Math.max(spec.to - spec.from, spec.insert.length);
  const size = Math.max(current.length, next.length, 1);
  return changed >= 48 && changed / size >= 0.45;
}

type StateWithConfig = EditorState & { config?: { base?: Extension } };

/** 读出创建时的扩展列表。CodeMirror 6.11 没有公开的 resetHistory。 */
export function readConfiguredExtensions(state: EditorState): Extension {
  return (state as StateWithConfig).config?.base ?? [];
}

/** 用同一套扩展重建状态，撤销栈清空，选区夹到新文档内。 */
export function editorStateReplacingDoc(state: EditorState, doc: string, selection = EditorSelection.single(0)): EditorState {
  const len = doc.length;
  const anchor = Math.max(0, Math.min(len, selection.main.anchor));
  const head = Math.max(0, Math.min(len, selection.main.head));
  return EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: readConfiguredExtensions(state),
  });
}
