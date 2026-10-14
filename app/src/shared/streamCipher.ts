/** RC4 与 Rabbit 流密码（纯 JS）。 */

export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) & 255;
    const t = s[i]!;
    s[i] = s[j]!;
    s[j] = t;
  }
  const out = new Uint8Array(data.length);
  let i = 0;
  j = 0;
  for (let n = 0; n < data.length; n++) {
    i = (i + 1) & 255;
    j = (j + s[i]!) & 255;
    const t = s[i]!;
    s[i] = s[j]!;
    s[j] = t;
    const k = s[(s[i]! + s[j]!) & 255]!;
    out[n] = data[n]! ^ k;
  }
  return out;
}

/** Rabbit（eSTREAM 128-bit key + 64-bit IV），IV 取前 8 字节。 */
export function rabbit(key: Uint8Array, data: Uint8Array, iv?: Uint8Array): Uint8Array {
  const k = new Uint8Array(16);
  k.set(key.subarray(0, 16));
  if (key.length < 16) {
    for (let i = key.length; i < 16; i++) k[i] = key[i % key.length]!;
  }
  const iv8 = new Uint8Array(8);
  if (iv && iv.length) iv8.set(iv.subarray(0, 8));

  const x = new Uint32Array(8);
  const c = new Uint32Array(8);
  for (let i = 0; i < 8; i++) {
    if (i % 2 === 0) {
      x[i] = (k[i * 2]! | (k[i * 2 + 1]! << 8) | (k[i * 2 + 2]! << 16) | (k[i * 2 + 3]! << 24)) >>> 0;
    } else {
      x[i] =
        (k[(i * 2 + 8) % 16]! |
          (k[(i * 2 + 9) % 16]! << 8) |
          (k[(i * 2 + 10) % 16]! << 16) |
          (k[(i * 2 + 11) % 16]! << 24)) >>>
        0;
    }
  }
  for (let i = 0; i < 8; i++) {
    c[i] = (iv8[i % 8]! | (iv8[(i + 1) % 8]! << 8) | (iv8[(i + 2) % 8]! << 16) | (iv8[(i + 3) % 8]! << 24)) >>> 0;
  }

  function rot32(v: number, n: number): number {
    return ((v << n) | (v >>> (32 - n))) >>> 0;
  }

  function next(): number {
    let g = new Uint32Array(8);
    for (let j = 0; j < 8; j++) {
      g[j] = (x[j]! + c[j]!) >>> 0;
    }
    c[0] = (c[0]! + 0x4d34d34d + (c[7]! >>> 0)) >>> 0;
    c[1] = (c[1]! + 0xd34d34d3 + (c[0]! >>> 0)) >>> 0;
    c[2] = (c[2]! + 0x34d34d34 + (c[1]! >>> 0)) >>> 0;
    c[3] = (c[3]! + 0x4d34d34d + (c[2]! >>> 0)) >>> 0;
    c[4] = (c[4]! + 0xd34d34d3 + (c[3]! >>> 0)) >>> 0;
    c[5] = (c[5]! + 0x34d34d34 + (c[4]! >>> 0)) >>> 0;
    c[6] = (c[6]! + 0x4d34d34d + (c[5]! >>> 0)) >>> 0;
    c[7] = (c[7]! + 0xd34d34d3 + (c[6]! >>> 0)) >>> 0;

    const xNew = new Uint32Array(8);
    xNew[0] = (g[0]! + rot32(g[7]!, 16) + rot32(g[6]!, 16)) >>> 0;
    xNew[1] = (g[1]! + rot32(g[0]!, 8) + g[7]!) >>> 0;
    xNew[2] = (g[2]! + rot32(g[1]!, 16) + rot32(g[0]!, 16)) >>> 0;
    xNew[3] = (g[3]! + rot32(g[2]!, 8) + g[1]!) >>> 0;
    xNew[4] = (g[4]! + rot32(g[3]!, 16) + rot32(g[2]!, 16)) >>> 0;
    xNew[5] = (g[5]! + rot32(g[4]!, 8) + g[3]!) >>> 0;
    xNew[6] = (g[6]! + rot32(g[5]!, 16) + rot32(g[4]!, 16)) >>> 0;
    xNew[7] = (g[7]! + rot32(g[6]!, 8) + g[5]!) >>> 0;
    for (let j = 0; j < 8; j++) x[j] = xNew[j]!;

    return (g[0]! ^ (g[5]! >>> 16) ^ (g[3]! << 16)) >>> 0;
  }

  // IV setup rounds
  for (let r = 0; r < 4; r++) next();

  const out = new Uint8Array(data.length);
  let idx = 0;
  let word = 0;
  let used = 4;
  for (let n = 0; n < data.length; n++) {
    if (used >= 4) {
      word = next();
      used = 0;
    }
    out[n] = data[n]! ^ ((word >>> (used * 8)) & 0xff);
    used++;
    idx++;
  }
  void idx;
  return out;
}
