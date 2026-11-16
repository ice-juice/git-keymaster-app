-- 分享登记。主键是 App 传入的 10 字符 base62 slug，不使用自增 id。
-- fail_streak / locked_until 不在设计文档 §3.2 的列清单里，
-- 但「连续 5 次锁 15 分钟」必须落在 D1 上，否则换 isolate 就丢。
-- expire_at / locked_until 是 Unix 毫秒。NULL expire_at 表示永久。
-- NULL max_pulls 与 NULL pulls_left 表示不限次数。

CREATE TABLE locker (
  slug TEXT PRIMARY KEY CHECK (length(slug) = 10),
  object_key TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  expire_at INTEGER,
  max_pulls INTEGER,
  pulls_left INTEGER,
  fail_count INTEGER NOT NULL DEFAULT 0,
  fail_streak INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked'))
) WITHOUT ROWID;

CREATE INDEX idx_locker_sweep ON locker (expire_at, pulls_left);
