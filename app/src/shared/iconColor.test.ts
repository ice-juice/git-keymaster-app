import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { colorIconRef, isLetterIcon, parseIconColor, pickPlatformIcon, platformListIcon } from "./iconColor.ts";

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

const builtins = [
  { id: "github", name: "GitHub" },
  { id: "wechat", name: "微信" },
];

describe("platformListIcon", () => {
  test("keeps an uploaded image and a stored builtin icon", () => {
    assert.equal(
      platformListIcon("GitHub", ["custom:abc", "builtin:github"], builtins),
      "custom:abc",
    );
    assert.equal(platformListIcon("别的名字", ["builtin:github"], builtins), "builtin:github");
  });

  test("falls back to the preset logo when account icons are empty", () => {
    assert.equal(platformListIcon("GitHub", [undefined, ""], builtins), "builtin:github");
    assert.equal(platformListIcon("微信", [null], builtins), "builtin:wechat");
    assert.equal(platformListIcon("github.com", [undefined], builtins), "builtin:github");
  });

  test("keeps an explicit letter color and unknown platforms", () => {
    assert.equal(platformListIcon("GitHub", ["color:#475569"], builtins), "color:#475569");
    assert.equal(platformListIcon("我的站", [undefined], builtins), undefined);
  });
});
