/** 连续扫光传帧时，把取景框映射到摄像头像素，并决定要不要走后备解码。 */

export type PxRect = { x: number; y: number; width: number; height: number };

export type CssBox = { left: number; top: number; width: number; height: number };

/**
 * object-fit: cover 下，把页面上的取景框换算成视频帧里的像素矩形。
 * 光传二维码模块很密，整幅画面再缩到几百像素后，解码器会一直认不出。
 */
export function viewfinderSourceCrop(
  frameWidth: number,
  frameHeight: number,
  display: CssBox,
  box: CssBox,
  padRatio = 0.06,
): PxRect | null {
  if (frameWidth < 2 || frameHeight < 2) return null;
  if (display.width < 2 || display.height < 2 || box.width < 2 || box.height < 2) return null;
  const scale = Math.max(display.width / frameWidth, display.height / frameHeight);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const renderedW = frameWidth * scale;
  const renderedH = frameHeight * scale;
  const offsetX = (renderedW - display.width) / 2;
  const offsetY = (renderedH - display.height) / 2;
  const padX = box.width * padRatio;
  const padY = box.height * padRatio;
  let x = (box.left - display.left + offsetX - padX) / scale;
  let y = (box.top - display.top + offsetY - padY) / scale;
  let width = (box.width + padX * 2) / scale;
  let height = (box.height + padY * 2) / scale;
  if (x < 0) {
    width += x;
    x = 0;
  }
  if (y < 0) {
    height += y;
    y = 0;
  }
  if (x + width > frameWidth) width = frameWidth - x;
  if (y + height > frameHeight) height = frameHeight - y;
  if (width < 8 || height < 8) return null;
  return { x, y, width, height };
}

/** 取景框还没布局好时，用画面中央一块，避免又退回整帧缩小。 */
export function centerSquareCrop(frameWidth: number, frameHeight: number, ratio = 0.72): PxRect | null {
  if (frameWidth < 8 || frameHeight < 8) return null;
  const side = Math.min(frameWidth, frameHeight) * ratio;
  if (side < 8) return null;
  return {
    x: (frameWidth - side) / 2,
    y: (frameHeight - side) / 2,
    width: side,
    height: side,
  };
}

export function fitMaxSide(width: number, height: number, maxSide: number): { width: number; height: number } {
  const w = Math.max(0, width);
  const h = Math.max(0, height);
  const side = Math.max(w, h);
  if (side <= maxSide || side <= 0 || !Number.isFinite(maxSide) || maxSide <= 0) {
    return { width: Math.max(1, Math.round(w || 1)), height: Math.max(1, Math.round(h || 1)) };
  }
  const scale = maxSide / side;
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/**
 * 检测器只有真正交出新文本时才挡住 jsQR。
 * 对着动画码时，视频管线经常反复交回同一帧；若因此跳过像素解码，后面的帧永远进不了组帧。
 */
export function shouldRunPixelFallback(deliveredNewText: boolean): boolean {
  return !deliveredNewText;
}

export function takeNewFrameTexts(texts: readonly string[], last: string): { fresh: string[]; last: string } {
  const fresh: string[] = [];
  let cursor = last;
  for (const raw of texts) {
    const text = raw.trim();
    if (!text || text === cursor) continue;
    cursor = text;
    fresh.push(text);
  }
  return { fresh, last: cursor };
}

/** 硬件图层抽不到像素时，canvas 会是一片黑，jsQR 和 rqrr 都会静默失败。 */
export function looksLikeBlankFrame(data: Uint8ClampedArray, width: number, height: number): boolean {
  if (width < 8 || height < 8 || data.length < width * height * 4) return false;
  const samples = 32;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < samples; i++) {
    const x = 1 + ((i * 47) % (width - 2));
    const y = 1 + ((i * 29) % (height - 2));
    const o = (y * width + x) * 4;
    const luma = data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114;
    sum += luma;
    sumSq += luma * luma;
  }
  const mean = sum / samples;
  const variance = sumSq / samples - mean * mean;
  return mean < 14 && variance < 24;
}
