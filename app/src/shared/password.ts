export const PASSWORD_ROOT_POSITIONS = ["head", "tail", "mid"] as const;
export type PasswordRootPosition = (typeof PASSWORD_ROOT_POSITIONS)[number];

export type GeneratePasswordOpts = {
  length: number;
  lower: boolean;
  upper: boolean;
  digits: boolean;
  symbols: boolean;
  excludeAmbiguous: boolean;
  /** 原样拼入。空或纯空白时忽略，不改写非空词根。 */
  root?: string;
  /** 默认开头。 */
  rootPosition?: PasswordRootPosition;
};

export const DEFAULT_PASSWORD_OPTS: GeneratePasswordOpts = {
  length: 16,
  lower: true,
  upper: true,
  digits: true,
  symbols: true,
  excludeAmbiguous: true,
  root: "",
  rootPosition: "head",
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

function clampPasswordLength(length: number): number {
  return Math.max(4, Math.min(128, Math.floor(length) || 0));
}

/** 纯空白视为未设置；其余字符（含首尾空格）原样保留。 */
export function passwordRootText(root: string | undefined): string {
  if (!root || root.trim() === "") return "";
  return root;
}

export function passwordRootTooLong(opts: Pick<GeneratePasswordOpts, "length" | "root">): boolean {
  const root = passwordRootText(opts.root);
  if (!root) return false;
  return root.length >= clampPasswordLength(opts.length);
}

function fillPassword(length: number, opts: GeneratePasswordOpts): string {
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

function placePasswordRoot(randomPart: string, root: string, position: PasswordRootPosition): string {
  if (position === "tail") return randomPart + root;
  if (position === "mid") {
    const front = Math.ceil(randomPart.length / 2);
    return randomPart.slice(0, front) + root + randomPart.slice(front);
  }
  return root + randomPart;
}

export function generatePassword(opts: GeneratePasswordOpts): string {
  const length = clampPasswordLength(opts.length);
  const root = passwordRootText(opts.root);
  if (!root) return fillPassword(length, opts);

  const randomLen = Math.max(0, length - root.length);
  if (randomLen === 0) return root;
  return placePasswordRoot(fillPassword(randomLen, opts), root, opts.rootPosition ?? "head");
}
