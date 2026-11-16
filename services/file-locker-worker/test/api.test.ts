import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { hashPickupCode, signRequest } from "../src/auth.ts";
import { LOCK_MS } from "../src/constants.ts";
import { handleRequest, sweepExpired } from "../src/handle.ts";
import {
  CODE,
  CODE_HASH,
  NONCE,
  OBJECT_KEY,
  ORIGIN,
  SECRET,
  SLUG,
  logOf,
  makeFixture,
  registerBody,
  signedRequest,
} from "./helpers.ts";

const NOW = 1_800_000_000_000;

function putDefault(fx: ReturnType<typeof makeFixture>, size = 16): Uint8Array {
  const bytes = new Uint8Array(size).fill(9);
  fx.bucket.put(OBJECT_KEY, bytes);
  return bytes;
}

async function register(fx: ReturnType<typeof makeFixture>, now: number, extra: Record<string, unknown> = {}) {
  putDefault(fx);
  const body = await registerBody(now, extra);
  const req = await signedRequest(`${ORIGIN}/register`, "POST", body, now);
  const res = await handleRequest(req, fx.env, fx.ctx, { now, log: logOf(fx), rethrow: true });
  return { res, body };
}

test("pickup hash matches App pickup_code_hash and ignores the shared secret", async () => {
  const expected = createHmac("sha256", Buffer.from("gam-locker-code-v1")).update(CODE).digest("hex");
  assert.equal(expected, CODE_HASH);
  assert.equal(await hashPickupCode(CODE), expected);
  const viaSecret = createHmac("sha256", Buffer.from(SECRET)).update(CODE).digest("hex");
  assert.notEqual(expected, viaSecret);
});

test("signature canonical matches node:crypto and contains the nonce", async () => {
  const body = new TextEncoder().encode('{"slug":"abc"}');
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const canonical = ["1700000000", NONCE, "POST", "/register", bodyHash].join("\n");
  assert.equal(canonical.split("\n").length, 5);
  assert.equal(canonical.startsWith("locker-auth-v1"), false);
  const expected = createHmac("sha256", Buffer.from(SECRET)).update(canonical).digest("hex");
  assert.equal(await signRequest(SECRET, "1700000000", NONCE, "POST", "/register", body), expected);
});

test("register rejects a bad signature and does not insert a row", async () => {
  const fx = makeFixture();
  putDefault(fx);
  const body = await registerBody(NOW);
  const req = await signedRequest(`${ORIGIN}/register`, "POST", body, NOW, "wrong-secret-value!!");
  const res = await handleRequest(req, fx.env, fx.ctx, { now: NOW, log: logOf(fx), rethrow: true });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "unauthorized");
  const row = fx.db.prepare("SELECT COUNT(*) AS n FROM locker").get() as { n: number };
  assert.equal(Number(row.n), 0);
  assert.equal(JSON.stringify(fx.logs).includes(CODE), false);
  assert.equal(JSON.stringify(fx.logs).includes("UNIQUE_BODY_MARKER"), false);
});

test("missing nonce or a stale timestamp is unauthorized", async () => {
  const fx = makeFixture();
  putDefault(fx);
  const body = await registerBody(NOW);
  const req = await signedRequest(`${ORIGIN}/register`, "POST", body, NOW);
  req.headers.delete("x-locker-nonce");
  const res = await handleRequest(req, fx.env, fx.ctx, { now: NOW, log: logOf(fx), rethrow: true });
  assert.equal(res.status, 401);

  const late = NOW + 301_000;
  const stale = await signedRequest(`${ORIGIN}/register`, "POST", body, NOW);
  const res2 = await handleRequest(stale, fx.env, fx.ctx, { now: late, log: logOf(fx), rethrow: true });
  assert.equal(res2.status, 401);
  const row = fx.db.prepare("SELECT COUNT(*) AS n FROM locker").get() as { n: number };
  assert.equal(Number(row.n), 0);
});

