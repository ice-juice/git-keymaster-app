/** 把光传帧画成黑白二维码，再用 gifenc / gifuct-js 做 GIF 往返。字节只在调用方手里，不进历史。 */

import { GIFEncoder } from "gifenc/dist/gifenc.esm.js";
import { decompressFrame, parseGIF, type ParsedGif } from "gifuct-js";
import jsQR from "jsqr";
import qrcode from "qrcode-generator";
import { QRBEAM_DEFAULT_FPS, estimateNeededFrames, isQrBeamFrame } from "./protocol.ts";
import { createQrBeamReceiver, type QrBeamFeedResult, type QrBeamFile, type QrBeamReceiver } from "./receiver.ts";
import { takeQrBeamFrames, type QrBeamSender } from "./sender.ts";

type QrFactory = typeof qrcode & {
  stringToBytes?: (s: string) => number[];
  stringToBytesFuncs?: Record<string, (s: string) => number[]>;
};

type GifImageFrame = Parameters<typeof decompressFrame>[0];

const QR_PALETTE = [
  [0, 0, 0],
  [255, 255, 255],
];

/** 二维码边长目标。模块取整后会略小于该值；模块太密时略大，保证每格至少 3 像素。 */
export const QRBEAM_GIF_SIDE = 512;
const QUIET_MODULES = 4;
const MIN_CELL = 3;
/** 建议下限。实际还会再抬到能稳定还原的数量。 */
const GIF_SUGGESTED_FACTOR = 1.2;
/** 这套理想孤子分布的经验上沿，低于它第一遍经常还原失败。 */
const GIF_STABLE_FACTOR = 2;

export type QrGifRaster = {
  data: Uint8ClampedArray;
  width: number;
  height: number;
};

export type QrGifScanProgress = {
  scanned: number;
  total: number;
  recognized: number;
  feed: QrBeamFeedResult | null;
};

export type QrBeamGifExpect = {
  data: Uint8Array;
  filename: string;
};

function utf8Bytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

function makeQr(text: string) {
  const factory = qrcode as QrFactory;
  factory.stringToBytes = factory.stringToBytesFuncs?.["UTF-8"] ?? utf8Bytes;
  const qr = factory(0, "M");
  qr.addData(text);
  qr.make();
  return qr;
}

function yieldNow(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function imageFrame(frame: ParsedGif["frames"][number]): GifImageFrame | null {
  if (!("image" in frame) || !frame.image) return null;
  return frame as GifImageFrame;
}

function frameDelayMs(fps: number): number {
  const rate = fps > 0 ? fps : QRBEAM_DEFAULT_FPS;
  return Math.max(20, Math.round(1000 / rate));
}

/** 至少 estimateNeededFrames，建议约 1.2×K，且不少于经验上能稳定解码的 2×K。 */
export function qrBeamGifFrameTarget(k: number): number {
  const safeK = Number.isFinite(k) && k > 0 ? Math.floor(k) : 0;
  const suggested = Math.ceil(safeK * GIF_SUGGESTED_FACTOR);
  const stable = Math.ceil(safeK * GIF_STABLE_FACTOR);
  return Math.max(estimateNeededFrames(safeK), suggested, stable);
}

export function renderQrIndexed(text: string, side = QRBEAM_GIF_SIDE): { index: Uint8Array; width: number; height: number } {
  const qr = makeQr(text);
  const count = qr.getModuleCount();
  const span = count + QUIET_MODULES * 2;
  let cell = Math.floor(side / span);
  if (cell < MIN_CELL) cell = MIN_CELL;
  const width = cell * span;
  const height = width;
  const index = new Uint8Array(width * height);
  index.fill(1);
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (!qr.isDark(row, col)) continue;
      const x0 = (col + QUIET_MODULES) * cell;
      const y0 = (row + QUIET_MODULES) * cell;
      for (let y = 0; y < cell; y++) {
        const start = (y0 + y) * width + x0;
        index.fill(0, start, start + cell);
      }
    }
  }
  return { index, width, height };
}

export function qrBeamFramesRestore(frames: readonly string[], expected?: QrBeamGifExpect): boolean {
  const receiver = createQrBeamReceiver();
  for (const frame of frames) {
    const result = receiver.feed(frame);
    if (result.status === "error") return false;
    if (result.status !== "complete") continue;
    if (!expected) return true;
    return result.file.filename === expected.filename && bytesEqual(result.file.data, expected.data);
  }
  return false;
}

/** 先取稳定帧数做还原校验；失败则再加同样多的帧，只重试一次。 */
export function collectVerifiedQrBeamFrames(sender: QrBeamSender, expected?: QrBeamGifExpect): string[] {
  const target = Math.max(qrBeamGifFrameTarget(sender.k), 1);
  const first = takeQrBeamFrames(sender, target);
  if (qrBeamFramesRestore(first, expected)) return first;
  const second = first.concat(takeQrBeamFrames(sender, target));
  if (qrBeamFramesRestore(second, expected)) return second;
  throw new Error("qrbeam_gif_incomplete");
}

