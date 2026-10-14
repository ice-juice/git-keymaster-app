import assert from "node:assert/strict";
import { describe, test, beforeEach } from "node:test";
import {
  LEGACY_QR_GEN_KEY,
  LEGACY_QR_SCAN_KEY,
  clearLegacyQrHistory,
  normalizeLegacyEntries,
  readLegacyQrHistory,
} from "./qrHistory.ts";

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  };
});

describe("qrHistory legacy migration", () => {
  test("reads scan and gen lists separately, then clears both", () => {
    localStorage.setItem(
      LEGACY_QR_SCAN_KEY,
      JSON.stringify([{ id: "s1", at: 10, text: "scan-text" }]),
    );
    localStorage.setItem(
      LEGACY_QR_GEN_KEY,
      JSON.stringify([{ id: "g1", at: 11, text: "gen-text" }]),
    );
    const legacy = readLegacyQrHistory();
    assert.equal(legacy.scans[0]?.text, "scan-text");
    assert.equal(legacy.generations[0]?.text, "gen-text");
    assert.equal(legacy.scans[0]?.id, "s1");
    clearLegacyQrHistory();
    assert.equal(readLegacyQrHistory().scans.length, 0);
    assert.equal(readLegacyQrHistory().generations.length, 0);
  });

  test("normalize drops empty text and duplicate ids", () => {
    const out = normalizeLegacyEntries([
      { id: " a ", at: 1, text: " first " },
      { id: "a", at: 2, text: "second" },
      { id: "b", at: 3, text: "   " },
      { id: "", at: 4, text: "no-id" },
    ]);
    assert.deepEqual(out, [{ id: "a", at: 1, text: "first" }]);
  });

  test("broken local storage does not throw", () => {
    localStorage.setItem(LEGACY_QR_SCAN_KEY, "{");
    localStorage.setItem(LEGACY_QR_GEN_KEY, JSON.stringify({ not: "array" }));
    const legacy = readLegacyQrHistory();
    assert.deepEqual(legacy.scans, []);
    assert.deepEqual(legacy.generations, []);
  });
});
