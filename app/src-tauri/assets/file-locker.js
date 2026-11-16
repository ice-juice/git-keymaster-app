// src/constants.ts
var MAX_PLAIN_BYTES = 100 * 1024 * 1024;
var MAX_CIPHER_BYTES = MAX_PLAIN_BYTES + 64 * 1024;
var LOCK_MS = 15 * 60 * 1e3;
var MAX_SKEW_SEC = 300;
var MIN_SECRET_LEN = 16;
var MAX_EXPIRE_MS = 100 * 366 * 24 * 60 * 60 * 1e3;
var PICKUP_CODE_LABEL = "gam-locker-code-v1";
var NONCE_HEX_LEN = 32;
var BLOB_MAGIC = new Uint8Array([71, 75, 66, 49]);
var MAX_CHUNK_SIZE = 8 * 1024 * 1024;

// src/auth.ts
var enc = new TextEncoder();
function normalizeSecret(raw) {
  if (typeof raw !== "string") return null;
  const secret = raw.trim();
  if (secret.length < MIN_SECRET_LEN) return null;
  return secret;
}
function toHex(bytes) {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
function hexToBytes(hex) {
  if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
async function hmacKey(secretBytes) {
  return crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}
async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(new Uint8Array(digest));
}
function canonicalAuth(timestamp, nonceHex, method, path, bodyHashHex) {
  return `${timestamp}
${nonceHex}
${method.toUpperCase()}
${path}
${bodyHashHex}`;
}
async function verifyRequest(secret, method, path, body, timestampHeader, nonceHeader, signatureHeader, nowMs) {
  const tsRaw = (timestampHeader ?? "").trim();
  const nonceHex = (nonceHeader ?? "").trim().toLowerCase();
  const sigHex = (signatureHeader ?? "").trim().toLowerCase();
  if (!/^\d{1,12}$/.test(tsRaw)) return false;
  if (!new RegExp(`^[0-9a-f]{${NONCE_HEX_LEN}}$`).test(nonceHex)) return false;
  if (!/^[0-9a-f]{64}$/.test(sigHex)) return false;
  const ts = Number(tsRaw);
  const nowSec = Math.floor(nowMs / 1e3);
  if (Math.abs(nowSec - ts) > MAX_SKEW_SEC) return false;
  const sig = hexToBytes(sigHex);
  if (!sig) return false;
  const bodyHash = await sha256Hex(body);
  const canonical = canonicalAuth(tsRaw, nonceHex, method, path, bodyHash);
  const key = await hmacKey(enc.encode(secret));
  return crypto.subtle.verify("HMAC", key, sig, enc.encode(canonical));
}
async function pickupMatches(code, codeHashHex) {
  const hex = codeHashHex.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) return false;
  const sig = hexToBytes(hex);
  if (!sig) return false;
  const key = await hmacKey(enc.encode(PICKUP_CODE_LABEL));
  return crypto.subtle.verify("HMAC", key, sig, enc.encode(code));
}

// src/http.ts
function json(status, body, extra) {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  return new Response(JSON.stringify(body), { status, headers });
}
function html(status, markup) {
  const headers = new Headers();
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-robots-tag", "noindex");
  headers.set(
    "content-security-policy",
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  );
  return new Response(markup, { status, headers });
}

