import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { PAGE_SCRIPT } from "../src/page-script.ts";
import { renderV2Page as renderPickup } from "../src/page-v2.ts";

function inlinedScript(html: string): string {
  const start = html.indexOf("<script>") + "<script>".length;
  const end = html.lastIndexOf("</script>");
  return html.slice(start, end);
}

const source = readFileSync(new URL("../src/download-client.ts", import.meta.url), "utf8");

test("download page keeps fragment keys local and uses lookup / original-operation claims", () => {
  assert.match(source, /location\.hash/);
  assert.match(source, /\/lookup`, \{ code \}/);
  assert.doesNotMatch(source, /LOCKER_HMAC_SECRET/);
  assert.doesNotMatch(source, /locker-pickup-v1/);
  assert.match(PAGE_SCRIPT, /\/v2\/claims\//);
  assert.doesNotMatch(PAGE_SCRIPT, /\/api\//);
  assert.match(PAGE_SCRIPT, /\.hash/);
  const html = renderPickup("aB3dE6gH9k", "</script><script>alert(1)");
  assert.match(html, /data-slug="aB3dE6gH9k"/);
  assert.doesNotMatch(html, /<\/script><script>alert\(1\)/);
  assert.match(html, /<\\\/script>/);
});

test("inlined download script keeps comparison operators and parses", () => {
  const sample = renderPickup("aB3dE6gH9k", "if (1 < 2 && 1 << 1) null;");
  const sampleJs = inlinedScript(sample);
  assert.match(sampleJs, /1 < 2/);
  assert.match(sampleJs, /1 << 1/);
  assert.doesNotThrow(() => new vm.Script(sampleJs));

  const html = renderPickup("aB3dE6gH9k", PAGE_SCRIPT);
  const js = inlinedScript(html);
  assert.doesNotThrow(() => new vm.Script(js));
  assert.match(js, /addEventListener\("submit"/);
});
