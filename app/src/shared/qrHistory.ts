/** 二维码工具历史（localStorage，不进保险库）。 */

import { encodeQrSvg } from "./qrEncode.ts";

const KEY_SCAN = "gk-tools-qr-scan-v1";
const KEY_GEN = "gk-tools-qr-gen-v1";
const MAX = 80;

export type QrScanHistoryEntry = {
  id: string;
  at: number;
  text: string;
};

export type QrGenHistoryEntry = {
  id: string;
  at: number;
  text: string;
};

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function readList<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as T[];
  } catch {
    return [];
  }
}

function writeList<T>(key: string, list: T[]): void {
  localStorage.setItem(key, JSON.stringify(list.slice(0, MAX)));
}

export function listQrScanHistory(): QrScanHistoryEntry[] {
  return readList<QrScanHistoryEntry>(KEY_SCAN);
}

export function listQrGenHistory(): QrGenHistoryEntry[] {
  return readList<QrGenHistoryEntry>(KEY_GEN);
}

export function pushQrScanHistory(text: string): QrScanHistoryEntry {
  const entry: QrScanHistoryEntry = { id: newId(), at: Date.now(), text };
  const next = [entry, ...listQrScanHistory()].slice(0, MAX);
  writeList(KEY_SCAN, next);
  return entry;
}

export function pushQrGenHistory(text: string): QrGenHistoryEntry {
  const entry: QrGenHistoryEntry = { id: newId(), at: Date.now(), text };
  const next = [entry, ...listQrGenHistory()].slice(0, MAX);
  writeList(KEY_GEN, next);
  return entry;
}

export function removeQrScanHistory(id: string): void {
  writeList(
    KEY_SCAN,
    listQrScanHistory().filter((e) => e.id !== id),
  );
}

export function removeQrGenHistory(id: string): void {
  writeList(
    KEY_GEN,
    listQrGenHistory().filter((e) => e.id !== id),
  );
}

export function clearQrScanHistory(): void {
  localStorage.removeItem(KEY_SCAN);
}

export function clearQrGenHistory(): void {
  localStorage.removeItem(KEY_GEN);
}

export function qrSvgForHistory(text: string): string {
  return encodeQrSvg(text.trim());
}