// src/page-v2.ts
function renderV2Page(slug, script) {
  const safeSlug = /^[A-Za-z0-9]{10}$/.test(slug) ? slug : "invalid";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>\u6587\u4EF6\u5BC4\u5B58\u67DC \xB7 \u53D6\u4EF6</title><style>
  :root{color-scheme:light dark;font:15px/1.6 system-ui,"Microsoft YaHei",sans-serif;color:light-dark(#192438,#eef2fb);background:light-dark(#f3f6fb,#101722)}*{box-sizing:border-box}body{margin:0;padding:30px 18px}main{max-width:580px;margin:auto;padding:28px;background:light-dark(#fff,#1c2737);border:1px solid light-dark(#e0e6f0,#35455b);border-radius:14px}h1{font-size:24px;margin:0 0 8px}h2{font-size:17px}p{margin:8px 0;color:light-dark(#65738a,#adbad0)}label{display:block;margin-top:20px}input,button{font:inherit;padding:10px 13px;border-radius:8px;min-height:44px}input{width:100%;margin:7px 0;border:1px solid light-dark(#ccd6e5,#53657d);color:inherit;background:transparent}button{border:1px solid light-dark(#d6deeb,#54627a);background:transparent;color:inherit;cursor:pointer}button.primary{color:#fff;background:#5147df;border-color:#5147df}button:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible{outline:2px solid #8e83ff;outline-offset:3px}.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}.meta{border-top:1px solid light-dark(#e0e6f0,#35455b);margin-top:22px;padding-top:16px}#error{color:light-dark(#a63841,#ffadb5);overflow-wrap:anywhere}#file-name{overflow-wrap:anywhere;color:inherit;font-weight:600}.small{font-size:12px}[hidden]{display:none!important}
  </style></head><body data-locker-protocol="2" data-slug="${safeSlug}"><main><h1>\u6587\u4EF6\u5BC4\u5B58\u67DC</h1><p>\u5148\u9A8C\u8BC1\u53D6\u4EF6\u4FE1\u606F\uFF0C\u518D\u786E\u8BA4\u9886\u53D6\u3002</p><form id="pick"><label for="code">6 \u4F4D\u53D6\u4EF6\u7801</label><input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="12" placeholder="\u8F93\u5165\u6216\u7C98\u8D34\u53D6\u4EF6\u7801"><div class="actions"><button id="go" class="primary" type="submit">\u67E5\u8BE2\u6587\u4EF6</button></div></form><div id="details" class="meta" hidden><h2 id="file-name"></h2><p id="rules"></p><p class="small">\u67E5\u8BE2\u4E0D\u6D88\u8017\u540D\u989D\u3002\u5F00\u59CB\u9886\u53D6\u540E\uFF0C\u4E2D\u65AD\u65F6\u8BF7\u7EE7\u7EED\u539F\u64CD\u4F5C\uFF0C\u907F\u514D\u91CD\u590D\u9886\u53D6\u3002</p><div class="actions"><button id="receive" class="primary" type="button">\u9886\u53D6\u5E76\u4FDD\u5B58</button><button id="cancel" type="button" hidden>\u53D6\u6D88\u672C\u6B21\u9884\u7559</button><button id="save-again" type="button" hidden>\u518D\u6B21\u4FDD\u5B58\u5DF2\u89E3\u5BC6\u6587\u4EF6</button></div></div><p id="status" role="status" aria-live="polite"></p><p id="error" role="alert"></p><p class="small">\u89E3\u5BC6\u53EA\u5728\u6B64\u6D4F\u89C8\u5668\u4E2D\u5B8C\u6210\u3002\u8BF7\u4FDD\u7559\u94FE\u63A5\u4E2D # \u540E\u7684\u5B8C\u6574\u4FE1\u606F\u3002</p></main><script>${script.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
}

// src/handle-v2.ts
var ID = /^[A-Za-z0-9_-]{8,80}$/;
var SLUG = /^[A-Za-z0-9]{10}$/;
var HASH = /^[a-f0-9]{64}$/;
var MAX_CIPHER = 100 * 1024 * 1024 + 64 * 1024;
var RECOVERY_MS = 15 * 60 * 1e3;
var enc2 = new TextEncoder();
var failure = (status, error, extra = {}) => json(status, { error, ...extra });
var iso = (n) => n == null ? null : new Date(n).toISOString();
var itemById = (env, id) => env.DB.prepare("SELECT * FROM locker_v2_items WHERE item_id=?").bind(id).first();
var claimById = (env, id) => env.DB.prepare("SELECT * FROM locker_v2_claims WHERE operation_id=?").bind(id).first();
async function bodyBytes(request, max = 8192) {
  if (Number(request.headers.get("content-length")) > max) return failure(413, "too_large");
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.length;
    if (size > max) {
      await reader.cancel();
      return failure(413, "too_large");
    }
    chunks.push(part.value);
  }
  const data = new Uint8Array(size);
  let at = 0;
  for (const part of chunks) {
    data.set(part, at);
    at += part.length;
  }
  return data;
}
function parseBody(bytes) {
  try {
    const b = bytes.length ? JSON.parse(new TextDecoder().decode(bytes)) : {};
    return b && typeof b === "object" && !Array.isArray(b) ? b : null;
  } catch {
    return null;
  }
}
async function ownerBody(request, env, now) {
  const secret = normalizeSecret(env.LOCKER_HMAC_SECRET);
  if (!secret) return failure(500, "misconfigured");
  const bytes = await bodyBytes(request);
  if (bytes instanceof Response) return bytes;
  const valid = await verifyRequest(
    secret,
    request.method,
    new URL(request.url).pathname,
    bytes,
    request.headers.get("x-locker-timestamp"),
    request.headers.get("x-locker-nonce"),
    request.headers.get("x-locker-signature"),
    now
  );
  if (!valid) return failure(401, "unauthorized");
  const value = parseBody(bytes);
  if (!value) return failure(400, "invalid");
  const nonce = request.headers.get("x-locker-nonce").toLowerCase();
  const inserted = await env.DB.prepare("INSERT OR IGNORE INTO locker_v2_nonces(nonce,expires_at) VALUES (?,?)").bind(nonce, now + 601e3).run();
  if (!inserted.meta.changes) return failure(401, "replayed_auth");
  return value;
}
async function publicBody(request) {
  const bytes = await bodyBytes(request, 2048);
  if (bytes instanceof Response) return bytes;
  return parseBody(bytes) ?? failure(400, "invalid");
}
async function schemaReady(env) {
  try {
    await env.DB.batch([
      env.DB.prepare("SELECT item_id,version,register_hash,cleanup_status,reservation_marker FROM locker_v2_items LIMIT 0"),
      env.DB.prepare("SELECT slug,active,operation_id FROM locker_v2_shares LIMIT 0"),
      env.DB.prepare("SELECT operation_id,token_hash,recovery_until,attempts FROM locker_v2_claims LIMIT 0"),
      env.DB.prepare("SELECT operation_id,token_hash FROM locker_v2_claim_tokens LIMIT 0"),
      env.DB.prepare("SELECT operation_id,request_hash,applied,result_json FROM locker_v2_operations LIMIT 0"),
      env.DB.prepare("SELECT nonce,expires_at FROM locker_v2_nonces LIMIT 0")
    ]);
    return true;
  } catch {
    return false;
  }
}
async function health(env) {
  if (!await schemaReady(env)) return failure(503, "schema_required", { protocolVersion: 2, schemaVersion: 0 });
  return json(200, {
    service: "file-locker",
    ok: true,
    protocolVersion: 2,
    schemaVersion: 2,
    capabilities: ["private-items", "lookup", "claims", "resume", "stop-share", "cleanup-status"]
  });
}
function itemStatus(item, now) {
  if (item.state === "deleted") return "deleted";
  if (item.expire_at != null && item.expire_at <= now) return "expired";
  if (item.pulls_left === 0) return "exhausted";
  return "active";
}
async function metadata(env, item, now) {
  const share = await env.DB.prepare("SELECT slug FROM locker_v2_shares WHERE item_id=? AND active=1 ORDER BY created_at DESC LIMIT 1").bind(item.item_id).first();
  const held = await env.DB.prepare("SELECT COUNT(*) AS count FROM locker_v2_claims WHERE item_id=? AND state IN ('reserved','delivering') AND recovery_until>?").bind(item.item_id, now).first();
  return {
    itemId: item.item_id,
    version: item.version,
    cipherSize: item.cipher_size,
    expireAt: iso(item.expire_at),
    maxPulls: item.max_pulls,
    pullsLeft: item.pulls_left,
    inFlightClaims: held?.count ?? 0,
    status: itemStatus(item, now),
    cleanupStatus: item.cleanup_status,
    shareSlug: share?.slug ?? null
  };
}
function available(item, now) {
  if (item.state !== "active" || item.cleanup_status === "cleaned") return failure(404, "not_found");
  if (item.expire_at != null && item.expire_at <= now) return failure(410, "expired");
  return null;
}
async function verifyPublic(env, slug, code, now, replay) {
  if (!SLUG.test(slug)) return failure(404, "not_found");
  const alias = await env.DB.prepare("SELECT item_id,active FROM locker_v2_shares WHERE slug=?").bind(slug).first();
  if (!alias) return failure(404, "not_found");
  let item = await itemById(env, alias.item_id);
  if (!item) return failure(404, "not_found");
  const prior = replay && typeof replay.operationId === "string" && ID.test(replay.operationId) ? await claimById(env, replay.operationId) : null;
  const recovering = prior && prior.item_id === item.item_id && prior.scope === `share:${slug}` && prior.version === replay?.expectedVersion && prior.recovery_until > now && ["reserved", "delivering"].includes(prior.state) && item.state === "active" && item.cleanup_status === "none";
  if (!alias.active && !recovering) return failure(404, "not_found");
  if (item.locked_until != null && item.locked_until > now) return failure(423, "locked", { retryAfter: Math.ceil((item.locked_until - now) / 1e3) });
  if (item.locked_until != null) {
    await env.DB.prepare("UPDATE locker_v2_items SET fail_streak=0,locked_until=NULL WHERE item_id=? AND locked_until<=?").bind(item.item_id, now).run();
  }
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return failure(400, "invalid");
  if (!await pickupMatches(code, item.code_hash)) {
    const updated = await env.DB.prepare("UPDATE locker_v2_items SET fail_streak=fail_streak+1,locked_until=CASE WHEN fail_streak+1>=5 THEN ? ELSE locked_until END WHERE item_id=? RETURNING locked_until").bind(now + RECOVERY_MS, item.item_id).first();
    return updated?.locked_until && updated.locked_until > now ? failure(423, "locked", { retryAfter: 900 }) : failure(401, "bad_code");
  }
  await env.DB.prepare("UPDATE locker_v2_items SET fail_streak=0 WHERE item_id=? AND (locked_until IS NULL OR locked_until<=?)").bind(item.item_id, now).run();
  item = await itemById(env, item.item_id);
  if (item.locked_until != null && item.locked_until > now) return failure(423, "locked", { retryAfter: Math.ceil((item.locked_until - now) / 1e3) });
  return recovering ? item : available(item, now) ?? item;
}
function validObjectKey(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 && /^[A-Za-z0-9._/-]+$/.test(value) && !value.startsWith("/") && !value.endsWith("/") && !value.includes("..") && !value.includes("//");
}
function validCount(value) {
  return value === null || typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 4294967295;
}
async function registerItem(env, id, b, now) {
  if (!ID.test(id) || typeof b.operationId !== "string" || !ID.test(b.operationId) || typeof b.version !== "string" || !ID.test(b.version) || !validObjectKey(b.objectKey) || typeof b.codeHash !== "string" || !HASH.test(b.codeHash) || typeof b.cipherSize !== "number" || !Number.isInteger(b.cipherSize) || b.cipherSize < 9 || b.cipherSize > MAX_CIPHER || !validCount(b.maxPulls) || !(b.pullsLeft === null || typeof b.pullsLeft === "number" && Number.isInteger(b.pullsLeft) && b.pullsLeft >= 0 && b.pullsLeft <= Number(b.maxPulls)) || b.maxPulls === null !== (b.pullsLeft === null)) return failure(400, "invalid");
  const hash = await sha256Hex(enc2.encode(JSON.stringify({ id, ...b })));
  const existing = await itemById(env, id);
  if (existing) return existing.register_operation_id === b.operationId && existing.register_hash === hash ? json(200, await metadata(env, existing, now)) : failure(409, "operation_conflict");
  const expire = b.expireAt === null ? null : typeof b.expireAt === "string" ? Date.parse(b.expireAt) : NaN;
  if (expire !== null && (!Number.isFinite(expire) || expire <= now || expire - now > 100 * 366 * 864e5)) return failure(400, "invalid");
  const object = await env.LOCKER_BUCKET.head(b.objectKey);
  if (!object) return failure(400, "missing_object");
  if (object.size !== b.cipherSize) return failure(400, "size_mismatch");
  try {
    await env.DB.prepare("INSERT INTO locker_v2_items(item_id,version,register_operation_id,register_hash,object_key,code_hash,cipher_size,expire_at,max_pulls,pulls_left,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(id, b.version, b.operationId, hash, b.objectKey, b.codeHash, b.cipherSize, expire, b.maxPulls, b.pullsLeft, now).run();
  } catch {
    const again = await itemById(env, id);
    if (!again || again.register_operation_id !== b.operationId || again.register_hash !== hash) return failure(409, "operation_conflict");
  }
  return json(200, await metadata(env, await itemById(env, id), now));
}
async function operation(env, id, route, b, statements, result) {
  if (typeof b.operationId !== "string" || !ID.test(b.operationId)) return failure(400, "invalid");
  const hash = await sha256Hex(enc2.encode(JSON.stringify(b)));
  const existing = await env.DB.prepare("SELECT * FROM locker_v2_operations WHERE operation_id=?").bind(b.operationId).first();
  if (existing) return existing.route === route && existing.request_hash === hash ? json(200, JSON.parse(existing.result_json)) : failure(409, "operation_conflict");
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO locker_v2_operations(operation_id,route,request_hash,result_json) VALUES (?,?,?,?)").bind(b.operationId, route, hash, JSON.stringify(result)),
    ...statements,
    env.DB.prepare("UPDATE locker_v2_operations SET applied=1 WHERE operation_id=? AND route=? AND request_hash=?").bind(b.operationId, route, hash)
  ]);
  const saved = await env.DB.prepare("SELECT route,request_hash FROM locker_v2_operations WHERE operation_id=?").bind(b.operationId).first();
  return saved?.route === route && saved.request_hash === hash ? null : failure(409, "operation_conflict");
}
async function createShare(env, item, b, now) {
  if (typeof b.slug !== "string" || !SLUG.test(b.slug) || typeof b.operationId !== "string" || !ID.test(b.operationId)) return failure(400, "invalid");
  const denied = available(item, now);
  if (denied) return denied;
  if (item.pulls_left === 0) return failure(409, "no_allowance");
  const replay = async () => {
    const old2 = await env.DB.prepare("SELECT * FROM locker_v2_shares WHERE operation_id=? OR slug=?").bind(b.operationId, b.slug).first();
    if (!old2) return null;
    if (old2.item_id !== item.item_id || old2.operation_id !== b.operationId || old2.slug !== b.slug) return failure(409, "operation_conflict");
    return old2.active ? json(200, { slug: old2.slug }) : failure(409, "share_stopped");
  };
  const old = await replay();
  if (old) return old;
  try {
    const r = await env.DB.prepare("INSERT INTO locker_v2_shares(slug,item_id,operation_id,created_at) SELECT ?,item_id,?,? FROM locker_v2_items WHERE item_id=? AND state='active' AND cleanup_status='none' AND (expire_at IS NULL OR expire_at>?) AND (pulls_left IS NULL OR pulls_left>0)").bind(b.slug, b.operationId, now, item.item_id, now).run();
    if (!r.meta.changes) return failure(409, "no_allowance");
  } catch {
    return await replay() ?? failure(409, "operation_conflict");
  }
  return json(200, { slug: b.slug });
}
async function stopShare(env, item, b) {
  const route = `/v2/items/${item.item_id}/share`;
  const requestHash = await sha256Hex(enc2.encode(JSON.stringify(b)));
  const r = await operation(env, item.item_id, route, b, [env.DB.prepare("UPDATE locker_v2_shares SET active=0 WHERE item_id=? AND EXISTS(SELECT 1 FROM locker_v2_operations WHERE operation_id=? AND route=? AND request_hash=? AND applied=0)").bind(item.item_id, b.operationId ?? "", route, requestHash)], { ok: true });
  return r ?? json(200, { ok: true });
}
async function tokenFor(env, id, itemId, version, scope) {
  const key = await crypto.subtle.importKey("raw", enc2.encode(env.LOCKER_HMAC_SECRET.trim()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc2.encode(`locker-claim-v2
${id}
${itemId}
${version}
${scope}`))));
}
async function claimResult(env, claim, token) {
  const item = await itemById(env, claim.item_id);
  return {
    operationId: claim.operation_id,
    token,
    itemId: claim.item_id,
    version: claim.version,
    state: claim.state,
    recoveryUntil: iso(claim.recovery_until),
    attempts: claim.attempts,
    pullsLeft: item.pulls_left,
    cipherSize: item.cipher_size,
    cleanupStatus: item.cleanup_status
  };
}
async function replayClaim(env, claim, token) {
  const hash = await sha256Hex(enc2.encode(token));
  if (hash !== claim.token_hash) await env.DB.prepare("INSERT OR IGNORE INTO locker_v2_claim_tokens(operation_id,token_hash) VALUES (?,?)").bind(claim.operation_id, hash).run();
  return json(200, await claimResult(env, claim, token));
}
async function reserve(env, item, scope, b, now) {
  if (typeof b.operationId !== "string" || !ID.test(b.operationId) || typeof b.expectedVersion !== "string") return failure(400, "invalid");
  const token = await tokenFor(env, b.operationId, item.item_id, item.version, scope);
  let existing = await claimById(env, b.operationId);
  if (existing) return existing.item_id === item.item_id && existing.version === b.expectedVersion && existing.scope === scope ? replayClaim(env, existing, token) : failure(409, "operation_conflict");
  if (b.expectedVersion !== item.version) return failure(409, "version_conflict");
  const denied = available(item, now);
  if (denied) return denied;
  await expireReserved(env, item.item_id, now);
  const tokenHash = await sha256Hex(enc2.encode(token));
  const publicSlug = scope.startsWith("share:") ? scope.slice(6) : "";
  await env.DB.batch([
    env.DB.prepare("UPDATE locker_v2_items SET pulls_left=CASE WHEN pulls_left IS NULL THEN NULL ELSE pulls_left-1 END,reservation_marker=? WHERE item_id=? AND version=? AND state='active' AND cleanup_status='none' AND (expire_at IS NULL OR expire_at>?) AND (pulls_left IS NULL OR pulls_left>0) AND NOT EXISTS(SELECT 1 FROM locker_v2_claims WHERE operation_id=?) AND (?='' OR EXISTS(SELECT 1 FROM locker_v2_shares WHERE slug=? AND item_id=locker_v2_items.item_id AND active=1))").bind(b.operationId, item.item_id, b.expectedVersion, now, b.operationId, publicSlug, publicSlug),
    env.DB.prepare("INSERT OR IGNORE INTO locker_v2_claims(operation_id,item_id,version,scope,token_hash,recovery_until,created_at) SELECT ?,item_id,version,?,?,?,? FROM locker_v2_items WHERE item_id=? AND reservation_marker=?").bind(b.operationId, scope, tokenHash, now + RECOVERY_MS, now, item.item_id, b.operationId)
  ]);
  existing = await claimById(env, b.operationId);
  if (!existing) return failure(409, "no_allowance");
  if (existing.item_id !== item.item_id || existing.scope !== scope || existing.version !== b.expectedVersion) return failure(409, "operation_conflict");
  return replayClaim(env, existing, token);
}
async function expireReserved(env, itemId, now) {
  await env.DB.batch([
    env.DB.prepare("UPDATE locker_v2_items SET pulls_left=CASE WHEN pulls_left IS NULL THEN NULL ELSE pulls_left+(SELECT COUNT(*) FROM locker_v2_claims WHERE item_id=? AND state='reserved' AND recovery_until<=?) END WHERE item_id=? AND state='active'").bind(itemId, now, itemId),
    env.DB.prepare("UPDATE locker_v2_claims SET state='expired' WHERE item_id=? AND state IN ('reserved','delivering') AND recovery_until<=?").bind(itemId, now)
  ]);
}
async function cleanup(env, id, now) {
  const item = await itemById(env, id);
  if (!item || item.cleanup_status === "cleaned") return;
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
      env.DB.prepare("UPDATE locker_v2_shares SET active=0 WHERE item_id=?").bind(id)
    ]);
  } catch {
    await env.DB.prepare("UPDATE locker_v2_items SET cleanup_status='failed' WHERE item_id=? AND cleanup_status!='cleaned'").bind(id).run();
  }
}
async function deleteItem(env, item, b, now) {
  const route = `/v2/items/${item.item_id}`;
  const hash = await sha256Hex(enc2.encode(JSON.stringify(b)));
  const gate = "EXISTS(SELECT 1 FROM locker_v2_operations WHERE operation_id=? AND route=? AND request_hash=? AND applied=0)";
  const r = await operation(env, item.item_id, route, b, [
    env.DB.prepare(`UPDATE locker_v2_items SET state='deleted',cleanup_status=CASE WHEN cleanup_status='cleaned' THEN 'cleaned' ELSE 'pending' END WHERE item_id=? AND ${gate}`).bind(item.item_id, b.operationId ?? "", route, hash),
    env.DB.prepare(`UPDATE locker_v2_shares SET active=0 WHERE item_id=? AND ${gate}`).bind(item.item_id, b.operationId ?? "", route, hash),
    env.DB.prepare(`UPDATE locker_v2_claims SET state='cancelled' WHERE item_id=? AND state IN ('reserved','delivering') AND ${gate}`).bind(item.item_id, b.operationId ?? "", route, hash)
  ], { ok: true });
  if (r && r.status !== 200) return r;
  await cleanup(env, item.item_id, now);
  return json(200, await metadata(env, await itemById(env, item.item_id), now));
}
async function claimAction(env, id, action, b, now) {
  if (!ID.test(id) || typeof b.token !== "string" || !HASH.test(b.token)) return failure(401, "unauthorized");
  let claim = await claimById(env, id);
  if (!claim) return failure(401, "unauthorized");
  const tokenHash = await sha256Hex(enc2.encode(b.token));
  if (claim.token_hash !== tokenHash && !await env.DB.prepare("SELECT 1 AS valid FROM locker_v2_claim_tokens WHERE operation_id=? AND token_hash=?").bind(id, tokenHash).first()) return failure(401, "unauthorized");
  await expireReserved(env, claim.item_id, now);
  claim = await claimById(env, id);
  if (action === "status") {
    await cleanup(env, claim.item_id, now);
    return json(200, await claimResult(env, claim, b.token));
  }
  if (action === "ack" && claim.state === "delivered") {
    await cleanup(env, claim.item_id, now);
    return json(200, await claimResult(env, claim, b.token));
  }
  if (action === "cancel" && claim.state === "cancelled") return json(200, await claimResult(env, claim, b.token));
  if (claim.state === "expired" || claim.recovery_until <= now) return failure(410, "session_expired");
  if (claim.state === "cancelled" || claim.state === "delivered") return failure(410, "session_closed");
  if (action === "cancel") {
    if (claim.state !== "reserved") return failure(409, "delivery_started");
    await env.DB.batch([
      env.DB.prepare("UPDATE locker_v2_items SET pulls_left=CASE WHEN pulls_left IS NULL THEN NULL ELSE pulls_left+1 END WHERE item_id=? AND state='active' AND EXISTS(SELECT 1 FROM locker_v2_claims WHERE operation_id=? AND state='reserved')").bind(claim.item_id, id),
      env.DB.prepare("UPDATE locker_v2_claims SET state='cancelled' WHERE operation_id=? AND state='reserved'").bind(id)
    ]);
    claim = await claimById(env, id);
    if (claim.state !== "cancelled") return failure(409, "delivery_started");
    await cleanup(env, claim.item_id, now);
    return json(200, await claimResult(env, claim, b.token));
  }
  if (action === "ack") {
    if (claim.state !== "delivering") return failure(409, "delivery_not_started");
    await env.DB.prepare("UPDATE locker_v2_claims SET state='delivered' WHERE operation_id=? AND state='delivering'").bind(id).run();
    claim = await claimById(env, id);
    if (claim.state !== "delivered") return failure(410, "session_closed");
    await cleanup(env, claim.item_id, now);
    return json(200, await claimResult(env, claim, b.token));
  }
  if (action !== "content") return failure(404, "not_found");
  const started = await env.DB.prepare("UPDATE locker_v2_claims SET state='delivering',attempts=attempts+1 WHERE operation_id=? AND state IN ('reserved','delivering') AND recovery_until>? AND attempts<3 AND EXISTS(SELECT 1 FROM locker_v2_items WHERE item_id=locker_v2_claims.item_id AND state='active' AND cleanup_status='none') RETURNING *").bind(id, now).first();
  if (!started) return failure(410, "attempts_exhausted");
  const item = await itemById(env, claim.item_id);
  const object = await env.LOCKER_BUCKET.get(item.object_key);
  if (!object?.body) return failure(503, "storage_unavailable");
  if (object.size !== item.cipher_size || object.size > MAX_CIPHER) return failure(503, "size_mismatch");
  const headers = new Headers({ "content-type": "application/octet-stream", "content-length": String(object.size), "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-locker-operation-id": id });
  if (item.pulls_left != null) headers.set("x-locker-pulls-left", String(item.pulls_left));
  return new Response(object.body, { status: 200, headers });
}
async function migrateLegacy(env, slug, b, now) {
  if (!SLUG.test(slug) || typeof b.itemId !== "string" || !ID.test(b.itemId) || typeof b.version !== "string" || !ID.test(b.version) || typeof b.operationId !== "string" || !ID.test(b.operationId) || !validObjectKey(b.expectedObjectKey) || typeof b.expectedCipherSize !== "number" || !Number.isInteger(b.expectedCipherSize)) return failure(400, "invalid");
  const hash = await sha256Hex(enc2.encode(JSON.stringify({ slug, ...b })));
  const exists = await itemById(env, b.itemId);
  if (exists) return exists.register_operation_id === b.operationId && exists.register_hash === hash ? json(200, await metadata(env, exists, now)) : failure(409, "operation_conflict");
  const old = await env.DB.prepare("SELECT * FROM locker WHERE slug=?").bind(slug).first();
  if (!old || old.status !== "active") return failure(404, "legacy_missing");
  if (old.object_key !== b.expectedObjectKey || old.size !== b.expectedCipherSize) return failure(409, "source_mismatch");
  const object = await env.LOCKER_BUCKET.head(old.object_key);
  if (!object || object.size !== old.size) return failure(404, "missing_object");
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO locker_v2_items(item_id,version,register_operation_id,register_hash,object_key,code_hash,cipher_size,expire_at,max_pulls,pulls_left,created_at) SELECT ?,?,?,?,object_key,code_hash,size,expire_at,max_pulls,pulls_left,? FROM locker WHERE slug=? AND status='active'").bind(b.itemId, b.version, b.operationId, hash, now, slug),
      env.DB.prepare("UPDATE locker SET status='revoked' WHERE slug=? AND EXISTS(SELECT 1 FROM locker_v2_items WHERE item_id=? AND register_operation_id=? AND register_hash=?)").bind(slug, b.itemId, b.operationId, hash)
    ]);
  } catch {
    return failure(409, "operation_conflict");
  }
  const item = await itemById(env, b.itemId);
  if (!item || item.register_hash !== hash) return failure(409, "operation_conflict");
  return json(200, await metadata(env, item, now));
}
async function sweepV2(env, now = Date.now()) {
  if (!await schemaReady(env)) return;
  const candidates = await env.DB.prepare("SELECT item_id FROM locker_v2_items WHERE cleanup_status!='cleaned' AND (state='deleted' OR expire_at<=? OR pulls_left=0 OR EXISTS(SELECT 1 FROM locker_v2_claims WHERE item_id=locker_v2_items.item_id AND state IN ('reserved','delivering') AND recovery_until<=?)) LIMIT 100").bind(now, now).all();
  for (const { item_id } of candidates.results) {
    await expireReserved(env, item_id, now);
    await cleanup(env, item_id, now);
  }
  const legacy = await env.DB.prepare("SELECT slug,object_key FROM locker WHERE (expire_at<=? OR pulls_left=0) AND NOT EXISTS(SELECT 1 FROM locker_v2_items WHERE locker_v2_items.object_key=locker.object_key) LIMIT 40").bind(now).all();
  for (const row of legacy.results) {
    const marked = await env.DB.prepare("UPDATE locker SET status='revoked' WHERE slug=? AND (expire_at<=? OR pulls_left=0) AND NOT EXISTS(SELECT 1 FROM locker_v2_items WHERE locker_v2_items.object_key=locker.object_key)").bind(row.slug, now).run();
    if (!marked.meta.changes) continue;
    try {
      await env.LOCKER_BUCKET.delete(row.object_key);
      await env.DB.prepare("DELETE FROM locker WHERE slug=? AND status='revoked'").bind(row.slug).run();
    } catch {
    }
  }
  await env.DB.prepare("DELETE FROM locker_v2_nonces WHERE expires_at<=?").bind(now).run();
}
async function handleV2(request, env, _ctx, pageScript, now = Date.now()) {
  const path = new URL(request.url).pathname;
  try {
    if (request.method === "GET" && (path === "/" || path === "/v2/health")) return await health(env);
    if (path === "/register" || path.startsWith("/register/") || path.startsWith("/api/")) return failure(426, "protocol_upgrade_required");
    if (request.method === "GET" && path.startsWith("/d/")) return html(200, renderV2Page(path.slice(3), pageScript));
    if (path.startsWith("/v2/claims/")) {
      const m2 = /^\/v2\/claims\/([^/]+)\/(status|content|ack|cancel)$/.exec(path);
      if (!m2 || request.method !== "POST") return failure(404, "not_found");
      const b2 = await publicBody(request);
      return b2 instanceof Response ? b2 : await claimAction(env, m2[1], m2[2], b2, now);
    }
    if (path.startsWith("/v2/shares/")) {
      const m2 = /^\/v2\/shares\/([^/]+)\/(lookup|claims)$/.exec(path);
      if (!m2 || request.method !== "POST") return failure(404, "not_found");
      const b2 = await publicBody(request);
      if (b2 instanceof Response) return b2;
      const item2 = await verifyPublic(env, m2[1], b2.code, now, m2[2] === "claims" ? b2 : void 0);
      if (item2 instanceof Response) return item2;
      return m2[2] === "lookup" ? json(200, await metadata(env, item2, now)) : await reserve(env, item2, `share:${m2[1]}`, b2, now);
    }
    if (!path.startsWith("/v2/")) return failure(404, "not_found");
    const b = await ownerBody(request, env, now);
    if (b instanceof Response) return b;
    if (path === "/v2/probe" && request.method === "POST") {
      if (!validObjectKey(b.objectKey)) return failure(400, "invalid");
      if (!await schemaReady(env)) return failure(503, "schema_required");
      const object = await env.LOCKER_BUCKET.head(b.objectKey);
      if (!object) return failure(400, "missing_object");
      if (b.cipherSize != null && b.cipherSize !== object.size) return failure(400, "size_mismatch");
      return json(200, { ok: true, protocolVersion: 2, schemaVersion: 2, objectExists: true, cipherSize: object.size });
    }
    if (path.startsWith("/v2/migrate/") && request.method === "POST") return await migrateLegacy(env, path.slice(12), b, now);
    const m = /^\/v2\/items\/([^/]+)(?:\/(lookup|share|claims))?$/.exec(path);
    if (!m || !ID.test(m[1])) return failure(404, "not_found");
    const [, id, sub] = m;
    if (!sub && request.method === "PUT") return await registerItem(env, id, b, now);
    await expireReserved(env, id, now);
    const item = await itemById(env, id);
    if (!item) return failure(404, "not_found");
    if (!sub && request.method === "GET") return json(200, await metadata(env, item, now));
    if (!sub && request.method === "DELETE") return await deleteItem(env, item, b, now);
    if (sub === "lookup" && request.method === "POST") return available(item, now) ?? json(200, await metadata(env, item, now));
    if (sub === "share" && request.method === "POST") return await createShare(env, item, b, now);
    if (sub === "share" && request.method === "DELETE") return await stopShare(env, item, b);
    if (sub === "claims" && request.method === "POST") return await reserve(env, item, "owner", b, now);
    return failure(404, "not_found");
  } catch {
    return failure(503, "storage_unavailable");
  }
}

