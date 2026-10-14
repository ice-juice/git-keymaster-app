import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { packJsSource, unpackJsSource } from "./jsPack.ts";

describe("jsPack", () => {
  test("roundtrip", () => {
    const src = "console.log('ok');\n";
    const wrapped = packJsSource(src);
    assert.match(wrapped, /^eval\(atob\(/);
    assert.equal(unpackJsSource(wrapped), src);
  });
});
