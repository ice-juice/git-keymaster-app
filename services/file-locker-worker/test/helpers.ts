import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { hashPickupCode, signRequest } from "../src/auth.ts";
import type { Bucket, BucketObject, Ctx, Db, Env } from "../src/types.ts";

export const SECRET = "example-secret-value";
export const CODE = "482193";
export const CODE_HASH = "8e9eaf8aca0e5ca697acf681978ca4699ff7d3606647b5f6d8bcf5549574a3ca";
export const NONCE = "00112233445566778899aabbccddeeff";
export const SLUG = "aB3dE6gH9k";
export const OBJECT_KEY = "sync-prefix/locker/" + "ab".repeat(32);
export const ORIGIN = "http://locker.test";

const migration = readFileSync(new URL("../migrations/0001_locker.sql", import.meta.url), "utf8");

class SqliteDb implements Db {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }
  prepare(sql: string) {
    const stmt = this.db.prepare(sql);
    let args: unknown[] = [];
    const prepared = {
      bind(...bound: unknown[]) {
        args = bound.map((v) => (v === undefined ? null : v));
        return prepared;
      },
      async first<T>() {
        const row = stmt.get(...(args as never[]));
        return (row ?? null) as T | null;
      },
      async all<T>() {
        return { results: stmt.all(...(args as never[])) as T[] };
      },
      async run() {
        const info = stmt.run(...(args as never[]));
        return { meta: { changes: Number(info.changes ?? 0) } };
      },
    };
    return prepared;
  }
}

export class MemoryBucket implements Bucket {
  objects = new Map<string, Uint8Array>();
  put(key: string, bytes: Uint8Array): void {
    this.objects.set(key, bytes.slice());
  }
  async head(key: string): Promise<{ size: number } | null> {
    const v = this.objects.get(key);
    return v ? { size: v.byteLength } : null;
  }
  async get(key: string): Promise<BucketObject | null> {
    const v = this.objects.get(key);
    if (!v) return null;
    const bytes = v.slice();
    return {
      size: bytes.byteLength,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    };
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

export class FakeCtx implements Ctx {
  pending: Promise<unknown>[] = [];
  waitUntil(promise: Promise<unknown>): void {
    this.pending.push(promise);
  }
  async flush(): Promise<void> {
    while (this.pending.length) {
      const batch = this.pending.splice(0);
      await Promise.all(batch);
    }
  }
}

export interface Fixture {
  db: DatabaseSync;
  bucket: MemoryBucket;
  env: Env;
  ctx: FakeCtx;
  logs: string[];
}

export function makeFixture(): Fixture {
  const db = new DatabaseSync(":memory:");
  db.exec(migration);
  const bucket = new MemoryBucket();
  const logs: string[] = [];
  const env: Env = {
    DB: new SqliteDb(db),
    LOCKER_BUCKET: bucket,
    LOCKER_HMAC_SECRET: SECRET,
  };
  return {
    db,
    bucket,
    env,
    ctx: new FakeCtx(),
    logs,
  };
}

export function logOf(fx: Fixture) {
  return (event: string, fields?: Record<string, string | number | boolean | null>) => {
    fx.logs.push(JSON.stringify({ event, ...fields }));
  };
}

export async function signedRequest(
  url: string,
  method: string,
  body: string,
  now: number,
  secret = SECRET,
  nonce = NONCE,
): Promise<Request> {
  const bytes = new TextEncoder().encode(body);
  const payload = method === "DELETE" ? new Uint8Array() : bytes;
  const ts = String(Math.floor(now / 1000));
  const path = new URL(url).pathname;
  const sig = await signRequest(secret, ts, nonce, method, path, payload);
  return new Request(url, {
    method,
    body: method === "DELETE" ? undefined : body,
    headers: {
      "content-type": "application/json",
      "x-locker-timestamp": ts,
      "x-locker-nonce": nonce,
      "x-locker-signature": sig,
    },
  });
}

export async function registerBody(now: number, extra: Record<string, unknown> = {}): Promise<string> {
  const codeHash = await hashPickupCode(CODE);
  return JSON.stringify({
    slug: SLUG,
    object_key: OBJECT_KEY,
    code_hash: codeHash,
    size: 16,
    expire_at: new Date(now + 86_400_000).toISOString(),
    max_pulls: 1,
    pulls_left: 1,
    ...extra,
  });
}