test("register uses snake_case and returns 409 when the slug exists", async () => {
  const fx = makeFixture();
  const first = await register(fx, NOW);
  assert.equal(first.res.status, 201);
  assert.equal(first.body.includes("object_key"), true);
  assert.equal(first.body.includes("objectKey"), false);

  const camel = JSON.stringify({
    slug: "bB3dE6gH9k",
    objectKey: OBJECT_KEY,
    codeHash: CODE_HASH,
    size: 16,
    expireAt: new Date(NOW + 86_400_000).toISOString(),
    maxPulls: 1,
    pullsLeft: 1,
  });
  const bad = await signedRequest(`${ORIGIN}/register`, "POST", camel, NOW);
  const rejected = await handleRequest(bad, fx.env, fx.ctx, { now: NOW, log: logOf(fx), rethrow: true });
  assert.equal(rejected.status, 400);

  const again = await signedRequest(`${ORIGIN}/register`, "POST", first.body, NOW);
  const conflict = await handleRequest(again, fx.env, fx.ctx, { now: NOW, log: logOf(fx), rethrow: true });
  assert.equal(conflict.status, 409);
});

test("twenty bad pickup codes revoke the share and keep the object", async () => {
  const fx = makeFixture();
  const created = await register(fx, NOW, { max_pulls: 3, pulls_left: 3 });
  assert.equal(created.res.status, 201);
  let now = NOW;
  for (let n = 1; n <= 20; n++) {
    const req = new Request(`${ORIGIN}/api/${SLUG}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "000000", ck: "CKMARKER123" }),
    });
    const res = await handleRequest(req, fx.env, fx.ctx, { now, log: logOf(fx), rethrow: true });
    if (n === 20) {
      assert.equal(res.status, 404);
    } else if (n % 5 === 0) {
      assert.equal(res.status, 423);
      const correct = new Request(`${ORIGIN}/api/${SLUG}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: CODE }),
      });
      const locked = await handleRequest(correct, fx.env, fx.ctx, { now, log: logOf(fx), rethrow: true });
      assert.equal(locked.status, 423);
      now += LOCK_MS + 1;
    } else {
      assert.equal(res.status, 401);
      assert.equal((await res.json()).error, "bad_code");
    }
  }
  const row = fx.db.prepare("SELECT status, pulls_left, fail_count FROM locker WHERE slug = ?").get(SLUG) as {
    status: string;
    pulls_left: number;
    fail_count: number;
  };
  assert.equal(row.status, "revoked");
  assert.equal(Number(row.fail_count), 20);
  assert.equal(Number(row.pulls_left), 3);
  assert.equal(fx.bucket.objects.has(OBJECT_KEY), true);
  const page = await handleRequest(new Request(`${ORIGIN}/d/${SLUG}`), fx.env, fx.ctx, { now, rethrow: true });
  assert.equal(page.status, 404);
  const swept = await sweepExpired(fx.env, now, logOf(fx));
  assert.equal(swept.removed, 0);
  assert.equal(fx.bucket.objects.has(OBJECT_KEY), true);
  const dumped = JSON.stringify(fx.logs);
  assert.equal(dumped.includes("000000"), false);
  assert.equal(dumped.includes(CODE), false);
  assert.equal(dumped.includes("CKMARKER123"), false);
});

test("the last pull deletes the R2 object and the row", async () => {
  const fx = makeFixture();
  const created = await register(fx, NOW);
  assert.equal(created.res.status, 201);
  const cipher = fx.bucket.objects.get(OBJECT_KEY)!;
  const res = await handleRequest(
    new Request(`${ORIGIN}/api/${SLUG}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: CODE }),
    }),
    fx.env,
    fx.ctx,
    { now: NOW, log: logOf(fx), rethrow: true },
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-locker-pulls-left"), "0");
  assert.equal(res.headers.get("x-locker-burned"), "1");
  const got = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual(got, cipher);
  await fx.ctx.flush();
  assert.equal(fx.bucket.objects.has(OBJECT_KEY), false);
  const row = fx.db.prepare("SELECT COUNT(*) AS n FROM locker").get() as { n: number };
  assert.equal(Number(row.n), 0);
  const again = await handleRequest(
    new Request(`${ORIGIN}/api/${SLUG}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: CODE }),
    }),
    fx.env,
    fx.ctx,
    { now: NOW, rethrow: true },
  );
  assert.equal(again.status, 404);
});

