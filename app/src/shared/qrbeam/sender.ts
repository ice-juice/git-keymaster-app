/** 光传发送端：文件头 meta + 喷泉编码，逐帧产出 GKB1. 文本。 */

import { appendFileHeaderMetaToBuffer, createEncoder, type EncodedBlock } from "luby-transform";
import {
  QRBEAM_DEFAULT_BLOCK_SIZE,
  QRBEAM_DEFAULT_FPS,
  blockToFrame,
  estimateDurationSec,
  estimateNeededFrames,
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

export function createQrBeamSender(data: Uint8Array, options: QrBeamSenderOptions): QrBeamSender {
  const blockSize = options.blockSize ?? QRBEAM_DEFAULT_BLOCK_SIZE;
  if (!Number.isInteger(blockSize) || blockSize <= 0) {
    throw new Error("qrbeam_invalid_block_size");
  }
  const merged = appendFileHeaderMetaToBuffer(data, {
    filename: encodeFilename(options.filename),
    contentType: options.contentType || "application/octet-stream",
  });
  const encoder = createEncoder(merged, blockSize, options.compress);
  const shared = encoder.fountain();
  const fps = options.fps ?? QRBEAM_DEFAULT_FPS;

  return {
    k: encoder.k,
    bytes: encoder.bytes,
    checksum: encoder.checksum,
    blockSize,
    overSoftLimit: exceedsSoftLimit(data.byteLength),
    neededFrames: estimateNeededFrames(encoder.k),
    estimateSec: estimateDurationSec(encoder.k, fps),
    nextBlock() {
      return shared.next().value;
    },
    nextFrame() {
      return blockToFrame(shared.next().value);
    },
    *frames(): Generator<string, never> {
      const blocks = encoder.fountain();
      while (true) {
        yield blockToFrame(blocks.next().value);
      }
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
