# Locker IPC v2

All objects camelCase. All commands require an unlocked workspace. Writes also check writesLocked. Nullable properties are JSON null (UI should also tolerate absent properties on old data).

`locker_connection_status({verify?:boolean})` -> `{storageConfigured:boolean,serviceConfigured:boolean,protocolVersion:number|null,serviceReady:boolean,storageVerified:boolean,serviceVerified:boolean,checkedAt:string,error:string|null}`. Only explicit verify=true does signed test-object bucket binding check. serviceReady means protocol2/schema2 plus owner credential configured; no implication of verified credentials without serviceVerified.

`locker_source_stat({path:string})` -> `{name:string,size:number}` (file only, max100MiB).

`LockerSource={id?:string,code?:string,shareUrl?:string}`. Exactly own id OR own code OR external shareUrl+code. External URL keeps fragment locally only. Own lookup by ID need not reveal pickup code.

`locker_lookup({source:LockerSource,password?:string})` -> `{id:string,name:string,originalName:string,size:number,sizeIsEstimate:boolean,expireAt:string|null,maxPulls:number|null,pullsLeft:number|null,version:string,source:'own'|'share',protocolVersion:number,legacy:boolean,quotaOrigin:string|null,inFlightClaims:number}`. New authenticated v2 link carries exact authenticated plaintext size and sizeIsEstimate=false; legacy fragments are rejected with a request to re-copy a new link. No consuming request.

`locker_receive({operationId:string,source:LockerSource,snapshotVersion:string,destination:{kind:'disk'|'vault',path?:string},password?:string})` -> `LockerOperation`. operationId UUID; immutable binding to source/version/target. Disk paths absolute. Existing target must not be overwritten silently; choose a new name. The same ID and original bound source/target are required for retry.

`locker_operation_status({operationId:string})` -> `LockerOperation|null`.

`locker_operations_list()` -> `{operations:LockerOperation[]}`.

`locker_operation_resume({operationId:string,password?:string})` -> `LockerOperation`. Reads original encrypted persisted source/target. No UI secret persistence required. Saved state retries only ACK, never content.

`locker_operation_retarget({operationId,destination,password?})` -> `LockerOperation`. Explicit user alternate-save action only when canRetarget=true. Keeps source/version/reservation ID and cached ciphertext. Revalidates new no-overwrite destination. If original output actually published before a lost journal write, reconciles its hash witness and returns original result rather than creating a second output. Does not silently alter target during retries.

`locker_migrate_legacy({id,password?})` -> void. Explicit shared migration copies authoritative remote remaining quota and invalidates old alias without object deletion; private migration preserves this workspace's remaining quota and sets quotaOrigin='legacyWorkspace'. Upgrade all clients before migration. Unknown remote result replays the identical deterministic operation/source binding.

`LockerOperation={operationId:string,kind:'receive'|'put',status:'prepared'|'running'|'unknown'|'failed'|'saved'|'completed',phase:string,itemId:string|null,name:string|null,destPath:string|null,fileId:string|null,pullsLeft:number|null,cleanupStatus:string|null,error:string|null,recoverable:boolean,canRetarget:boolean,updatedAt:string}`. Status saved means durable local save succeeded and server ACK still pending; UI must display saved with confirmation pending, not failed. Unknown is not an instruction to create a replacement op. Resume only when recoverable true, with original ID. Definitive preflight rejection is persisted as failed/validation/recoverable=false. NEED_REAUTH/LOCKED/BUSY gates occur before an operation and must not be described as unknown cloud result.

Existing `locker_list` still returns `{entries:LockerEntry[]}`. Entries add `{accessStatus:'active'|'expired'|'exhausted'|'deleted',cleanupStatus:'none'|'pending'|'failed'|'cleaned',syncStatus:'confirmed'|'unknown',legacy:boolean,endedAt:string|null,lastError:string|null,quotaOrigin:string|null,inFlightClaims:number,shareStatus:'none'|'pending'|'active'|'failed'|'stopped',shareRequested:boolean,shareError:string|null}`. Zero free quota with inFlightClaims>0 may still have recoverable claims; never equate it to completed destruction. Entries include ended history rows. Ended rows have share=null; no code/key in views. `locker_clear_history()` -> void, only confirmed-cleaned history removed, pending cleanup never dropped.

Existing put opts add `operationId?:string` (frontend must supply), `shareRequested?:boolean`. Existing `{id,code}` success shape unchanged. On RPC error inspect operation_status(original ID); completed put itemId can reveal code through existing authorized command. Resume operates on persisted encrypted upload and bound S3 endpoint/bucket/region/prefix; changing the storage destination requires restoring original config before resume. After choosing file no call to put occurs until explicit submit. TTL counts from confirmed upload completion. Finite quota requires protocol2 service even for self use. Missing service allows explicitly unlimited self only.

Existing share/revoke/delete command names retained; they require v2 service for managed/shared items and cannot fall back to destructive legacy revoke. Delete can return success with cleanup pending, reload list shows truthful state. UI shouldn't discard the row on command success alone.
