export type GeneratePasswordOpts = {
  length: number;
  lower: boolean;
  upper: boolean;
  digits: boolean;
  symbols: boolean;
  excludeAmbiguous: boolean;
};

export const DEFAULT_PASSWORD_OPTS: GeneratePasswordOpts = {
  length: 16,
  lower: true,
  upper: true,
  digits: true,
  symbols: true,
  excludeAmbiguous: true,
};

const LOWER_ALL = "abcdefghijklmnopqrstuvwxyz";
const LOWER_SAFE = "abcdefghijkmnopqrstuvwxyz";
const UPPER_ALL = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const UPPER_SAFE = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS_ALL = "0123456789";
const DIGITS_SAFE = "23456789";
const SYMBOLS = "!@#$%^&*_-+=?";

export function passwordPools(opts: Pick<GeneratePasswordOpts, "lower" | "upper" | "digits" | "symbols" | "excludeAmbiguous">): string[] {
  const pools: string[] = [];
  if (opts.lower) pools.push(opts.excludeAmbiguous ? LOWER_SAFE : LOWER_ALL);
  if (opts.upper) pools.push(opts.excludeAmbiguous ? UPPER_SAFE : UPPER_ALL);
  if (opts.digits) pools.push(opts.excludeAmbiguous ? DIGITS_SAFE : DIGITS_ALL);
  if (opts.symbols) pools.push(SYMBOLS);
  return pools;
}

/** 用 rejection sampling 在 `[0, maxExclusive)` 上取无偏整数。 */
export function unbiasedInt(maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 256) {
    throw new Error("unbiasedInt: maxExclusive must be 1..256");
  }
  const max = 256 - (256 % maxExclusive);
  const buf = new Uint8Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < max) return buf[0] % maxExclusive;
  }
}

export function generatePassword(opts: GeneratePasswordOpts): string {
  const length = Math.max(4, Math.min(128, Math.floor(opts.length) || 0));
  const pools = passwordPools(opts);
  const alphabet = pools.join("");
  if (!alphabet) {
    throw new Error("no charset");
  }

  const chars: string[] = [];
  for (const pool of pools) {
    if (chars.length >= length) break;
    chars.push(pool[unbiasedInt(pool.length)]);
  }
  while (chars.length < length) {
    chars.push(alphabet[unbiasedInt(alphabet.length)]);
  }
  for (let i = chars.length - 1; i > 0; i--) {
    const j = unbiasedInt(i + 1);
    const tmp = chars[i];
    chars[i] = chars[j];
    chars[j] = tmp;
  }
  return chars.join("");
}
