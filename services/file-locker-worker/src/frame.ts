import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import {
  BLOB_MAGIC,
  BLOB_VERSION,
  HEADER_LEN,
  MAX_CHUNK_SIZE,
  MAX_CIPHER_BYTES,
  MAX_PLAIN_BYTES,
  MIN_CHUNK_SIZE,
  NONCE_LEN,
  TAG_LEN,
} from "./constants.ts";

/**
 * 与保险库 `store/blob.rs` 相同的分块帧。v1 不做 HKDF，密钥就是链接 # 后的 32 字节 CK。
 *
 * ```
 * magic(4 = "GKB1") || version(1 = 1) || chunk_size(u32 LE)
 * [ nonce(24) || XChaCha20-Poly1305(chunk, aad = chunk_index u64 LE) ]*
 * ```
 *
 * 密文含 16 字节 tag。除最后一块外，每块明文长度等于 chunk_size。
 * 浏览器 WebCrypto 没有 XChaCha20-Poly1305，解密使用 @noble/ciphers。
 */

export function parseHeader(header: Uint8Array): { chunkSize: number } {
  if (header.length !== HEADER_LEN) throw new Error("header");
  for (let i = 0; i < 4; i++) {
    if (header[i] !== BLOB_MAGIC[i]) throw new Error("magic");
  }
  if (header[4] !== BLOB_VERSION) throw new Error("version");
  const bytes = Uint8Array.from(header);
  const chunkSize = new DataView(bytes.buffer).getUint32(5, true);
  if (chunkSize < MIN_CHUNK_SIZE || chunkSize > MAX_CHUNK_SIZE) throw new Error("chunk");
  return { chunkSize };
}

function aadFor(index: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(index), true);
  return out;
}

function aeadOpen(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, index: number): Uint8Array {
  try {
    return xchacha20poly1305(key, nonce, aadFor(index)).decrypt(ciphertext);
  } catch {
    throw new Error("auth");
  }
}

function assertKey(key: Uint8Array): void {
  if (key.length !== 32) throw new Error("key");
}

export function decryptBlob(data: Uint8Array, key: Uint8Array, expectedPlainSize: number): Uint8Array {
  assertKey(key);
  if (!Number.isSafeInteger(expectedPlainSize) || expectedPlainSize < 0 || expectedPlainSize > MAX_PLAIN_BYTES) throw new Error("size");
  if (data.length < HEADER_LEN || data.length > MAX_CIPHER_BYTES) throw new Error("size");
  const { chunkSize } = parseHeader(data.subarray(0, HEADER_LEN));
  const full = NONCE_LEN + chunkSize + TAG_LEN;
  const parts: Uint8Array[] = [];
  let pos = HEADER_LEN;
  let index = 0;
  while (pos < data.length) {
    const left = data.length - pos;
    if (left < NONCE_LEN + TAG_LEN) throw new Error("truncated");
    const cipherLen = Math.min(left - NONCE_LEN, chunkSize + TAG_LEN);
    if (pos + NONCE_LEN + cipherLen < data.length && NONCE_LEN + cipherLen !== full) {
      throw new Error("frame");
    }
    const nonce = data.slice(pos, pos + NONCE_LEN);
    const ct = data.slice(pos + NONCE_LEN, pos + NONCE_LEN + cipherLen);
    pos += NONCE_LEN + cipherLen;
    parts.push(aeadOpen(key, nonce, ct, index));
    index += 1;
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  if (total !== expectedPlainSize) {
    for (const part of parts) part.fill(0);
    throw new Error("truncated");
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

class ByteReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private eof = false;

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.reader = reader;
  }

  private async fill(): Promise<void> {
    if (this.eof) return;
    const { done, value } = await this.reader.read();
    if (done || !value) {
      this.eof = true;
      return;
    }
    if (value.byteLength === 0) return;
    this.chunks.push(value);
    this.buffered += value.byteLength;
  }

  async read(n: number): Promise<Uint8Array> {
    while (this.buffered < n && !this.eof) await this.fill();
    if (this.buffered < n) throw new Error("truncated");
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const head = this.chunks[0];
      if (!head) throw new Error("truncated");
      const need = n - filled;
      if (head.byteLength <= need) {
        out.set(head, filled);
        filled += head.byteLength;
        this.buffered -= head.byteLength;
        this.chunks.shift();
      } else {
        out.set(head.subarray(0, need), filled);
        this.chunks[0] = head.subarray(need);
        this.buffered -= need;
        filled = n;
      }
    }
    return out;
  }
}

export async function decryptBlobStream(
  stream: ReadableStream<Uint8Array>,
  total: number,
  key: Uint8Array,
  write: (plain: Uint8Array) => Promise<void> | void,
  expectedPlainSize: number,
): Promise<void> {
  assertKey(key);
  if (!Number.isSafeInteger(expectedPlainSize) || expectedPlainSize < 0 || expectedPlainSize > MAX_PLAIN_BYTES) throw new Error("size");
  if (!Number.isInteger(total) || total < HEADER_LEN || total > MAX_CIPHER_BYTES) {
    throw new Error("size");
  }
  const reader = new ByteReader(stream.getReader());
  const header = await reader.read(HEADER_LEN);
  const { chunkSize } = parseHeader(header);
  const full = NONCE_LEN + chunkSize + TAG_LEN;
  let pos = HEADER_LEN;
  let index = 0;
  let plaintextBytes = 0;
  while (pos < total) {
    const left = total - pos;
    if (left < NONCE_LEN + TAG_LEN) throw new Error("truncated");
    const cipherLen = Math.min(left - NONCE_LEN, chunkSize + TAG_LEN);
    if (pos + NONCE_LEN + cipherLen < total && NONCE_LEN + cipherLen !== full) {
      throw new Error("frame");
    }
    const nonce = await reader.read(NONCE_LEN);
    const ct = await reader.read(cipherLen);
    pos += NONCE_LEN + cipherLen;
    const decoded = aeadOpen(key, nonce, ct, index);
    plaintextBytes += decoded.length;
    if (plaintextBytes > MAX_PLAIN_BYTES) throw new Error("size");
    await write(decoded);
    index += 1;
  }
  if (pos !== total || plaintextBytes !== expectedPlainSize) throw new Error("truncated");
}
