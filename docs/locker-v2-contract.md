# Locker wire protocol v2

Implementation contract shared by Worker, Rust backend and UI contributors. All new JSON names are camelCase; timestamps are RFC3339 UTC strings or null. Existing owner HMAC headers/canonicalization remain unchanged; request bodies are signed exactly as transmitted. No service credentials or decryption keys go in URLs or logs.

## Health and migrations

`GET /` and `GET /v2/health`: `{service:"file-locker",ok:true,protocolVersion:2,schemaVersion:2,capabilities:["private-items","lookup","claims","resume","stop-share","cleanup-status"]}`. Health must fail `503 schema_required` when v2 tables are missing. D1 migration `0002_locker_v2.sql` adds independent `locker_v2_items`, `locker_v2_shares`, `locker_v2_claims`, `locker_v2_operations`, `locker_v2_nonces`. Keep legacy `locker` table untouched. Old mutating `/register`, `/api/*` routes fail closed with `426 protocol_upgrade_required`. Legacy links return the v2 receiver shell but lookup rejects non-v2 aliases; they never trigger legacy destructive revoke/download paths. Registering a v2 item does not implicitly mutate legacy rows.

## Owner routes (HMAC authentication)

| Method / path | Body | Result |
|---|---|---|
| PUT `/v2/items/:itemId` | `{operationId,version,objectKey,codeHash,cipherSize,expireAt,maxPulls,pullsLeft}` | metadata; immutable, idempotent registration; validates actual R2 object size |
| GET `/v2/items/:itemId` | empty | metadata, including closed/cleanup states |
| POST `/v2/items/:itemId/lookup` | `{}` | available metadata, no quota use |
| POST `/v2/items/:itemId/share` | `{operationId,slug}` | `{slug}`; random existing-compatible 10-char base62 slug |
| DELETE `/v2/items/:itemId/share` | `{operationId}` | `{ok:true}`; disables all current public aliases, preserves object and owner access |
| DELETE `/v2/items/:itemId` | `{operationId}` | metadata; disables item and all claims first, then attempts cleanup; retry/query shows cleanup status |
| POST `/v2/items/:itemId/claims` | `{operationId,expectedVersion}` | claim; private owner reservation |
| POST `/v2/migrate/:legacySlug` | `{operationId,itemId,version,expectedObjectKey,expectedCipherSize}` | copy authoritative legacy object/quota/expiry to v2, retire old alias without deleting object; binding mismatch is 409 source_mismatch |
| POST `/v2/probe` | `{objectKey,cipherSize?}` | HMAC + R2 HEAD validates a client-created isolated probe object and returns `{ok:true,protocolVersion:2,schemaVersion:2,objectExists:true,cipherSize}` |

Metadata: `{itemId,version,cipherSize,expireAt,maxPulls,pullsLeft,inFlightClaims,status,cleanupStatus,shareSlug}`. `status`: active / expired / exhausted / deleted. `cleanupStatus`: none / pending / failed / cleaned. `pullsLeft` counts currently unreserved slots, null means unlimited. `inFlightClaims` counts reserved/delivering claims whose recovery window remains open; zero unreserved slots plus inFlightClaims>0 means held by ongoing transfers, not completed destruction. Metadata does not contain plaintext filenames; existing link fragment carries untrusted display filename, locally sanitized. `codeHash` uses existing pickup HMAC label `gam-locker-code-v1`.

## Authenticated fragment integrity (security update)

New links use `#v2.<CK-base64url>.<plain-size-decimal>.<filename-base64url>.<tag-base64url>`.
Derive `authKey = HMAC-SHA256(CK, "gam-locker-share-auth-key-v2")`. The tag is HMAC-SHA256(authKey, UTF-8(`gam-locker-share-v2\n<canonicalBase>\n<slug>\n<plainSize>\n<encodedFilename>`)). Canonical base uses standard URL serialization without trailing slashes, query, fragment or credentials. Filename remains local and is sanitized after verification. Fragment values and CK never go into service requests or logs.

