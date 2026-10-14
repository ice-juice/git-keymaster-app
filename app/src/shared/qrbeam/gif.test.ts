import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decompressFrames, parseGIF } from "gifuct-js";
import { createQrBeamReceiver } from "./receiver.ts";
import { createQrBeamSender, takeQrBeamFrames } from "./sender.ts";
import {
  QRBEAM_GIF_SIDE,
  collectVerifiedQrBeamFrames,
  decodeGifRasters,
  encodeQrBeamGif,
  qrBeamFramesRestore,
  qrBeamGifFrameTarget,
  readQrFromRaster,
  receiveQrBeamGif,
  renderQrIndexed,
} from "./gif.ts";

function payload(size: number): Uint8Array {
  const data = new Uint8Array(size);
  let x = 0x9e3779b1;
  for (let i = 0; i < size; i++) {
    x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
    x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
    x ^= x >>> 16;
    data[i] = x & 255;
  }
  return data;
}

function shuffle<T>(items: T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = (i * 17 + 3) % (i + 1);
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

describe("qrbeam gif", () => {
  test("帧数至少 1.2×K，且不低于稳定解码量", () => {
    for (const k of [1, 5, 9, 17]) {
      const target = qrBeamGifFrameTarget(k);
      assert.ok(target >= k);
      assert.ok(target >= Math.ceil(k * 1.2));
      assert.ok(target >= Math.ceil(k * 2));
    }
  });

  test("二维码约 512 边长，四角是白边", () => {
    const rendered = renderQrIndexed("GKB1.quiet-zone");
    assert.equal(rendered.width, rendered.height);
    assert.ok(rendered.width >= QRBEAM_GIF_SIDE - 80);
    assert.ok(rendered.width <= QRBEAM_GIF_SIDE + 80);
    assert.equal(rendered.index[0], 1);
    assert.equal(rendered.index[rendered.index.length - 1], 1);
    assert.ok(rendered.index.includes(0));
  });

  test("GIF 往返：乱序像素帧仍能还原文件", async () => {
    const data = payload(180);
    const sender = createQrBeamSender(data, {
      filename: "note.txt",
      contentType: "text/plain",
      blockSize: 64,
      compress: false,
    });
    assert.ok(sender.k > 1);
    const frames = collectVerifiedQrBeamFrames(sender, { data, filename: "note.txt" });
    const gif = await encodeQrBeamGif(frames, 8, { yieldEvery: 0 });
    assert.equal(gif[0], 0x47);
    assert.equal(String.fromCharCode(gif[0]!, gif[1]!, gif[2]!), "GIF");

    const parsed = parseGIF(gif.buffer.slice(gif.byteOffset, gif.byteOffset + gif.byteLength));
    const delays = decompressFrames(parsed, false).map((frame) => frame.delay);
    assert.ok(delays.length >= frames.length);
    assert.equal(delays[0], 130);

    const rasters = shuffle(decodeGifRasters(gif));
    const receiver = createQrBeamReceiver();
    let file = null;
    const seen = new Set<string>();
    for (const raster of rasters) {
      const text = readQrFromRaster(raster);
      assert.ok(text?.startsWith("GKB1."));
      seen.add(text!);
      const result = receiver.feed(text!);
      if (result.status === "complete") {
        file = result.file;
        break;
      }
    }
    assert.ok(file);
    assert.equal(file!.filename, "note.txt");
    assert.deepEqual(Array.from(file!.data), Array.from(data));
    const doubled = [...seen, ...seen];
    assert.equal(qrBeamFramesRestore(doubled, { data, filename: "note.txt" }), true);
  });

  test("帧不够时导入结果为空，不给出半截文件", async () => {
    const data = payload(220);
    const sender = createQrBeamSender(data, {
      filename: "short.bin",
      contentType: "application/octet-stream",
      blockSize: 48,
      compress: false,
    });
    assert.ok(sender.k > 2);
    const one = takeQrBeamFrames(sender, 1);
    assert.equal(qrBeamFramesRestore(one, { data, filename: "short.bin" }), false);
    const gif = await encodeQrBeamGif(one, 8, { yieldEvery: 0 });
    const receiver = createQrBeamReceiver();
    const result = await receiveQrBeamGif(gif, receiver);
    assert.equal(result.file, null);
    assert.equal(result.recognized, 1);
    assert.equal(await receiveQrBeamGif(new Uint8Array([1, 2, 3, 4]), createQrBeamReceiver()).then((r) => r.file), null);
  });
});
