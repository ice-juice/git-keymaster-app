// src/constants.ts
var SLUG_LEN = 10;
var MAX_CIPHER_BYTES = 100 * 1024 * 1024;
var MIN_CIPHER_BYTES = 9;
var MAX_PULLS = 4294967295;
var LOCK_STREAK = 5;
var REVOKE_FAILS = 20;
var LOCK_MS = 15 * 60 * 1e3;
var MAX_SKEW_SEC = 300;
var MIN_SECRET_LEN = 16;
var SWEEP_LIMIT = 40;
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
var unauthorized = () => json(401, { error: "unauthorized" });
var badCode = () => json(401, { error: "bad_code" });
var notFound = () => json(404, { error: "not_found" });
var expired = () => json(410, { error: "expired" });
var conflict = () => json(409, { error: "conflict" });
var invalid = () => json(400, { error: "invalid" });
var tooLarge = () => json(413, { error: "too_large" });
var misconfigured = () => json(500, { error: "misconfigured" });
var internal = () => json(500, { error: "internal" });
function locked(retryAfterSec) {
  const sec = Math.max(1, retryAfterSec);
  return json(423, { error: "locked", retryAfter: sec }, { "retry-after": String(sec) });
}

// src/page.ts
function esc(s) {
  return s.replace(/[&<>"'"'"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
function inlineScript(js) {
  return js.replace(/<\/script/gi, "<\\/script");
}
var STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: #f3f0e8;
  color: #1c1915;
  font: 16px/1.5 ui-sans-serif, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif;
}
main {
  width: min(420px, calc(100% - 32px));
  background: #fffdf8;
  border: 1px solid #e4dccb;
  border-radius: 16px;
  padding: 28px 24px 22px;
  box-shadow: 0 12px 40px rgba(60, 40, 10, 0.06);
}
h1 { font-size: 22px; font-weight: 650; margin: 0 0 8px; }
p { margin: 0; color: #5c564c; }
label { display: block; margin: 22px 0 8px; font-size: 14px; }
input {
  width: 100%;
  font: 600 28px/1 ui-monospace, "Cascadia Mono", Consolas, monospace;
  letter-spacing: 0.28em;
  padding: 12px 12px 12px 16px;
  border: 1px solid #d9d0c0;
  border-radius: 10px;
  background: #fff;
}
input:focus { outline: 2px solid #8a6a32; border-color: transparent; }
button {
  margin-top: 16px;
  width: 100%;
  border: 0;
  border-radius: 10px;
  padding: 12px 16px;
  background: #2c2416;
  color: #f7f1e4;
  font: 600 16px/1.2 inherit;
  cursor: pointer;
}
button:disabled { opacity: 0.55; cursor: default; }
#error { min-height: 1.5em; margin-top: 12px; color: #8a2e24; }
footer { margin-top: 18px; font-size: 13px; color: #6f685e; }
`;
function shell(title, body) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}
function renderMissing() {
  return shell("\u94FE\u63A5\u5DF2\u5931\u6548", "<h1>\u94FE\u63A5\u5DF2\u5931\u6548</h1><p>\u8FD9\u4EFD\u5206\u4EAB\u4E0D\u5B58\u5728\uFF0C\u6216\u5DF2\u7ECF\u9500\u6BC1\u3002</p>");
}
function renderExpired() {
  return shell("\u94FE\u63A5\u5DF2\u8FC7\u671F", "<h1>\u94FE\u63A5\u5DF2\u8FC7\u671F</h1><p>\u5230\u8FBE\u9500\u6BC1\u65F6\u95F4\u540E\uFF0C\u6587\u4EF6\u548C\u5206\u4EAB\u4E00\u8D77\u5220\u9664\u4E86\u3002</p>");
}
function renderPickup(slug, pageScript) {
  const script = pageScript ? `<script>${inlineScript(pageScript)}</script>` : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>\u53D6\u4EF6</title>
<style>${STYLE}</style>
</head>
<body data-slug="${esc(slug)}">
<main>
<h1>\u53D6\u4EF6</h1>
<p>\u8F93\u5165\u5BF9\u65B9\u544A\u8BC9\u4F60\u7684 6 \u4F4D\u53D6\u4EF6\u7801\u3002\u89E3\u5BC6\u5728\u8FD9\u53F0\u8BBE\u5907\u4E0A\u5B8C\u6210\u3002</p>
<form id="pick" action="#" method="post" onsubmit="return false">
<label for="code">\u53D6\u4EF6\u7801</label>
<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" placeholder="......" required>
<button id="go" type="submit">\u4E0B\u8F7D</button>
<p id="error" role="alert"></p>
</form>
<footer>\u89E3\u5BC6\u5BC6\u94A5\u53EA\u7559\u5728\u5730\u5740 # \u540E\u9762\uFF0C\u4E0D\u4F1A\u53D1\u7ED9\u670D\u52A1\u5668\u3002\u670D\u52A1\u5668\u53EA\u6838\u5BF9\u53D6\u4EF6\u7801\uFF0C\u4E0D\u4FDD\u5B58\u660E\u6587\u3002</footer>
</main>
<noscript><p>\u9700\u8981\u542F\u7528 JavaScript\u3002\u6587\u4EF6\u5728\u4F60\u7684\u6D4F\u89C8\u5668\u91CC\u89E3\u5BC6\uFF0C\u670D\u52A1\u5668\u89E3\u4E0D\u4E86\u3002</p></noscript>
${script}
</body>
</html>`;
}

// src/handle.ts
var SLUG_RE = /^[0-9A-Za-z]{10}$/;
var OBJECT_KEY_RE = /^[A-Za-z0-9._~/-]{1,1024}$/;
var EXPIRE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
var HASH_RE = /^[0-9a-f]{64}$/;
var SQL_LOAD = `SELECT slug, object_key, code_hash, size, expire_at, max_pulls, pulls_left,
  fail_count, fail_streak, locked_until, status FROM locker WHERE slug = ?`;
var SQL_INSERT = `INSERT INTO locker (
  slug, object_key, code_hash, size, expire_at, max_pulls, pulls_left,
  fail_count, fail_streak, locked_until, status
) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, 'active')`;
var SQL_CLEAR_LOCK = `UPDATE locker SET fail_streak = 0, locked_until = NULL
  WHERE slug = ? AND status = 'active' AND locked_until IS NOT NULL AND locked_until <= ?`;
var SQL_FAIL = `UPDATE locker SET
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
var SQL_PULL = `UPDATE locker SET
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
var SQL_SWEEP = `SELECT slug, object_key FROM locker
  WHERE (expire_at IS NOT NULL AND expire_at <= ?) OR pulls_left = 0
  ORDER BY expire_at IS NULL, expire_at
  LIMIT ${SWEEP_LIMIT}`;
var SQL_DELETE = `DELETE FROM locker WHERE slug = ?`;
var SQL_RESTORE = `UPDATE locker SET pulls_left = pulls_left + 1
  WHERE slug = ? AND status = 'active' AND pulls_left = ?`;
function defaultLog(event, fields) {
  console.log(JSON.stringify({ event, ...fields }));
}
async function handleRequest(request, env, ctx, options = {}) {
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
async function authedBody(request, env, now, maxBytes) {
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
    now
  );
  if (!ok) return unauthorized();
  return { body };
}
async function register(request, env, now, log) {
  const gate = await authedBody(request, env, now, 8192);
  if (gate instanceof Response) return gate;
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) return invalid();
  let parsed;
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
  let head;
  try {
    head = await env.LOCKER_BUCKET.head(input.objectKey);
  } catch {
    log("r2_error", { slug: input.slug });
    return internal();
  }
  if (!head) return json(400, { error: "missing_object" });
  if (head.size !== input.size) return json(400, { error: "size_mismatch" });
  try {
    await env.DB.prepare(SQL_INSERT).bind(input.slug, input.objectKey, input.codeHash, input.size, input.expireAt, input.maxPulls, input.pullsLeft).run();
  } catch {
    const again = await load(env, input.slug);
    if (again) return conflict();
    log("db_error", { slug: input.slug });
    return internal();
  }
  log("register", { slug: input.slug, size: input.size });
  return json(201, { ok: true });
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validObjectKey(key) {
  if (!OBJECT_KEY_RE.test(key)) return false;
  if (key.startsWith("/") || key.endsWith("/") || key.includes("//") || key.includes("..")) return false;
  return true;
}
function normalizeRegister(value, now) {
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
    pullsLeft
  };
}
function parseExpire(value, now) {
  if (value === null) return null;
  if (typeof value !== "string" || !EXPIRE_RE.test(value)) return "invalid";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms <= now || ms > now + MAX_EXPIRE_MS) return "invalid";
  return ms;
}
function parseMaxPulls(value) {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_PULLS) return "invalid";
  return value;
}
function parsePullsLeft(maxPulls, value) {
  if (maxPulls === null) {
    if (value === void 0 || value === null) return null;
    return "invalid";
  }
  const left = value === void 0 || value === null ? maxPulls : value;
  if (typeof left !== "number" || !Number.isInteger(left) || left < 1 || left > maxPulls) return "invalid";
  return left;
}
async function revoke(request, env, slug, now, log) {
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
async function downloadPage(env, slug, now, pageScript, log) {
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
async function pull(request, env, ctx, slug, now, log) {
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
  const updated = await env.DB.prepare(SQL_PULL).bind(slug, row.code_hash, now, now).first();
  if (!updated) {
    const again = await load(env, slug);
    const denied = await deny(env, again, now, log);
    if (denied) return denied;
    return conflict();
  }
  const pullsLeft = updated.pulls_left == null ? null : Number(updated.pulls_left);
  const objectKey = String(updated.object_key);
  let obj;
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
function parseCode(raw) {
  let parsed;
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
async function recordFailure(env, slug, now, log) {
  const lockUntil = now + LOCK_MS;
  const updated = await env.DB.prepare(SQL_FAIL).bind(lockUntil, slug, now).first();
  if (!updated || updated.status === "revoked") {
    log("revoked", { slug });
    return notFound();
  }
  const lockedUntil = updated.locked_until == null ? null : Number(updated.locked_until);
  if (lockedUntil !== null && lockedUntil > now) {
    log("locked", { slug, failCount: Number(updated.fail_count) });
    return locked(Math.ceil((lockedUntil - now) / 1e3));
  }
  log("bad_code", { slug, failCount: Number(updated.fail_count) });
  return badCode();
}
function streamCipher(body, size, pullsLeft, shouldBurn, env, ctx, slug, objectKey, log) {
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
  const { readable, writable } = new TransformStream();
  ctx.waitUntil(body.pipeTo(writable).then(burnOnce, () => burnOnce()));
  return new Response(readable, { status: 200, headers });
}
async function deny(env, row, now, log) {
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
    return locked(Math.ceil((row.locked_until - now) / 1e3));
  }
  return null;
}
async function load(env, slug) {
  const raw = await env.DB.prepare(SQL_LOAD).bind(slug).first();
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
    status: String(raw.status)
  };
}
async function burn(env, slug, objectKey, log) {
  try {
    await env.LOCKER_BUCKET.delete(objectKey);
  } catch {
    log("r2_delete_failed", { slug });
    return false;
  }
  await env.DB.prepare(SQL_DELETE).bind(slug).run();
  return true;
}
async function sweepExpired(env, now, log = defaultLog) {
  const listed = await env.DB.prepare(SQL_SWEEP).bind(now).all();
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

// src/page-script.ts
var PAGE_SCRIPT = '"use strict";(()=>{function ut(e){return e instanceof Uint8Array||ArrayBuffer.isView(e)&&e.constructor.name==="Uint8Array"}function Q(e){if(typeof e!="boolean")throw new Error(`boolean expected, not ${e}`)}function tt(e){if(!Number.isSafeInteger(e)||e<0)throw new Error("positive integer expected, got "+e)}function F(e,...t){if(!ut(e))throw new Error("Uint8Array expected");if(t.length>0&&!t.includes(e.length))throw new Error("Uint8Array expected of length "+t+", got length="+e.length)}function it(e,t=!0){if(e.destroyed)throw new Error("Hash instance has been destroyed");if(t&&e.finished)throw new Error("Hash#digest() has already been called")}function pt(e,t){F(e);let r=t.outputLen;if(e.length<r)throw new Error("digestInto() expects output buffer of length at least "+r)}function D(e){return new Uint32Array(e.buffer,e.byteOffset,Math.floor(e.byteLength/4))}function X(...e){for(let t=0;t<e.length;t++)e[t].fill(0)}function vt(e){return new DataView(e.buffer,e.byteOffset,e.byteLength)}var Rt=new Uint8Array(new Uint32Array([287454020]).buffer)[0]===68;function Ht(e){if(typeof e!="string")throw new Error("string expected");return new Uint8Array(new TextEncoder().encode(e))}function et(e){if(typeof e=="string")e=Ht(e);else if(ut(e))e=nt(e);else throw new Error("Uint8Array expected, got "+typeof e);return e}function xt(e,t){if(t==null||typeof t!="object")throw new Error("options must be defined");return Object.assign(e,t)}function dt(e,t){if(e.length!==t.length)return!1;let r=0;for(let o=0;o<e.length;o++)r|=e[o]^t[o];return r===0}var ft=(e,t)=>{function r(o,...s){if(F(o),!Rt)throw new Error("Non little-endian hardware is not yet supported");if(e.nonceLength!==void 0){let c=s[0];if(!c)throw new Error("nonce / iv required");e.varSizeNonce?F(c):F(c,e.nonceLength)}let n=e.tagLength;n&&s[1]!==void 0&&F(s[1]);let i=t(o,...s),f=(c,h)=>{if(h!==void 0){if(c!==2)throw new Error("cipher output not supported");F(h)}},l=!1;return{encrypt(c,h){if(l)throw new Error("cannot encrypt() twice with same key + nonce");return l=!0,F(c),f(i.encrypt.length,h),i.encrypt(c,h)},decrypt(c,h){if(F(c),n&&c.length<n)throw new Error("invalid ciphertext length: smaller than tagLength="+n);return f(i.decrypt.length,h),i.decrypt(c,h)}}}return Object.assign(r,e),r};function st(e,t,r=!0){if(t===void 0)return new Uint8Array(e);if(t.length!==e)throw new Error("invalid output length, expected "+e+", got: "+t.length);if(r&&!Kt(t))throw new Error("invalid output, must be aligned");return t}function ht(e,t,r,o){if(typeof e.setBigUint64=="function")return e.setBigUint64(t,r,o);let s=BigInt(32),n=BigInt(4294967295),i=Number(r>>s&n),f=Number(r&n),l=o?4:0,p=o?0:4;e.setUint32(t+l,i,o),e.setUint32(t+p,f,o)}function gt(e,t,r){Q(r);let o=new Uint8Array(16),s=vt(o);return ht(s,0,BigInt(t),r),ht(s,8,BigInt(e),r),o}function Kt(e){return e.byteOffset%4===0}function nt(e){return Uint8Array.from(e)}var wt=e=>Uint8Array.from(e.split("").map(t=>t.charCodeAt(0))),Pt=wt("expand 16-byte k"),zt=wt("expand 32-byte k"),Ft=D(Pt),$t=D(zt);function a(e,t){return e<<t|e>>>32-t}function ct(e){return e.byteOffset%4===0}var rt=64,jt=16,bt=2**32-1,yt=new Uint32Array;function kt(e,t,r,o,s,n,i,f){let l=s.length,p=new Uint8Array(rt),c=D(p),h=ct(s)&&ct(n),x=h?D(s):yt,w=h?D(n):yt;for(let d=0;d<l;i++){if(e(t,r,o,c,i,f),i>=bt)throw new Error("arx: counter overflow");let y=Math.min(rt,l-d);if(h&&y===rt){let g=d/4;if(d%4!==0)throw new Error("arx: invalid block position");for(let b=0,m;b<jt;b++)m=g+b,w[m]=x[m]^c[b];d+=rt;continue}for(let g=0,b;g<y;g++)b=d+g,n[b]=s[b]^p[g];d+=y}}function lt(e,t){let{allowShortKeys:r,extendNonceFn:o,counterLength:s,counterRight:n,rounds:i}=xt({allowShortKeys:!1,counterLength:8,counterRight:!1,rounds:20},t);if(typeof e!="function")throw new Error("core must be a function");return tt(s),tt(i),Q(n),Q(r),(f,l,p,c,h=0)=>{F(f),F(l),F(p);let x=p.length;if(c===void 0&&(c=new Uint8Array(x)),F(c),tt(h),h<0||h>=bt)throw new Error("arx: counter overflow");if(c.length<x)throw new Error(`arx: output (${c.length}) is shorter than data (${x})`);let w=[],d=f.length,y,g;if(d===32)w.push(y=nt(f)),g=$t;else if(d===16&&r)y=new Uint8Array(32),y.set(f),y.set(f,16),g=Ft,w.push(y);else throw new Error(`arx: invalid 32-byte key, got length=${d}`);ct(l)||w.push(l=nt(l));let b=D(y);if(o){if(l.length!==24)throw new Error("arx: extended nonce must be 24 bytes");o(g,b,D(l.subarray(0,16)),b),l=l.subarray(16)}let m=16-s;if(m!==l.length)throw new Error(`arx: nonce must be ${m} or 16 bytes`);if(m!==12){let R=new Uint8Array(12);R.set(l,n?0:12-l.length),l=R,w.push(l)}let E=D(l);return kt(e,g,b,E,p,c,h,i),X(...w),c}}var H=(e,t)=>e[t++]&255|(e[t++]&255)<<8,at=class{constructor(t){this.blockLen=16,this.outputLen=16,this.buffer=new Uint8Array(16),this.r=new Uint16Array(10),this.h=new Uint16Array(10),this.pad=new Uint16Array(8),this.pos=0,this.finished=!1,t=et(t),F(t,32);let r=H(t,0),o=H(t,2),s=H(t,4),n=H(t,6),i=H(t,8),f=H(t,10),l=H(t,12),p=H(t,14);this.r[0]=r&8191,this.r[1]=(r>>>13|o<<3)&8191,this.r[2]=(o>>>10|s<<6)&7939,this.r[3]=(s>>>7|n<<9)&8191,this.r[4]=(n>>>4|i<<12)&255,this.r[5]=i>>>1&8190,this.r[6]=(i>>>14|f<<2)&8191,this.r[7]=(f>>>11|l<<5)&8065,this.r[8]=(l>>>8|p<<8)&8191,this.r[9]=p>>>5&127;for(let c=0;c<8;c++)this.pad[c]=H(t,16+2*c)}process(t,r,o=!1){let s=o?0:2048,{h:n,r:i}=this,f=i[0],l=i[1],p=i[2],c=i[3],h=i[4],x=i[5],w=i[6],d=i[7],y=i[8],g=i[9],b=H(t,r+0),m=H(t,r+2),E=H(t,r+4),R=H(t,r+6),j=H(t,r+8),K=H(t,r+10),P=H(t,r+12),z=H(t,r+14),A=n[0]+(b&8191),U=n[1]+((b>>>13|m<<3)&8191),L=n[2]+((m>>>10|E<<6)&8191),_=n[3]+((E>>>7|R<<9)&8191),B=n[4]+((R>>>4|j<<12)&8191),N=n[5]+(j>>>1&8191),C=n[6]+((j>>>14|K<<2)&8191),S=n[7]+((K>>>11|P<<5)&8191),O=n[8]+((P>>>8|z<<8)&8191),I=n[9]+(z>>>5|s),u=0,M=u+A*f+U*(5*g)+L*(5*y)+_*(5*d)+B*(5*w);u=M>>>13,M&=8191,M+=N*(5*x)+C*(5*h)+S*(5*c)+O*(5*p)+I*(5*l),u+=M>>>13,M&=8191;let v=u+A*l+U*f+L*(5*g)+_*(5*y)+B*(5*d);u=v>>>13,v&=8191,v+=N*(5*w)+C*(5*x)+S*(5*h)+O*(5*c)+I*(5*p),u+=v>>>13,v&=8191;let T=u+A*p+U*l+L*f+_*(5*g)+B*(5*y);u=T>>>13,T&=8191,T+=N*(5*d)+C*(5*w)+S*(5*x)+O*(5*h)+I*(5*c),u+=T>>>13,T&=8191;let k=u+A*c+U*p+L*l+_*f+B*(5*g);u=k>>>13,k&=8191,k+=N*(5*y)+C*(5*d)+S*(5*w)+O*(5*x)+I*(5*h),u+=k>>>13,k&=8191;let V=u+A*h+U*c+L*p+_*l+B*f;u=V>>>13,V&=8191,V+=N*(5*g)+C*(5*y)+S*(5*d)+O*(5*w)+I*(5*x),u+=V>>>13,V&=8191;let Z=u+A*x+U*h+L*c+_*p+B*l;u=Z>>>13,Z&=8191,Z+=N*f+C*(5*g)+S*(5*y)+O*(5*d)+I*(5*w),u+=Z>>>13,Z&=8191;let q=u+A*w+U*x+L*h+_*c+B*p;u=q>>>13,q&=8191,q+=N*l+C*f+S*(5*g)+O*(5*y)+I*(5*d),u+=q>>>13,q&=8191;let Y=u+A*d+U*w+L*x+_*h+B*c;u=Y>>>13,Y&=8191,Y+=N*p+C*l+S*f+O*(5*g)+I*(5*y),u+=Y>>>13,Y&=8191;let G=u+A*y+U*d+L*w+_*x+B*h;u=G>>>13,G&=8191,G+=N*c+C*p+S*l+O*f+I*(5*g),u+=G>>>13,G&=8191;let W=u+A*g+U*y+L*d+_*w+B*x;u=W>>>13,W&=8191,W+=N*h+C*c+S*p+O*l+I*f,u+=W>>>13,W&=8191,u=(u<<2)+u|0,u=u+M|0,M=u&8191,u=u>>>13,v+=u,n[0]=M,n[1]=v,n[2]=T,n[3]=k,n[4]=V,n[5]=Z,n[6]=q,n[7]=Y,n[8]=G,n[9]=W}finalize(){let{h:t,pad:r}=this,o=new Uint16Array(10),s=t[1]>>>13;t[1]&=8191;for(let f=2;f<10;f++)t[f]+=s,s=t[f]>>>13,t[f]&=8191;t[0]+=s*5,s=t[0]>>>13,t[0]&=8191,t[1]+=s,s=t[1]>>>13,t[1]&=8191,t[2]+=s,o[0]=t[0]+5,s=o[0]>>>13,o[0]&=8191;for(let f=1;f<10;f++)o[f]=t[f]+s,s=o[f]>>>13,o[f]&=8191;o[9]-=8192;let n=(s^1)-1;for(let f=0;f<10;f++)o[f]&=n;n=~n;for(let f=0;f<10;f++)t[f]=t[f]&n|o[f];t[0]=(t[0]|t[1]<<13)&65535,t[1]=(t[1]>>>3|t[2]<<10)&65535,t[2]=(t[2]>>>6|t[3]<<7)&65535,t[3]=(t[3]>>>9|t[4]<<4)&65535,t[4]=(t[4]>>>12|t[5]<<1|t[6]<<14)&65535,t[5]=(t[6]>>>2|t[7]<<11)&65535,t[6]=(t[7]>>>5|t[8]<<8)&65535,t[7]=(t[8]>>>8|t[9]<<5)&65535;let i=t[0]+r[0];t[0]=i&65535;for(let f=1;f<8;f++)i=(t[f]+r[f]|0)+(i>>>16)|0,t[f]=i&65535;X(o)}update(t){it(this),t=et(t),F(t);let{buffer:r,blockLen:o}=this,s=t.length;for(let n=0;n<s;){let i=Math.min(o-this.pos,s-n);if(i===o){for(;o<=s-n;n+=o)this.process(t,n);continue}r.set(t.subarray(n,n+i),this.pos),this.pos+=i,n+=i,this.pos===o&&(this.process(r,0,!1),this.pos=0)}return this}destroy(){X(this.h,this.r,this.buffer,this.pad)}digestInto(t){it(this),pt(t,this),this.finished=!0;let{buffer:r,h:o}=this,{pos:s}=this;if(s){for(r[s++]=1;s<16;s++)r[s]=0;this.process(r,0,!0)}this.finalize();let n=0;for(let i=0;i<8;i++)t[n++]=o[i]>>>0,t[n++]=o[i]>>>8;return t}digest(){let{buffer:t,outputLen:r}=this;this.digestInto(t);let o=t.slice(0,r);return this.destroy(),o}};function Dt(e){let t=(o,s)=>e(s).update(et(o)).digest(),r=e(new Uint8Array(32));return t.outputLen=r.outputLen,t.blockLen=r.blockLen,t.create=o=>e(o),t}var mt=Dt(e=>new at(e));function Ut(e,t,r,o,s,n=20){let i=e[0],f=e[1],l=e[2],p=e[3],c=t[0],h=t[1],x=t[2],w=t[3],d=t[4],y=t[5],g=t[6],b=t[7],m=s,E=r[0],R=r[1],j=r[2],K=i,P=f,z=l,A=p,U=c,L=h,_=x,B=w,N=d,C=y,S=g,O=b,I=m,u=E,M=R,v=j;for(let k=0;k<n;k+=2)K=K+U|0,I=a(I^K,16),N=N+I|0,U=a(U^N,12),K=K+U|0,I=a(I^K,8),N=N+I|0,U=a(U^N,7),P=P+L|0,u=a(u^P,16),C=C+u|0,L=a(L^C,12),P=P+L|0,u=a(u^P,8),C=C+u|0,L=a(L^C,7),z=z+_|0,M=a(M^z,16),S=S+M|0,_=a(_^S,12),z=z+_|0,M=a(M^z,8),S=S+M|0,_=a(_^S,7),A=A+B|0,v=a(v^A,16),O=O+v|0,B=a(B^O,12),A=A+B|0,v=a(v^A,8),O=O+v|0,B=a(B^O,7),K=K+L|0,v=a(v^K,16),S=S+v|0,L=a(L^S,12),K=K+L|0,v=a(v^K,8),S=S+v|0,L=a(L^S,7),P=P+_|0,I=a(I^P,16),O=O+I|0,_=a(_^O,12),P=P+_|0,I=a(I^P,8),O=O+I|0,_=a(_^O,7),z=z+B|0,u=a(u^z,16),N=N+u|0,B=a(B^N,12),z=z+B|0,u=a(u^z,8),N=N+u|0,B=a(B^N,7),A=A+U|0,M=a(M^A,16),C=C+M|0,U=a(U^C,12),A=A+U|0,M=a(M^A,8),C=C+M|0,U=a(U^C,7);let T=0;o[T++]=i+K|0,o[T++]=f+P|0,o[T++]=l+z|0,o[T++]=p+A|0,o[T++]=c+U|0,o[T++]=h+L|0,o[T++]=x+_|0,o[T++]=w+B|0,o[T++]=d+N|0,o[T++]=y+C|0,o[T++]=g+S|0,o[T++]=b+O|0,o[T++]=m+I|0,o[T++]=E+u|0,o[T++]=R+M|0,o[T++]=j+v|0}function Xt(e,t,r,o){let s=e[0],n=e[1],i=e[2],f=e[3],l=t[0],p=t[1],c=t[2],h=t[3],x=t[4],w=t[5],d=t[6],y=t[7],g=r[0],b=r[1],m=r[2],E=r[3];for(let j=0;j<20;j+=2)s=s+l|0,g=a(g^s,16),x=x+g|0,l=a(l^x,12),s=s+l|0,g=a(g^s,8),x=x+g|0,l=a(l^x,7),n=n+p|0,b=a(b^n,16),w=w+b|0,p=a(p^w,12),n=n+p|0,b=a(b^n,8),w=w+b|0,p=a(p^w,7),i=i+c|0,m=a(m^i,16),d=d+m|0,c=a(c^d,12),i=i+c|0,m=a(m^i,8),d=d+m|0,c=a(c^d,7),f=f+h|0,E=a(E^f,16),y=y+E|0,h=a(h^y,12),f=f+h|0,E=a(E^f,8),y=y+E|0,h=a(h^y,7),s=s+p|0,E=a(E^s,16),d=d+E|0,p=a(p^d,12),s=s+p|0,E=a(E^s,8),d=d+E|0,p=a(p^d,7),n=n+c|0,g=a(g^n,16),y=y+g|0,c=a(c^y,12),n=n+c|0,g=a(g^n,8),y=y+g|0,c=a(c^y,7),i=i+h|0,b=a(b^i,16),x=x+b|0,h=a(h^x,12),i=i+h|0,b=a(b^i,8),x=x+b|0,h=a(h^x,7),f=f+l|0,m=a(m^f,16),w=w+m|0,l=a(l^w,12),f=f+l|0,m=a(m^f,8),w=w+m|0,l=a(l^w,7);let R=0;o[R++]=s,o[R++]=n,o[R++]=i,o[R++]=f,o[R++]=g,o[R++]=b,o[R++]=m,o[R++]=E}var Vt=lt(Ut,{counterRight:!1,counterLength:4,allowShortKeys:!1}),Zt=lt(Ut,{counterRight:!1,counterLength:8,extendNonceFn:Xt,allowShortKeys:!1});var qt=new Uint8Array(16),Et=(e,t)=>{e.update(t);let r=t.length%16;r&&e.update(qt.subarray(r))},Yt=new Uint8Array(32);function At(e,t,r,o,s){let n=e(t,r,Yt),i=mt.create(n);s&&Et(i,s),Et(i,o);let f=gt(o.length,s?s.length:0,!0);i.update(f);let l=i.digest();return X(n,f),l}var Lt=e=>(t,r,o)=>({encrypt(n,i){let f=n.length;i=st(f+16,i,!1),i.set(n);let l=i.subarray(0,-16);e(t,r,l,l,1);let p=At(e,t,r,l,o);return i.set(p,f),X(p),i},decrypt(n,i){i=st(n.length-16,i,!1);let f=n.subarray(0,-16),l=n.subarray(-16),p=At(e,t,r,f,o);if(!dt(l,p))throw new Error("invalid tag");return i.set(n.subarray(0,-16)),e(t,r,i,i,1),X(p),i}}),ge=ft({blockSize:64,nonceLength:12,tagLength:16},Lt(Vt)),_t=ft({blockSize:64,nonceLength:24,tagLength:16},Lt(Zt));var Bt=new Uint8Array([71,75,66,49]),Nt=1,J=9,$=24,ot=16,Ct=1,St=8*1024*1024;function Wt(e){if(e.length!==J)throw new Error("header");for(let o=0;o<4;o++)if(e[o]!==Bt[o])throw new Error("magic");if(e[4]!==Nt)throw new Error("version");let t=Uint8Array.from(e),r=new DataView(t.buffer).getUint32(5,!0);if(r<Ct||r>St)throw new Error("chunk");return{chunkSize:r}}function Jt(e){let t=new Uint8Array(8);return new DataView(t.buffer).setBigUint64(0,BigInt(e),!0),t}function Qt(e,t,r,o){try{return _t(e,t,Jt(o)).decrypt(r)}catch{throw new Error("auth")}}function te(e){if(e.length!==32)throw new Error("key")}function Ot(e,t){if(te(t),e.length<J||e.length>104857600)throw new Error("size");let{chunkSize:r}=Wt(e.subarray(0,J)),o=$+r+ot,s=[],n=J,i=0;for(;n<e.length;){let c=e.length-n;if(c<$+ot)throw new Error("truncated");let h=Math.min(c-$,r+ot);if(n+$+h<e.length&&$+h!==o)throw new Error("frame");let x=e.slice(n,n+$),w=e.slice(n+$,n+$+h);n+=$+h,s.push(Qt(t,x,w,i)),i+=1}let f=s.reduce((c,h)=>c+h.length,0),l=new Uint8Array(f),p=0;for(let c of s)l.set(c,p),p+=c.length;return l}function It(e){if(!/^[A-Za-z0-9_-]+$/.test(e))return null;let t=e.length%4===0?"":"=".repeat(4-e.length%4),r=e.replace(/-/g,"+").replace(/_/g,"/")+t,o;try{o=atob(r)}catch{return null}let s=new Uint8Array(o.length);for(let n=0;n<o.length;n++)s[n]=o.charCodeAt(n);return s}function ee(e){if(!/^[0-9a-fA-F]{64}$/.test(e))return null;let t=new Uint8Array(32);for(let r=0;r<32;r++)t[r]=Number.parseInt(e.slice(r*2,r*2+2),16);return t}function ne(e){if(/^[0-9a-fA-F]{64}$/.test(e))return ee(e);let t=It(e);return!t||t.length!==32?null:t}function re(e){let r=(e.split(/[/\\\\]/).pop()??"").replace(/[\\u0000-\\u001f]/g,"").replace(/^\\.+/,"").slice(0,80).trim();return!r||r==="."||r===".."?"download.bin":r}function Tt(e){let t=e.startsWith("#")?e.slice(1):e;if(!t||t.length>2048)return null;try{t=decodeURIComponent(t)}catch{return null}let r=t.indexOf("."),o=r===-1?t:t.slice(0,r),s=r===-1?"":t.slice(r+1),n=ne(o);if(!n)return null;if(!s)return{key:n,filename:"download.bin"};let i=It(s);if(!i)return{key:n,filename:"download.bin"};let f="";try{f=new TextDecoder("utf-8",{fatal:!0,ignoreBOM:!0}).decode(i)}catch{return{key:n,filename:"download.bin"}}return{key:n,filename:re(f)}}var Mt=100*1024*1024;function oe(e,t,r){return e==="bad_code"||t===401?"\\u53D6\\u4EF6\\u7801\\u4E0D\\u6B63\\u786E":e==="locked"||t===423?`\\u5C1D\\u8BD5\\u8FC7\\u591A\\uFF0C\\u8BF7\\u7EA6 ${r?Math.max(1,Math.ceil(r/60)):15} \\u5206\\u949F\\u540E\\u518D\\u8BD5`:e==="expired"||t===410?"\\u94FE\\u63A5\\u5DF2\\u8FC7\\u671F":e==="not_found"||t===404?"\\u94FE\\u63A5\\u4E0D\\u5B58\\u5728\\u6216\\u5DF2\\u5931\\u6548":t===400?"\\u8BF7\\u8F93\\u5165 6 \\u4F4D\\u6570\\u5B57\\u53D6\\u4EF6\\u7801":"\\u4E0B\\u8F7D\\u5931\\u8D25\\uFF0C\\u8BF7\\u7A0D\\u540E\\u518D\\u8BD5"}function ie(e,t){let r=new ArrayBuffer(e.byteLength);new Uint8Array(r).set(e);let o=new Blob([r],{type:"application/octet-stream"}),s=URL.createObjectURL(o),n=document.createElement("a");n.href=s,n.download=t,n.click(),URL.revokeObjectURL(s)}function fe(){let e=document.querySelector("#pick"),t=document.querySelector("#code"),r=document.querySelector("#error"),o=document.querySelector("#go");if(!e||!t||!r||!o)return;let s=e,n=t,i=r,f=o,l=document.body.dataset.slug??"";if(!/^[0-9A-Za-z]{10}$/.test(l))return;s.addEventListener("submit",c=>{c.preventDefault(),p()});async function p(){i.textContent="";let c=Tt(globalThis.location.hash);if(!c){i.textContent="\\u8FD9\\u6761\\u94FE\\u63A5\\u4E0D\\u5B8C\\u6574\\u3002\\u8BF7\\u8BA9\\u5BF9\\u65B9\\u91CD\\u65B0\\u590D\\u5236\\u5B8C\\u6574\\u94FE\\u63A5\\uFF08\\u4E95\\u53F7\\u540E\\u9762\\u7684\\u5185\\u5BB9\\u4E5F\\u8981\\u4FDD\\u7559\\uFF09\\u3002";return}let h=n.value.trim();if(!/^\\d{6}$/.test(h)){i.textContent="\\u8BF7\\u8F93\\u5165 6 \\u4F4D\\u6570\\u5B57\\u53D6\\u4EF6\\u7801";return}f.disabled=!0;try{let x=await fetch("/api/"+l,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({code:h}),cache:"no-store",credentials:"omit",redirect:"error"}),w=x.headers.get("content-type")??"";if(!x.ok||!w.includes("application/octet-stream")){let E=await x.json().catch(()=>null);i.textContent=oe(E?.error,x.status,E?.retryAfter),f.disabled=x.status===404||x.status===410;return}let d=Number(x.headers.get("content-length")??""),y=new Uint8Array(await x.arrayBuffer());if(Number.isFinite(d)&&d>Mt||y.byteLength>Mt)throw new Error("size");let g=Ot(y,c.key);ie(g,c.filename);let b=x.headers.get("x-locker-pulls-left");x.headers.get("x-locker-burned")==="1"||b==="0"?i.textContent="\\u6587\\u4EF6\\u5DF2\\u4E0B\\u8F7D\\uFF0C\\u94FE\\u63A5\\u5DF2\\u5931\\u6548\\u3002":b?i.textContent=`\\u4E0B\\u8F7D\\u5DF2\\u5F00\\u59CB\\uFF0C\\u8FD8\\u5269 ${b} \\u6B21\\u3002`:i.textContent="\\u4E0B\\u8F7D\\u5DF2\\u5F00\\u59CB\\u3002"}catch{i.textContent="\\u65E0\\u6CD5\\u89E3\\u5BC6\\u3002\\u8BF7\\u786E\\u8BA4\\u94FE\\u63A5\\u5B8C\\u6574\\u3002\\u82E5\\u8FD9\\u662F\\u4E00\\u6B21\\u6027\\u94FE\\u63A5\\uFF0C\\u6B21\\u6570\\u53EF\\u80FD\\u5DF2\\u7ECF\\u7528\\u6389\\u3002",f.disabled=!1}finally{c.key.fill(0)}}}fe();})();\n/*! Bundled license information:\n\n@noble/ciphers/esm/utils.js:\n  (*! noble-ciphers - MIT License (c) 2023 Paul Miller (paulmillr.com) *)\n*/\n';

// src/index.ts
var index_default = {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx, { pageScript: PAGE_SCRIPT });
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(sweepExpired(env, Date.now()));
  }
};
export {
  index_default as default
};
