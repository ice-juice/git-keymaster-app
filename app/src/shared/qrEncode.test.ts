import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { encodeQrDataUrl, encodeQrSvg } from "./qrEncode.ts";

describe("qrEncode", () => {
  test("encodes text to SVG and data URL", () => {
    const svg = encodeQrSvg("hello-keymaster");
    assert.match(svg, /<svg[\s>]/i);
    assert.match(svg, /<\/svg>/i);

    const dataUrl = encodeQrDataUrl("hello-keymaster");
    assert.match(dataUrl, /^data:image\/gif;base64,/);
    assert.ok(dataUrl.length > 80);
  });

  test("accepts UTF-8 payload", () => {
    const svg = encodeQrSvg("御钥师");
    assert.match(svg, /<svg[\s>]/i);
  });
});
