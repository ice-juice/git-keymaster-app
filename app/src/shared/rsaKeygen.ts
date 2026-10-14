/** 浏览器 Web Crypto 生成 RSA 密钥对并导出 PEM。仅内存展示，不写入保险库。 */

export type RsaModulus = 2048 | 4096;

export type RsaPemPair = {
  publicPem: string;
  privatePem: string;
  modulusLength: RsaModulus;
};

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function derToPem(der: ArrayBuffer, label: string): string {
  const b64 = bytesToBase64(new Uint8Array(der));
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----`;
}

export async function generateRsaPem(modulusLength: RsaModulus = 2048): Promise<RsaPemPair> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const [spki, pkcs8] = await Promise.all([
    crypto.subtle.exportKey("spki", pair.publicKey),
    crypto.subtle.exportKey("pkcs8", pair.privateKey),
  ]);
  return {
    publicPem: derToPem(spki, "PUBLIC KEY"),
    privatePem: derToPem(pkcs8, "PRIVATE KEY"),
    modulusLength,
  };
}
