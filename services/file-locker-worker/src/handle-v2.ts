import type { D1Database, R2Bucket, ExecutionContext } from "@cloudflare/workers-types";
import { normalizeSecret, verifyRequest, sha256Hex, pickupMatches, toHex } from "./auth.ts";
import { json, html } from "./http.ts";
import { renderV2Page } from "./page-v2.ts";

export interface V2Env { DB: D1Database; LOCKER_BUCKET: R2Bucket; LOCKER_HMAC_SECRET: string }
type Item = { item_id: string; version: string; register_operation_id: string; register_hash: string; object_key: string; code_hash: string; cipher_size: number; expire_at: number | null; max_pulls: number | null; pulls_left: number | null; state: string; cleanup_status: string; fail_streak: number; locked_until: number | null };
type Claim = { operation_id: string; item_id: string; version: string; scope: string; token_hash: string; state: string; recovery_until: number; attempts: number; created_at: number };
type Body = Record<string, unknown>;
const ID = /^[A-Za-z0-9_-]{8,80}$/;
const SLUG = /^[A-Za-z0-9]{10}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_CIPHER = 100 * 1024 * 1024 + 64 * 1024;
const RECOVERY_MS = 15 * 60 * 1000;
const enc = new TextEncoder();
const failure = (status: number, error: string, extra: Body = {}) => json(status, { error, ...extra });
const iso = (n: number | null) => n == null ? null : new Date(n).toISOString();
const itemById = (env: V2Env, id: string) => env.DB.prepare("SELECT * FROM locker_v2_items WHERE item_id=?").bind(id).first<Item>();
const claimById = (env: V2Env, id: string) => env.DB.prepare("SELECT * FROM locker_v2_claims WHERE operation_id=?").bind(id).first<Claim>();

