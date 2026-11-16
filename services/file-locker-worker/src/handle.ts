import { normalizeSecret, pickupMatches, verifyRequest } from "./auth.ts";
import {
  LOCK_MS,
  LOCK_STREAK,
  MAX_CIPHER_BYTES,
  MAX_EXPIRE_MS,
  MAX_PULLS,
  MIN_CIPHER_BYTES,
  REVOKE_FAILS,
  SLUG_LEN,
  SWEEP_LIMIT,
} from "./constants.ts";
import {
  badCode,
  conflict,
  expired,
  html,
  internal,
  invalid,
  json,
  locked,
  misconfigured,
  notFound,
  tooLarge,
  unauthorized,
} from "./http.ts";
import { renderExpired, renderMissing, renderPickup } from "./page.ts";
import type { Ctx, Env, LockerRow } from "./types.ts";

const SLUG_RE = /^[0-9A-Za-z]{10}$/;
const OBJECT_KEY_RE = /^[A-Za-z0-9._~/-]{1,1024}$/;
const EXPIRE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const HASH_RE = /^[0-9a-f]{64}$/;

const SQL_LOAD = `SELECT slug, object_key, code_hash, size, expire_at, max_pulls, pulls_left,
  fail_count, fail_streak, locked_until, status FROM locker WHERE slug = ?`;
const SQL_INSERT = `INSERT INTO locker (
  slug, object_key, code_hash, size, expire_at, max_pulls, pulls_left,
  fail_count, fail_streak, locked_until, status
) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, 'active')`;
const SQL_CLEAR_LOCK = `UPDATE locker SET fail_streak = 0, locked_until = NULL
  WHERE slug = ? AND status = 'active' AND locked_until IS NOT NULL AND locked_until <= ?`;
const SQL_FAIL = `UPDATE locker SET
  fail_count = fail_count + 1,
  fail_streak = fail_streak + 1,
  status = CASE WHEN fail_count + 1 >= ${REVOKE_FAILS} THEN 'revoked' ELSE status END,
  locked_until = CASE
    WHEN fail_count + 1 >= ${REVOKE_FAILS} THEN NULL
    WHEN fail_streak + 1 >= ${LOCK_STREAK} THEN ?
    ELSE NULL
  END
  WHERE slug = ? AND status = 'active' AND (locked_until IS NULL OR locked_until <= ?)
  RETURNING fail_count, status, locked_until`;
const SQL_PULL = `UPDATE locker SET
  pulls_left = CASE WHEN pulls_left IS NULL THEN NULL ELSE pulls_left - 1 END,
  fail_streak = 0,
  locked_until = NULL
  WHERE slug = ?
    AND status = 'active'
    AND code_hash = ?
    AND (pulls_left IS NULL OR pulls_left > 0)
    AND (expire_at IS NULL OR expire_at > ?)
    AND (locked_until IS NULL OR locked_until <= ?)
  RETURNING pulls_left, object_key`;
const SQL_SWEEP = `SELECT slug, object_key FROM locker
  WHERE (expire_at IS NOT NULL AND expire_at <= ?) OR pulls_left = 0
  ORDER BY expire_at IS NULL, expire_at
  LIMIT ${SWEEP_LIMIT}`;
const SQL_DELETE = `DELETE FROM locker WHERE slug = ?`;
const SQL_RESTORE = `UPDATE locker SET pulls_left = pulls_left + 1
  WHERE slug = ? AND status = 'active' AND pulls_left = ?`;

export interface HandleOptions {
  now?: number;
  pageScript?: string;
  log?: LogFn;
  rethrow?: boolean;
}

export type LogFn = (event: string, fields?: Record<string, string | number | boolean | null>) => void;

function defaultLog(event: string, fields?: Record<string, string | number | boolean | null>): void {
  console.log(JSON.stringify({ event, ...fields }));
}

