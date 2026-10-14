/** 光传发送端：文件头 meta + 低度数喷泉块，逐帧产出 GKB1. 文本。 */

import { appendFileHeaderMetaToBuffer, createEncoder, type EncodedBlock, type LtEncoder } from "luby-transform";
import {
  QRBEAM_DEFAULT_BLOCK_SIZE,
  QRBEAM_DEFAULT_FPS,
  QRBEAM_MAX_K,
  QRBEAM_TOO_LARGE,
  blockToFrame,
  effectiveBlockSize,
  estimateCameraFrames,
  estimateDurationSec,
  exceedsHardLimit,
  exceedsSoftLimit,
} from "./protocol.ts";

export type QrBeamSenderOptions = {
  filename: string;
  contentType?: string;
  blockSize?: number;
  compress?: boolean;
  fps?: number;
};

export type QrBeamSender = {
  k: number;
  bytes: number;
  checksum: number;
  blockSize: number;
  overSoftLimit: boolean;
  neededFrames: number;
  estimateSec: number;
  nextBlock(): EncodedBlock;
  nextFrame(): string;
  frames(): Generator<string, never>;
};

function encodeFilename(name: string): string {
  const trimmed = name.trim() || "file";
  return encodeURIComponent(trimmed);
}

/**
 * 先按顺序送出每个源块（度数 1），再夹一个度数 2 的修复块。
 * 理想孤子的高度数帧会让大文件的二维码密到手机解不开，所以这里不使用它。
 */
function* scanBlocks(encoder: LtEncoder): Generator<EncodedBlock, never> {
  const k = encoder.k;
  if (k < 1) throw new Error("qrbeam_empty");
  let round = 0;
  while (true) {
    for (let i = 0; i < k; i++) {
      yield encoder.createBlock([i]);
      if (k < 2) continue;
      const span = k - 1;
      let j = (i + 1 + (round % span)) % k;
      if (j === i) j = (i + 1) % k;
      const indices = i < j ? [i, j] : [j, i];
      yield encoder.createBlock(indices);
    }
    round += 1;
  }
}

export function createQrBeamSender(data: Uint8Array, options: QrBeamSenderOptions): QrBeamSender {
  const requested = options.blockSize ?? QRBEAM_DEFAULT_BLOCK_SIZE;
  const blockSize = effectiveBlockSize(requested);
  if (exceedsHardLimit(data.byteLength, blockSize)) {
    throw new Error(QRBEAM_TOO_LARGE);
  }
  const merged = appendFileHeaderMetaToBuffer(data, {
    filename: encodeFilename(options.filename),
    contentType: options.contentType || "application/octet-stream",
  });
  const encoder = createEncoder(merged, blockSize, options.compress);
  if (encoder.k > QRBEAM_MAX_K || encoder.k < 1) {
    throw new Error(QRBEAM_TOO_LARGE);
  }
  const shared = scanBlocks(encoder);
  const fps = options.fps ?? QRBEAM_DEFAULT_FPS;

  return {
    k: encoder.k,
    bytes: encoder.bytes,
    checksum: encoder.checksum,
    blockSize,
    overSoftLimit: exceedsSoftLimit(data.byteLength),
    neededFrames: estimateCameraFrames(encoder.k),
    estimateSec: estimateDurationSec(encoder.k, fps),
    nextBlock() {
      return shared.next().value;
    },
    nextFrame() {
      return blockToFrame(shared.next().value);
    },
    *frames(): Generator<string, never> {
      for (const block of scanBlocks(encoder)) yield blockToFrame(block);
      throw new Error("qrbeam_frames_ended");
    },
  };
}

export function takeQrBeamFrames(sender: QrBeamSender, count: number): string[] {
  const out: string[] = [];
  for (const frame of sender.frames()) {
    out.push(frame);
    if (out.length >= count) break;
  }
  return out;
}
