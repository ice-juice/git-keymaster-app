import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { noteTagColor, tagColor } from "./tagColor.ts";

describe("tagColor", () => {
  it("keeps one color for the same tag", () => {
    assert.deepEqual(tagColor("老婆"), tagColor(" 老婆 "));
    assert.deepEqual(tagColor("Work"), tagColor("work"));
  });

  it("can separate different tags", () => {
    const a = tagColor("老婆");
    const b = tagColor("私人账号");
    const c = tagColor("work");
    assert.notEqual(a.fg, b.fg);
    assert.notEqual(b.fg, c.fg);
  });
});

describe("noteTagColor", () => {
  it("keeps a soft color for the same note tag", () => {
    assert.deepEqual(noteTagColor("程序猿"), noteTagColor(" 程序猿 "));
    assert.notEqual(noteTagColor("程序猿").fg, noteTagColor("技术").fg);
    assert.notEqual(noteTagColor("windows").fg, noteTagColor("开发").fg);
    assert.equal(noteTagColor("windows", true).fg, noteTagColor("windows").fg);
  });
});
