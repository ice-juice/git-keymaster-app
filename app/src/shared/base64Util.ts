/** UTF-8 安全的 Base64，仅本地工具使用。 */

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s/g, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function base64EncodeUtf8(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

export function base64DecodeUtf8(b64: string): string {
  return new TextDecoder().decode(base64ToBytes(b64));
}
