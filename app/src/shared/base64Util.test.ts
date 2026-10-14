import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { base64DecodeUtf8, base64EncodeUtf8 } from "./base64Util.ts";

describe("base64Util", () => {
  test("utf8 roundtrip", () => {
    const s = "Hello 世界 🎉";
    assert.equal(base64DecodeUtf8(base64EncodeUtf8(s)), s);
  });
});