export async function handleRequest(
  request: Request,
  env: Env,
  ctx: Ctx,
  options: HandleOptions = {},
): Promise<Response> {
  const now = options.now ?? Date.now();
  const log = options.log ?? defaultLog;
  const url = new URL(request.url);
  const path = url.pathname;
  try {
    if (request.method === "GET" && path === "/") return json(200, { service: "file-locker", ok: true });
    if (request.method === "POST" && path === "/register") return await register(request, env, now, log);
    if (request.method === "DELETE" && path.startsWith("/register/")) {
      return await revoke(request, env, path.slice("/register/".length), now, log);
    }
    if (request.method === "GET" && path.startsWith("/d/")) {
      return await downloadPage(env, path.slice("/d/".length), now, options.pageScript ?? "", log);
    }
    if (request.method === "POST" && path.startsWith("/api/")) {
      return await pull(request, env, ctx, path.slice("/api/".length), now, log);
    }
    return notFound();
  } catch (err) {
    log("internal", {});
    if (options.rethrow) throw err;
    return internal();
  }
}

async function authedBody(
  request: Request,
  env: Env,
  now: number,
  maxBytes: number,
): Promise<{ body: Uint8Array } | Response> {
  const secret = normalizeSecret(env.LOCKER_HMAC_SECRET);
  if (!secret) return misconfigured();
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) return tooLarge();
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > maxBytes) return tooLarge();
  const url = new URL(request.url);
  const ok = await verifyRequest(
    secret,
    request.method,
    url.pathname,
    body,
    request.headers.get("x-locker-timestamp"),
    request.headers.get("x-locker-nonce"),
    request.headers.get("x-locker-signature"),
    now,
  );
  if (!ok) return unauthorized();
  return { body };
}

async function register(request: Request, env: Env, now: number, log: LogFn): Promise<Response> {
  const gate = await authedBody(request, env, now, 8192);
  if (gate instanceof Response) return gate;
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) return invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(gate.body));
  } catch {
    return invalid();
  }
  const input = normalizeRegister(parsed, now);
  if (!input) return invalid();
  if (input.size > MAX_CIPHER_BYTES) return tooLarge();
  const existing = await load(env, input.slug);
  if (existing) {
    log("register_conflict", { slug: input.slug });
    return conflict();
  }
  let head: { size: number } | null;
  try {
    head = await env.LOCKER_BUCKET.head(input.objectKey);
  } catch {
    log("r2_error", { slug: input.slug });
    return internal();
  }
  if (!head) return json(400, { error: "missing_object" });
  if (head.size !== input.size) return json(400, { error: "size_mismatch" });
  try {
    await env.DB.prepare(SQL_INSERT)
      .bind(input.slug, input.objectKey, input.codeHash, input.size, input.expireAt, input.maxPulls, input.pullsLeft)
      .run();
  } catch {
    const again = await load(env, input.slug);
    if (again) return conflict();
    log("db_error", { slug: input.slug });
    return internal();
  }
  log("register", { slug: input.slug, size: input.size });
  return json(201, { ok: true });
}

interface RegisterInput {
  slug: string;
  objectKey: string;
  codeHash: string;
  size: number;
  expireAt: number | null;
  maxPulls: number | null;
  pullsLeft: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validObjectKey(key: string): boolean {
  if (!OBJECT_KEY_RE.test(key)) return false;
  if (key.startsWith("/") || key.endsWith("/") || key.includes("//") || key.includes("..")) return false;
  return true;
}

function normalizeRegister(value: unknown, now: number): RegisterInput | null {
  if (!isRecord(value)) return null;
  const slug = value.slug;
  const objectKey = value.object_key;
  const codeHashRaw = value.code_hash;
  const size = value.size;
  if (typeof slug !== "string" || slug.length !== SLUG_LEN || !SLUG_RE.test(slug)) return null;
  if (typeof objectKey !== "string" || !validObjectKey(objectKey)) return null;
  if (typeof codeHashRaw !== "string" || !HASH_RE.test(codeHashRaw.toLowerCase())) return null;
  if (typeof size !== "number" || !Number.isInteger(size) || size < MIN_CIPHER_BYTES) return null;
  const expireAt = parseExpire(value.expire_at, now);
  if (expireAt === "invalid") return null;
  const maxPulls = parseMaxPulls(value.max_pulls);
  if (maxPulls === "invalid") return null;
  const pullsLeft = parsePullsLeft(maxPulls, value.pulls_left);
  if (pullsLeft === "invalid") return null;
  return {
    slug,
    objectKey,
    codeHash: codeHashRaw.toLowerCase(),
    size,
    expireAt,
    maxPulls,
    pullsLeft,
  };
}

function parseExpire(value: unknown, now: number): number | null | "invalid" {
  if (value === null) return null;
  if (typeof value !== "string" || !EXPIRE_RE.test(value)) return "invalid";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms <= now || ms > now + MAX_EXPIRE_MS) return "invalid";
  return ms;
}

