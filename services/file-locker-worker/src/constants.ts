/** 与御钥师 App locker/worker.rs、locker/mod.rs 对齐的契约常量。 */

export const SLUG_LEN = 10;
export const PICKUP_CODE_LEN = 6;
/** Plaintext cap plus bounded framing overhead. */
export const MAX_PLAIN_BYTES = 100 * 1024 * 1024;
export const MAX_CIPHER_BYTES = MAX_PLAIN_BYTES + 64 * 1024;
/** GKB1 头最少 9 字节。空明文也有头。 */
export const MIN_CIPHER_BYTES = 9;
export const MAX_PULLS = 4_294_967_295;
export const LOCK_STREAK = 5;
export const REVOKE_FAILS = 20;
export const LOCK_MS = 15 * 60 * 1000;
export const MAX_SKEW_SEC = 300;
export const MIN_SECRET_LEN = 16;
/** 单次 Cron 最多焚毁条数，避免免费档子请求打满。 */
export const SWEEP_LIMIT = 40;
/** 与 App resolve_put_policy 的最长存放时间一致。 */
export const MAX_EXPIRE_MS = 100 * 366 * 24 * 60 * 60 * 1000;

/** 取件码 HMAC 的公开密钥字节，等于 LABEL_LOCKER_CODE。不是共享密钥。 */
export const PICKUP_CODE_LABEL = "gam-locker-code-v1";
/** X-Locker-Nonce：16 字节随机数的小写 hex。 */
export const NONCE_HEX_LEN = 32;

export const BLOB_MAGIC = new Uint8Array([0x47, 0x4b, 0x42, 0x31]); // "GKB1"
export const BLOB_VERSION = 1;
export const HEADER_LEN = 9;
export const NONCE_LEN = 24;
export const TAG_LEN = 16;
export const MIN_CHUNK_SIZE = 1;
export const MAX_CHUNK_SIZE = 8 * 1024 * 1024;
