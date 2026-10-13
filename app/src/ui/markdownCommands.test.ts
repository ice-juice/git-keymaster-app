import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { history, undoDepth } from "@codemirror/commands";
import { EditorSelection, EditorState } from "@codemirror/state";
import {
  planInsertCodeBlock,
  planInsertHr,
  planInsertTable,
  planToggleHeading,
  planToggleLinePrefix,
  planToggleWrap,
  type PlannedEdit,
} from "./markdownCommands.ts";
import { editorStateReplacingDoc, isWholesaleReplace, planMinimalReplace } from "./markdownDocSync.ts";

function apply(doc: string, from: number, to: number, plan: (state: EditorState) => PlannedEdit) {
  const state = EditorState.create({
    doc,
    selection: from === to ? EditorSelection.cursor(from) : EditorSelection.range(from, to),
  });
  const edit = plan(state);
  return state.update({ changes: edit.changes, selection: edit.selection }).state;
}

describe("markdown commands", () => {
  test("行中间切换标题不会劈行", () => {
    const next = apply("hello world", 6, 6, (state) => planToggleHeading(state, 1));
    assert.equal(next.doc.toString(), "# hello world");
    assert.equal(next.doc.lines, 1);
    const off = apply("# hello world", 4, 4, (state) => planToggleHeading(state, 1));
    assert.equal(off.doc.toString(), "hello world");
  });

  test("多行无序列表可开关", () => {
    const on = apply("alpha\nbeta\ngamma", 2, 14, (state) => planToggleLinePrefix(state, "ul"));
    assert.equal(on.doc.toString(), "- alpha\n- beta\n- gamma");
    const off = apply("- alpha\n- beta\n- gamma", 0, on.doc.length, (state) => planToggleLinePrefix(state, "ul"));
    assert.equal(off.doc.toString(), "alpha\nbeta\ngamma");
  });

  test("有序列表从 1 编号", () => {
    const next = apply("alpha\nbeta\ngamma", 0, 16, (state) => planToggleLinePrefix(state, "ol"));
    assert.equal(next.doc.toString(), "1. alpha\n2. beta\n3. gamma");
  });

  test("包裹标记可以解开", () => {
    const wrapped = apply("hello", 0, 5, (state) => planToggleWrap(state, "**"));
    assert.equal(wrapped.doc.toString(), "**hello**");
    const inner = apply("**hello**", 2, 7, (state) => planToggleWrap(state, "**"));
    assert.equal(inner.doc.toString(), "hello");
    const whole = apply("**hello**", 0, 9, (state) => planToggleWrap(state, "**"));
    assert.equal(whole.doc.toString(), "hello");
  });

  test("链接无选区时光标在括号间，有选区时选中 url", () => {
    const empty = apply("hello", 5, 5, (state) => planToggleWrap(state, "[", "](url)"));
    assert.equal(empty.doc.toString(), "hello[](url)");
    assert.equal(empty.selection.main.head, 6);
    const picked = apply("hello", 0, 5, (state) => planToggleWrap(state, "[", "](url)"));
    assert.equal(picked.doc.toString(), "[hello](url)");
    assert.equal(picked.sliceDoc(picked.selection.main.from, picked.selection.main.to), "url");
  });

  test("代码块按整行插入，不劈开当前行", () => {
    const next = apply("hello world", 5, 5, (state) => planInsertCodeBlock(state));
    const text = next.doc.toString();
    assert.equal(text.includes("hello world"), true);
    assert.equal(text.includes("hel```") || text.includes("lo```"), false);
    assert.match(text, /```\n\n```/);
    assert.equal(next.doc.lineAt(next.selection.main.head).text, "");
  });

  test("代码块包裹选区", () => {
    const next = apply("foo\nbar", 0, 7, (state) => planInsertCodeBlock(state));
    assert.match(next.doc.toString(), /```\nfoo\nbar\n```/);
  });

  test("分隔线单独成行", () => {
    const next = apply("hello world", 3, 3, (state) => planInsertHr(state));
    assert.equal(next.doc.toString(), "hello world\n\n---\n");
  });

  test("表格光标落在第一个单元格", () => {
    const next = apply("hello", 5, 5, (state) => planInsertTable(state));
    const text = next.doc.toString();
    assert.match(text, /\| {2}\| {2}\| {2}\|/);
    const at = next.selection.main.head;
    assert.equal(text.slice(at - 2, at), "| ");
  });
});

describe("markdown doc sync", () => {
  test("前后缀对齐只替换中间一段", () => {
    assert.deepEqual(planMinimalReplace("hello world", "hello there"), { from: 6, to: 11, insert: "there" });
    assert.equal(planMinimalReplace("same", "same"), null);
  });

  test("整篇不同算作大替换", () => {
    const current = "a".repeat(80);
    const next = "b".repeat(80);
    const spec = planMinimalReplace(current, next);
    assert.ok(spec);
    assert.equal(isWholesaleReplace(current, next, spec), true);
    assert.equal(isWholesaleReplace("hello world", "hello there", planMinimalReplace("hello world", "hello there")!), false);
  });

  test("重建文档后不能撤销回上一篇", () => {
    let state = EditorState.create({ doc: "上一篇", extensions: [history()] });
    state = state.update({ changes: { from: 0, to: 0, insert: "改" } }).state;
    assert.ok(undoDepth(state) > 0);
    const replaced = editorStateReplacingDoc(state, "下一篇");
    assert.equal(replaced.doc.toString(), "下一篇");
    assert.equal(undoDepth(replaced), 0);
    assert.equal(replaced.selection.main.head, 0);
  });
});
