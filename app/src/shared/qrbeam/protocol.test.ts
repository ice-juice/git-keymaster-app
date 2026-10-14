import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  QRBEAM_PREFIX,
  QRBEAM_SOFT_LIMIT_BYTES,
  blockToFrame,
  exceedsSoftLimit,
  frameToBlock,
  isQrBeamFrame,
  progressOf,
  sessionKey,
} from "./protocol.ts";
import { createQrBeamSender } from "./sender.ts";

function payload(text: string): Uint8Array {
  return new TextEncoder().encode(text);
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

  test("进度 ratio 夹在 0..1", () => {
    assert.deepEqual(progressOf(0, 10), { decoded: 0, k: 10, ratio: 0 });
    assert.deepEqual(progressOf(5, 10), { decoded: 5, k: 10, ratio: 0.5 });
    assert.deepEqual(progressOf(12, 10), { decoded: 12, k: 10, ratio: 1 });
    assert.deepEqual(progressOf(1, 0), { decoded: 1, k: 0, ratio: 0 });
  });
});
