import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { existingRecordNeedsEditAuth } from "./editAuth.ts";

describe("edit auth gate", () => {
  test("已有记录要验证，新建不用", () => {
    assert.equal(existingRecordNeedsEditAuth("acc-1"), true);
    assert.equal(existingRecordNeedsEditAuth("  "), false);
    assert.equal(existingRecordNeedsEditAuth(""), false);
    assert.equal(existingRecordNeedsEditAuth(undefined), false);
    assert.equal(existingRecordNeedsEditAuth(null), false);
  });
});
