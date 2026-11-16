import { MAX_PLAIN_BYTES } from "./constants.ts";

const encoder = new TextEncoder();
function b64urlDecode(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - s.length % 4) % 4));
    return Uint8Array.from(bin, c => c.charCodeAt(0));
  } catch { return null; }
}

export function safeDownloadName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  const cleaned = [...base.replace(/[\u0000-\u001f]/g, "").replace(/^\.+/, "")].slice(0, 80).join("").trim();
  return !cleaned || cleaned === "." || cleaned === ".." ? "download.bin" : cleaned;
}

export type ShareFragment = { key: Uint8Array; filename: string; plainSize: number };

/** Only accept size/name/service/slug metadata authenticated by the content key.
 * Old fragments cannot establish whole-file integrity and must be re-shared. */
export async function parseFragment(hash: string, base: string, slug: string): Promise<ShareFragment | null> {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw.length > 2048 || !/^[A-Za-z0-9]{10}$/.test(slug)) return null;
  const parts = raw.split(".");
  if (parts.length !== 5 || parts[0] !== "v2" || !/^(0|[1-9][0-9]{0,8})$/.test(parts[2])) return null;
  const plainSize = Number(parts[2]);
  if (!Number.isSafeInteger(plainSize) || plainSize > MAX_PLAIN_BYTES) return null;
  const key = b64urlDecode(parts[1]);
  if (!key || key.length !== 32) { key?.fill(0); return null; }
  let accepted = false;
  let derived: Uint8Array | undefined;
  try {
    const parsedBase = new URL(base);
    if (!["https:", "http:"].includes(parsedBase.protocol) || parsedBase.username || parsedBase.password || parsedBase.search || parsedBase.hash) return null;
    const canonicalBase = parsedBase.href.replace(/\/+$/, "");
    const tag = b64urlDecode(parts[4]);
    const nameBytes = b64urlDecode(parts[3]);
    if (!tag || tag.length !== 32 || !nameBytes) return null;
    const name = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(nameBytes);
    const rawKey = await crypto.subtle.importKey("raw", Uint8Array.from(key).buffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    derived = new Uint8Array(await crypto.subtle.sign("HMAC", rawKey, encoder.encode("gam-locker-share-auth-key-v2")));
    const authKey = await crypto.subtle.importKey("raw", Uint8Array.from(derived).buffer, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const payload = encoder.encode(`gam-locker-share-v2\n${canonicalBase}\n${slug}\n${plainSize}\n${parts[3]}`);
    if (!await crypto.subtle.verify("HMAC", authKey, Uint8Array.from(tag).buffer, payload)) return null;
    accepted = true;
    return { key, filename: safeDownloadName(name), plainSize };
  } catch { return null; }
  finally { derived?.fill(0); if (!accepted) key.fill(0); }
}
