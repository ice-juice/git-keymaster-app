import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterBuiltinIcons, findBuiltinAccount, platformEntryMode, resolveBuiltinQuery } from "./iconAliases.ts";

const builtins = [
  { id: "twitter", name: "Twitter/X", color: "#000", glyph: "X" },
  { id: "facebook", name: "Facebook", color: "#0866FF", glyph: "f" },
  { id: "wechat", name: "微信", color: "#07C160", glyph: "微" },
  { id: "telegram", name: "Telegram", color: "#26A5E4", glyph: "TG" },
  { id: "github", name: "GitHub", color: "#181717", glyph: "GH" },
  { id: "deepseek", name: "DeepSeek", color: "#4D6BFE", glyph: "DS" },
  { id: "binance", name: "币安", color: "#F0B90B", glyph: "币" },
];

describe("resolveBuiltinQuery", () => {
  it("matches domains and short aliases", () => {
    assert.equal(resolveBuiltinQuery("x.com", builtins), "twitter");
    assert.equal(resolveBuiltinQuery("facebook.com", builtins), "facebook");
    assert.equal(resolveBuiltinQuery("t.me", builtins), "telegram");
    assert.equal(resolveBuiltinQuery("GitHub", builtins), "github");
    assert.equal(resolveBuiltinQuery("深度求索", builtins), "deepseek");
    assert.equal(resolveBuiltinQuery("币安", builtins), "binance");
  });

  it("matches Chinese names", () => {
    assert.equal(resolveBuiltinQuery("微信", builtins), "wechat");
    assert.equal(resolveBuiltinQuery("推特", builtins), "twitter");
  });
});

describe("findBuiltinAccount", () => {
  it("matches a built-in icon or the official name", () => {
    assert.equal(findBuiltinAccount(builtins, "别的名字", "builtin:github")?.id, "github");
    assert.equal(findBuiltinAccount(builtins, "微信", "custom:abc")?.id, "wechat");
    assert.equal(findBuiltinAccount(builtins, "我的站", "custom:abc"), undefined);
  });
});

describe("platformEntryMode", () => {
  it("starts blank accounts on the built-in list", () => {
    assert.equal(platformEntryMode(builtins, "", ""), "builtin");
    assert.equal(platformEntryMode(builtins, "GitHub", ""), "builtin");
    assert.equal(platformEntryMode(builtins, "我的站", "custom:abc"), "custom");
  });
});

describe("filterBuiltinIcons", () => {
  it("filters the picker by alias", () => {
    const hit = filterBuiltinIcons(builtins, "脸书");
    assert.deepEqual(hit.map((item) => item.id), ["facebook"]);
  });
});
