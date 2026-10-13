export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
export const TOGGLE_ZOOM = 2;
export const SWIPE_PX = 48;

export function clampZoom(scale: number) {
  if (!Number.isFinite(scale)) return MIN_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
}

export function isFitted(scale: number) {
  return scale <= MIN_ZOOM + 0.001;
}

export function toggleZoom(scale: number) {
  return isFitted(scale) ? TOGGLE_ZOOM : MIN_ZOOM;
}

/** 适合屏幕时，横向甩动切图；放大后同一手势只算平移。 */
export function gestureAfterDrag(scale: number, dx: number, dy: number): "prev" | "next" | "pan" | "none" {
  if (!isFitted(scale)) return "pan";
  if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy)) return dx < 0 ? "next" : "prev";
  return "none";
}

export function panLimit(fittedSize: number, stageSize: number, scale: number) {
  return Math.max(0, (fittedSize * scale - stageSize) / 2);
}

export function clampPan(pan: number, limit: number) {
  if (!Number.isFinite(pan) || limit <= 0) return 0;
  return Math.min(limit, Math.max(-limit, pan));
}

/** 以光标（相对舞台中心）为锚点缩放，缩回 1 倍时平移归零。 */
export function zoomAtPoint(opts: {
  scale: number;
  panX: number;
  panY: number;
  nextScale: number;
  originX: number;
  originY: number;
}) {
  const scale = clampZoom(opts.nextScale);
  if (isFitted(scale) || !Number.isFinite(opts.scale) || opts.scale <= 0) {
    return { scale: MIN_ZOOM, panX: 0, panY: 0 };
  }
  const ratio = scale / opts.scale;
  return {
    scale,
    panX: opts.originX * (1 - ratio) + opts.panX * ratio,
    panY: opts.originY * (1 - ratio) + opts.panY * ratio,
  };
}

export function pinchScale(startScale: number, startDist: number, dist: number) {
  if (startDist <= 0 || !Number.isFinite(dist)) return clampZoom(startScale);
  return clampZoom(startScale * (dist / startDist));
}

/** 滚轮：纵向或捏合缩放；适合屏幕时横向甩动切图；放大后横向滚动改为平移。 */
export function wheelAction(
  scale: number,
  deltaX: number,
  deltaY: number,
  ctrlKey: boolean,
):
  | { type: "zoom"; factor: number }
  | { type: "pan"; dx: number; dy: number }
  | { type: "next" }
  | { type: "prev" } {
  if (ctrlKey || Math.abs(deltaY) >= Math.abs(deltaX)) {
    return { type: "zoom", factor: Math.exp(-deltaY * 0.002) };
  }
  if (isFitted(scale) && Math.abs(deltaX) > 20) return deltaX > 0 ? { type: "next" } : { type: "prev" };
  if (!isFitted(scale)) return { type: "pan", dx: -deltaX, dy: -deltaY };
  return { type: "zoom", factor: 1 };
}