export async function encodeQrBeamGif(
  frames: readonly string[],
  fps: number,
  options?: { side?: number; yieldEvery?: number },
): Promise<Uint8Array> {
  if (frames.length === 0) throw new Error("qrbeam_gif_incomplete");
  const gif = GIFEncoder();
  const delay = frameDelayMs(fps);
  const side = options?.side ?? QRBEAM_GIF_SIDE;
  const yieldEvery = options?.yieldEvery ?? 1;
  for (let i = 0; i < frames.length; i++) {
    const rendered = renderQrIndexed(frames[i] ?? "", side);
    gif.writeFrame(rendered.index, rendered.width, rendered.height, {
      palette: i === 0 ? QR_PALETTE : undefined,
      delay,
      repeat: 0,
      dispose: 1,
      colorDepth: 2,
    });
    if (yieldEvery > 0 && (i + 1) % yieldEvery === 0) await yieldNow();
  }
  gif.finish();
  return gif.bytes();
}

export async function exportQrBeamGif(
  sender: QrBeamSender,
  options: { fps: number; data: Uint8Array; filename: string; side?: number },
): Promise<Uint8Array> {
  const frames = collectVerifiedQrBeamFrames(sender, { data: options.data, filename: options.filename });
  return encodeQrBeamGif(frames, options.fps, { side: options.side });
}

export function decodeGifRasters(bytes: Uint8Array): QrGifRaster[] {
  const parsed = parseGIF(toArrayBuffer(bytes));
  const out: QrGifRaster[] = [];
  for (const raw of parsed.frames) {
    const frame = imageFrame(raw);
    if (!frame) continue;
    const decoded = decompressFrame(frame, parsed.gct, true);
    if (!decoded?.patch || !decoded.dims?.width || !decoded.dims?.height) continue;
    out.push({ data: decoded.patch, width: decoded.dims.width, height: decoded.dims.height });
  }
  return out;
}

export function readQrFromRaster(raster: QrGifRaster): string | null {
  const code = jsQR(raster.data, raster.width, raster.height, { inversionAttempts: "attemptBoth" });
  const text = code?.data?.trim();
  return text ? text : null;
}

export function gifDownloadName(filename: string): string {
  const base = filename.trim().replace(/[\\/:*?"<>|]/g, "_") || "file";
  return base.toLowerCase().endsWith(".gif") ? base : `${base}.gif`;
}

export function downloadGifBytes(filename: string, bytes: Uint8Array): void {
  const blob = new Blob([bytes as BlobPart], { type: "image/gif" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = gifDownloadName(filename);
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function shareOrDownloadGif(filename: string, bytes: Uint8Array): Promise<"shared" | "downloaded" | "cancelled"> {
  const name = gifDownloadName(filename);
  const file = new File([bytes as BlobPart], name, { type: "image/gif" });
  const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
  if (typeof nav.share === "function" && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: name });
      return "shared";
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return "cancelled";
    }
  }
  downloadGifBytes(name, bytes);
  return "downloaded";
}

export async function rasterToPngBytes(raster: QrGifRaster): Promise<Uint8Array | null> {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = raster.width;
  canvas.height = raster.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const pixels = new Uint8ClampedArray(raster.data.byteLength);
  pixels.set(raster.data);
  ctx.putImageData(new ImageData(pixels, raster.width, raster.height), 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((next) => resolve(next), "image/png");
  });
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
}

export async function decodeRasterFallback(
  raster: QrGifRaster,
  decodeImage: (bytes: Uint8Array) => Promise<string[]>,
): Promise<string | null> {
  const png = await rasterToPngBytes(raster);
  if (!png) return null;
  const texts = await decodeImage(png);
  for (const text of texts) {
    const trimmed = text.trim();
    if (trimmed && isQrBeamFrame(trimmed)) return trimmed;
  }
  const first = texts[0]?.trim();
  return first || null;
}

export async function receiveQrBeamGif(
  bytes: Uint8Array,
  receiver: QrBeamReceiver,
  options?: {
    onProgress?: (progress: QrGifScanProgress) => void;
    decodeFallback?: (raster: QrGifRaster) => Promise<string | null>;
  },
): Promise<{ recognized: number; file: QrBeamFile | null; scanned: number }> {
  let parsed: ParsedGif;
  try {
    parsed = parseGIF(toArrayBuffer(bytes));
  } catch {
    return { recognized: 0, file: null, scanned: 0 };
  }
  const total = parsed.frames.reduce((count, raw) => count + (imageFrame(raw) ? 1 : 0), 0);
  let recognized = 0;
  let scanned = 0;
  for (const raw of parsed.frames) {
    const frame = imageFrame(raw);
    if (!frame) continue;
    scanned += 1;
    const decoded = decompressFrame(frame, parsed.gct, true);
    const raster =
      decoded?.patch && decoded.dims?.width && decoded.dims?.height
        ? { data: decoded.patch, width: decoded.dims.width, height: decoded.dims.height }
        : null;
    let text = raster ? readQrFromRaster(raster) : null;
    if (!text && raster && options?.decodeFallback) {
      try {
        text = (await options.decodeFallback(raster))?.trim() || null;
      } catch {
        text = null;
      }
    }
    let feed: QrBeamFeedResult | null = null;
    if (text && isQrBeamFrame(text)) {
      recognized += 1;
      feed = receiver.feed(text);
      if (feed.status === "complete") {
        options?.onProgress?.({ scanned, total, recognized, feed });
        return { recognized, file: feed.file, scanned };
      }
    }
    options?.onProgress?.({ scanned, total, recognized, feed });
    await yieldNow();
  }
  return { recognized, file: null, scanned };
}
