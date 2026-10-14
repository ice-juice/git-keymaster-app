/** 光传接收端：喂帧、去重、会话切换、凑齐后还原文件名。 */

import { createDecoder, readFileHeaderMetaFromBuffer, type LtDecoder } from "luby-transform";
import {
  type QrBeamProgress,
  type QrBeamSessionId,
  frameToBlock,
  progressOf,
  sameSession,
  sessionIdOf,
  sessionKey,
} from "./protocol.ts";

export type QrBeamFile = {
  data: Uint8Array;
  filename: string;
  contentType: string;
};

export type QrBeamFeedResult =
  | { status: "ignored" }
  | { status: "duplicate"; progress: QrBeamProgress; sessionKey: string }
  | { status: "progress"; progress: QrBeamProgress; sessionKey: string; switched: boolean }
  | { status: "complete"; progress: QrBeamProgress; sessionKey: string; file: QrBeamFile; switched: boolean }
  | { status: "error"; message: string; progress: QrBeamProgress; limitBytes?: number };

function decodeFilename(name: string | undefined): string {
  if (!name) return "file";
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

export class QrBeamReceiver {
  #decoder: LtDecoder = createDecoder();
  #session: QrBeamSessionId | null = null;
  #seen = new Set<string>();
  #complete: QrBeamFile | null = null;

  get session(): QrBeamSessionId | null {
    return this.#session;
  }

  get progress(): QrBeamProgress {
    const k = this.#session?.k ?? 0;
    return progressOf(this.#decoder.decodedCount, k);
  }

  reset(): void {
    this.#decoder = createDecoder();
    this.#session = null;
    this.#seen.clear();
    this.#complete = null;
  }

  feed(text: string): QrBeamFeedResult {
    const block = frameToBlock(text);
    if (!block) return { status: "ignored" };

    const sid = sessionIdOf(block);
    let switched = false;
    if (this.#session && !sameSession(this.#session, sid)) {
      this.reset();
      switched = true;
    }
    if (!this.#session) this.#session = sid;

    const skey = sessionKey(sid);
    if (this.#seen.has(text)) {
      if (this.#complete) {
        return { status: "complete", progress: this.progress, sessionKey: skey, file: this.#complete, switched };
      }
      return { status: "duplicate", progress: this.progress, sessionKey: skey };
    }
    this.#seen.add(text);

    if (this.#complete) {
      return { status: "complete", progress: this.progress, sessionKey: skey, file: this.#complete, switched };
    }

    let done = false;
    try {
      done = this.#decoder.addBlock(block);
    } catch (err) {
      this.reset();
      this.#session = sid;
      this.#seen.add(text);
      switched = true;
      try {
        done = this.#decoder.addBlock(block);
      } catch (retryErr) {
        const message = retryErr instanceof Error ? retryErr.message : String(err);
        return { status: "error", message, progress: this.progress };
      }
    }

    const progress = this.progress;
    if (!done) {
      return { status: "progress", progress, sessionKey: skey, switched };
    }

    try {
      const decoded = this.#decoder.getDecoded();
      if (!decoded) {
        return { status: "progress", progress, sessionKey: skey, switched };
      }
      const [data, meta] = readFileHeaderMetaFromBuffer(decoded);
      this.#complete = {
        data,
        filename: decodeFilename(meta.filename),
        contentType: meta.contentType || "application/octet-stream",
      };
      return {
        status: "complete",
        progress: progressOf(this.#decoder.decodedCount, sid.k),
        sessionKey: skey,
        file: this.#complete,
        switched,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: "error", message, progress };
    }
  }
}

export function createQrBeamReceiver(): QrBeamReceiver {
  return new QrBeamReceiver();
}