Receivers verify before lookup/reservation, require authenticated total plaintext length after GKB1 decryption, and only then save/ACK. This closes valid-whole-chunk truncation without changing stored ciphertext format. Old unauthenticated links are refused with a request to copy a new link from the sender; existing objects can be reused. Old journals containing only an estimated ciphertext size cannot authorize a fresh plaintext save.

Replaying a share-create operation whose alias was stopped returns 409 `share_stopped`; it never revives the old alias. Explicit new sharing uses a new operation ID and new slug. Legacy cleanup excludes every key referenced by a v2 item, preventing a migrated legacy tombstone from deleting its adopted object.

## Public routes

`GET /d/:slug`: new browser receiver shell, no file metadata until code validation.

`POST /v2/shares/:slug/lookup {code}`: code-validated, rate-limited metadata, no quota use.

`POST /v2/shares/:slug/claims {operationId,expectedVersion,code}`: public reservation, code and current share authorization checked. The operation ID is caller-generated UUID, persisted by the caller before request; same ID retry must bind to the same item version and owner/public scope. If the initial response is lost, an existing reserved/delivering operation can be recovered within its original deadline even after stop-share or item TTL, with the original operation ID, version and correct pickup code. This does not enable new reservations, bypass code lockout, restore deleted items, or extend the recovery deadline.

## Claim routes

All claim routes are POST `/v2/claims/:operationId/{status|content|ack|cancel}` with `{token}`. Token is an opaque 64-hex capability; protect like a download capability. Claim result: `{operationId,token,itemId,version,state,recoveryUntil,attempts,pullsLeft,cipherSize,cleanupStatus}`. State: reserved / delivering / delivered / cancelled / expired. `recoveryUntil` is a 15-minute absolute deadline from initial reservation; bounded content attempts: three, including initial attempt. Token remains stable across a valid idempotent reserve retry unless the owner signing secret rotates. After rotation, authenticated replay registers the newly derived token hash in `locker_v2_claim_tokens`; both original and recovered tokens retain access to the same claim, without another debit. No plaintext tokens are stored. The replayable `0002` migration and health check include this hash-only alias table.

- Reservation uses D1 transaction/batch with conditional quota debit, so a last slot has exactly one winner across isolates/devices. Before bytes start, explicit cancel/expiry refunds once.
- `content` atomically marks `delivering` and increments attempts before R2 fetch/stream. It returns ciphertext with `application/octet-stream`, `content-length`, `x-locker-pulls-left` (when finite), and `x-locker-operation-id`. Any failure after this point is potentially delivered: no refund, no automatic new reservation. Same-operation retries are allowed within the bound.
- `ack` is called after native durable save/vault import, or browser verified decryption and initiation of save. It marks delivered idempotently. Browser must say download/save initiated, never claim proof of on-disk saving. ACK loss is recoverable via the same claim status/ACK.
- `cancel` only refunds a reserved claim. A delivering claim cannot be refunded or silently replaced.
- At zero slots or natural expiry, deny new reservations but preserve existing claims until ACK/cancellation/deadline; cleanup only after no recoverable claim remains. Explicit owner deletion cancels every claim and may remove immediately. Stop-share rejects new public claims but does not terminate existing delivery capabilities or owner claims.
- `status` can report terminal state without starting content or decrementing another slot. A delivered claim remains queryable after object cleanup.

Errors: `{error,retryAfter?}`. 400 invalid; 401 unauthorized / bad_code; 404 not_found; 409 version_conflict / no_allowance / operation_conflict / delivery_started; 410 expired / session_expired / attempts_exhausted; 423 locked; 426 protocol_upgrade_required; 503 schema_required / storage_unavailable. Public unknown/disabled aliases return not_found; no anonymous metadata probing.

## Deployment boundary

Only local source/build/emulator validation is authorized in this task. No real Worker deploy, credentials, existing bucket objects, or user files are touched. Root integrates SQL application for fresh and existing installations; v2 health requires the full schema, preventing UI claims against an outdated service.