async function bodyBytes(request: Request, max = 8192): Promise<Uint8Array | Response> {
  if (Number(request.headers.get("content-length")) > max) return failure(413, "too_large");
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const part = await reader.read(); if (part.done) break;
    size += part.value.length;
    if (size > max) { await reader.cancel(); return failure(413, "too_large"); }
    chunks.push(part.value);
  }
  const data = new Uint8Array(size); let at = 0;
  for (const part of chunks) { data.set(part, at); at += part.length; }
  return data;
}
function parseBody(bytes: Uint8Array): Body | null {
  try { const b: unknown = bytes.length ? JSON.parse(new TextDecoder().decode(bytes)) : {}; return b && typeof b === "object" && !Array.isArray(b) ? b as Body : null; } catch { return null; }
}
async function ownerBody(request: Request, env: V2Env, now: number): Promise<Body | Response> {
  const secret = normalizeSecret(env.LOCKER_HMAC_SECRET);
  if (!secret) return failure(500, "misconfigured");
  const bytes = await bodyBytes(request); if (bytes instanceof Response) return bytes;
  const valid = await verifyRequest(secret, request.method, new URL(request.url).pathname, bytes,
    request.headers.get("x-locker-timestamp"), request.headers.get("x-locker-nonce"), request.headers.get("x-locker-signature"), now);
  if (!valid) return failure(401, "unauthorized");
  const value = parseBody(bytes); if (!value) return failure(400, "invalid");
  const nonce = request.headers.get("x-locker-nonce")!.toLowerCase();
  const inserted = await env.DB.prepare("INSERT OR IGNORE INTO locker_v2_nonces(nonce,expires_at) VALUES (?,?)").bind(nonce, now + 601_000).run();
  if (!inserted.meta.changes) return failure(401, "replayed_auth");
  return value;
}
async function publicBody(request: Request): Promise<Body | Response> {
  const bytes = await bodyBytes(request, 2048); if (bytes instanceof Response) return bytes;
  return parseBody(bytes) ?? failure(400, "invalid");
}
async function schemaReady(env: V2Env): Promise<boolean> {
  try {
    await env.DB.batch([
      env.DB.prepare("SELECT item_id,version,register_hash,cleanup_status,reservation_marker FROM locker_v2_items LIMIT 0"),
      env.DB.prepare("SELECT slug,active,operation_id FROM locker_v2_shares LIMIT 0"),
      env.DB.prepare("SELECT operation_id,token_hash,recovery_until,attempts FROM locker_v2_claims LIMIT 0"),
      env.DB.prepare("SELECT operation_id,token_hash FROM locker_v2_claim_tokens LIMIT 0"),
      env.DB.prepare("SELECT operation_id,request_hash,applied,result_json FROM locker_v2_operations LIMIT 0"),
      env.DB.prepare("SELECT nonce,expires_at FROM locker_v2_nonces LIMIT 0"),
    ]); return true;
  } catch { return false; }
}
async function health(env: V2Env) {
  if (!(await schemaReady(env))) return failure(503, "schema_required", { protocolVersion: 2, schemaVersion: 0 });
  return json(200, { service: "file-locker", ok: true, protocolVersion: 2, schemaVersion: 2,
    capabilities: ["private-items", "lookup", "claims", "resume", "stop-share", "cleanup-status"] });
}
function itemStatus(item: Item, now: number): string {
  if (item.state === "deleted") return "deleted";
  if (item.expire_at != null && item.expire_at <= now) return "expired";
  if (item.pulls_left === 0) return "exhausted";
  return "active";
}
async function metadata(env: V2Env, item: Item, now: number) {
  const share = await env.DB.prepare("SELECT slug FROM locker_v2_shares WHERE item_id=? AND active=1 ORDER BY created_at DESC LIMIT 1").bind(item.item_id).first<{ slug: string }>();
  const held = await env.DB.prepare("SELECT COUNT(*) AS count FROM locker_v2_claims WHERE item_id=? AND state IN ('reserved','delivering') AND recovery_until>?").bind(item.item_id, now).first<{ count: number }>();
  return { itemId: item.item_id, version: item.version, cipherSize: item.cipher_size, expireAt: iso(item.expire_at),
    maxPulls: item.max_pulls, pullsLeft: item.pulls_left, inFlightClaims: held?.count ?? 0, status: itemStatus(item, now), cleanupStatus: item.cleanup_status, shareSlug: share?.slug ?? null };
}
function available(item: Item, now: number): Response | null {
  if (item.state !== "active" || item.cleanup_status === "cleaned") return failure(404, "not_found");
  if (item.expire_at != null && item.expire_at <= now) return failure(410, "expired");
  return null;
}
async function verifyPublic(env: V2Env, slug: string, code: unknown, now: number, replay?: Body): Promise<Item | Response> {
  if (!SLUG.test(slug)) return failure(404, "not_found");
  const alias = await env.DB.prepare("SELECT item_id,active FROM locker_v2_shares WHERE slug=?").bind(slug).first<{ item_id: string; active: number }>();
  if (!alias) return failure(404, "not_found");
  let item = await itemById(env, alias.item_id); if (!item) return failure(404, "not_found");
  const prior = replay && typeof replay.operationId === "string" && ID.test(replay.operationId) ? await claimById(env, replay.operationId) : null;
  // Only an already reserved operation may cross share retirement/item TTL.
  // Keep its exact identity and recovery window; new operations still fail closed.
  const recovering = prior && prior.item_id === item.item_id && prior.scope === `share:${slug}` && prior.version === replay?.expectedVersion && prior.recovery_until > now && ["reserved", "delivering"].includes(prior.state) && item.state === "active" && item.cleanup_status === "none";
  if (!alias.active && !recovering) return failure(404, "not_found");
  if (item.locked_until != null && item.locked_until > now) return failure(423, "locked", { retryAfter: Math.ceil((item.locked_until - now) / 1000) });
  if (item.locked_until != null) {
    await env.DB.prepare("UPDATE locker_v2_items SET fail_streak=0,locked_until=NULL WHERE item_id=? AND locked_until<=?").bind(item.item_id, now).run();
  }
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return failure(400, "invalid");
  if (!(await pickupMatches(code, item.code_hash))) {
    const updated = await env.DB.prepare("UPDATE locker_v2_items SET fail_streak=fail_streak+1,locked_until=CASE WHEN fail_streak+1>=5 THEN ? ELSE locked_until END WHERE item_id=? RETURNING locked_until").bind(now + RECOVERY_MS, item.item_id).first<{ locked_until: number | null }>();
    return updated?.locked_until && updated.locked_until > now ? failure(423, "locked", { retryAfter: 900 }) : failure(401, "bad_code");
  }
  await env.DB.prepare("UPDATE locker_v2_items SET fail_streak=0 WHERE item_id=? AND (locked_until IS NULL OR locked_until<=?)").bind(item.item_id, now).run();
  item = (await itemById(env, item.item_id))!;
  if (item.locked_until != null && item.locked_until > now) return failure(423, "locked", { retryAfter: Math.ceil((item.locked_until - now) / 1000) });
  return recovering ? item : available(item, now) ?? item;
}
function validObjectKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 && /^[A-Za-z0-9._/-]+$/.test(value) && !value.startsWith("/") && !value.endsWith("/") && !value.includes("..") && !value.includes("//");
}
function validCount(value: unknown): value is number | null { return value === null || typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 4294967295; }
async function registerItem(env: V2Env, id: string, b: Body, now: number): Promise<Response> {
  if (!ID.test(id) || typeof b.operationId !== "string" || !ID.test(b.operationId) || typeof b.version !== "string" || !ID.test(b.version) || !validObjectKey(b.objectKey) || typeof b.codeHash !== "string" || !HASH.test(b.codeHash)
    || typeof b.cipherSize !== "number" || !Number.isInteger(b.cipherSize) || b.cipherSize < 9 || b.cipherSize > MAX_CIPHER || !validCount(b.maxPulls) || !(b.pullsLeft === null || typeof b.pullsLeft === "number" && Number.isInteger(b.pullsLeft) && b.pullsLeft >= 0 && b.pullsLeft <= Number(b.maxPulls)) || (b.maxPulls === null) !== (b.pullsLeft === null)) return failure(400, "invalid");
  const hash = await sha256Hex(enc.encode(JSON.stringify({ id, ...b })));
  const existing = await itemById(env, id);
  if (existing) return existing.register_operation_id === b.operationId && existing.register_hash === hash ? json(200, await metadata(env, existing, now)) : failure(409, "operation_conflict");
  const expire = b.expireAt === null ? null : typeof b.expireAt === "string" ? Date.parse(b.expireAt) : NaN;
  if (expire !== null && (!Number.isFinite(expire) || expire <= now || expire - now > 100 * 366 * 86400_000)) return failure(400, "invalid");
  const object = await env.LOCKER_BUCKET.head(b.objectKey);
  if (!object) return failure(400, "missing_object");
  if (object.size !== b.cipherSize) return failure(400, "size_mismatch");
  try {
    await env.DB.prepare("INSERT INTO locker_v2_items(item_id,version,register_operation_id,register_hash,object_key,code_hash,cipher_size,expire_at,max_pulls,pulls_left,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .bind(id, b.version, b.operationId, hash, b.objectKey, b.codeHash, b.cipherSize, expire, b.maxPulls, b.pullsLeft, now).run();
  } catch {
    const again = await itemById(env, id);
    if (!again || again.register_operation_id !== b.operationId || again.register_hash !== hash) return failure(409, "operation_conflict");
  }
  return json(200, await metadata(env, (await itemById(env, id))!, now));
}
async function operation(env: V2Env, id: string, route: string, b: Body, statements: ReturnType<D1Database["prepare"]>[], result: Body): Promise<Response | null> {
  if (typeof b.operationId !== "string" || !ID.test(b.operationId)) return failure(400, "invalid");
  const hash = await sha256Hex(enc.encode(JSON.stringify(b)));
  const existing = await env.DB.prepare("SELECT * FROM locker_v2_operations WHERE operation_id=?").bind(b.operationId).first<{ route: string; request_hash: string; result_json: string }>();
  if (existing) return existing.route === route && existing.request_hash === hash ? json(200, JSON.parse(existing.result_json)) : failure(409, "operation_conflict");
  // Each mutation statement is gated by operation_id + applied=0. Batch is atomic.
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO locker_v2_operations(operation_id,route,request_hash,result_json) VALUES (?,?,?,?)").bind(b.operationId, route, hash, JSON.stringify(result)),
    ...statements,
    env.DB.prepare("UPDATE locker_v2_operations SET applied=1 WHERE operation_id=? AND route=? AND request_hash=?").bind(b.operationId, route, hash),
  ]);
  const saved = await env.DB.prepare("SELECT route,request_hash FROM locker_v2_operations WHERE operation_id=?").bind(b.operationId).first<{ route: string; request_hash: string }>();
  return saved?.route === route && saved.request_hash === hash ? null : failure(409, "operation_conflict");
}
async function createShare(env: V2Env, item: Item, b: Body, now: number): Promise<Response> {
  if (typeof b.slug !== "string" || !SLUG.test(b.slug) || typeof b.operationId !== "string" || !ID.test(b.operationId)) return failure(400, "invalid");
  const denied = available(item, now); if (denied) return denied;
  if (item.pulls_left === 0) return failure(409, "no_allowance");
  const replay = async () => {
    const old = await env.DB.prepare("SELECT * FROM locker_v2_shares WHERE operation_id=? OR slug=?").bind(b.operationId, b.slug).first<{ slug: string; operation_id: string; item_id: string; active: number }>();
    if (!old) return null;
    if (old.item_id !== item.item_id || old.operation_id !== b.operationId || old.slug !== b.slug) return failure(409, "operation_conflict");
    return old.active ? json(200, { slug: old.slug }) : failure(409, "share_stopped");
  };
  const old = await replay(); if (old) return old;
  // Retired aliases are never reused. Atomic insert checks item eligibility again.
  try {
    const r = await env.DB.prepare("INSERT INTO locker_v2_shares(slug,item_id,operation_id,created_at) SELECT ?,item_id,?,? FROM locker_v2_items WHERE item_id=? AND state='active' AND cleanup_status='none' AND (expire_at IS NULL OR expire_at>?) AND (pulls_left IS NULL OR pulls_left>0)").bind(b.slug, b.operationId, now, item.item_id, now).run();
    if (!r.meta.changes) return failure(409, "no_allowance");
  } catch { return (await replay()) ?? failure(409, "operation_conflict"); }
  return json(200, { slug: b.slug });
}
async function stopShare(env: V2Env, item: Item, b: Body): Promise<Response> {
  const route = `/v2/items/${item.item_id}/share`;
  const requestHash = await sha256Hex(enc.encode(JSON.stringify(b)));
  const r = await operation(env, item.item_id, route, b, [env.DB.prepare("UPDATE locker_v2_shares SET active=0 WHERE item_id=? AND EXISTS(SELECT 1 FROM locker_v2_operations WHERE operation_id=? AND route=? AND request_hash=? AND applied=0)").bind(item.item_id, b.operationId ?? "", route, requestHash)], { ok: true });
  return r ?? json(200, { ok: true });
}
async function tokenFor(env: V2Env, id: string, itemId: string, version: string, scope: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(env.LOCKER_HMAC_SECRET.trim()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`locker-claim-v2\n${id}\n${itemId}\n${version}\n${scope}`))));
}
async function claimResult(env: V2Env, claim: Claim, token: string) {
  const item = (await itemById(env, claim.item_id))!;
  return { operationId: claim.operation_id, token, itemId: claim.item_id, version: claim.version, state: claim.state,
    recoveryUntil: iso(claim.recovery_until), attempts: claim.attempts, pullsLeft: item.pulls_left, cipherSize: item.cipher_size, cleanupStatus: item.cleanup_status };
}
async function replayClaim(env: V2Env, claim: Claim, token: string) {
  const hash = await sha256Hex(enc.encode(token));
  // A rotated owner signing secret derives a new token. Persist only its hash,
  // retaining the original token so concurrent recovery never invalidates it.
  if (hash !== claim.token_hash) await env.DB.prepare("INSERT OR IGNORE INTO locker_v2_claim_tokens(operation_id,token_hash) VALUES (?,?)").bind(claim.operation_id, hash).run();
  return json(200, await claimResult(env, claim, token));
}
async function reserve(env: V2Env, item: Item, scope: string, b: Body, now: number): Promise<Response> {
  if (typeof b.operationId !== "string" || !ID.test(b.operationId) || typeof b.expectedVersion !== "string") return failure(400, "invalid");
  const token = await tokenFor(env, b.operationId, item.item_id, item.version, scope);
  let existing = await claimById(env, b.operationId);
  if (existing) return existing.item_id === item.item_id && existing.version === b.expectedVersion && existing.scope === scope ? replayClaim(env, existing, token) : failure(409, "operation_conflict");
  if (b.expectedVersion !== item.version) return failure(409, "version_conflict");
  const denied = available(item, now); if (denied) return denied;
  await expireReserved(env, item.item_id, now);
  const tokenHash = await sha256Hex(enc.encode(token));
  const publicSlug = scope.startsWith("share:") ? scope.slice(6) : "";
  // D1 batch is a transaction: marker makes INSERT contingent on this exact debit.
  await env.DB.batch([
    env.DB.prepare("UPDATE locker_v2_items SET pulls_left=CASE WHEN pulls_left IS NULL THEN NULL ELSE pulls_left-1 END,reservation_marker=? WHERE item_id=? AND version=? AND state='active' AND cleanup_status='none' AND (expire_at IS NULL OR expire_at>?) AND (pulls_left IS NULL OR pulls_left>0) AND NOT EXISTS(SELECT 1 FROM locker_v2_claims WHERE operation_id=?) AND (?='' OR EXISTS(SELECT 1 FROM locker_v2_shares WHERE slug=? AND item_id=locker_v2_items.item_id AND active=1))")
      .bind(b.operationId, item.item_id, b.expectedVersion, now, b.operationId, publicSlug, publicSlug),
    env.DB.prepare("INSERT OR IGNORE INTO locker_v2_claims(operation_id,item_id,version,scope,token_hash,recovery_until,created_at) SELECT ?,item_id,version,?,?,?,? FROM locker_v2_items WHERE item_id=? AND reservation_marker=?")
      .bind(b.operationId, scope, tokenHash, now + RECOVERY_MS, now, item.item_id, b.operationId),
  ]);
  existing = await claimById(env, b.operationId);
  if (!existing) return failure(409, "no_allowance");
  if (existing.item_id !== item.item_id || existing.scope !== scope || existing.version !== b.expectedVersion) return failure(409, "operation_conflict");
  return replayClaim(env, existing, token);
}
async function expireReserved(env: V2Env, itemId: string, now: number) {
  await env.DB.batch([
    env.DB.prepare("UPDATE locker_v2_items SET pulls_left=CASE WHEN pulls_left IS NULL THEN NULL ELSE pulls_left+(SELECT COUNT(*) FROM locker_v2_claims WHERE item_id=? AND state='reserved' AND recovery_until<=?) END WHERE item_id=? AND state='active'").bind(itemId, now, itemId),
    env.DB.prepare("UPDATE locker_v2_claims SET state='expired' WHERE item_id=? AND state IN ('reserved','delivering') AND recovery_until<=?").bind(itemId, now),
  ]);
}
async function cleanup(env: V2Env, id: string, now: number): Promise<void> {
  const item = await itemById(env, id); if (!item || item.cleanup_status === "cleaned") return;
  if (item.state !== "deleted") {
    if (itemStatus(item, now) === "active") return;
    const held = await env.DB.prepare("SELECT 1 AS present FROM locker_v2_claims WHERE item_id=? AND state IN ('reserved','delivering') AND recovery_until>? LIMIT 1").bind(id, now).first();
    if (held) return;
  }
  const marked = await env.DB.prepare("UPDATE locker_v2_items SET cleanup_status='pending' WHERE item_id=? AND cleanup_status!='cleaned' AND (state='deleted' OR ((expire_at<=? OR pulls_left=0) AND NOT EXISTS(SELECT 1 FROM locker_v2_claims WHERE item_id=? AND state IN ('reserved','delivering') AND recovery_until>?)))").bind(id, now, id, now).run();
  if (!marked.meta.changes) return;
  try {
    await env.LOCKER_BUCKET.delete(item.object_key);
    await env.DB.batch([
      env.DB.prepare("UPDATE locker_v2_items SET cleanup_status='cleaned' WHERE item_id=?").bind(id),
      env.DB.prepare("UPDATE locker_v2_shares SET active=0 WHERE item_id=?").bind(id),
    ]);
  } catch { await env.DB.prepare("UPDATE locker_v2_items SET cleanup_status='failed' WHERE item_id=? AND cleanup_status!='cleaned'").bind(id).run(); }
}
async function deleteItem(env: V2Env, item: Item, b: Body, now: number): Promise<Response> {
  const route = `/v2/items/${item.item_id}`;
  const hash = await sha256Hex(enc.encode(JSON.stringify(b)));
  const gate = "EXISTS(SELECT 1 FROM locker_v2_operations WHERE operation_id=? AND route=? AND request_hash=? AND applied=0)";
  const r = await operation(env, item.item_id, route, b, [
    env.DB.prepare(`UPDATE locker_v2_items SET state='deleted',cleanup_status=CASE WHEN cleanup_status='cleaned' THEN 'cleaned' ELSE 'pending' END WHERE item_id=? AND ${gate}`).bind(item.item_id, b.operationId ?? "", route, hash),
    env.DB.prepare(`UPDATE locker_v2_shares SET active=0 WHERE item_id=? AND ${gate}`).bind(item.item_id, b.operationId ?? "", route, hash),
    env.DB.prepare(`UPDATE locker_v2_claims SET state='cancelled' WHERE item_id=? AND state IN ('reserved','delivering') AND ${gate}`).bind(item.item_id, b.operationId ?? "", route, hash),
  ], { ok: true });
  if (r && r.status !== 200) return r;
  await cleanup(env, item.item_id, now);
  return json(200, await metadata(env, (await itemById(env, item.item_id))!, now));
}
async function claimAction(env: V2Env, id: string, action: string, b: Body, now: number): Promise<Response> {
  if (!ID.test(id) || typeof b.token !== "string" || !HASH.test(b.token)) return failure(401, "unauthorized");
  let claim = await claimById(env, id); if (!claim) return failure(401, "unauthorized");
  const tokenHash = await sha256Hex(enc.encode(b.token));
  if (claim.token_hash !== tokenHash && !await env.DB.prepare("SELECT 1 AS valid FROM locker_v2_claim_tokens WHERE operation_id=? AND token_hash=?").bind(id, tokenHash).first()) return failure(401, "unauthorized");
  await expireReserved(env, claim.item_id, now);
  claim = (await claimById(env, id))!;
  if (action === "status") { await cleanup(env, claim.item_id, now); return json(200, await claimResult(env, claim, b.token)); }
  if (action === "ack" && claim.state === "delivered") { await cleanup(env, claim.item_id, now); return json(200, await claimResult(env, claim, b.token)); }
  if (action === "cancel" && claim.state === "cancelled") return json(200, await claimResult(env, claim, b.token));
  if (claim.state === "expired" || claim.recovery_until <= now) return failure(410, "session_expired");
  if (claim.state === "cancelled" || claim.state === "delivered") return failure(410, "session_closed");
  if (action === "cancel") {
    if (claim.state !== "reserved") return failure(409, "delivery_started");
    await env.DB.batch([
      env.DB.prepare("UPDATE locker_v2_items SET pulls_left=CASE WHEN pulls_left IS NULL THEN NULL ELSE pulls_left+1 END WHERE item_id=? AND state='active' AND EXISTS(SELECT 1 FROM locker_v2_claims WHERE operation_id=? AND state='reserved')").bind(claim.item_id, id),
      env.DB.prepare("UPDATE locker_v2_claims SET state='cancelled' WHERE operation_id=? AND state='reserved'").bind(id),
    ]);
    claim = (await claimById(env, id))!;
    if (claim.state !== "cancelled") return failure(409, "delivery_started");
    await cleanup(env, claim.item_id, now);
    return json(200, await claimResult(env, claim, b.token));
  }
  if (action === "ack") {
    if (claim.state !== "delivering") return failure(409, "delivery_not_started");
    await env.DB.prepare("UPDATE locker_v2_claims SET state='delivered' WHERE operation_id=? AND state='delivering'").bind(id).run();
    claim = (await claimById(env, id))!;
    if (claim.state !== "delivered") return failure(410, "session_closed");
    await cleanup(env, claim.item_id, now);
    return json(200, await claimResult(env, claim, b.token));
  }
  if (action !== "content") return failure(404, "not_found");
  const started = await env.DB.prepare("UPDATE locker_v2_claims SET state='delivering',attempts=attempts+1 WHERE operation_id=? AND state IN ('reserved','delivering') AND recovery_until>? AND attempts<3 AND EXISTS(SELECT 1 FROM locker_v2_items WHERE item_id=locker_v2_claims.item_id AND state='active' AND cleanup_status='none') RETURNING *").bind(id, now).first<Claim>();
  if (!started) return failure(410, "attempts_exhausted");
  const item = (await itemById(env, claim.item_id))!;
  const object = await env.LOCKER_BUCKET.get(item.object_key);
  if (!object?.body) return failure(503, "storage_unavailable");
  if (object.size !== item.cipher_size || object.size > MAX_CIPHER) return failure(503, "size_mismatch");
  const headers = new Headers({ "content-type": "application/octet-stream", "content-length": String(object.size), "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-locker-operation-id": id });
  if (item.pulls_left != null) headers.set("x-locker-pulls-left", String(item.pulls_left));
  return new Response(object.body, { status: 200, headers });
}
async function migrateLegacy(env: V2Env, slug: string, b: Body, now: number): Promise<Response> {
  if (!SLUG.test(slug) || typeof b.itemId !== "string" || !ID.test(b.itemId) || typeof b.version !== "string" || !ID.test(b.version) || typeof b.operationId !== "string" || !ID.test(b.operationId) || !validObjectKey(b.expectedObjectKey) || typeof b.expectedCipherSize !== "number" || !Number.isInteger(b.expectedCipherSize)) return failure(400, "invalid");
  const hash = await sha256Hex(enc.encode(JSON.stringify({ slug, ...b })));
  const exists = await itemById(env, b.itemId);
  if (exists) return exists.register_operation_id === b.operationId && exists.register_hash === hash ? json(200, await metadata(env, exists, now)) : failure(409, "operation_conflict");
  const old = await env.DB.prepare("SELECT * FROM locker WHERE slug=?").bind(slug).first<{ object_key: string; code_hash: string; size: number; status: string }>();
  if (!old || old.status !== "active") return failure(404, "legacy_missing");
  if (old.object_key !== b.expectedObjectKey || old.size !== b.expectedCipherSize) return failure(409, "source_mismatch");
  const object = await env.LOCKER_BUCKET.head(old.object_key);
  if (!object || object.size !== old.size) return failure(404, "missing_object");
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO locker_v2_items(item_id,version,register_operation_id,register_hash,object_key,code_hash,cipher_size,expire_at,max_pulls,pulls_left,created_at) SELECT ?,?,?,?,object_key,code_hash,size,expire_at,max_pulls,pulls_left,? FROM locker WHERE slug=? AND status='active'").bind(b.itemId, b.version, b.operationId, hash, now, slug),
      env.DB.prepare("UPDATE locker SET status='revoked' WHERE slug=? AND EXISTS(SELECT 1 FROM locker_v2_items WHERE item_id=? AND register_operation_id=? AND register_hash=?)").bind(slug, b.itemId, b.operationId, hash),
    ]);
  } catch { return failure(409, "operation_conflict"); }
  const item = await itemById(env, b.itemId);
  if (!item || item.register_hash !== hash) return failure(409, "operation_conflict");
  return json(200, await metadata(env, item, now));
}

