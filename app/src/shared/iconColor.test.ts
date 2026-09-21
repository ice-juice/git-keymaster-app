import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { colorIconRef, isLetterIcon, parseIconColor, pickPlatformIcon } from "./iconColor.ts";

describe("parseIconColor", () => {
  test("reads a stored letter color", () => {
    assert.equal(parseIconColor("color:#EA580C"), "#ea580c");
    assert.equal(parseIconColor("builtin:github"), null);
    assert.equal(parseIconColor("custom:abc"), null);
  });
});

describe("colorIconRef", () => {
  test("normalizes hex into an icon ref", () => {
    assert.equal(colorIconRef("#2563EB"), "color:#2563eb");
  });
});

describe("isLetterIcon", () => {
  test("letter mode is empty or a color ref", () => {
    assert.equal(isLetterIcon(undefined), true);
    assert.equal(isLetterIcon("color:#2563eb"), true);
    assert.equal(isLetterIcon("builtin:github"), false);
  });
});

describe("pickPlatformIcon", () => {
  test("prefers an uploaded image over a letter color", () => {
    assert.equal(
      pickPlatformIcon(["color:#475569", "custom:abc", "builtin:github"]),
      "custom:abc",
    );
  });
});
