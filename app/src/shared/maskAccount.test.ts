import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clampMaskKeep, maskAccountMiddle } from "./maskAccount.ts";

describe("clampMaskKeep", () => {
  test("defaults and clamps", () => {
    assert.equal(clampMaskKeep(Number.NaN), 3);
    assert.equal(clampMaskKeep(0), 1);
    assert.equal(clampMaskKeep(3.6), 4);
    assert.equal(clampMaskKeep(99), 8);
  });
});

describe("maskAccountMiddle", () => {
  test("returns full text when disabled", () => {
    assert.equal(maskAccountMiddle("lynecham81@icloud.com", 3, false), "lynecham81@icloud.com");
  });

  test("keeps head and tail when long enough", () => {
    assert.equal(maskAccountMiddle("abcdefghij", 3), "abc***hij");
    assert.equal(maskAccountMiddle("tcho100@gmail.com", 3), "tch***com");
  });

  test("uses custom keep count", () => {
    assert.equal(maskAccountMiddle("1234567890", 2), "12***90");
    assert.equal(maskAccountMiddle("1234567890", 4), "1234***7890");
  });

  test("degrades short strings instead of losing identity", () => {
    assert.equal(maskAccountMiddle(""),  "");
    assert.equal(maskAccountMiddle("a"), "a");
    assert.equal(maskAccountMiddle("ab"), "ab");
    assert.equal(maskAccountMiddle("abc"), "a***c");
    assert.equal(maskAccountMiddle("abcdef", 3), "a***f");
  });

  test("handles unicode code points, not UTF-16 units", () => {
    assert.equal(maskAccountMiddle("账号名字测试一二", 2), "账号***一二");
  });
});
