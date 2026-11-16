export interface DbPrepared {
  bind(...args: unknown[]): DbPrepared;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}

export interface Db {
  prepare(sql: string): DbPrepared;
}

export interface BucketObject {
  size: number;
  body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface Bucket {
  head(key: string): Promise<{ size: number } | null>;
  get(key: string): Promise<BucketObject | null>;
  delete(key: string): Promise<void>;
}

export interface Env {
  DB: Db;
  LOCKER_BUCKET: Bucket;
  LOCKER_HMAC_SECRET: string;
}

export interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
}

export interface LockerRow {
  slug: string;
  object_key: string;
  code_hash: string;
  size: number;
  expire_at: number | null;
  max_pulls: number | null;
  pulls_left: number | null;
  fail_count: number;
  fail_streak: number;
  locked_until: number | null;
  status: string;
}
