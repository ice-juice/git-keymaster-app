/** 二维码扫描/生成历史。旧版只在 localStorage；现在迁入保险库，跟其他云同步数据走同一条加密通道。 */

import type { QrHistoryList } from "../lib/ipc";

export const LEGACY_QR_SCAN_KEY = "gk-tools-qr-scan-v1";
export const LEGACY_QR_GEN_KEY = "gk-tools-qr-gen-v1";

export type QrHistoryEntry = {
  id: string;
  at: number;
  text: string;
};

export type QrScanHistoryEntry = QrHistoryEntry;
export type QrGenHistoryEntry = QrHistoryEntry;

export type QrHistoryLists = {
  scans: QrScanHistoryEntry[];
  generations: QrGenHistoryEntry[];
};

function readLegacyList(key: string): QrHistoryEntry[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const rec = item as { id?: unknown; at?: unknown; text?: unknown };
      if (typeof rec.id !== "string" || typeof rec.text !== "string" || typeof rec.at !== "number") return [];
      return [{ id: rec.id, at: rec.at, text: rec.text }];
    });
  } catch {
    return [];
  }
}

export function readLegacyQrHistory(): QrHistoryLists {
  return {
    scans: readLegacyList(LEGACY_QR_SCAN_KEY),
    generations: readLegacyList(LEGACY_QR_GEN_KEY),
  };
}

export function clearLegacyQrHistory(): void {
  localStorage.removeItem(LEGACY_QR_SCAN_KEY);
  localStorage.removeItem(LEGACY_QR_GEN_KEY);
}

/** 丢掉空原文，并按 id 去重。真正的合并、墓碑和上限在保险库里做。 */
export function normalizeLegacyEntries(entries: QrHistoryEntry[]): QrHistoryEntry[] {
  const seen = new Set<string>();
  const out: QrHistoryEntry[] = [];
  for (const entry of entries) {
    const id = entry.id.trim();
    const text = entry.text.trim();
    if (!id || !text || !Number.isFinite(entry.at)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, at: entry.at, text });
  }
  return out;
}

function toLists(data: QrHistoryList): QrHistoryLists {
  return {
    scans: data.scans.map((entry) => ({ id: entry.id, at: entry.at, text: entry.text })),
    generations: data.generations.map((entry) => ({ id: entry.id, at: entry.at, text: entry.text })),
  };
}

let migrateInflight: Promise<void> | null = null;

/** 把升级前的本地记录并进同步数据。失败时保留 localStorage，下次再试。 */
export function migrateLegacyQrHistory(): Promise<void> {
  if (migrateInflight) return migrateInflight;
  const job = (async () => {
    const legacy = readLegacyQrHistory();
    const scans = normalizeLegacyEntries(legacy.scans);
    const generations = normalizeLegacyEntries(legacy.generations);
    if (!scans.length && !generations.length) {
      if (legacy.scans.length || legacy.generations.length) clearLegacyQrHistory();
      return;
    }
    const { api } = await import("../lib/ipc");
    await api.qrHistoryImportLegacy(scans, generations);
    clearLegacyQrHistory();
  })();
  migrateInflight = job;
  void job.finally(() => {
    if (migrateInflight === job) migrateInflight = null;
  });
  return job;
}

export async function loadSyncedQrHistory(): Promise<QrHistoryLists> {
  try {
    await migrateLegacyQrHistory();
  } catch {
    /* 本地记录留到下次解锁再迁 */
  }
  const { api } = await import("../lib/ipc");
  return toLists(await api.qrHistoryList());
}

export async function pushQrScanHistory(text: string): Promise<QrHistoryLists> {
  const { api } = await import("../lib/ipc");
  return toLists(await api.qrHistoryAdd("scan", text));
}

export async function pushQrGenHistory(text: string): Promise<QrHistoryLists> {
  const { api } = await import("../lib/ipc");
  return toLists(await api.qrHistoryAdd("generate", text));
}

export async function removeQrScanHistory(id: string): Promise<QrHistoryLists> {
  const { api } = await import("../lib/ipc");
  return toLists(await api.qrHistoryDelete("scan", id));
}

export async function removeQrGenHistory(id: string): Promise<QrHistoryLists> {
  const { api } = await import("../lib/ipc");
  return toLists(await api.qrHistoryDelete("generate", id));
}

export async function clearQrScanHistory(): Promise<QrHistoryLists> {
  const { api } = await import("../lib/ipc");
  return toLists(await api.qrHistoryClear("scan"));
}

export async function clearQrGenHistory(): Promise<QrHistoryLists> {
  const { api } = await import("../lib/ipc");
  return toLists(await api.qrHistoryClear("generate"));
}
