import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { appUpdateNotes } from "./updateNotes.ts";

const SAMPLE = [
  "### 新增功能",
  "- 自定义字段",
  "",
  "### 修复问题",
  "- 安卓上传图标",
  "",
  "### 下载建议",
  "- **每平台一份**：不要按语言挑两套",
  "- **Windows**：setup.exe",
].join("\n");

describe("appUpdateNotes", () => {
  test("drops the download guide and keeps the changelog", () => {
    assert.equal(
      appUpdateNotes(SAMPLE),
      ["### 新增功能", "- 自定义字段", "", "### 修复问题", "- 安卓上传图标"].join("\n"),
    );
  });

  test("drops an english download heading", () => {
    assert.equal(
      appUpdateNotes("### Fixes\n- a\n\n### Download suggestions\n- setup.exe"),
      "### Fixes\n- a",
    );
  });

  test("leaves notes unchanged when there is no download guide", () => {
    const notes = "### 修复问题\n- 乙";
    assert.equal(appUpdateNotes(notes), notes);
  });

  test("returns empty for missing notes or a guide-only body", () => {
    assert.equal(appUpdateNotes(null), "");
    assert.equal(appUpdateNotes("### 下载建议\n- 只剩下载说明"), "");
  });
});