// src/page-script.ts
var PAGE_SCRIPT = '"use strict";(()=>{function kt(t){return t instanceof Uint8Array||ArrayBuffer.isView(t)&&t.constructor.name==="Uint8Array"}function dt(t){if(typeof t!="boolean")throw new Error(`boolean expected, not ${t}`)}function pt(t){if(!Number.isSafeInteger(t)||t<0)throw new Error("positive integer expected, got "+t)}function z(t,...e){if(!kt(t))throw new Error("Uint8Array expected");if(e.length>0&&!e.includes(t.length))throw new Error("Uint8Array expected of length "+e+", got length="+t.length)}function Lt(t,e=!0){if(t.destroyed)throw new Error("Hash instance has been destroyed");if(e&&t.finished)throw new Error("Hash#digest() has already been called")}function Tt(t,e){z(t);let r=e.outputLen;if(t.length<r)throw new Error("digestInto() expects output buffer of length at least "+r)}function Z(t){return new Uint32Array(t.buffer,t.byteOffset,Math.floor(t.byteLength/4))}function G(...t){for(let e=0;e<t.length;e++)t[e].fill(0)}function ie(t){return new DataView(t.buffer,t.byteOffset,t.byteLength)}var se=new Uint8Array(new Uint32Array([287454020]).buffer)[0]===68;function fe(t){if(typeof t!="string")throw new Error("string expected");return new Uint8Array(new TextEncoder().encode(t))}function yt(t){if(typeof t=="string")t=fe(t);else if(kt(t))t=gt(t);else throw new Error("Uint8Array expected, got "+typeof t);return t}function $t(t,e){if(e==null||typeof e!="object")throw new Error("options must be defined");return Object.assign(t,e)}function Rt(t,e){if(t.length!==e.length)return!1;let r=0;for(let n=0;n<t.length;n++)r|=t[n]^e[n];return r===0}var Ut=(t,e)=>{function r(n,...f){if(z(n),!se)throw new Error("Non little-endian hardware is not yet supported");if(t.nonceLength!==void 0){let l=f[0];if(!l)throw new Error("nonce / iv required");t.varSizeNonce?z(l):z(l,t.nonceLength)}let i=t.tagLength;i&&f[1]!==void 0&&z(f[1]);let o=e(n,...f),s=(l,u)=>{if(u!==void 0){if(l!==2)throw new Error("cipher output not supported");z(u)}},a=!1;return{encrypt(l,u){if(a)throw new Error("cannot encrypt() twice with same key + nonce");return a=!0,z(l),s(o.encrypt.length,u),o.encrypt(l,u)},decrypt(l,u){if(z(l),i&&l.length<i)throw new Error("invalid ciphertext length: smaller than tagLength="+i);return s(o.decrypt.length,u),o.decrypt(l,u)}}}return Object.assign(r,t),r};function _t(t,e,r=!0){if(e===void 0)return new Uint8Array(t);if(e.length!==t)throw new Error("invalid output length, expected "+t+", got: "+e.length);if(r&&!ae(e))throw new Error("invalid output, must be aligned");return e}function Ot(t,e,r,n){if(typeof t.setBigUint64=="function")return t.setBigUint64(e,r,n);let f=BigInt(32),i=BigInt(4294967295),o=Number(r>>f&i),s=Number(r&i),a=n?4:0,d=n?0:4;t.setUint32(e+a,o,n),t.setUint32(e+d,s,n)}function Ht(t,e,r){dt(r);let n=new Uint8Array(16),f=ie(n);return Ot(f,0,BigInt(e),r),Ot(f,8,BigInt(t),r),n}function ae(t){return t.byteOffset%4===0}function gt(t){return Uint8Array.from(t)}var qt=t=>Uint8Array.from(t.split("").map(e=>e.charCodeAt(0))),ce=qt("expand 16-byte k"),le=qt("expand 32-byte k"),ue=Z(ce),he=Z(le);function c(t,e){return t<<e|t>>>32-e}function Ct(t){return t.byteOffset%4===0}var xt=64,de=16,zt=2**32-1,Kt=new Uint32Array;function pe(t,e,r,n,f,i,o,s){let a=f.length,d=new Uint8Array(xt),l=Z(d),u=Ct(f)&&Ct(i),y=u?Z(f):Kt,m=u?Z(i):Kt;for(let g=0;g<a;o++){if(t(e,r,n,l,o,s),o>=zt)throw new Error("arx: counter overflow");let w=Math.min(xt,a-g);if(u&&w===xt){let x=g/4;if(g%4!==0)throw new Error("arx: invalid block position");for(let b=0,E;b<de;b++)E=x+b,m[E]=y[E]^l[b];g+=xt;continue}for(let x=0,b;x<w;x++)b=g+x,i[b]=f[b]^d[x];g+=w}}function vt(t,e){let{allowShortKeys:r,extendNonceFn:n,counterLength:f,counterRight:i,rounds:o}=$t({allowShortKeys:!1,counterLength:8,counterRight:!1,rounds:20},e);if(typeof t!="function")throw new Error("core must be a function");return pt(f),pt(o),dt(i),dt(r),(s,a,d,l,u=0)=>{z(s),z(a),z(d);let y=d.length;if(l===void 0&&(l=new Uint8Array(y)),z(l),pt(u),u<0||u>=zt)throw new Error("arx: counter overflow");if(l.length<y)throw new Error(`arx: output (${l.length}) is shorter than data (${y})`);let m=[],g=s.length,w,x;if(g===32)m.push(w=gt(s)),x=he;else if(g===16&&r)w=new Uint8Array(32),w.set(s),w.set(s,16),x=ue,m.push(w);else throw new Error(`arx: invalid 32-byte key, got length=${g}`);Ct(a)||m.push(a=gt(a));let b=Z(w);if(n){if(a.length!==24)throw new Error("arx: extended nonce must be 24 bytes");n(x,b,Z(a.subarray(0,16)),b),a=a.subarray(16)}let E=16-f;if(E!==a.length)throw new Error(`arx: nonce must be ${E} or 16 bytes`);if(E!==12){let $=new Uint8Array(12);$.set(a,i?0:12-a.length),a=$,m.push(a)}let k=Z(a);return pe(t,x,b,k,d,l,u,o),G(...m),l}}var R=(t,e)=>t[e++]&255|(t[e++]&255)<<8,St=class{constructor(e){this.blockLen=16,this.outputLen=16,this.buffer=new Uint8Array(16),this.r=new Uint16Array(10),this.h=new Uint16Array(10),this.pad=new Uint16Array(8),this.pos=0,this.finished=!1,e=yt(e),z(e,32);let r=R(e,0),n=R(e,2),f=R(e,4),i=R(e,6),o=R(e,8),s=R(e,10),a=R(e,12),d=R(e,14);this.r[0]=r&8191,this.r[1]=(r>>>13|n<<3)&8191,this.r[2]=(n>>>10|f<<6)&7939,this.r[3]=(f>>>7|i<<9)&8191,this.r[4]=(i>>>4|o<<12)&255,this.r[5]=o>>>1&8190,this.r[6]=(o>>>14|s<<2)&8191,this.r[7]=(s>>>11|a<<5)&8065,this.r[8]=(a>>>8|d<<8)&8191,this.r[9]=d>>>5&127;for(let l=0;l<8;l++)this.pad[l]=R(e,16+2*l)}process(e,r,n=!1){let f=n?0:2048,{h:i,r:o}=this,s=o[0],a=o[1],d=o[2],l=o[3],u=o[4],y=o[5],m=o[6],g=o[7],w=o[8],x=o[9],b=R(e,r+0),E=R(e,r+2),k=R(e,r+4),$=R(e,r+6),V=R(e,r+8),H=R(e,r+10),K=R(e,r+12),q=R(e,r+14),A=i[0]+(b&8191),L=i[1]+((b>>>13|E<<3)&8191),U=i[2]+((E>>>10|k<<6)&8191),_=i[3]+((k>>>7|$<<9)&8191),C=i[4]+(($>>>4|V<<12)&8191),v=i[5]+(V>>>1&8191),S=i[6]+((V>>>14|H<<2)&8191),B=i[7]+((H>>>11|K<<5)&8191),I=i[8]+((K>>>8|q<<8)&8191),N=i[9]+(q>>>5|f),p=0,O=p+A*s+L*(5*x)+U*(5*w)+_*(5*g)+C*(5*m);p=O>>>13,O&=8191,O+=v*(5*y)+S*(5*u)+B*(5*l)+I*(5*d)+N*(5*a),p+=O>>>13,O&=8191;let T=p+A*a+L*s+U*(5*x)+_*(5*w)+C*(5*g);p=T>>>13,T&=8191,T+=v*(5*m)+S*(5*y)+B*(5*u)+I*(5*l)+N*(5*d),p+=T>>>13,T&=8191;let M=p+A*d+L*a+U*s+_*(5*x)+C*(5*w);p=M>>>13,M&=8191,M+=v*(5*g)+S*(5*m)+B*(5*y)+I*(5*u)+N*(5*l),p+=M>>>13,M&=8191;let Y=p+A*l+L*d+U*a+_*s+C*(5*x);p=Y>>>13,Y&=8191,Y+=v*(5*w)+S*(5*g)+B*(5*m)+I*(5*y)+N*(5*u),p+=Y>>>13,Y&=8191;let rt=p+A*u+L*l+U*d+_*a+C*s;p=rt>>>13,rt&=8191,rt+=v*(5*x)+S*(5*w)+B*(5*g)+I*(5*m)+N*(5*y),p+=rt>>>13,rt&=8191;let ot=p+A*y+L*u+U*l+_*d+C*a;p=ot>>>13,ot&=8191,ot+=v*s+S*(5*x)+B*(5*w)+I*(5*g)+N*(5*m),p+=ot>>>13,ot&=8191;let it=p+A*m+L*y+U*u+_*l+C*d;p=it>>>13,it&=8191,it+=v*a+S*s+B*(5*x)+I*(5*w)+N*(5*g),p+=it>>>13,it&=8191;let st=p+A*g+L*m+U*y+_*u+C*l;p=st>>>13,st&=8191,st+=v*d+S*a+B*s+I*(5*x)+N*(5*w),p+=st>>>13,st&=8191;let ft=p+A*w+L*g+U*m+_*y+C*u;p=ft>>>13,ft&=8191,ft+=v*l+S*d+B*a+I*s+N*(5*x),p+=ft>>>13,ft&=8191;let at=p+A*x+L*w+U*g+_*m+C*y;p=at>>>13,at&=8191,at+=v*u+S*l+B*d+I*a+N*s,p+=at>>>13,at&=8191,p=(p<<2)+p|0,p=p+O|0,O=p&8191,p=p>>>13,T+=p,i[0]=O,i[1]=T,i[2]=M,i[3]=Y,i[4]=rt,i[5]=ot,i[6]=it,i[7]=st,i[8]=ft,i[9]=at}finalize(){let{h:e,pad:r}=this,n=new Uint16Array(10),f=e[1]>>>13;e[1]&=8191;for(let s=2;s<10;s++)e[s]+=f,f=e[s]>>>13,e[s]&=8191;e[0]+=f*5,f=e[0]>>>13,e[0]&=8191,e[1]+=f,f=e[1]>>>13,e[1]&=8191,e[2]+=f,n[0]=e[0]+5,f=n[0]>>>13,n[0]&=8191;for(let s=1;s<10;s++)n[s]=e[s]+f,f=n[s]>>>13,n[s]&=8191;n[9]-=8192;let i=(f^1)-1;for(let s=0;s<10;s++)n[s]&=i;i=~i;for(let s=0;s<10;s++)e[s]=e[s]&i|n[s];e[0]=(e[0]|e[1]<<13)&65535,e[1]=(e[1]>>>3|e[2]<<10)&65535,e[2]=(e[2]>>>6|e[3]<<7)&65535,e[3]=(e[3]>>>9|e[4]<<4)&65535,e[4]=(e[4]>>>12|e[5]<<1|e[6]<<14)&65535,e[5]=(e[6]>>>2|e[7]<<11)&65535,e[6]=(e[7]>>>5|e[8]<<8)&65535,e[7]=(e[8]>>>8|e[9]<<5)&65535;let o=e[0]+r[0];e[0]=o&65535;for(let s=1;s<8;s++)o=(e[s]+r[s]|0)+(o>>>16)|0,e[s]=o&65535;G(n)}update(e){Lt(this),e=yt(e),z(e);let{buffer:r,blockLen:n}=this,f=e.length;for(let i=0;i<f;){let o=Math.min(n-this.pos,f-i);if(o===n){for(;n<=f-i;i+=n)this.process(e,i);continue}r.set(e.subarray(i,i+o),this.pos),this.pos+=o,i+=o,this.pos===n&&(this.process(r,0,!1),this.pos=0)}return this}destroy(){G(this.h,this.r,this.buffer,this.pad)}digestInto(e){Lt(this),Tt(e,this),this.finished=!0;let{buffer:r,h:n}=this,{pos:f}=this;if(f){for(r[f++]=1;f<16;f++)r[f]=0;this.process(r,0,!0)}this.finalize();let i=0;for(let o=0;o<8;o++)e[i++]=n[o]>>>0,e[i++]=n[o]>>>8;return e}digest(){let{buffer:e,outputLen:r}=this;this.digestInto(e);let n=e.slice(0,r);return this.destroy(),n}};function ye(t){let e=(n,f)=>t(f).update(yt(n)).digest(),r=t(new Uint8Array(32));return e.outputLen=r.outputLen,e.blockLen=r.blockLen,e.create=n=>t(n),e}var Pt=ye(t=>new St(t));function Dt(t,e,r,n,f,i=20){let o=t[0],s=t[1],a=t[2],d=t[3],l=e[0],u=e[1],y=e[2],m=e[3],g=e[4],w=e[5],x=e[6],b=e[7],E=f,k=r[0],$=r[1],V=r[2],H=o,K=s,q=a,A=d,L=l,U=u,_=y,C=m,v=g,S=w,B=x,I=b,N=E,p=k,O=$,T=V;for(let Y=0;Y<i;Y+=2)H=H+L|0,N=c(N^H,16),v=v+N|0,L=c(L^v,12),H=H+L|0,N=c(N^H,8),v=v+N|0,L=c(L^v,7),K=K+U|0,p=c(p^K,16),S=S+p|0,U=c(U^S,12),K=K+U|0,p=c(p^K,8),S=S+p|0,U=c(U^S,7),q=q+_|0,O=c(O^q,16),B=B+O|0,_=c(_^B,12),q=q+_|0,O=c(O^q,8),B=B+O|0,_=c(_^B,7),A=A+C|0,T=c(T^A,16),I=I+T|0,C=c(C^I,12),A=A+C|0,T=c(T^A,8),I=I+T|0,C=c(C^I,7),H=H+U|0,T=c(T^H,16),B=B+T|0,U=c(U^B,12),H=H+U|0,T=c(T^H,8),B=B+T|0,U=c(U^B,7),K=K+_|0,N=c(N^K,16),I=I+N|0,_=c(_^I,12),K=K+_|0,N=c(N^K,8),I=I+N|0,_=c(_^I,7),q=q+C|0,p=c(p^q,16),v=v+p|0,C=c(C^v,12),q=q+C|0,p=c(p^q,8),v=v+p|0,C=c(C^v,7),A=A+L|0,O=c(O^A,16),S=S+O|0,L=c(L^S,12),A=A+L|0,O=c(O^A,8),S=S+O|0,L=c(L^S,7);let M=0;n[M++]=o+H|0,n[M++]=s+K|0,n[M++]=a+q|0,n[M++]=d+A|0,n[M++]=l+L|0,n[M++]=u+U|0,n[M++]=y+_|0,n[M++]=m+C|0,n[M++]=g+v|0,n[M++]=w+S|0,n[M++]=x+B|0,n[M++]=b+I|0,n[M++]=E+N|0,n[M++]=k+p|0,n[M++]=$+O|0,n[M++]=V+T|0}function ge(t,e,r,n){let f=t[0],i=t[1],o=t[2],s=t[3],a=e[0],d=e[1],l=e[2],u=e[3],y=e[4],m=e[5],g=e[6],w=e[7],x=r[0],b=r[1],E=r[2],k=r[3];for(let V=0;V<20;V+=2)f=f+a|0,x=c(x^f,16),y=y+x|0,a=c(a^y,12),f=f+a|0,x=c(x^f,8),y=y+x|0,a=c(a^y,7),i=i+d|0,b=c(b^i,16),m=m+b|0,d=c(d^m,12),i=i+d|0,b=c(b^i,8),m=m+b|0,d=c(d^m,7),o=o+l|0,E=c(E^o,16),g=g+E|0,l=c(l^g,12),o=o+l|0,E=c(E^o,8),g=g+E|0,l=c(l^g,7),s=s+u|0,k=c(k^s,16),w=w+k|0,u=c(u^w,12),s=s+u|0,k=c(k^s,8),w=w+k|0,u=c(u^w,7),f=f+d|0,k=c(k^f,16),g=g+k|0,d=c(d^g,12),f=f+d|0,k=c(k^f,8),g=g+k|0,d=c(d^g,7),i=i+l|0,x=c(x^i,16),w=w+x|0,l=c(l^w,12),i=i+l|0,x=c(x^i,8),w=w+x|0,l=c(l^w,7),o=o+u|0,b=c(b^o,16),y=y+b|0,u=c(u^y,12),o=o+u|0,b=c(b^o,8),y=y+b|0,u=c(u^y,7),s=s+a|0,E=c(E^s,16),m=m+E|0,a=c(a^m,12),s=s+a|0,E=c(E^s,8),m=m+E|0,a=c(a^m,7);let $=0;n[$++]=f,n[$++]=i,n[$++]=o,n[$++]=s,n[$++]=x,n[$++]=b,n[$++]=E,n[$++]=k}var xe=vt(Dt,{counterRight:!1,counterLength:4,allowShortKeys:!1}),we=vt(Dt,{counterRight:!1,counterLength:8,extendNonceFn:ge,allowShortKeys:!1});var me=new Uint8Array(16),jt=(t,e)=>{t.update(e);let r=e.length%16;r&&t.update(me.subarray(r))},be=new Uint8Array(32);function Xt(t,e,r,n,f){let i=t(e,r,be),o=Pt.create(i);f&&jt(o,f),jt(o,n);let s=Ht(n.length,f?f.length:0,!0);o.update(s);let a=o.digest();return G(i,s),a}var Ft=t=>(e,r,n)=>({encrypt(i,o){let s=i.length;o=_t(s+16,o,!1),o.set(i);let a=o.subarray(0,-16);t(e,r,a,a,1);let d=Xt(t,e,r,a,n);return o.set(d,s),G(d),o},decrypt(i,o){o=_t(i.length-16,o,!1);let s=i.subarray(0,-16),a=i.subarray(-16),d=Xt(t,e,r,s,n);if(!Rt(a,d))throw new Error("invalid tag");return o.set(i.subarray(0,-16)),t(e,r,o,o,1),G(d),o}}),qe=Ut({blockSize:64,nonceLength:12,tagLength:16},Ft(xe)),Vt=Ut({blockSize:64,nonceLength:24,tagLength:16},Ft(we));var Yt=new Uint8Array([71,75,66,49]),Zt=1,lt=9,D=24,wt=16,Gt=1,Wt=8*1024*1024;function Ae(t){if(t.length!==lt)throw new Error("header");for(let n=0;n<4;n++)if(t[n]!==Yt[n])throw new Error("magic");if(t[4]!==Zt)throw new Error("version");let e=Uint8Array.from(t),r=new DataView(e.buffer).getUint32(5,!0);if(r<Gt||r>Wt)throw new Error("chunk");return{chunkSize:r}}function Le(t){let e=new Uint8Array(8);return new DataView(e.buffer).setBigUint64(0,BigInt(t),!0),e}function Ue(t,e,r,n){try{return Vt(t,e,Le(n)).decrypt(r)}catch{throw new Error("auth")}}function _e(t){if(t.length!==32)throw new Error("key")}function Jt(t,e,r){if(_e(e),!Number.isSafeInteger(r)||r<0||r>104857600)throw new Error("size");if(t.length<lt||t.length>104923136)throw new Error("size");let{chunkSize:n}=Ae(t.subarray(0,lt)),f=D+n+wt,i=[],o=lt,s=0;for(;o<t.length;){let u=t.length-o;if(u<D+wt)throw new Error("truncated");let y=Math.min(u-D,n+wt);if(o+D+y<t.length&&D+y!==f)throw new Error("frame");let m=t.slice(o,o+D),g=t.slice(o+D,o+D+y);o+=D+y,i.push(Ue(e,m,g,s)),s+=1}let a=i.reduce((u,y)=>u+y.length,0);if(a!==r){for(let u of i)u.fill(0);throw new Error("truncated")}let d=new Uint8Array(a),l=0;for(let u of i)d.set(u,l),l+=u.length;return d}var Qt=new TextEncoder;function It(t){if(!/^[A-Za-z0-9_-]+$/.test(t))return null;try{let e=atob(t.replace(/-/g,"+").replace(/_/g,"/")+"=".repeat((4-t.length%4)%4));return Uint8Array.from(e,r=>r.charCodeAt(0))}catch{return null}}function Ce(t){let r=[...(t.split(/[/\\\\]/).pop()??"").replace(/[\\u0000-\\u001f]/g,"").replace(/^\\.+/,"")].slice(0,80).join("").trim();return!r||r==="."||r===".."?"download.bin":r}async function mt(t,e,r){let n=t.startsWith("#")?t.slice(1):t;if(n.length>2048||!/^[A-Za-z0-9]{10}$/.test(r))return null;let f=n.split(".");if(f.length!==5||f[0]!=="v2"||!/^(0|[1-9][0-9]{0,8})$/.test(f[2]))return null;let i=Number(f[2]);if(!Number.isSafeInteger(i)||i>104857600)return null;let o=It(f[1]);if(!o||o.length!==32)return o?.fill(0),null;let s=!1,a;try{let d=new URL(e);if(!["https:","http:"].includes(d.protocol)||d.username||d.password||d.search||d.hash)return null;let l=d.href.replace(/\\/+$/,""),u=It(f[4]),y=It(f[3]);if(!u||u.length!==32||!y)return null;let m=new TextDecoder("utf-8",{fatal:!0,ignoreBOM:!0}).decode(y),g=await crypto.subtle.importKey("raw",Uint8Array.from(o).buffer,{name:"HMAC",hash:"SHA-256"},!1,["sign"]);a=new Uint8Array(await crypto.subtle.sign("HMAC",g,Qt.encode("gam-locker-share-auth-key-v2")));let w=await crypto.subtle.importKey("raw",Uint8Array.from(a).buffer,{name:"HMAC",hash:"SHA-256"},!1,["verify"]),x=Qt.encode(`gam-locker-share-v2\n${l}\n${r}\n${i}\n${f[3]}`);return await crypto.subtle.verify("HMAC",w,Uint8Array.from(u).buffer,x)?(s=!0,{key:o,filename:Ce(m),plainSize:i}):null}catch{return null}finally{a?.fill(0),s||o.fill(0)}}var te=100*1024*1024+64*1024,ve=document.querySelector("#pick"),At=document.querySelector("#code"),j=document.querySelector("#error"),tt=document.querySelector("#status"),ee=document.querySelector("#go"),F=document.querySelector("#receive"),et=document.querySelector("#cancel"),ne=document.querySelector("#save-again"),ut=document.querySelector("#details"),nt=document.body.dataset.slug||"",Mt=location.origin+location.pathname.slice(0,location.pathname.lastIndexOf("/d/")),P=null,h=null,ht=!1,J="",re="download.bin",Nt=`locker.claim.v2.${nt}`;try{let t=JSON.parse(sessionStorage.getItem(Nt)||"null");t&&/^[A-Za-z0-9_-]{8,80}$/.test(t.operationId)&&typeof t.version=="string"&&(!t.token||/^[a-f0-9]{64}$/.test(t.token))&&(h=t)}catch{}function Q(){try{h?sessionStorage.setItem(Nt,JSON.stringify(h)):sessionStorage.removeItem(Nt)}catch{}}function ct(t){return{bad_code:"\\u53D6\\u4EF6\\u7801\\u4E0D\\u6B63\\u786E\\u3002",locked:"\\u5C1D\\u8BD5\\u8FC7\\u591A\\uFF0C\\u8BF7\\u7B49\\u5F85 15 \\u5206\\u949F\\u540E\\u518D\\u8BD5\\u3002",not_found:"\\u5206\\u4EAB\\u5165\\u53E3\\u4E0D\\u5B58\\u5728\\u6216\\u5DF2\\u505C\\u6B62\\uFF0C\\u8BF7\\u8054\\u7CFB\\u53D1\\u9001\\u65B9\\u3002",expired:"\\u6587\\u4EF6\\u5DF2\\u5230\\u671F\\uFF0C\\u4E0D\\u80FD\\u5F00\\u59CB\\u65B0\\u7684\\u9886\\u53D6\\u3002",no_allowance:"\\u6CA1\\u6709\\u53EF\\u7528\\u9886\\u53D6\\u540D\\u989D\\uFF0C\\u53EF\\u80FD\\u6B63\\u5728\\u88AB\\u5176\\u4ED6\\u4EBA\\u9886\\u53D6\\u3002",version_conflict:"\\u6587\\u4EF6\\u4FE1\\u606F\\u5DF2\\u53D8\\u5316\\uFF0C\\u8BF7\\u91CD\\u65B0\\u67E5\\u8BE2\\u3002",operation_conflict:"\\u9886\\u53D6\\u64CD\\u4F5C\\u4E0D\\u5339\\u914D\\uFF0C\\u4E0D\\u80FD\\u81EA\\u52A8\\u521B\\u5EFA\\u53E6\\u4E00\\u7B14\\u9886\\u53D6\\u3002",session_expired:"\\u672C\\u6B21\\u6062\\u590D\\u7A97\\u53E3\\u5DF2\\u7ED3\\u675F\\uFF0C\\u8BF7\\u8054\\u7CFB\\u53D1\\u9001\\u65B9\\u786E\\u8BA4\\u3002",attempts_exhausted:"\\u672C\\u6B21\\u9886\\u53D6\\u7684\\u6062\\u590D\\u6B21\\u6570\\u5DF2\\u7528\\u5B8C\\uFF0C\\u8BF7\\u8054\\u7CFB\\u53D1\\u9001\\u65B9\\u3002",protocol_upgrade_required:"\\u53D1\\u9001\\u65B9\\u9700\\u8981\\u5347\\u7EA7\\u53D6\\u4EF6\\u670D\\u52A1\\u540E\\u91CD\\u65B0\\u5206\\u4EAB\\u3002",storage_unavailable:"\\u8FDE\\u63A5\\u6682\\u65F6\\u5F02\\u5E38\\u3002\\u8BF7\\u7EE7\\u7EED\\u672C\\u6B21\\u64CD\\u4F5C\\uFF0C\\u4E0D\\u8981\\u65B0\\u5EFA\\u9886\\u53D6\\u3002",delivery_started:"\\u5185\\u5BB9\\u5DF2\\u7ECF\\u5F00\\u59CB\\u4EA4\\u4ED8\\uFF0C\\u4E0D\\u80FD\\u9000\\u56DE\\u9886\\u53D6\\u540D\\u989D\\u3002",invalid:"\\u8BF7\\u68C0\\u67E5\\u53D6\\u4EF6\\u7801\\u548C\\u5206\\u4EAB\\u94FE\\u63A5\\u3002",missing_fragment:"\\u94FE\\u63A5\\u7F3A\\u5C11\\u6216\\u672A\\u901A\\u8FC7\\u5B8C\\u6574\\u6027\\u9A8C\\u8BC1\\uFF0C\\u8BF7\\u53D1\\u9001\\u65B9\\u91CD\\u65B0\\u590D\\u5236\\u5206\\u4EAB\\u94FE\\u63A5\\uFF08\\u4FDD\\u7559 # \\u540E\\u7684\\u5B8C\\u6574\\u4FE1\\u606F\\uFF09\\u3002",decrypt_failed:"\\u5185\\u5BB9\\u672A\\u80FD\\u901A\\u8FC7\\u89E3\\u5BC6\\u6821\\u9A8C\\u3002\\u8BF7\\u6838\\u5BF9\\u5B8C\\u6574\\u94FE\\u63A5\\uFF0C\\u53EF\\u7EE7\\u7EED\\u672C\\u6B21\\u9886\\u53D6\\u3002"}[t]||"\\u64CD\\u4F5C\\u7ED3\\u679C\\u6682\\u65F6\\u65E0\\u6CD5\\u786E\\u8BA4\\uFF0C\\u8BF7\\u7EE7\\u7EED\\u672C\\u6B21\\u64CD\\u4F5C\\u3002"}async function W(t,e,r=!1){let n=await fetch(t,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(e),credentials:"omit",cache:"no-store",redirect:"error"});if(!n.ok){let f=await n.json().catch(()=>({}));throw new Error(f.error||"storage_unavailable")}return r?n:n.json()}async function Se(t){if(Number(t.headers.get("content-length"))>te||!t.body)throw new Error("size_mismatch");let r=t.body.getReader(),n=[],f=0;for(;;){let s=await r.read();if(s.done)break;if(f+=s.value.length,f>te)throw await r.cancel(),new Error("size_mismatch");n.push(s.value)}let i=new Uint8Array(f),o=0;for(let s of n)i.set(s,o),o+=s.length;return i}function bt(){return At.value.replace(/[\uFF10-\uFF19]/g,t=>String.fromCharCode(t.charCodeAt(0)-65248)).replace(/\\s/g,"")}function X(t){ht=t,ee.disabled=t||!!h,F.disabled=t,At.disabled=t||!!h?.token,et.disabled=t}function oe(){let t=document.createElement("a");t.href=J,t.download=re,t.click()}function Be(t){return t<1024?`${t} B`:t<1024*1024?`${(t/1024).toFixed(1)} KiB`:`${(t/1024/1024).toFixed(2)} MiB`}async function Et(){if(!h)return;ut.hidden=!1,F.textContent=h.state==="delivered"?"\\u786E\\u8BA4\\u9886\\u53D6\\u7ED3\\u679C":"\\u7EE7\\u7EED\\u672C\\u6B21\\u9886\\u53D6",et.hidden=![void 0,"reserved"].includes(h.state),ee.disabled=!0,At.disabled=!!h.token,F.disabled=ht||h.state==="expired"||h.state==="cancelled",h.state==="delivered"&&(F.hidden=!0);let t=await mt(location.hash,Mt,nt);t&&(document.querySelector("#file-name").textContent=t.filename,t.key.fill(0)),h.pullsLeft!==void 0&&(document.querySelector("#rules").textContent=`${h.state==="delivered"?"\\u672C\\u6B21\\u9886\\u53D6\\u5DF2\\u5B8C\\u6210":"\\u7EE7\\u7EED\\u672C\\u6B21\\u9886\\u53D6\\u4E0D\\u4F1A\\u518D\\u6263\\u540D\\u989D"} \\xB7 ${h.pullsLeft===null?"\\u4E0D\\u9650\\u6B21\\u9886\\u53D6":`\\u53EF\\u4F9B\\u65B0\\u9886\\u53D6 ${h.pullsLeft} \\u4E2A\\u540D\\u989D`}`),tt.textContent=h.state==="delivered"?"\\u5DF2\\u786E\\u8BA4\\u5185\\u5BB9\\u4EA4\\u4ED8\\u3002\\u6D4F\\u89C8\\u5668\\u4FDD\\u5B58\\u4F4D\\u7F6E\\u8BF7\\u5728\\u4E0B\\u8F7D\\u8BB0\\u5F55\\u4E2D\\u68C0\\u67E5\\u3002":"\\u5DF2\\u6709\\u9886\\u53D6\\u64CD\\u4F5C\\u3002\\u7EE7\\u7EED\\u4F1A\\u4F7F\\u7528\\u540C\\u4E00\\u540D\\u989D\\uFF0C\\u4E0D\\u4F1A\\u521B\\u5EFA\\u65B0\\u7684\\u9886\\u53D6\\u3002"}function Ie(){h=null,Q(),P=null,ut.hidden=!0,X(!1),et.hidden=!0}ve?.addEventListener("submit",async t=>{if(t.preventDefault(),ht||h)return;j.textContent="",X(!0);let e=await mt(location.hash,Mt,nt);if(!e){j.textContent=ct("missing_fragment"),X(!1);return}e.key.fill(0);let r=bt();if(!/^\\d{6}$/.test(r)){j.textContent="\\u8BF7\\u8F93\\u5165 6 \\u4F4D\\u6570\\u5B57\\u53D6\\u4EF6\\u7801\\u3002",X(!1);return}X(!0);try{P=await W(`/v2/shares/${nt}/lookup`,{code:r}),document.querySelector("#file-name").textContent=e.filename,document.querySelector("#rules").textContent=`${P.expireAt?`\\u622A\\u6B62 ${new Date(P.expireAt).toLocaleString()}`:"\\u672A\\u8BBE\\u622A\\u6B62\\u65F6\\u95F4"} \\xB7 ${P.pullsLeft==null?"\\u4E0D\\u9650\\u6B21\\u9886\\u53D6":`\\u5269\\u4F59 ${P.pullsLeft} \\u4E2A\\u540D\\u989D`} \\xB7 \\u5BC6\\u6587 ${Be(P.cipherSize)}`,ut.hidden=!1,tt.textContent="\\u53D6\\u4EF6\\u4FE1\\u606F\\u5DF2\\u9A8C\\u8BC1\\u3002"}catch(n){P=null,ut.hidden=!0,j.textContent=ct(n.message)}finally{X(!1),P?.pullsLeft===0&&(F.disabled=!0)}});At?.addEventListener("input",()=>{h||(P=null,ut.hidden=!0,j.textContent="",tt.textContent="")});F?.addEventListener("click",async()=>{if(ht||!P&&!h)return;X(!0);let t=await mt(location.hash,Mt,nt);if(!t){j.textContent=ct("missing_fragment"),X(!1);return}X(!0),j.textContent="";try{if(h||(h={operationId:crypto.randomUUID(),version:P.version},Q()),h.token)h=await W(`/v2/claims/${h.operationId}/status`,{token:h.token}),Q();else{if(!/^\\d{6}$/.test(bt()))throw new Error("invalid");h=await W(`/v2/shares/${nt}/claims`,{operationId:h.operationId,expectedVersion:h.version,code:bt()}),Q()}if(h.state==="delivered"){tt.textContent="\\u5DF2\\u786E\\u8BA4\\u5185\\u5BB9\\u4EA4\\u4ED8\\u3002\\u8BF7\\u5728\\u6D4F\\u89C8\\u5668\\u4E0B\\u8F7D\\u8BB0\\u5F55\\u4E2D\\u68C0\\u67E5\\u4FDD\\u5B58\\u7ED3\\u679C\\u3002";return}if(h.state==="cancelled"||h.state==="expired"){j.textContent=ct("session_expired"),F.disabled=!0;return}if(J){h=await W(`/v2/claims/${h.operationId}/ack`,{token:h.token}),Q(),F.hidden=!0,et.hidden=!0;return}tt.textContent="\\u6B63\\u5728\\u9886\\u53D6\\u5E76\\u89E3\\u5BC6\\u2026",h.state="delivering",Q();let e=await W(`/v2/claims/${h.operationId}/content`,{token:h.token},!0),r=await Se(e),n;try{n=Jt(r,t.key,t.plainSize)}catch{throw new Error("decrypt_failed")}J&&URL.revokeObjectURL(J);let f=new ArrayBuffer(n.byteLength);new Uint8Array(f).set(n),n.fill(0),J=URL.createObjectURL(new Blob([f],{type:"application/octet-stream"})),re=t.filename,oe(),ne.hidden=!1,tt.textContent="\\u89E3\\u5BC6\\u5B8C\\u6210\\uFF0C\\u5DF2\\u53D1\\u8D77\\u4FDD\\u5B58\\u3002\\u8BF7\\u5728\\u6D4F\\u89C8\\u5668\\u4E0B\\u8F7D\\u8BB0\\u5F55\\u4E2D\\u786E\\u8BA4\\u5B9E\\u9645\\u4FDD\\u5B58\\u7ED3\\u679C\\u3002",h=await W(`/v2/claims/${h.operationId}/ack`,{token:h.token}),Q(),F.hidden=!0,et.hidden=!0}catch(e){if(j.textContent=ct(e.message),h?.token)try{h=await W(`/v2/claims/${h.operationId}/status`,{token:h.token}),Q()}catch{}h?.state==="delivered"&&J&&(F.hidden=!0,et.hidden=!0,j.textContent=""),Et()}finally{t.key.fill(0),X(!1),h&&Et()}});et?.addEventListener("click",async()=>{if(!(ht||!h)){X(!0),j.textContent="";try{h.token||(h=await W(`/v2/shares/${nt}/claims`,{operationId:h.operationId,expectedVersion:h.version,code:bt()})),(await W(`/v2/claims/${h.operationId}/cancel`,{token:h.token})).state==="cancelled"&&(Ie(),tt.textContent="\\u9884\\u7559\\u5DF2\\u53D6\\u6D88\\uFF0C\\u672A\\u5F00\\u59CB\\u5185\\u5BB9\\u4EA4\\u4ED8\\u3002")}catch(t){j.textContent=ct(t.message)}finally{X(!1),h&&Et()}}});ne?.addEventListener("click",()=>{J&&oe()});window.addEventListener("pagehide",()=>{J&&URL.revokeObjectURL(J)});h&&Et();})();\n/*! Bundled license information:\n\n@noble/ciphers/esm/utils.js:\n  (*! noble-ciphers - MIT License (c) 2023 Paul Miller (paulmillr.com) *)\n*/\n';

// src/index.ts
var index_default = {
  async fetch(request, env, ctx) {
    return handleV2(request, env, ctx, PAGE_SCRIPT);
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(sweepV2(env, Date.now()));
  }
};
export {
  index_default as default
};
