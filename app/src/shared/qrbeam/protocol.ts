/** 光传文件帧协议：GKB1. + base64(喷泉块)。 */

import { binaryToBlock, blockToBinary, type EncodedBlock } from "luby-transform";
import { base64ToBytes, bytesToBase64 } from "../base64Util.ts";

export const QRBEAM_PREFIX = "GKB1.";
/** 超过此大小给黄色提示，不禁止。帧会变多，但每帧仍在可扫密度内。 */
export const QRBEAM_SOFT_LIMIT_BYTES = 50 * 1024;
/**
 * 手机连续取景能稳定解开的符号模块上限（版本 15）。
 *
 * 1920×1080、取景框 min(86vw, 520px)、object-fit:cover，再加 6% 裁切边。
 * 390×844 上裁切大约 481px，二维码落在框内约 430px。纠错 M，静区每边 4 格。
 * 旧默认块 512 字节、度数 1：一帧约 717 字符、105 模块，大约 4 像素/模块。
 * 只有一个源块时画面是静止的，有时能扫；文件一大，码开始动画，高度数帧还会到 130 模块以上，一帧都解不出。
 * 77 模块加静区约 85 格，430px 里大约 5 像素/模块，动画时仍有余量。
 * 字节模式版本 15 最多 412 字符。GKB1. + base64 在 300 字节二进制时是 405 字符。
 */
export const QRBEAM_MAX_QR_MODULES = 77;
/** 实际播出的修复帧度数。理想孤子可以到 k，那会把大文件的单帧撑破上面的模块上限。 */
export const QRBEAM_MAX_DEGREE = 2;
/** 版本 15、纠错 M 下，GKB1. 帧对应的二进制上限（留 3 字节，避开 303 的边界）。 */
export const QRBEAM_MAX_FRAME_BINARY = 300;
/** 4×(度数+4) 是喷泉块头。度数 2 时头是 24 字节，块数据最多 276。 */
export const QRBEAM_MAX_BLOCK_SIZE = QRBEAM_MAX_FRAME_BINARY - 4 * (QRBEAM_MAX_DEGREE + 4);
export const QRBEAM_MIN_BLOCK_SIZE = 64;
export const QRBEAM_BLOCK_STEP = 4;
export const QRBEAM_DEFAULT_BLOCK_SIZE = QRBEAM_MAX_BLOCK_SIZE;
/** 每帧大约停 250ms，让手机对上焦再解。滑块仍可调快。 */
export const QRBEAM_DEFAULT_FPS = 4;
/** 屏幕上的光传码静区。GIF 渲染本来就是 4，直播 SVG 之前只有 2。 */
export const QRBEAM_QUIET_MODULES = 4;
/**
 * 摄像头会漏掉一部分帧。系统块加两两修复、大约四成捕获率时，
 * 24 次模拟里最慢要 7.9×k 帧。界面「约需 n 帧」按 8×k 估算，不是理论最少的 k。
 */
export const QRBEAM_CAMERA_FRAME_FACTOR = 8;
/**
 * 文件名 JSON、长度前缀，以及不可压缩数据的 deflate 膨胀。
 * 120 字文件名实测大约 130 字节；留 256，避免刚好卡在块数上限上。
 */
export const QRBEAM_META_BUDGET_BYTES = 256;
/** 块数超过 QRBEAM_MAX_K 时发送端抛出。界面译成 fileBeamHardLimit。 */
export const QRBEAM_TOO_LARGE = "qrbeam_too_large";
/** 单会话块数硬上限，防止垃圾帧把解码器撑爆。 */
export const QRBEAM_MAX_K = 4096;

export type QrBeamSessionId = {
  checksum: number;
  k: number;
};

export type QrBeamProgress = {
  decoded: number;
  k: number;
  ratio: number;
};

export function isQrBeamFrame(text: string): boolean {
  return text.startsWith(QRBEAM_PREFIX);
}

export function exceedsSoftLimit(byteLength: number): boolean {
  return byteLength > QRBEAM_SOFT_LIMIT_BYTES;
}

/** 滑块可以调小，不能调到会把单帧撑过版本 15 的块大小。 */
export function effectiveBlockSize(requested: number): number {
  if (!Number.isInteger(requested) || requested <= 0) {
    throw new Error("qrbeam_invalid_block_size");
  }
  return Math.min(requested, QRBEAM_MAX_BLOCK_SIZE);
}

