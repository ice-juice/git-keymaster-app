/** DES / 3DES 块密码（CBC + PKCS#7），纯 JS，供本地工具使用。 */

const IP = [
  58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6, 64, 56,
  48, 40, 32, 24, 16, 8, 57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37,
  29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7,
];
const FP = [
  40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14, 54, 22, 62, 30, 37, 5,
  45, 13, 53, 21, 61, 29, 36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27, 34, 2, 42, 10,
  50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25,
];
const E = [
  32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17, 16, 17, 18, 19, 20,
  21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1,
];
const P = [
  16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30,
  6, 22, 11, 4, 25,
];
const SBOX = [
  [
    [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7],
    [0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8],
    [4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0],
    [15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
  ],
  [
    [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10],
    [3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5],
    [0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15],
    [13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
  ],
  [
    [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8],
    [13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1],
    [13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7],
    [1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
  ],
  [
    [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15],
    [13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9],
    [10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4],
    [3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
  ],
  [
    [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9],
    [14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6],
    [4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14],
    [11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
  ],
  [
    [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11],
    [10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8],
    [9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6],
    [4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
  ],
  [
    [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1],
    [13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6],
    [1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2],
    [6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
  ],
  [
    [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7],
    [1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2],
    [7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8],
    [2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
  ],
];
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
const PC1 = [
  57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44,
  36, 63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20,
  12, 4,
];
const PC2 = [
  14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2, 41, 52, 31, 37,
  47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32,
];

function permute(table: number[], input: number[]): number[] {
  const out = new Array<number>(table.length);
  for (let i = 0; i < table.length; i++) out[i] = input[table[i]! - 1]!;
  return out;
}

function bitsFromBytes(block: Uint8Array): number[] {
  const bits = new Array<number>(64);
  for (let i = 0; i < 8; i++) {
    const b = block[i]!;
    for (let j = 0; j < 8; j++) bits[i * 8 + j] = (b >>> (7 - j)) & 1;
  }
  return bits;
}

function bytesFromBits(bits: number[]): Uint8Array {
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j]!;
    out[i] = v;
  }
  return out;
}

function leftShift28(bits: number[], n: number): number[] {
  const out = bits.slice();
  for (let i = 0; i < n; i++) {
    const first = out.shift()!;
    out.push(first);
  }
  return out;
}

function expandKey(key8: Uint8Array): number[][] {
  const kb = bitsFromBytes(key8);
  const perm = permute(PC1, kb);
  let c = perm.slice(0, 28);
  let d = perm.slice(28, 56);
  const subkeys: number[][] = [];
  for (let round = 0; round < 16; round++) {
    c = leftShift28(c, SHIFTS[round]!);
    d = leftShift28(d, SHIFTS[round]!);
    subkeys.push(permute(PC2, [...c, ...d]));
  }
  return subkeys;
}

function feistel(right: number[], subkey: number[]): number[] {
  const expanded = permute(E, right);
  for (let i = 0; i < 48; i++) expanded[i]! ^= subkey[i]!;
  const out = new Array<number>(32).fill(0);
  for (let s = 0; s < 8; s++) {
    const chunk = expanded.slice(s * 6, s * 6 + 6);
    const row = (chunk[0]! << 1) | chunk[5]!;
    const col = (chunk[1]! << 3) | (chunk[2]! << 2) | (chunk[3]! << 1) | chunk[4]!;
    const val = SBOX[s]![row]![col]!;
    for (let b = 0; b < 4; b++) out[s * 4 + b] = (val >>> (3 - b)) & 1;
  }
  return permute(P, out);
}

function desBlock(block: Uint8Array, key8: Uint8Array, decrypt: boolean): Uint8Array {
  const subkeys = expandKey(key8);
  const order = decrypt ? [...subkeys].reverse() : subkeys;
  let bits = permute(IP, bitsFromBytes(block));
  let left = bits.slice(0, 32);
  let right = bits.slice(32, 64);
  for (let r = 0; r < 16; r++) {
    const f = feistel(right, order[r]!);
    const newRight = left.map((b, i) => b ^ f[i]!);
    left = right;
    right = newRight;
  }
  bits = [...right, ...left];
  bits = permute(FP, bits);
  return bytesFromBits(bits);
}

function pkcs7Pad(data: Uint8Array, blockSize: number): Uint8Array {
  const pad = blockSize - (data.length % blockSize || blockSize);
  const out = new Uint8Array(data.length + pad);
  out.set(data);
  out.fill(pad, data.length);
  return out;
}

function pkcs7Unpad(data: Uint8Array): Uint8Array {
  if (!data.length) throw new Error("bad_padding");
  const pad = data[data.length - 1]!;
  if (pad < 1 || pad > 8 || pad > data.length) throw new Error("bad_padding");
  for (let i = data.length - pad; i < data.length; i++) {
    if (data[i] !== pad) throw new Error("bad_padding");
  }
  return data.slice(0, data.length - pad);
}

function normalizeKey8(key: Uint8Array): Uint8Array {
  const out = new Uint8Array(8);
  out.set(key.subarray(0, 8));
  return out;
}

function normalizeKey24(key: Uint8Array): Uint8Array {
  const out = new Uint8Array(24);
  if (key.length >= 24) out.set(key.subarray(0, 24));
  else {
    out.set(key);
    for (let i = key.length; i < 24; i++) out[i] = key[i % key.length]!;
  }
  return out;
}

function cbcCrypt(
  data: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
  blockFn: (block: Uint8Array, key: Uint8Array, decrypt: boolean) => Uint8Array,
  decrypt: boolean,
): Uint8Array {
  const padded = decrypt ? data : pkcs7Pad(data, 8);
  const out = new Uint8Array(padded.length);
  let prev = new Uint8Array(iv.slice(0, 8));
  for (let off = 0; off < padded.length; off += 8) {
    const block = padded.subarray(off, off + 8);
    if (!decrypt) {
      const xored = new Uint8Array(8);
      for (let i = 0; i < 8; i++) xored[i] = block[i]! ^ prev[i]!;
      const enc = blockFn(xored, key, false);
      out.set(enc, off);
      prev = new Uint8Array(enc);
    } else {
      const dec = blockFn(block, key, true);
      const plain = new Uint8Array(8);
      for (let i = 0; i < 8; i++) plain[i] = dec[i]! ^ prev[i]!;
      out.set(plain, off);
      prev = new Uint8Array(block);
    }
  }
  return decrypt ? pkcs7Unpad(out) : out;
}

function tripleDesBlock(block: Uint8Array, key24: Uint8Array, decrypt: boolean): Uint8Array {
  const k1 = key24.subarray(0, 8);
  const k2 = key24.subarray(8, 16);
  const k3 = key24.subarray(16, 24);
  if (!decrypt) {
    return desBlock(desBlock(desBlock(block, k1, false), k2, true), k3, false);
  }
  return desBlock(desBlock(desBlock(block, k3, true), k2, false), k1, true);
}

export function desCbcEncrypt(plain: Uint8Array, key: Uint8Array, iv: Uint8Array): Uint8Array {
  return cbcCrypt(plain, normalizeKey8(key), iv, desBlock, false);
}

export function desCbcDecrypt(cipher: Uint8Array, key: Uint8Array, iv: Uint8Array): Uint8Array {
  return cbcCrypt(cipher, normalizeKey8(key), iv, desBlock, true);
}

export function tripleDesCbcEncrypt(plain: Uint8Array, key: Uint8Array, iv: Uint8Array): Uint8Array {
  return cbcCrypt(plain, normalizeKey24(key), iv, tripleDesBlock, false);
}

export function tripleDesCbcDecrypt(cipher: Uint8Array, key: Uint8Array, iv: Uint8Array): Uint8Array {
  return cbcCrypt(cipher, normalizeKey24(key), iv, tripleDesBlock, true);
}