test("an expired share is rejected and burned", async () => {
  const fx = makeFixture();
  const expireAt = new Date(NOW + 10_000).toISOString();
  const created = await register(fx, NOW, { expire_at: expireAt, max_pulls: 2, pulls_left: 2 });
  assert.equal(created.res.status, 201);
  const res = await handleRequest(
    new Request(`${ORIGIN}/api/${SLUG}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: CODE }),
    }),
    fx.env,
    fx.ctx,
    { now: NOW + 10_000, log: logOf(fx), rethrow: true },
  );
  assert.equal(res.status, 410);
  assert.equal((await res.json()).error, "expired");
  assert.equal(fx.bucket.objects.has(OBJECT_KEY), false);
  const row = fx.db.prepare("SELECT COUNT(*) AS n FROM locker").get() as { n: number };
  assert.equal(Number(row.n), 0);
});

test("cron deletes expired rows and pulls_left = 0, and keeps a live share", async () => {
  const fx = makeFixture();
  putDefault(fx);
  const liveKey = "sync-prefix/locker/" + "cd".repeat(32);
  fx.bucket.put(liveKey, new Uint8Array(16).fill(3));
  const soon = await registerBody(NOW, { expire_at: new Date(NOW + 1_000).toISOString() });
  const live = await registerBody(NOW, {
    slug: "bB3dE6gH9k",
    object_key: liveKey,
    expire_at: new Date(NOW + 86_400_000).toISOString(),
  });
  assert.equal((await handleRequest(await signedRequest(`${ORIGIN}/register`, "POST", soon, NOW), fx.env, fx.ctx, { now: NOW, rethrow: true })).status, 201);
  assert.equal((await handleRequest(await signedRequest(`${ORIGIN}/register`, "POST", live, NOW), fx.env, fx.ctx, { now: NOW, rethrow: true })).status, 201);
  fx.db.prepare("UPDATE locker SET pulls_left = 0 WHERE slug = ?").run("bB3dE6gH9k");
  const swept = await sweepExpired(fx.env, NOW + 2_000, logOf(fx));
  assert.equal(swept.removed, 2);
  assert.equal(fx.bucket.objects.has(OBJECT_KEY), false);
  assert.equal(fx.bucket.objects.has(liveKey), false);
});

test("delete revoke requires the same HMAC and removes the object", async () => {
  const fx = makeFixture();
  assert.equal((await register(fx, NOW)).res.status, 201);
  const bad = await signedRequest(`${ORIGIN}/register/${SLUG}`, "DELETE", "", NOW, "wrong-secret-value!!");
  const denied = await handleRequest(bad, fx.env, fx.ctx, { now: NOW, rethrow: true });
  assert.equal(denied.status, 401);
  assert.equal(fx.bucket.objects.has(OBJECT_KEY), true);
  const ok = await signedRequest(`${ORIGIN}/register/${SLUG}`, "DELETE", "", NOW);
  const res = await handleRequest(ok, fx.env, fx.ctx, { now: NOW, log: logOf(fx), rethrow: true });
  assert.equal(res.status, 200);
  assert.equal(fx.bucket.objects.has(OBJECT_KEY), false);
  const again = await signedRequest(`${ORIGIN}/register/${SLUG}`, "DELETE", "", NOW);
  const res2 = await handleRequest(again, fx.env, fx.ctx, { now: NOW, rethrow: true });
  assert.equal(res2.status, 200);
});