/** 喷泉块二进制长度。头是度数、下标、k、bytes、checksum，每个 uint32。 */
export function frameBinaryBytes(degree: number, blockSize: number): number {
  return 4 * (degree + 4) + blockSize;
}

/** GKB1. + base64 的字符数。base64 长度按 4×ceil(n/3) 计。 */
export function frameCharCount(degree: number, blockSize: number): number {
  return QRBEAM_PREFIX.length + 4 * Math.ceil(frameBinaryBytes(degree, blockSize) / 3);
}

/**
 * 不可压缩文件在该块大小下，块数还不超过 QRBEAM_MAX_K 的字节上限。
 * 传入比可扫上限更大的块大小时，按封顶后的块大小计算。
 */
export function maxScannableFileBytes(blockSize = QRBEAM_DEFAULT_BLOCK_SIZE): number {
  const size = effectiveBlockSize(Math.max(1, Math.floor(blockSize) || QRBEAM_DEFAULT_BLOCK_SIZE));
  return Math.max(0, QRBEAM_MAX_K * size - QRBEAM_META_BUDGET_BYTES);
}

export function exceedsHardLimit(byteLength: number, blockSize: number): boolean {
  return byteLength > maxScannableFileBytes(blockSize);
}

/** 默认（已封顶）块大小下，不可压缩文件的字节上限，含 256 字节预留。 */
export const QRBEAM_HARD_LIMIT_BYTES = maxScannableFileBytes(QRBEAM_DEFAULT_BLOCK_SIZE);

/** 喷泉码至少需要 k 帧。GIF 导出仍用这个下界，再乘自己的冗余系数。 */
export function estimateNeededFrames(k: number): number {
  return Math.max(0, k);
}

/** 给界面的预计帧数：把摄像头漏帧算进去。 */
export function estimateCameraFrames(k: number): number {
  const safe = Number.isFinite(k) && k > 0 ? Math.floor(k) : 0;
  if (safe === 0) return 0;
  return Math.max(safe, Math.ceil(safe * QRBEAM_CAMERA_FRAME_FACTOR));
}

export function estimateDurationSec(k: number, fps = QRBEAM_DEFAULT_FPS): number {
  const rate = fps > 0 ? fps : QRBEAM_DEFAULT_FPS;
  return estimateCameraFrames(k) / rate;
}

export function sessionIdOf(block: EncodedBlock): QrBeamSessionId {
  return { checksum: block.checksum, k: block.k };
}

export function sameSession(a: QrBeamSessionId, b: QrBeamSessionId): boolean {
  return a.checksum === b.checksum && a.k === b.k;
}

export function sessionKey(id: QrBeamSessionId): string {
  return `${id.checksum}:${id.k}`;
}

export function progressOf(decoded: number, k: number): QrBeamProgress {
  const safeK = k > 0 ? k : 0;
  const safeDecoded = decoded > 0 ? decoded : 0;
  return {
    decoded: safeDecoded,
    k: safeK,
    ratio: safeK === 0 ? 0 : Math.min(1, safeDecoded / safeK),
  };
}

export function isPlausibleBlock(block: EncodedBlock): boolean {
  if (!Number.isInteger(block.k) || block.k < 1 || block.k > QRBEAM_MAX_K) return false;
  if (!Number.isInteger(block.bytes) || block.bytes < 1) return false;
  if (!Array.isArray(block.indices) || block.indices.length === 0) return false;
  if (!(block.data instanceof Uint8Array) || block.data.length === 0) return false;
  return true;
}

export function blockToFrame(block: EncodedBlock): string {
  return QRBEAM_PREFIX + bytesToBase64(blockToBinary(block));
}

export function frameToBlock(text: string): EncodedBlock | null {
  if (!isQrBeamFrame(text)) return null;
  try {
    const raw = base64ToBytes(text.slice(QRBEAM_PREFIX.length));
    const aligned =
      raw.byteOffset === 0 && raw.buffer instanceof ArrayBuffer ? raw : raw.slice();
    const block = binaryToBlock(aligned);
    return isPlausibleBlock(block) ? block : null;
  } catch {
    return null;
  }
}
