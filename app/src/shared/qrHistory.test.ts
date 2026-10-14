import assert from "node:assert/strict";
import { describe, test, beforeEach } from "node:test";
import {
  clearQrGenHistory,
  clearQrScanHistory,
  listQrGenHistory,
  listQrScanHistory,
  pushQrGenHistory,
  pushQrScanHistory,
  removeQrGenHistory,
  removeQrScanHistory,
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

describe("qrHistory", () => {
  test("scan and gen lists", () => {
    const s = pushQrScanHistory("scan-text");
    assert.equal(listQrScanHistory()[0]?.id, s.id);
    removeQrScanHistory(s.id);
    assert.equal(listQrScanHistory().length, 0);
    clearQrScanHistory();

    const g = pushQrGenHistory("gen-text");
    assert.equal(listQrGenHistory()[0]?.text, "gen-text");
    removeQrGenHistory(g.id);
    clearQrGenHistory();
    assert.equal(listQrGenHistory().length, 0);
  });
});
