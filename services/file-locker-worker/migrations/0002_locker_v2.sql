-- Independent v2 tables; replayable to repair interrupted deployment.
CREATE TABLE IF NOT EXISTS locker_v2_items (
  item_id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  register_operation_id TEXT NOT NULL UNIQUE,
  register_hash TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  code_hash TEXT NOT NULL,
  cipher_size INTEGER NOT NULL,
  expire_at INTEGER,
  max_pulls INTEGER,
  pulls_left INTEGER CHECK (pulls_left IS NULL OR pulls_left >= 0),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','deleted')),
  cleanup_status TEXT NOT NULL DEFAULT 'none' CHECK (cleanup_status IN ('none','pending','failed','cleaned')),
  created_at INTEGER NOT NULL,
  reservation_marker TEXT,
  fail_streak INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS locker_v2_shares (
  slug TEXT PRIMARY KEY CHECK (length(slug) = 10),
  item_id TEXT NOT NULL REFERENCES locker_v2_items(item_id),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  operation_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_locker_v2_shares_item ON locker_v2_shares(item_id,active);
CREATE TABLE IF NOT EXISTS locker_v2_claims (
  operation_id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES locker_v2_items(item_id),
  version TEXT NOT NULL,
  scope TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','delivering','delivered','cancelled','expired')),
  recovery_until INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_locker_v2_claims_item ON locker_v2_claims(item_id,state,recovery_until);
-- Hash-only aliases let an authenticated original operation survive signing-key rotation.
CREATE TABLE IF NOT EXISTS locker_v2_claim_tokens (
  operation_id TEXT NOT NULL REFERENCES locker_v2_claims(operation_id),
  token_hash TEXT NOT NULL,
  PRIMARY KEY(operation_id,token_hash)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS locker_v2_operations (
  operation_id TEXT PRIMARY KEY,
  route TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0,
  result_json TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS locker_v2_nonces (
  nonce TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_locker_v2_nonces_expiry ON locker_v2_nonces(expires_at);
