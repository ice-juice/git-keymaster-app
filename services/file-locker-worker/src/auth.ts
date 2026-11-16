import { MAX_SKEW_SEC, MIN_SECRET_LEN, NONCE_HEX_LEN, PICKUP_CODE_LABEL } from "./constants.ts";

const enc = new TextEncoder();

/** 去掉首尾空白。wrangler secret put 偶尔会带上换行。App 侧填的是去掉空白后的同一串。 */
export function normalizeSecret(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  const secret = raw.trim();
  if (secret.length < MIN_SECRET_LEN) return null;
  return secret;
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function hmacKey(secretBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(new Uint8Array(digest));
}

/**
 * 与 locker/worker.rs 的 canonical 逐字节一致：
 * {unix秒}\n{nonce小写hex}\n{METHOD}\n{path}\n{body的SHA-256小写hex}
 */
export function canonicalAuth(
  timestamp: string,
  nonceHex: string,
  method: string,
  path: string,
  bodyHashHex: string,
): string {
  return `${timestamp}\n${nonceHex}\n${method.toUpperCase()}\n${path}\n${bodyHashHex}`;
}

export async function signRequest(
  secret: string,
  timestamp: string,
  nonceHex: string,
  method: string,
  path: string,
  body: Uint8Array,
): Promise<string> {
  const bodyHash = await sha256Hex(body);
  const canonical = canonicalAuth(timestamp, nonceHex.toLowerCase(), method, path, bodyHash);
  const key = await hmacKey(enc.encode(secret));
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(canonical));
  return toHex(new Uint8Array(sig));
}

export async function verifyRequest(
  secret: string,
  method: string,
  path: string,
  body: Uint8Array,
  timestampHeader: string | null,
  nonceHeader: string | null,
  signatureHeader: string | null,
  nowMs: number,
): Promise<boolean> {
  const tsRaw = (timestampHeader ?? "").trim();
  const nonceHex = (nonceHeader ?? "").trim().toLowerCase();
  const sigHex = (signatureHeader ?? "").trim().toLowerCase();
  if (!/^\d{1,12}$/.test(tsRaw)) return false;
  if (!new RegExp(`^[0-9a-f]{${NONCE_HEX_LEN}}$`).test(nonceHex)) return false;
  if (!/^[0-9a-f]{64}$/.test(sigHex)) return false;
  const ts = Number(tsRaw);
  const nowSec = Math.floor(nowMs / 1000);
  if (Math.abs(nowSec - ts) > MAX_SKEW_SEC) return false;
  const sig = hexToBytes(sigHex);
  if (!sig) return false;
  const bodyHash = await sha256Hex(body);
  const canonical = canonicalAuth(tsRaw, nonceHex, method, path, bodyHash);
  const key = await hmacKey(enc.encode(secret));
  return crypto.subtle.verify("HMAC", key, sig, enc.encode(canonical));
}

/** 与 pickup_code_hash 相同：HMAC-SHA256(key = gam-locker-code-v1, msg = 六位码)。 */
export async function hashPickupCode(code: string): Promise<string> {
  const key = await hmacKey(enc.encode(PICKUP_CODE_LABEL));
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(code));
  return toHex(new Uint8Array(sig));
}

export async function pickupMatches(code: string, codeHashHex: string): Promise<boolean> {
  const hex = codeHashHex.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) return false;
  const sig = hexToBytes(hex);
  if (!sig) return false;
  const key = await hmacKey(enc.encode(PICKUP_CODE_LABEL));
  return crypto.subtle.verify("HMAC", key, sig, enc.encode(code));
}