export async function sweepV2(env: V2Env, now = Date.now()): Promise<void> {
  if (!(await schemaReady(env))) return;
  const candidates = await env.DB.prepare("SELECT item_id FROM locker_v2_items WHERE cleanup_status!='cleaned' AND (state='deleted' OR expire_at<=? OR pulls_left=0 OR EXISTS(SELECT 1 FROM locker_v2_claims WHERE item_id=locker_v2_items.item_id AND state IN ('reserved','delivering') AND recovery_until<=?)) LIMIT 100").bind(now, now).all<{ item_id: string }>();
  for (const { item_id } of candidates.results) { await expireReserved(env, item_id, now); await cleanup(env, item_id, now); }
  // Revoke eligibility before deleting so a concurrent legacy migration cannot
  // adopt an object after cleanup has begun. Migrated v2 keys are always excluded.
  const legacy = await env.DB.prepare("SELECT slug,object_key FROM locker WHERE (expire_at<=? OR pulls_left=0) AND NOT EXISTS(SELECT 1 FROM locker_v2_items WHERE locker_v2_items.object_key=locker.object_key) LIMIT 40").bind(now).all<{ slug: string; object_key: string }>();
  for (const row of legacy.results) {
    const marked = await env.DB.prepare("UPDATE locker SET status='revoked' WHERE slug=? AND (expire_at<=? OR pulls_left=0) AND NOT EXISTS(SELECT 1 FROM locker_v2_items WHERE locker_v2_items.object_key=locker.object_key)").bind(row.slug, now).run();
    if (!marked.meta.changes) continue;
    try { await env.LOCKER_BUCKET.delete(row.object_key); await env.DB.prepare("DELETE FROM locker WHERE slug=? AND status='revoked'").bind(row.slug).run(); }
    catch { /* retain the row for cleanup retry; never claim deletion succeeded */ }
  }
  await env.DB.prepare("DELETE FROM locker_v2_nonces WHERE expires_at<=?").bind(now).run();
}