function parseMaxPulls(value: unknown): number | null | "invalid" {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_PULLS) return "invalid";
  return value;
}

function parsePullsLeft(maxPulls: number | null, value: unknown): number | null | "invalid" {
  if (maxPulls === null) {
    if (value === undefined || value === null) return null;
    return "invalid";
  }
  const left = value === undefined || value === null ? maxPulls : value;
  if (typeof left !== "number" || !Number.isInteger(left) || left < 1 || left > maxPulls) return "invalid";
  return left;
}

async function revoke(request: Request, env: Env, slug: string, now: number, log: LogFn): Promise<Response> {
  const gate = await authedBody(request, env, now, 1024);
  if (gate instanceof Response) return gate;
  if (!SLUG_RE.test(slug)) return invalid();
  const row = await load(env, slug);
  if (row) {
    const gone = await burn(env, row.slug, row.object_key, log);
    if (!gone) return internal();
  }
  log("revoke", { slug });
  return json(200, { ok: true });
}

async function downloadPage(env: Env, slug: string, now: number, pageScript: string, log: LogFn): Promise<Response> {
  if (!SLUG_RE.test(slug)) return html(404, renderMissing());
  const row = await load(env, slug);
  if (!row || row.status !== "active") return html(404, renderMissing());
  if (row.expire_at !== null && row.expire_at <= now) {
    await burn(env, row.slug, row.object_key, log);
    return html(410, renderExpired());
  }
  if (row.pulls_left !== null && row.pulls_left <= 0) {
    await burn(env, row.slug, row.object_key, log);
    return html(404, renderMissing());
  }
  return html(200, renderPickup(slug, pageScript));
}

async function pull(
  request: Request,
  env: Env,
  ctx: Ctx,
  slug: string,
  now: number,
  log: LogFn,
): Promise<Response> {
  if (!normalizeSecret(env.LOCKER_HMAC_SECRET)) return misconfigured();
  if (!SLUG_RE.test(slug)) return notFound();
  const row = await load(env, slug);
  const early = await deny(env, row, now, log);
  if (early) return early;
  if (!row) return notFound();
  if (row.locked_until !== null && row.locked_until <= now) {
    await env.DB.prepare(SQL_CLEAR_LOCK).bind(slug, now).run();
  }
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > 1024) return tooLarge();
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength > 1024) return tooLarge();
  const code = parseCode(raw);
  if (!code) return invalid();
  const match = await pickupMatches(code, row.code_hash);
  if (!match) return recordFailure(env, slug, now, log);
  const updated = await env.DB.prepare(SQL_PULL)
    .bind(slug, row.code_hash, now, now)
    .first<{ pulls_left: number | null; object_key: string }>();
  if (!updated) {
    const again = await load(env, slug);
    const denied = await deny(env, again, now, log);
    if (denied) return denied;
    return conflict();
  }
  const pullsLeft = updated.pulls_left == null ? null : Number(updated.pulls_left);
  const objectKey = String(updated.object_key);
  let obj: Awaited<ReturnType<Env["LOCKER_BUCKET"]["get"]>>;
  try {
    obj = await env.LOCKER_BUCKET.get(objectKey);
  } catch {
    log("r2_error", { slug });
    return internal();
  }
  if (!obj?.body) {
    if (pullsLeft === 0) await burn(env, slug, objectKey, log);
    else if (pullsLeft !== null) await env.DB.prepare(SQL_RESTORE).bind(slug, pullsLeft).run();
    log("object_missing", { slug });
    return notFound();
  }
  if (obj.size > MAX_CIPHER_BYTES) {
    log("object_too_large", { slug });
    return tooLarge();
  }
  log("pull", { slug, pullsLeft: pullsLeft === null ? "unlimited" : pullsLeft });
  return streamCipher(obj.body, obj.size, pullsLeft, pullsLeft === 0, env, ctx, slug, objectKey, log);
}

