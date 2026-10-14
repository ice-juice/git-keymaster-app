import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { appendFileHeaderMetaToBuffer, createEncoder } from "luby-transform";
import { qrModuleCount } from "../qrEncode.ts";
import {
  QRBEAM_DEFAULT_BLOCK_SIZE,
  QRBEAM_HARD_LIMIT_BYTES,
  QRBEAM_MAX_BLOCK_SIZE,
  QRBEAM_MAX_DEGREE,
  QRBEAM_MAX_FRAME_BINARY,
  QRBEAM_MAX_K,
  QRBEAM_MAX_QR_MODULES,
  QRBEAM_PREFIX,
  QRBEAM_SOFT_LIMIT_BYTES,
  QRBEAM_TOO_LARGE,
  blockToFrame,
  effectiveBlockSize,
  exceedsHardLimit,
  exceedsSoftLimit,
  frameBinaryBytes,
  frameCharCount,
  frameToBlock,
  isQrBeamFrame,
  maxScannableFileBytes,
  progressOf,
  sessionKey,
} from "./protocol.ts";
import { createQrBeamReceiver } from "./receiver.ts";
import { createQrBeamSender, takeQrBeamFrames } from "./sender.ts";

function payload(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function incompressible(size: number): Uint8Array {
  const data = new Uint8Array(size);
  let x = 0x12345678;
  for (let i = 0; i < data.length; i++) {
    x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
    x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
    x ^= x >>> 16;
    data[i] = x & 255;
  }
  return data;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("qrbeam protocol", () => {
  test("block <-> frame 往返保留喷泉块字段", () => {
    const sender = createQrBeamSender(payload("hello qrbeam"), {
      filename: "hello.txt",
      contentType: "text/plain",
      blockSize: 64,
    });
    const block = sender.nextBlock();
    const frame = blockToFrame(block);
    assert.ok(frame.startsWith(QRBEAM_PREFIX));
    assert.equal(isQrBeamFrame(frame), true);

    const back = frameToBlock(frame);
    assert.ok(back);
    assert.equal(back.k, block.k);
    assert.equal(back.bytes, block.bytes);
    assert.equal(back.checksum, block.checksum);
    assert.deepEqual(back.indices, block.indices);
    assert.deepEqual(Array.from(back.data), Array.from(block.data));
    assert.equal(sessionKey({ checksum: back.checksum, k: back.k }), `${block.checksum}:${block.k}`);
  });

  test("无关二维码与坏帧被过滤", () => {
    assert.equal(isQrBeamFrame("otpauth://totp/x"), false);
    assert.equal(frameToBlock("otpauth://totp/x"), null);
    assert.equal(frameToBlock("GKB1.not-valid-base64!!!"), null);
    assert.equal(frameToBlock(`${QRBEAM_PREFIX}`), null);
  });

  test("软上限：50KB 不超，再大一字节才超", () => {
    assert.equal(exceedsSoftLimit(100), false);
    assert.equal(exceedsSoftLimit(QRBEAM_SOFT_LIMIT_BYTES), false);
    assert.equal(exceedsSoftLimit(QRBEAM_SOFT_LIMIT_BYTES + 1), true);
    const small = createQrBeamSender(new Uint8Array(16), { filename: "a.bin", blockSize: 64 });
    assert.equal(small.overSoftLimit, false);
    const big = createQrBeamSender(new Uint8Array(QRBEAM_SOFT_LIMIT_BYTES + 8), {
      filename: "b.bin",
      blockSize: 512,
    });
    assert.equal(big.overSoftLimit, true);
  });

  test("封顶块的度数 2 帧不超过 77 模块，旧的 512 字节块超过", () => {
    assert.equal(QRBEAM_DEFAULT_BLOCK_SIZE, QRBEAM_MAX_BLOCK_SIZE);
    assert.equal(frameBinaryBytes(QRBEAM_MAX_DEGREE, QRBEAM_MAX_BLOCK_SIZE), QRBEAM_MAX_FRAME_BINARY);
    assert.equal(effectiveBlockSize(512), QRBEAM_MAX_BLOCK_SIZE);
    assert.equal(effectiveBlockSize(64), 64);

    const capped = blockToFrame({
      k: 40,
      bytes: 8000,
      checksum: 1,
      indices: [1, 4],
      data: new Uint8Array(QRBEAM_MAX_BLOCK_SIZE),
    });
    assert.equal(capped.length, frameCharCount(QRBEAM_MAX_DEGREE, QRBEAM_MAX_BLOCK_SIZE));
    assert.ok(qrModuleCount(capped) <= QRBEAM_MAX_QR_MODULES);

    const merged = appendFileHeaderMetaToBuffer(incompressible(8 * 1024), {
      filename: "old.bin",
      contentType: "application/octet-stream",
    });
    const old = blockToFrame(createEncoder(merged, 512, false).createBlock([0]));
    const oldModules = qrModuleCount(old);
    assert.ok(oldModules > QRBEAM_MAX_QR_MODULES, `old degree-1 frame has ${oldModules} modules`);
    assert.ok(old.length > 700);
  });

  test("超过块数上限才拒绝，50KB 仍会按可扫密度发出", () => {
    const limit = QRBEAM_HARD_LIMIT_BYTES;
    assert.equal(limit, maxScannableFileBytes(512));
    assert.ok(limit > QRBEAM_SOFT_LIMIT_BYTES);
    assert.equal(exceedsHardLimit(limit, QRBEAM_DEFAULT_BLOCK_SIZE), false);
    assert.equal(exceedsHardLimit(limit + 1, QRBEAM_DEFAULT_BLOCK_SIZE), true);
    assert.throws(
      () =>
        createQrBeamSender(new Uint8Array(limit + 1), {
          filename: "too-big.bin",
          blockSize: 512,
        }),
      (err: unknown) => err instanceof Error && err.message === QRBEAM_TOO_LARGE,
    );
    assert.ok(QRBEAM_MAX_K > 100);
  });

  test("几百字节以上的文件，每一帧都不超过 77 模块，接收端能还原", () => {
    const name = `${"n".repeat(40)}.bin`;
    for (const size of [388, 8 * 1024, 50 * 1024]) {
      const data = incompressible(size);
      const sender = createQrBeamSender(data, {
        filename: name,
        contentType: "application/octet-stream",
        blockSize: 512,
        compress: false,
      });
      assert.equal(sender.blockSize, QRBEAM_MAX_BLOCK_SIZE);
      assert.ok(sender.k >= 1);
      if (size >= 8 * 1024) assert.ok(sender.k > 10, `k=${sender.k} for ${size}`);
      const round = takeQrBeamFrames(sender, Math.max(sender.k * 2, 1));
      for (const frame of round) {
        assert.ok(frame.startsWith(QRBEAM_PREFIX));
        const modules = qrModuleCount(frame);
        assert.ok(
          modules <= QRBEAM_MAX_QR_MODULES,
          `${size}B frame has ${modules} modules / ${frame.length} chars`,
        );
      }
      const receiver = createQrBeamReceiver();
      let restored = false;
      for (const frame of round) {
        const result = receiver.feed(frame);
        if (result.status !== "complete") continue;
        assert.equal(result.file.filename, name);
        assert.equal(result.file.data.byteLength, data.byteLength);
        assert.ok(result.file.data.every((byte, i) => byte === data[i]));
        restored = true;
        break;
      }
      assert.equal(restored, true, `${size}B did not restore from ${round.length} frames`);
    }
  });

  test("大约四成的帧被摄像头丢掉时，预计帧数内仍能组完", () => {
    const data = incompressible(8 * 1024);
    const probe = createQrBeamSender(data, {
      filename: "loss.bin",
      contentType: "application/octet-stream",
      blockSize: 512,
      compress: false,
    });
    for (const seed of [1, 2, 3, 8, 16, 24]) {
      const played = createQrBeamSender(data, {
        filename: "loss.bin",
        contentType: "application/octet-stream",
        blockSize: 512,
        compress: false,
      });
      const receiver = createQrBeamReceiver();
      const rand = mulberry32(seed);
      let displayed = 0;
      let done = false;
      for (const frame of played.frames()) {
        displayed += 1;
        if (rand() <= 0.4) {
          const result = receiver.feed(frame);
          if (result.status === "complete") {
            assert.ok(result.file.data.every((byte, i) => byte === data[i]));
            done = true;
            break;
          }
        }
        if (displayed >= probe.neededFrames) break;
      }
      assert.equal(done, true, `seed ${seed} used ${displayed}, estimate ${probe.neededFrames}`);
    }
  });

  test("进度 ratio 夹在 0..1", () => {
    assert.deepEqual(progressOf(0, 10), { decoded: 0, k: 10, ratio: 0 });
    assert.deepEqual(progressOf(5, 10), { decoded: 5, k: 10, ratio: 0.5 });
    assert.deepEqual(progressOf(12, 10), { decoded: 12, k: 10, ratio: 1 });
    assert.deepEqual(progressOf(1, 0), { decoded: 1, k: 0, ratio: 0 });
  });
});
