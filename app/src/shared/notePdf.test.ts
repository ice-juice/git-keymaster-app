import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseBlocks } from "../lib/notePdf.ts";

describe("PDF markdown parser termination", () => {
  it("preserves unsupported and unfinished images as text and continues", () => {
    for (const image of ["![image](https://example.invalid/a.png)", "![unfinished", "![x](kmasset://bad)"]) {
      const blocks = parseBlocks(`${image}\n\n# Next`);
      assert.equal(blocks.length, 2);
      assert.equal(blocks[0].type, "para");
      assert.deepEqual(blocks[1], { type: "heading", level: 1, text: "Next" });
    }
  });
  it("retains supported embedded images", () => {
    assert.deepEqual(parseBlocks("![x](data:image/png;base64,AAAA)"), [
      { type: "image", src: "data:image/png;base64,AAAA", alt: "x" },
    ]);
  });
});
