/** 本地对称加解密：AES-GCM（Web Crypto）+ DES/3DES/RC4/Rabbit（纯 JS）。 */

import { bytesToBase64, base64ToBytes } from "./base64Util.ts";
import { desCbcDecrypt, desCbcEncrypt, tripleDesCbcDecrypt, tripleDesCbcEncrypt } from "./desCore.ts";
import { rabbit, rc4 } from "./streamCipher.ts";

export type SymAlgo = "aes" | "des" | "3des" | "rc4" | "rabbit";

async function sha256Bytes(text: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return new Uint8Array(digest);
}

async function importAesKey(passphrase: string): Promise<CryptoKey> {
  const raw = await sha256Bytes(passphrase);
  return crypto.subtle.importKey("raw", new Uint8Array(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function aesEncrypt(plainText: string, passphrase: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importAesKey(passphrase);
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plainText),
  );
  const packed = new Uint8Array(iv.length + cipher.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(cipher), iv.length);
  return `aes1:${bytesToBase64(packed)}`;
}

export async function aesDecrypt(payload: string, passphrase: string): Promise<string> {
  const raw = payload.startsWith("aes1:") ? payload.slice(5) : payload;
  const packed = base64ToBytes(raw);
  if (packed.length < 13) throw new Error("bad_aes_payload");
  const iv = packed.subarray(0, 12);
  const data = packed.subarray(12);
  const key = await importAesKey(passphrase);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(iv) },
    key,
    new Uint8Array(data),
  );
  return new TextDecoder().decode(plain);
}

function keyBytes(passphrase: string, len: number): Uint8Array {
  const src = new TextEncoder().encode(passphrase);
  const out = new Uint8Array(len);
  if (!src.length) return out;
  out.set(src.subarray(0, len));
  for (let i = src.length; i < len; i++) out[i] = src[i % src.length]!;
  return out;
}

function iv8(passphrase: string, salt: string): Uint8Array {
  const mix = new TextEncoder().encode(`${salt}:${passphrase}`);
  const out = new Uint8Array(8);
  out.set(mix.subarray(0, 8));
  for (let i = mix.length; i < 8; i++) out[i] = mix[i % mix.length]!;
  return out;
}

export function desEncrypt(plainText: string, passphrase: string): string {
  const plain = new TextEncoder().encode(plainText);
  const key = keyBytes(passphrase, 8);
  const iv = iv8(passphrase, "des");
  const cipher = desCbcEncrypt(plain, key, iv);
  return `des1:${bytesToBase64(cipher)}`;
}

export function desDecrypt(payload: string, passphrase: string): string {
  const raw = payload.startsWith("des1:") ? payload.slice(5) : payload;
  const key = keyBytes(passphrase, 8);
  const iv = iv8(passphrase, "des");
  const plain = desCbcDecrypt(base64ToBytes(raw), key, iv);
  return new TextDecoder().decode(plain);
}

export function tripleDesEncrypt(plainText: string, passphrase: string): string {
  const plain = new TextEncoder().encode(plainText);
  const key = keyBytes(passphrase, 24);
  const iv = iv8(passphrase, "3des");
  const cipher = tripleDesCbcEncrypt(plain, key, iv);
  return `tdes1:${bytesToBase64(cipher)}`;
}

export function tripleDesDecrypt(payload: string, passphrase: string): string {
  const raw = payload.startsWith("tdes1:") ? payload.slice(6) : payload;
  const key = keyBytes(passphrase, 24);
  const iv = iv8(passphrase, "3des");
  const plain = tripleDesCbcDecrypt(base64ToBytes(raw), key, iv);
  return new TextDecoder().decode(plain);
}

export function rc4Encrypt(plainText: string, passphrase: string): string {
  const key = new TextEncoder().encode(passphrase);
  const plain = new TextEncoder().encode(plainText);
  return `rc41:${bytesToBase64(rc4(key, plain))}`;
}

export function rc4Decrypt(payload: string, passphrase: string): string {
  const raw = payload.startsWith("rc41:") ? payload.slice(5) : payload;
  const key = new TextEncoder().encode(passphrase);
  const plain = rc4(key, base64ToBytes(raw));
  return new TextDecoder().decode(plain);
}

export function rabbitEncrypt(plainText: string, passphrase: string): string {
  const key = keyBytes(passphrase, 16);
  const iv = iv8(passphrase, "rabbit");
  const plain = new TextEncoder().encode(plainText);
  return `rb1:${bytesToBase64(rabbit(key, plain, iv))}`;
}

export function rabbitDecrypt(payload: string, passphrase: string): string {
  const raw = payload.startsWith("rb1:") ? payload.slice(4) : payload;
  const key = keyBytes(passphrase, 16);
  const iv = iv8(passphrase, "rabbit");
  const plain = rabbit(key, base64ToBytes(raw), iv);
  return new TextDecoder().decode(plain);
}

export async function symEncrypt(algo: SymAlgo, plainText: string, passphrase: string): Promise<string> {
  switch (algo) {
    case "aes":
      return aesEncrypt(plainText, passphrase);
    case "des":
      return desEncrypt(plainText, passphrase);
    case "3des":
      return tripleDesEncrypt(plainText, passphrase);
    case "rc4":
      return rc4Encrypt(plainText, passphrase);
    case "rabbit":
      return rabbitEncrypt(plainText, passphrase);
    default:
      throw new Error("unknown_algo");
  }
}

export async function symDecrypt(algo: SymAlgo, payload: string, passphrase: string): Promise<string> {
  switch (algo) {
    case "aes":
      return aesDecrypt(payload, passphrase);
    case "des":
      return desDecrypt(payload, passphrase);
    case "3des":
      return tripleDesDecrypt(payload, passphrase);
    case "rc4":
      return rc4Decrypt(payload, passphrase);
    case "rabbit":
      return rabbitDecrypt(payload, passphrase);
    default:
      throw new Error("unknown_algo");
  }
}