export async function handleV2(request: Request, env: V2Env, _ctx: ExecutionContext, pageScript: string, now = Date.now()): Promise<Response> {
  const path = new URL(request.url).pathname;
  try {
    if (request.method === "GET" && (path === "/" || path === "/v2/health")) return await health(env);
    if (path === "/register" || path.startsWith("/register/") || path.startsWith("/api/")) return failure(426, "protocol_upgrade_required");
    if (request.method === "GET" && path.startsWith("/d/")) return html(200, renderV2Page(path.slice(3), pageScript));
    if (path.startsWith("/v2/claims/")) {
      const m = /^\/v2\/claims\/([^/]+)\/(status|content|ack|cancel)$/.exec(path); if (!m || request.method !== "POST") return failure(404, "not_found");
      const b = await publicBody(request); return b instanceof Response ? b : await claimAction(env, m[1], m[2], b, now);
    }
    if (path.startsWith("/v2/shares/")) {
      const m = /^\/v2\/shares\/([^/]+)\/(lookup|claims)$/.exec(path); if (!m || request.method !== "POST") return failure(404, "not_found");
      const b = await publicBody(request); if (b instanceof Response) return b;
      const item = await verifyPublic(env, m[1], b.code, now, m[2] === "claims" ? b : undefined); if (item instanceof Response) return item;
      return m[2] === "lookup" ? json(200, await metadata(env, item, now)) : await reserve(env, item, `share:${m[1]}`, b, now);
    }
    if (!path.startsWith("/v2/")) return failure(404, "not_found");
    const b = await ownerBody(request, env, now); if (b instanceof Response) return b;
    if (path === "/v2/probe" && request.method === "POST") {
      if (!validObjectKey(b.objectKey)) return failure(400, "invalid");
      if (!(await schemaReady(env))) return failure(503, "schema_required");
      const object = await env.LOCKER_BUCKET.head(b.objectKey);
      if (!object) return failure(400, "missing_object");
      if (b.cipherSize != null && b.cipherSize !== object.size) return failure(400, "size_mismatch");
      return json(200, { ok: true, protocolVersion: 2, schemaVersion: 2, objectExists: true, cipherSize: object.size });
    }
    if (path.startsWith("/v2/migrate/") && request.method === "POST") return await migrateLegacy(env, path.slice(12), b, now);
    const m = /^\/v2\/items\/([^/]+)(?:\/(lookup|share|claims))?$/.exec(path); if (!m || !ID.test(m[1])) return failure(404, "not_found");
    const [, id, sub] = m;
    if (!sub && request.method === "PUT") return await registerItem(env, id, b, now);
    await expireReserved(env, id, now);
    const item = await itemById(env, id); if (!item) return failure(404, "not_found");
    if (!sub && request.method === "GET") return json(200, await metadata(env, item, now));
    if (!sub && request.method === "DELETE") return await deleteItem(env, item, b, now);
    if (sub === "lookup" && request.method === "POST") return available(item, now) ?? json(200, await metadata(env, item, now));
    if (sub === "share" && request.method === "POST") return await createShare(env, item, b, now);
    if (sub === "share" && request.method === "DELETE") return await stopShare(env, item, b);
    if (sub === "claims" && request.method === "POST") return await reserve(env, item, "owner", b, now);
    return failure(404, "not_found");
  } catch {
    // Never log request bodies, pickup codes, tokens, URLs or object keys.
    return failure(503, "storage_unavailable");
  }
}
