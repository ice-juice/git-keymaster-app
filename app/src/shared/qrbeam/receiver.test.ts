import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { appendFileHeaderMetaToBuffer, createEncoder } from "luby-transform";
import { QRBEAM_PREFIX, blockToFrame } from "./protocol.ts";
import { createQrBeamReceiver, type QrBeamFeedResult } from "./receiver.ts";
import { createQrBeamSender, takeQrBeamFrames } from "./sender.ts";

function payload(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function shuffle<T>(items: T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

function feedAll(frames: string[]): QrBeamFeedResult {
  const receiver = createQrBeamReceiver();
  let last: QrBeamFeedResult = { status: "ignored" };
  for (const frame of frames) {
    last = receiver.feed(frame);
    if (last.status === "complete") return last;
  }
  return last;
}

function completeOf(data: Uint8Array, filename: string, contentType: string, frames: string[]) {
  const last = feedAll(frames);
  assert.equal(last.status, "complete", `expected complete, got ${JSON.stringify(last)}`);
  if (last.status !== "complete") throw new Error("unreachable");
  assert.ok(bytesEq(last.file.data, data));
  assert.equal(last.file.filename, filename);
  assert.equal(last.file.contentType, contentType);
  return last;
}

describe("qrbeam receiver", () => {
  test("旧喷泉码的 GKB1 帧仍能重组，不因度数高被丢掉", () => {
    const data = payload("legacy-fountain-" + "q".repeat(300));
    const merged = appendFileHeaderMetaToBuffer(data, {
      filename: encodeURIComponent("legacy.txt"),
      contentType: "text/plain",
    });
    const encoder = createEncoder(merged, 48, false);
    const frames: string[] = [];
    let n = 0;
    for (const block of encoder.fountain()) {
      const frame = blockToFrame(block);
      assert.ok(frame.startsWith(QRBEAM_PREFIX));
      frames.push(frame);
      n += 1;
      if (n >= encoder.k * 8) break;
    }
    const last = feedAll(frames);
    assert.equal(last.status, "complete");
    if (last.status !== "complete") throw new Error("unreachable");
    assert.equal(last.file.filename, "legacy.txt");
    assert.ok(bytesEq(last.file.data, data));
  });

  test("往返：编码后重组还原数据与 meta", () => {
    const data = payload("御钥师 air-gap 往返测试 " + "x".repeat(800));
    const sender = createQrBeamSender(data, {
      filename: "note.txt",
      contentType: "text/plain",
      blockSize: 80,
    });
    const frames = takeQrBeamFrames(sender, sender.k * 6);
    completeOf(data, "note.txt", "text/plain", frames);
  });

  test("乱序帧仍能重组", () => {
    const data = payload("out-of-order payload " + "y".repeat(400));
    const sender = createQrBeamSender(data, {
      filename: "oo.txt",
      contentType: "text/plain",
      blockSize: 64,
    });
    const frames = shuffle(takeQrBeamFrames(sender, sender.k * 8));
    completeOf(data, "oo.txt", "text/plain", frames);
  });

  test("丢掉约 1/3 帧仍能重组", () => {
    const data = payload("drop-third " + "z".repeat(600));
    const sender = createQrBeamSender(data, {
      filename: "drop.bin",
      contentType: "application/octet-stream",
      blockSize: 72,
    });
    const raw = takeQrBeamFrames(sender, sender.k * 9);
    const kept = raw.filter((_, i) => i % 3 !== 0);
    assert.ok(kept.length < raw.length);
    completeOf(data, "drop.bin", "application/octet-stream", kept);
  });

  test("重复帧不破坏解码", () => {
    const data = payload("dup-frames " + "a".repeat(300));
    const sender = createQrBeamSender(data, {
      filename: "dup.txt",
      contentType: "text/plain",
      blockSize: 64,
    });
    const unique = takeQrBeamFrames(sender, sender.k * 5);
    const doubled: string[] = [];
    for (const frame of unique) {
      doubled.push(frame, frame);
    }
    const last = completeOf(data, "dup.txt", "text/plain", doubled);
    const receiver = createQrBeamReceiver();
    let dupHits = 0;
    for (const frame of [unique[0]!, unique[0]!, unique[0]!]) {
      const r = receiver.feed(frame);
      if (r.status === "duplicate") dupHits += 1;
    }
    assert.ok(dupHits >= 1);
    assert.equal(last.status, "complete");
  });

  test("中文文件名与 MIME 能还原", () => {
    const data = payload("meta-restore");
    const sender = createQrBeamSender(data, {
      filename: "密钥备份.json",
      contentType: "application/json",
      blockSize: 48,
    });
    const frames = takeQrBeamFrames(sender, sender.k * 6);
    completeOf(data, "密钥备份.json", "application/json", frames);
  });

  test("无关帧被忽略，不改变进度", () => {
    const data = payload("filter-me");
    const sender = createQrBeamSender(data, {
      filename: "f.txt",
      contentType: "text/plain",
      blockSize: 48,
    });
    const receiver = createQrBeamReceiver();
    assert.equal(receiver.feed("https://example.com").status, "ignored");
    assert.equal(receiver.feed("GKB1.$$$$").status, "ignored");
    assert.deepEqual(receiver.progress, { decoded: 0, k: 0, ratio: 0 });

    const first = sender.nextFrame();
    const accepted = receiver.feed(first);
    assert.ok(accepted.status === "progress" || accepted.status === "complete");
    const afterNoise = receiver.feed("otpauth://totp/xx");
    assert.equal(afterNoise.status, "ignored");
    assert.ok((receiver.session?.k ?? 0) > 0);
  });

  test("会话切换会重置解码器并收下新文件", () => {
    const aData = payload("session-A-aaaa");
    const bData = payload("session-B-bbbb-different");
    const a = createQrBeamSender(aData, { filename: "a.txt", contentType: "text/plain", blockSize: 48 });
    const b = createQrBeamSender(bData, { filename: "b.txt", contentType: "text/plain", blockSize: 48 });
    assert.notEqual(a.checksum, b.checksum);

    const receiver = createQrBeamReceiver();
    const aFrame = a.nextFrame();
    const first = receiver.feed(aFrame);
    assert.ok(first.status === "progress" || first.status === "complete");
    const aKey = first.status === "ignored" || first.status === "error" ? "" : first.sessionKey;
    assert.ok(aKey);

    const bFrames = takeQrBeamFrames(b, b.k * 6);
    let switched = false;
    let last = receiver.feed(bFrames[0]!);
    if (last.status === "progress" || last.status === "complete") {
      switched = last.switched;
    }
    for (const frame of bFrames.slice(1)) {
      last = receiver.feed(frame);
      if (last.status === "complete") break;
    }
    assert.equal(last.status, "complete");
    if (last.status !== "complete") throw new Error("unreachable");
    assert.ok(switched || last.switched);
    assert.notEqual(last.sessionKey, aKey);
    assert.ok(bytesEq(last.file.data, bData));
    assert.equal(last.file.filename, "b.txt");
  });
});
