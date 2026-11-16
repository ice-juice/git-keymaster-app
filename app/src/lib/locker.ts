import { invoke } from "@tauri-apps/api/core";
import type { LockerEntry, LockerPutOpts, LockerPutResult } from "./ipc";

export type LockerSource = { id?: string; code?: string; shareUrl?: string };
export type LockerDestination = { kind: "disk" | "vault"; path?: string };
export interface LockerConnectionStatus {
  storageConfigured: boolean;
  serviceConfigured: boolean;
  protocolVersion: number | null;
  serviceReady: boolean;
  checkedAt: string;
  error: string | null;
  storageVerified?: boolean;
  serviceVerified?: boolean;
}
export interface LockerItem extends LockerEntry {
  shareRequested?: boolean;
  shareStatus?: "none" | "pending" | "active" | "failed" | "stopped";
  shareError?: string | null;
  accessStatus: "active" | "expired" | "exhausted" | "deleted";
  cleanupStatus: "none" | "pending" | "failed" | "cleaned";
  syncStatus: "confirmed" | "unknown";
  legacy: boolean;
  quotaOrigin?: string | null;
  inFlightClaims?: number;
  endedAt?: string | null;
  lastError?: string | null;
}
export interface LockerLookup {
  id: string;
  name: string;
  originalName: string;
  size: number;
  sizeIsEstimate?: boolean;
  expireAt: string | null;
  maxPulls: number | null;
  pullsLeft: number | null;
  version: string;
  source: "own" | "share";
  protocolVersion: number;
  legacy: boolean;
  quotaOrigin?: string | null;
  inFlightClaims?: number;
}
export interface LockerOperation {
  operationId: string;
  kind: "receive" | "put";
  status: "prepared" | "running" | "unknown" | "failed" | "saved" | "completed";
  phase: string;
  itemId?: string | null;
  name?: string | null;
  destPath?: string | null;
  fileId?: string | null;
  pullsLeft?: number | null;
  cleanupStatus?: string | null;
  error?: string | null;
  recoverable: boolean;
  canRetarget?: boolean;
  updatedAt: string;
}
export interface LockerReceiveArgs {
  operationId: string;
  source: LockerSource;
  snapshotVersion: string;
  destination: LockerDestination;
}
export type LockerPutOptions = LockerPutOpts & {
  operationId: string;
  shareRequested?: boolean;
};
export type LockerPutOutcome = LockerPutResult & {
  status?: string;
  phase?: string;
};

export const lockerApi = {
  list: () => invoke<{ entries: LockerItem[] }>("locker_list"),
  connectionStatus: (verify = false) =>
    invoke<LockerConnectionStatus>("locker_connection_status", { verify }),
  lookup: (source: LockerSource, password?: string) =>
    invoke<LockerLookup>("locker_lookup", {
      source,
      password: password ?? null,
    }),
  receive: (args: LockerReceiveArgs, password?: string) =>
    invoke<LockerOperation>("locker_receive", {
      ...args,
      password: password ?? null,
    }),
  operationStatus: (operationId: string) =>
    invoke<LockerOperation | null>("locker_operation_status", { operationId }),
  operationsList: () =>
    invoke<{ operations: LockerOperation[] }>("locker_operations_list"),
  operationResume: (operationId: string, password?: string) =>
    invoke<LockerOperation>("locker_operation_resume", {
      operationId,
      password: password ?? null,
    }),
  operationRetarget: (
    operationId: string,
    destination: LockerDestination,
    password?: string,
  ) =>
    invoke<LockerOperation>("locker_operation_retarget", {
      operationId,
      destination,
      password: password ?? null,
    }),
  sourceStat: (path: string) =>
    invoke<{ name: string; size: number }>("locker_source_stat", { path }),
  clearHistory: () => invoke<void>("locker_clear_history"),
  migrateLegacy: (id: string, password?: string) =>
    invoke<void>("locker_migrate_legacy", { id, password: password ?? null }),
  putPath: (path: string, opts: LockerPutOptions) =>
    invoke<LockerPutOutcome>("locker_put_from_path", { path, opts }),
  putBytes: (originalName: string, bytes: number[], opts: LockerPutOptions) =>
    invoke<LockerPutOutcome>("locker_put_bytes", { originalName, bytes, opts }),
  putVault: (
    entryId: string,
    attachmentId: string | null,
    opts: LockerPutOptions,
    password?: string,
  ) =>
    invoke<LockerPutOutcome>("locker_put_from_vault", {
      entryId,
      attachmentId,
      opts,
      password: password ?? null,
    }),
};
