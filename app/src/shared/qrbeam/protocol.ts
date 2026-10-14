/** 光传文件帧协议：GKB1. + base64(喷泉块)。 */

import { binaryToBlock, blockToBinary, type EncodedBlock } from "luby-transform";
import { base64ToBytes, bytesToBase64 } from "../base64Util.ts";

export const QRBEAM_PREFIX = "GKB1.";
/** 超过此大小给黄色提示，不禁止。 */
export const QRBEAM_SOFT_LIMIT_BYTES = 50 * 1024;
/** 二维码容量与帧数的折中（400–600）。 */
export const QRBEAM_DEFAULT_BLOCK_SIZE = 512;
export const QRBEAM_DEFAULT_FPS = 8;
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

/** 喷泉码至少需要 k 帧，展示用下界。 */
export function estimateNeededFrames(k: number): number {
  return Math.max(0, k);
}

export function estimateDurationSec(k: number, fps = QRBEAM_DEFAULT_FPS): number {
  const rate = fps > 0 ? fps : QRBEAM_DEFAULT_FPS;
  return estimateNeededFrames(k) / rate;
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
