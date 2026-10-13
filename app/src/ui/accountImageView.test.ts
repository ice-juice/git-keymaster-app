import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  clampPan,
  clampZoom,
  gestureAfterDrag,
  isFitted,
  pinchScale,
  toggleZoom,
  wheelAction,
  zoomAtPoint,
} from "./accountImageView.ts";

describe("account image view", () => {
  test("缩放限制在 1 到 4 倍", () => {
    assert.equal(clampZoom(0.2), 1);
    assert.equal(clampZoom(2.5), 2.5);
    assert.equal(clampZoom(9), 4);
    assert.equal(clampZoom(Number.NaN), 1);
  });

  test("适合屏幕时横向甩动切图，放大后只平移", () => {
    assert.equal(gestureAfterDrag(1, -80, 10), "next");
    assert.equal(gestureAfterDrag(1, 80, 10), "prev");
    assert.equal(gestureAfterDrag(1, 10, 80), "none");
    assert.equal(gestureAfterDrag(1, -20, 0), "none");
    assert.equal(gestureAfterDrag(1.2, -80, 0), "pan");
    assert.equal(gestureAfterDrag(4, 90, 0), "pan");
  });

  test("双击在适合屏幕和 2 倍之间切换", () => {
    assert.equal(toggleZoom(1), 2);
    assert.equal(toggleZoom(2), 1);
    assert.equal(toggleZoom(3.4), 1);
    assert.equal(isFitted(1), true);
    assert.equal(isFitted(1.2), false);
  });

  test("滚轮纵向缩放，适合屏幕时横向切图，放大后横向改为平移", () => {
    const zoom = wheelAction(1, 0, -100, false);
    assert.equal(zoom.type, "zoom");
    assert.ok(zoom.type === "zoom" && zoom.factor > 1);
    assert.deepEqual(wheelAction(1, 40, 4, false), { type: "next" });
    assert.deepEqual(wheelAction(1, -40, 4, false), { type: "prev" });
    assert.equal(wheelAction(2, 40, 4, false).type, "pan");
    assert.equal(wheelAction(2, 0, -20, true).type, "zoom");
  });

  test("以光标为锚点缩放，缩回 1 倍时平移归零", () => {
    const zoomed = zoomAtPoint({ scale: 1, panX: 0, panY: 0, nextScale: 2, originX: 40, originY: -10 });
    assert.equal(zoomed.scale, 2);
    assert.notEqual(zoomed.panX, 0);
    const fitted = zoomAtPoint({ scale: 2, panX: zoomed.panX, panY: zoomed.panY, nextScale: 1, originX: 40, originY: -10 });
    assert.deepEqual(fitted, { scale: 1, panX: 0, panY: 0 });
  });

  test("捏合按距离比例缩放并限制上限", () => {
    assert.equal(pinchScale(1, 100, 200), 2);
    assert.equal(pinchScale(2, 100, 400), 4);
    assert.equal(pinchScale(1, 0, 50), 1);
  });

  test("平移不超出放大后的画面", () => {
    assert.equal(clampPan(80, 30), 30);
    assert.equal(clampPan(-80, 30), -30);
    assert.equal(clampPan(10, 0), 0);
  });
});
