/** 本机自签名 / CA 签发 X.509（Web Crypto），PEM 导出，不写保险库。 */

import { bytesToBase64 } from "./base64Util.ts";

export type PemCertBundle = {
  certPem: string;
  keyPem: string;
  notBefore: Date;
  notAfter: Date;
  subjectCn: string;
};

export type CaMaterial = {
  certPem: string;
  keyPem: string;
  cryptoKey: CryptoKey;
  subjectCn: string;
};

function derToPem(der: Uint8Array, label: string): string {
  const b64 = bytesToBase64(der);
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----`;
}

function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN[^-]+-----/g, "")
    .replace(/-----END[^-]+-----/g, "")
    .replace(/\s/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importPkcs8PrivateKey(pem: string): Promise<CryptoKey> {
  const der = pemToDer(pem);
  return crypto.subtle.importKey(
    "pkcs8",
    new Uint8Array(der),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function encodeLen(len: number): Uint8Array {
  if (len < 128) return new Uint8Array([len]);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function wrap(tag: number, content: Uint8Array): Uint8Array {
  const len = encodeLen(content.length);
  return concat([new Uint8Array([tag]), len, content]);
}

function encodeOid(oid: string): Uint8Array {
  const parts = oid.split(".").map(Number);
  const first = parts[0]! * 40 + parts[1]!;
  const body: number[] = [first];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i]!;
    const stack: number[] = [];
    stack.unshift(v & 0x7f);
    v >>>= 7;
    while (v > 0) {
      stack.unshift((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    body.push(...stack);
  }
  return wrap(0x06, new Uint8Array(body));
}

function encodeInt(n: number | bigint): Uint8Array {
  let v = BigInt(n);
  const bytes: number[] = [];
  do {
    bytes.unshift(Number(v & 0xffn));
    v >>= 8n;
  } while (v > 0n);
  if (bytes[0]! & 0x80) bytes.unshift(0);
  return wrap(0x02, new Uint8Array(bytes));
}

function encodeBitString(bytes: Uint8Array): Uint8Array {
  return wrap(0x03, concat([new Uint8Array([0]), bytes]));
}

function encodeUtf8String(s: string): Uint8Array {
  return wrap(0x0c, new TextEncoder().encode(s));
}

function encodeUtcTime(d: Date): Uint8Array {
  const y = d.getUTCFullYear() % 100;
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const h = d.getUTCHours();
  const min = d.getUTCMinutes();
  const sec = d.getUTCSeconds();
  const s = `${y.toString().padStart(2, "0")}${m.toString().padStart(2, "0")}${day.toString().padStart(2, "0")}${h
    .toString()
    .padStart(2, "0")}${min.toString().padStart(2, "0")}${sec.toString().padStart(2, "0")}Z`;
  return wrap(0x17, new TextEncoder().encode(s));
}

function encodeSeq(parts: Uint8Array[]): Uint8Array {
  return wrap(0x30, concat(parts));
}

function encodeSet(parts: Uint8Array[]): Uint8Array {
  return wrap(0x31, concat(parts));
}

function encodeNull(): Uint8Array {
  return new Uint8Array([0x05, 0x00]);
}

const OID_CN = encodeOid("2.5.4.3");
const OID_SHA256_RSA = encodeOid("1.2.840.113549.1.1.11");
const OID_BC = encodeOid("2.5.29.19");
const OID_KU = encodeOid("2.5.29.15");

function rdnapCn(cn: string): Uint8Array {
  const atv = encodeSeq([OID_CN, encodeUtf8String(cn)]);
  const rdn = encodeSet([atv]);
  return encodeSeq([rdn]);
}

function algorithmIdentifierSha256Rsa(): Uint8Array {
  return encodeSeq([OID_SHA256_RSA, encodeNull()]);
}

function spkiFromDer(spkiDer: ArrayBuffer): Uint8Array {
  return new Uint8Array(spkiDer);
}

async function exportKeyPair(bits = 2048): Promise<{
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  spki: Uint8Array;
  pkcs8: Uint8Array;
}> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: bits,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const [spkiBuf, pkcs8Buf] = await Promise.all([
    crypto.subtle.exportKey("spki", pair.publicKey),
    crypto.subtle.exportKey("pkcs8", pair.privateKey),
  ]);
  return {
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    spki: spkiFromDer(spkiBuf),
    pkcs8: new Uint8Array(pkcs8Buf),
  };
}

function extBasicConstraints(isCa: boolean): Uint8Array {
  const inner = isCa ? new Uint8Array([0x30, 0x03, 0x01, 0x01, 0xff]) : new Uint8Array([0x30, 0x00]);
  return encodeSeq([OID_BC, new Uint8Array([0x01, 0x01, 0xff]), encodeOctet(inner)]);
}

function encodeOctet(bytes: Uint8Array): Uint8Array {
  return wrap(0x04, bytes);
}

function extKeyUsage(isCa: boolean): Uint8Array {
  const ku = isCa ? 0x06 : 0x05; // keyCertSign vs digitalSignature|keyEncipherment
  const inner = new Uint8Array([0x03, 0x03, 0x00, ku, 0x00]);
  return encodeSeq([OID_KU, new Uint8Array([0x01, 0x01, 0xff]), encodeOctet(inner)]);
}

function buildTbs(params: {
  serial: number;
  issuer: Uint8Array;
  subject: Uint8Array;
  spki: Uint8Array;
  notBefore: Date;
  notAfter: Date;
  isCa: boolean;
}): Uint8Array {
  const version = wrap(0xa0, encodeSeq([encodeInt(2)]));
  const validity = encodeSeq([encodeUtcTime(params.notBefore), encodeUtcTime(params.notAfter)]);
  const extSeq = wrap(0xa3, encodeSeq([extBasicConstraints(params.isCa), extKeyUsage(params.isCa)]));
  return encodeSeq([
    version,
    encodeInt(params.serial),
    algorithmIdentifierSha256Rsa(),
    params.issuer,
    validity,
    params.subject,
    params.spki,
    extSeq,
  ]);
}

async function signTbs(tbs: Uint8Array, privateKey: CryptoKey): Promise<Uint8Array> {
  const sig = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, privateKey, new Uint8Array(tbs));
  return new Uint8Array(sig);
}

function wrapCertificate(tbs: Uint8Array, sig: Uint8Array): Uint8Array {
  return encodeSeq([tbs, algorithmIdentifierSha256Rsa(), encodeBitString(sig)]);
}

export async function generateSelfSignedCert(options: {
  commonName: string;
  daysValid: number;
  isCa?: boolean;
  serial?: number;
}): Promise<PemCertBundle> {
  const { commonName, daysValid, isCa = false, serial = Math.floor(Math.random() * 1_000_000) + 1 } = options;
  const { privateKey, spki, pkcs8 } = await exportKeyPair(2048);
  const subject = rdnapCn(commonName);
  const notBefore = new Date();
  const notAfter = new Date(notBefore.getTime() + daysValid * 86400_000);
  const tbs = buildTbs({
    serial,
    issuer: subject,
    subject,
    spki,
    notBefore,
    notAfter,
    isCa: !!isCa,
  });
  const sig = await signTbs(tbs, privateKey);
  const certDer = wrapCertificate(tbs, sig);
  return {
    certPem: derToPem(certDer, "CERTIFICATE"),
    keyPem: derToPem(pkcs8, "PRIVATE KEY"),
    notBefore,
    notAfter,
    subjectCn: commonName,
  };
}

export async function generateCaCert(commonName: string, daysValid: number): Promise<PemCertBundle & { ca: CaMaterial }> {
  const bundle = await generateSelfSignedCert({ commonName, daysValid, isCa: true });
  const cryptoKey = await importPkcs8PrivateKey(bundle.keyPem);
  return {
    ...bundle,
    ca: { certPem: bundle.certPem, keyPem: bundle.keyPem, cryptoKey, subjectCn: commonName },
  };
}

export async function generateServerCertSignedByCa(options: {
  commonName: string;
  daysValid: number;
  ca: CaMaterial;
}): Promise<PemCertBundle> {
  const { commonName, daysValid, ca } = options;
  const { spki, pkcs8 } = await exportKeyPair(2048);
  const subject = rdnapCn(commonName);
  const issuer = rdnapCn(ca.subjectCn);
  const notBefore = new Date();
  const notAfter = new Date(notBefore.getTime() + daysValid * 86400_000);
  const tbs = buildTbs({
    serial: Math.floor(Math.random() * 1_000_000) + 1,
    issuer,
    subject,
    spki,
    notBefore,
    notAfter,
    isCa: false,
  });
  const sig = await signTbs(tbs, ca.cryptoKey);
  const certDer = wrapCertificate(tbs, sig);
  return {
    certPem: derToPem(certDer, "CERTIFICATE"),
    keyPem: derToPem(pkcs8, "PRIVATE KEY"),
    notBefore,
    notAfter,
    subjectCn: commonName,
  };
}

export function downloadTextFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export async function caMaterialFromPem(certPem: string, keyPem: string, subjectCn: string): Promise<CaMaterial> {
  return {
    certPem,
    keyPem,
    cryptoKey: await importPkcs8PrivateKey(keyPem),
    subjectCn,
  };
}
