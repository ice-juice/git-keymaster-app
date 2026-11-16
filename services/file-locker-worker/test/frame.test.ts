import assert from "node:assert/strict";
import test from "node:test";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { decryptBlob, decryptBlobStream } from "../src/frame.ts";
import { parseFragment } from "../src/fragment.ts";

function encodeFrame(key: Uint8Array, plain: Uint8Array, chunkSize: number): Uint8Array {
  const frames: Uint8Array[] = [];
  if (plain.length > 0) {
    for (let off = 0, index = 0; off < plain.length; index++) {
      const part = plain.slice(off, Math.min(plain.length, off + chunkSize));
      off += part.length;
      const nonce = new Uint8Array(24).fill(index + 1);
      const aad = new Uint8Array(8);
      new DataView(aad.buffer).setBigUint64(0, BigInt(index), true);
      const ct = xchacha20poly1305(key, nonce, aad).encrypt(part);
      const frame = new Uint8Array(nonce.length + ct.length);
      frame.set(nonce, 0);
      frame.set(ct, nonce.length);
      frames.push(frame);
    }
  }
  const header = new Uint8Array(9);
  header.set([0x47, 0x4b, 0x42, 0x31, 1]);
  new DataView(header.buffer).setUint32(5, chunkSize, true);
  const total = 9 + frames.reduce((n, f) => n + f.length, 0);
  const out = new Uint8Array(total);
  out.set(header, 0);
  let pos = 9;
  for (const frame of frames) {
    out.set(frame, pos);
    pos += frame.length;
  }
  return out;
}

test("GKB1 frame roundtrip matches vault blob layout", () => {
  const key = new Uint8Array(32).fill(7);
  const plain = new TextEncoder().encode("hello file vault across two chunks!!");
  const raw = encodeFrame(key, plain, 16);
  assert.equal(String.fromCharCode(...raw.slice(0, 4)), "GKB1");
  assert.deepEqual(decryptBlob(raw, key, plain.length), plain);
});

test("empty plaintext is a header only", () => {
  const key = new Uint8Array(32).fill(3);
  const raw = encodeFrame(key, new Uint8Array(), 16);
  assert.equal(raw.length, 9);
  assert.equal(decryptBlob(raw, key, 0).length, 0);
});

test("tamper and swapped chunks are rejected", () => {
  const key = new Uint8Array(32).fill(4);
  const plain = new Uint8Array(8).fill(1);
  const raw = encodeFrame(key, plain, 4);
  const flipped = raw.slice();
  flipped[flipped.length - 1] ^= 0x5a;
  assert.throws(() => decryptBlob(flipped, key, plain.length));
  const chunk = 24 + 4 + 16;
  const swapped = raw.slice();
  const a = swapped.slice(9, 9 + chunk);
  const b = swapped.slice(9 + chunk, 9 + 2 * chunk);
  swapped.set(b, 9);
  swapped.set(a, 9 + chunk);
  assert.throws(() => decryptBlob(swapped, key, plain.length));
});

test("stream decrypt accepts split reads", async () => {
  const key = new Uint8Array(32).fill(5);
  const plain = new TextEncoder().encode("stream-me-please");
  const raw = encodeFrame(key, plain, 8);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(raw.slice(0, 3));
      controller.enqueue(raw.slice(3, 11));
      controller.enqueue(raw.slice(11));
      controller.close();
    },
  });
  const parts: Uint8Array[] = [];
  await decryptBlobStream(stream, raw.length, key, (part) => parts.push(part), plain.length);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.length;
  }
  assert.deepEqual(out, plain);
});

test("authenticated fragment agrees with the Rust fixed vector", async () => {
  const vector = "v2.CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk.8.dHJpcC5qcGc.s7Ue520jW4iJJyFDcD3MXf76XCiLj_vO9wfduVU_X_Q";
  const base = "https://locker.example.com", slug = "aB3dE6gH9k";
  const parsed = await parseFragment("#" + vector, base, slug);
  assert.ok(parsed);
  assert.deepEqual(parsed.key, new Uint8Array(32).fill(9));
  assert.equal(parsed.filename, "trip.jpg");
  assert.equal(parsed.plainSize, 8);
  assert.equal(await parseFragment(vector.replace(".8.", ".4."), base, slug), null);
  assert.equal(await parseFragment(vector.replace("dHJpcC5qcGc", "bmV3LnR4dA"), base, slug), null);
  assert.equal(await parseFragment(vector, "https://other.example.com", slug), null);
  assert.equal(await parseFragment(vector, base, "0123456789"), null);
  assert.equal(await parseFragment(vector.split(".")[1], base, slug), null, "legacy fragment must fail closed");
});

test("whole-chunk and header-only truncation cannot pass whole-file integrity", async () => {
  const key = new Uint8Array(32).fill(9);
  const raw = encodeFrame(key, new TextEncoder().encode("ABCDEFGH"), 4);
  for (const truncated of [raw.slice(0, 9 + 24 + 4 + 16), raw.slice(0, 9)]) {
    assert.throws(() => decryptBlob(truncated, key, 8), /truncated/);
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(truncated); c.close(); } });
    await assert.rejects(() => decryptBlobStream(stream, truncated.length, key, () => {}, 8), /truncated/);
  }
  assert.deepEqual(new TextDecoder().decode(decryptBlob(raw, key, 8)), "ABCDEFGH");
});
