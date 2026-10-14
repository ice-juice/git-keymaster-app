import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  centerSquareCrop,
  fitMaxSide,
  looksLikeBlankFrame,
  shouldRunPixelFallback,
  takeNewFrameTexts,
  viewfinderSourceCrop,
} from "./qrScanFrame.ts";

describe("qr scan frame", () => {
  test("取景框按 cover 映射到视频像素，并留出一圈边", () => {
    const crop = viewfinderSourceCrop(
      1000,
      1000,
      { left: 0, top: 0, width: 200, height: 200 },
      { left: 50, top: 50, width: 100, height: 100 },
      0.06,
    );
    assert.ok(crop);
    assert.ok(Math.abs(crop.x - 220) < 0.01);
    assert.ok(Math.abs(crop.y - 220) < 0.01);
    assert.ok(Math.abs(crop.width - 560) < 0.01);
    assert.ok(Math.abs(crop.height - 560) < 0.01);
  });

  test("越出画面的取景框会被夹回帧内", () => {
    const crop = viewfinderSourceCrop(
      200,
      100,
      { left: 0, top: 0, width: 200, height: 100 },
      { left: -20, top: -10, width: 80, height: 40 },
      0,
    );
    assert.ok(crop);
    assert.equal(crop.x, 0);
    assert.equal(crop.y, 0);
    assert.ok(crop.width > 8);
    assert.ok(crop.height > 8);
    assert.ok(crop.x + crop.width <= 200);
    assert.ok(crop.y + crop.height <= 100);
  });

  test("尺寸不够时不给出裁剪", () => {
    assert.equal(
      viewfinderSourceCrop(0, 10, { left: 0, top: 0, width: 10, height: 10 }, { left: 0, top: 0, width: 10, height: 10 }),
      null,
    );
    assert.equal(centerSquareCrop(4, 4), null);
  });

  test("中央方块落在帧内", () => {
    const crop = centerSquareCrop(1280, 720, 0.72);
    assert.ok(crop);
    assert.ok(crop.x >= 0 && crop.y >= 0);
    assert.ok(crop.x + crop.width <= 1280);
    assert.ok(crop.y + crop.height <= 720);
  });

  test("缩小长边，不把小图放大", () => {
    assert.deepEqual(fitMaxSide(400, 200, 960), { width: 400, height: 200 });
    assert.deepEqual(fitMaxSide(1200, 800, 600), { width: 600, height: 400 });
  });

  test("重复的检测结果不能挡住后备解码，新文本才算交出去", () => {
    assert.equal(shouldRunPixelFallback(false), true);
    assert.equal(shouldRunPixelFallback(true), false);
    const first = takeNewFrameTexts(["GKB1.aaa", "GKB1.aaa"], "");
    assert.deepEqual(first.fresh, ["GKB1.aaa"]);
    const again = takeNewFrameTexts(["GKB1.aaa"], first.last);
    assert.deepEqual(again.fresh, []);
    assert.equal(shouldRunPixelFallback(again.fresh.length > 0), true);
    const next = takeNewFrameTexts([" GKB1.bbb "], again.last);
    assert.deepEqual(next.fresh, ["GKB1.bbb"]);
    assert.equal(shouldRunPixelFallback(next.fresh.length > 0), false);
  });

  test("纯黑画面算抽帧失败，有反差的画面不算", () => {
    const black = new Uint8ClampedArray(32 * 32 * 4);
    assert.equal(looksLikeBlankFrame(black, 32, 32), true);
    const noisy = new Uint8ClampedArray(32 * 32 * 4);
    for (let i = 0; i < noisy.length; i += 4) {
      const on = (i / 4) % 2 === 0;
      noisy[i] = noisy[i + 1] = noisy[i + 2] = on ? 255 : 0;
      noisy[i + 3] = 255;
    }
    assert.equal(looksLikeBlankFrame(noisy, 32, 32), false);
  });
});