function parseCode(raw: Uint8Array): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.code !== "string") return null;
  const code = parsed.code.trim();
  if (!/^\d{6}$/.test(code)) return null;
  return code;
}

async function recordFailure(env: Env, slug: string, now: number, log: LogFn): Promise<Response> {
  const lockUntil = now + LOCK_MS;
  const updated = await env.DB.prepare(SQL_FAIL)
    .bind(lockUntil, slug, now)
    .first<{ fail_count: number; status: string; locked_until: number | null }>();
  if (!updated || updated.status === "revoked") {
    log("revoked", { slug });
    return notFound();
  }
  const lockedUntil = updated.locked_until == null ? null : Number(updated.locked_until);
  if (lockedUntil !== null && lockedUntil > now) {
    log("locked", { slug, failCount: Number(updated.fail_count) });
    return locked(Math.ceil((lockedUntil - now) / 1000));
  }
  log("bad_code", { slug, failCount: Number(updated.fail_count) });
  return badCode();
}

function streamCipher(
  body: ReadableStream<Uint8Array>,
  size: number,
  pullsLeft: number | null,
  shouldBurn: boolean,
  env: Env,
  ctx: Ctx,
  slug: string,
  objectKey: string,
  log: LogFn,
): Response {
  const headers = new Headers();
  headers.set("content-type", "application/octet-stream");
  headers.set("content-length", String(size));
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("content-disposition", 'attachment; filename="locker.bin"');
  headers.set("x-locker-burned", shouldBurn ? "1" : "0");
  if (pullsLeft !== null) headers.set("x-locker-pulls-left", String(pullsLeft));
  if (!shouldBurn) return new Response(body, { status: 200, headers });
  let burned = false;
  const burnOnce = async () => {
    if (burned) return;
    burned = true;
    await burn(env, slug, objectKey, log);
  };
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  ctx.waitUntil(body.pipeTo(writable).then(burnOnce, () => burnOnce()));
  return new Response(readable, { status: 200, headers });
}

async function deny(env: Env, row: LockerRow | null, now: number, log: LogFn): Promise<Response | null> {
  if (!row || row.status !== "active") return notFound();
  if (row.expire_at !== null && row.expire_at <= now) {
    await burn(env, row.slug, row.object_key, log);
    return expired();
  }
  if (row.pulls_left !== null && row.pulls_left <= 0) {
    await burn(env, row.slug, row.object_key, log);
    return notFound();
  }
  if (row.locked_until !== null && row.locked_until > now) {
    return locked(Math.ceil((row.locked_until - now) / 1000));
  }
  return null;
}

async function load(env: Env, slug: string): Promise<LockerRow | null> {
  const raw = await env.DB.prepare(SQL_LOAD).bind(slug).first<Record<string, unknown>>();
  if (!raw) return null;
  return {
    slug: String(raw.slug),
    object_key: String(raw.object_key),
    code_hash: String(raw.code_hash).toLowerCase(),
    size: Number(raw.size),
    expire_at: raw.expire_at == null ? null : Number(raw.expire_at),
    max_pulls: raw.max_pulls == null ? null : Number(raw.max_pulls),
    pulls_left: raw.pulls_left == null ? null : Number(raw.pulls_left),
    fail_count: Number(raw.fail_count),
    fail_streak: Number(raw.fail_streak),
    locked_until: raw.locked_until == null ? null : Number(raw.locked_until),
    status: String(raw.status),
  };
}

export async function burn(env: Env, slug: string, objectKey: string, log: LogFn): Promise<boolean> {
  try {
    await env.LOCKER_BUCKET.delete(objectKey);
  } catch {
    log("r2_delete_failed", { slug });
    return false;
  }
  await env.DB.prepare(SQL_DELETE).bind(slug).run();
  return true;
}

export async function sweepExpired(env: Env, now: number, log: LogFn = defaultLog): Promise<{ removed: number }> {
  const listed = await env.DB.prepare(SQL_SWEEP).bind(now).all<{ slug: string; object_key: string }>();
  let removed = 0;
  for (const row of listed.results) {
    try {
      if (await burn(env, String(row.slug), String(row.object_key), log)) removed += 1;
    } catch {
      log("sweep_row_failed", { slug: String(row.slug) });
    }
  }
  if (removed > 0) log("sweep", { removed });
  return { removed };
}