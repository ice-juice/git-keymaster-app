import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomUUID, randomBytes, createHash, createHmac } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { decryptBlob } from '../src/frame.ts';
import { sweepV2, handleV2 } from '../src/handle-v2.ts';

const secret='local-test-owner-secret-32-characters';
const origin='https://locker.test';
const code='123456';
const codeHash=createHmac('sha256','gam-locker-code-v1').update(code).digest('hex');
let mf,db,bucket,workerOptions;
before(async()=>{
 const bundle=await build({entryPoints:['src/index.ts'],bundle:true,format:'esm',platform:'neutral',write:false,target:'es2022'});
 workerOptions=convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-01',d1Databases:['DB'],r2Buckets:['LOCKER_BUCKET'],bindings:{LOCKER_HMAC_SECRET:secret}});
 mf=new Miniflare(workerOptions);
 db=await mf.getD1Database('DB');bucket=await mf.getR2Bucket('LOCKER_BUCKET');
 const cold=await mf.dispatchFetch(origin+'/');assert.equal(cold.status,503);assert.equal((await cold.json()).error,'schema_required');
 for(const file of ['0001_locker.sql','0002_locker_v2.sql']){
  const sql=await readFile(new URL('../migrations/'+file,import.meta.url),'utf8');
  for(const statement of sql.split('\n').filter(x=>!x.trim().startsWith('--')).join('\n').split(';').map(x=>x.trim()).filter(Boolean)) await db.prepare(statement).run();
 }
});
after(async()=>{await mf?.dispose()});
function signed(method,path,body,nonce=randomBytes(16).toString('hex'),signingSecret=secret){
 const text=body===undefined?'':JSON.stringify(body),timestamp=String(Math.floor(Date.now()/1000));
 const digest=createHash('sha256').update(text).digest('hex');
 const signature=createHmac('sha256',signingSecret).update(`${timestamp}\n${nonce}\n${method}\n${path}\n${digest}`).digest('hex');
 return {method,headers:{'content-type':'application/json','x-locker-timestamp':timestamp,'x-locker-nonce':nonce,'x-locker-signature':signature},...(text?{body:text}:{})};
}
const owner=(method,path,body)=>mf.dispatchFetch(origin+path,signed(method,path,body));
const publicPost=(path,body)=>mf.dispatchFetch(origin+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
async function ok(res){assert.equal(res.status,200,await res.clone().text());return res.json()}
function encrypt(plain){
 const key=randomBytes(32),nonce=randomBytes(24),aad=new Uint8Array(8),head=new Uint8Array(9);
 head.set([71,75,66,49,1]);new DataView(head.buffer).setUint32(5,8*1024*1024,true);
 const ciphertext=xchacha20poly1305(key,nonce,aad).encrypt(plain);
 return {key,bytes:Buffer.concat([head,nonce,ciphertext])};
}
async function item(pulls=1,ttl=86400_000){
 const id=randomUUID(),version=randomBytes(32).toString('hex'),operationId=randomUUID(),objectKey='isolated-test/'+id;
 const plain=Buffer.from('文件寄存柜真实加密交付 '+id),sealed=encrypt(plain);await bucket.put(objectKey,sealed.bytes);
 const body={operationId,version,objectKey,codeHash,cipherSize:sealed.bytes.length,expireAt:new Date(Date.now()+ttl).toISOString(),maxPulls:pulls,pullsLeft:pulls};
 const meta=await ok(await owner('PUT','/v2/items/'+id,body));
 return {id,version,operationId,objectKey,body,meta,plain,...sealed};
}
async function share(it,slug=randomBytes(5).toString('hex')){const operationId=randomUUID();await ok(await owner('POST',`/v2/items/${it.id}/share`,{operationId,slug}));return {slug,operationId}}
async function reserve(it,operationId=randomUUID()){return ok(await owner('POST',`/v2/items/${it.id}/claims`,{operationId,expectedVersion:it.version}))}
const claimPost=(c,action)=>publicPost(`/v2/claims/${c.operationId}/${action}`,{token:c.token});

test('health validates schema; unsigned, replayed and old mutation requests fail closed',async()=>{
 const h=await ok(await mf.dispatchFetch(origin+'/'));assert.equal(h.protocolVersion,2);assert.equal(h.schemaVersion,2);assert(h.capabilities.includes('stop-share'));
 const unsigned=await mf.dispatchFetch(origin+'/v2/items/'+randomUUID(),{method:'PUT',body:'{}'});assert.equal(unsigned.status,401);
 assert.equal((await publicPost('/register',{})).status,426);
 assert.equal((await publicPost('/api/1234567890',{code})).status,426);
 const it=await item();const path=`/v2/items/${it.id}`;const init=signed('GET',path);
 assert.equal((await mf.dispatchFetch(origin+path,init)).status,200);
 assert.equal((await mf.dispatchFetch(origin+path,init)).status,401);
});
test('registration is idempotent and immutable; signed probe validates actual bucket object',async()=>{
 const it=await item(3);
 assert.equal((await ok(await owner('PUT','/v2/items/'+it.id,it.body))).pullsLeft,3);
 assert.equal((await owner('PUT','/v2/items/'+it.id,{...it.body,pullsLeft:2})).status,409);
 assert.equal((await ok(await owner('POST','/v2/probe',{objectKey:it.objectKey,cipherSize:it.bytes.length}))).objectExists,true);
 assert.equal((await owner('POST','/v2/probe',{objectKey:it.objectKey,cipherSize:1})).status,400);
 assert.equal((await publicPost('/v2/shares/0000000000/lookup',{code})).status,404);
});
test('lost registration response can be recovered after its original expiry',async()=>{
 const it=await item(1,1200);await new Promise(resolve=>setTimeout(resolve,1250));
 const replay=await ok(await owner('PUT','/v2/items/'+it.id,it.body));assert.equal(replay.status,'expired');assert.equal(replay.itemId,it.id);
});
test('public lookup is code-gated, rate-limited and never consumes allowance',async()=>{
 const it=await item(3),s=await share(it);
 for(let n=0;n<3;n++) assert.equal((await ok(await publicPost(`/v2/shares/${s.slug}/lookup`,{code}))).pullsLeft,3);
 for(let n=0;n<4;n++) assert.equal((await publicPost(`/v2/shares/${s.slug}/lookup`,{code:'999999'})).status,401);
 assert.equal((await publicPost(`/v2/shares/${s.slug}/lookup`,{code:'999999'})).status,423);
 assert.equal((await publicPost(`/v2/shares/${s.slug}/lookup`,{code})).status,423);
 assert.equal((await ok(await owner('GET',`/v2/items/${it.id}`))).pullsLeft,3);
});
test('real D1 atomic last-slot race has one winner; identical operation retry does not debit again',async()=>{
 const it=await item(1);const ids=Array.from({length:12},()=>randomUUID());
 const responses=await Promise.all(ids.map(operationId=>owner('POST',`/v2/items/${it.id}/claims`,{operationId,expectedVersion:it.version})));
 assert.equal(responses.filter(r=>r.status===200).length,1);
 assert(responses.filter(r=>r.status!==200).every(r=>r.status===409));
 const winner=await responses.find(r=>r.status===200).json();
 const repeated=await reserve(it,winner.operationId);assert.equal(repeated.token,winner.token);assert.equal(repeated.pullsLeft,0);
 const held=await ok(await owner('GET',`/v2/items/${it.id}`));assert.equal(held.inFlightClaims,1);assert.equal(held.cleanupStatus,'none');
 assert.equal((await owner('POST',`/v2/items/${it.id}/claims`,{operationId:randomUUID(),expectedVersion:'invalid-version'})).status,409);
});
test('simultaneous retries of the same reservation debit only once',async()=>{
 const it=await item(3),id=randomUUID();const replies=await Promise.all(Array.from({length:8},()=>reserve(it,id)));
 assert(replies.every(c=>c.token===replies[0].token));assert.equal((await ok(await owner('GET',`/v2/items/${it.id}`))).pullsLeft,2);
});
test('stop share preserves object/owner access and retired link never resurrects on replay',async()=>{
 const it=await item(3),s=await share(it),operationId=randomUUID();
 await ok(await owner('DELETE',`/v2/items/${it.id}/share`,{operationId}));
 assert(await bucket.head(it.objectKey));assert.equal((await publicPost(`/v2/shares/${s.slug}/lookup`,{code})).status,404);
 const retired=await owner('POST',`/v2/items/${it.id}/share`,{operationId:s.operationId,slug:s.slug});assert.equal(retired.status,409);assert.equal((await retired.json()).error,'share_stopped');
 assert.equal((await publicPost(`/v2/shares/${s.slug}/lookup`,{code})).status,404);
 const next=await share(it);assert.equal((await publicPost(`/v2/shares/${next.slug}/lookup`,{code})).status,200);
 // A repeated old stop operation is not allowed to disable a newer share.
 await ok(await owner('DELETE',`/v2/items/${it.id}/share`,{operationId}));
 assert.equal((await publicPost(`/v2/shares/${next.slug}/lookup`,{code})).status,200);
 assert.equal((await reserve(it)).state,'reserved');
});
test('public claim survives stopping share, while new claims are blocked',async()=>{
 const it=await item(2),s=await share(it);
 const c=await ok(await publicPost(`/v2/shares/${s.slug}/claims`,{operationId:randomUUID(),expectedVersion:it.version,code}));
 await ok(await owner('DELETE',`/v2/items/${it.id}/share`,{operationId:randomUUID()}));
 assert.equal((await publicPost(`/v2/shares/${s.slug}/claims`,{operationId:randomUUID(),expectedVersion:it.version,code})).status,404);
 const response=await claimPost(c,'content');assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),it.bytes);
});
test('lost public reservation response recovers after stop-share or TTL without opening new claims',async()=>{
 for(const reason of ['stop','expire']){
  const it=await item(2),s=await share(it),operationId=randomUUID();
  const body={operationId,expectedVersion:it.version,code};
  const original=await ok(await publicPost(`/v2/shares/${s.slug}/claims`,body));
  if(reason==='stop') await ok(await owner('DELETE',`/v2/items/${it.id}/share`,{operationId:randomUUID()}));
  else await db.prepare('UPDATE locker_v2_items SET expire_at=? WHERE item_id=?').bind(Date.now()-1,it.id).run();
  assert.equal((await publicPost(`/v2/shares/${s.slug}/lookup`,{code})).status,reason==='stop'?404:410);
  assert.equal((await publicPost(`/v2/shares/${s.slug}/claims`,{...body,operationId:randomUUID()})).status,reason==='stop'?404:410);
  assert.equal((await publicPost(`/v2/shares/${s.slug}/claims`,{...body,expectedVersion:'wrong-version'})).status,reason==='stop'?404:410);
  assert.equal((await publicPost(`/v2/shares/${s.slug}/claims`,{...body,code:'999999'})).status,401);
  const recovered=await ok(await publicPost(`/v2/shares/${s.slug}/claims`,body));
  assert.equal(recovered.token,original.token);assert.equal(recovered.pullsLeft,1);
  const content=await claimPost(recovered,'content');assert.equal(content.status,200);assert.deepEqual(Buffer.from(await content.arrayBuffer()),it.bytes);
  await db.prepare('UPDATE locker_v2_claims SET recovery_until=? WHERE operation_id=?').bind(Date.now()-1,operationId).run();
  assert.equal((await publicPost(`/v2/shares/${s.slug}/claims`,body)).status,reason==='stop'?404:410);
 }
});
test('signing secret rotation recovers original owner/public claims and retains old tokens with hashes only',async()=>{
 const it=await item(3),s=await share(it),ownerClaim=await reserve(it),publicBody={operationId:randomUUID(),expectedVersion:it.version,code};
 const publicClaim=await ok(await publicPost(`/v2/shares/${s.slug}/claims`,publicBody));
 const rotated='rotated-owner-signing-secret-32-characters';
 try{
  const rotatedOptions=structuredClone(workerOptions);
  rotatedOptions.workers[0].config.env.LOCKER_HMAC_SECRET.value=rotated;
  await mf.setOptions(rotatedOptions);
  db=await mf.getD1Database('DB');bucket=await mf.getR2Bucket('LOCKER_BUCKET');
  const recoveredOwner=await ok(await mf.dispatchFetch(origin+`/v2/items/${it.id}/claims`,signed('POST',`/v2/items/${it.id}/claims`,{operationId:ownerClaim.operationId,expectedVersion:it.version},undefined,rotated)));
  const recoveredPublic=await ok(await publicPost(`/v2/shares/${s.slug}/claims`,publicBody));
  for(const [original,recovered] of [[ownerClaim,recoveredOwner],[publicClaim,recoveredPublic]]){
   assert.notEqual(original.token,recovered.token);assert.equal(recovered.pullsLeft,1);
   assert.equal((await ok(await claimPost(original,'status'))).state,'reserved');
   assert.equal((await ok(await claimPost(recovered,'status'))).state,'reserved');
   const hashes=await db.prepare('SELECT token_hash FROM locker_v2_claim_tokens WHERE operation_id=?').bind(original.operationId).all();
   assert.deepEqual(hashes.results.map(r=>r.token_hash),[createHash('sha256').update(recovered.token).digest('hex')]);
   assert(!JSON.stringify(hashes.results).includes(recovered.token));
  }
  assert.equal((await publicPost(`/v2/claims/${ownerClaim.operationId}/status`,{token:recoveredPublic.token})).status,401);
  const response=await claimPost(recoveredPublic,'content');assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),it.bytes);
  assert.equal((await ok(await claimPost(publicClaim,'ack'))).state,'delivered');
 } finally {await mf.setOptions(workerOptions);db=await mf.getD1Database('DB');bucket=await mf.getR2Bucket('LOCKER_BUCKET')}
});
test('reserved cancellation and expiry refund exactly once; no content has been issued',async()=>{
 const it=await item(1),c=await reserve(it);
 const cancelled=await Promise.all([claimPost(c,'cancel'),claimPost(c,'cancel')]);assert(cancelled.every(r=>r.status===200));
 assert.equal((await ok(await owner('GET',`/v2/items/${it.id}`))).pullsLeft,1);
 const next=await reserve(it);await db.prepare('UPDATE locker_v2_claims SET recovery_until=? WHERE operation_id=?').bind(Date.now()-1,next.operationId).run();
 assert.equal((await ok(await claimPost(next,'status'))).state,'expired');
 assert.equal((await ok(await claimPost(next,'status'))).pullsLeft,1);
 assert(await bucket.head(it.objectKey));
});
test('ciphertext decrypts correctly; bounded resume keeps one allowance; ack is idempotent and cleans last item',async()=>{
 const it=await item(1),c=await reserve(it);
 for(let n=0;n<3;n++){
  const res=await claimPost(c,'content');assert.equal(res.status,200);
  assert.deepEqual(Buffer.from(decryptBlob(new Uint8Array(await res.arrayBuffer()),it.key,it.plain.length)),it.plain);
  assert(await bucket.head(it.objectKey),'last object remains available until ACK/recovery deadline');
 }
 assert.equal((await claimPost(c,'content')).status,410);
 assert.equal((await claimPost(c,'cancel')).status,409);
 assert.equal((await ok(await claimPost(c,'status'))).pullsLeft,0);
 const ack=await ok(await claimPost(c,'ack'));assert.equal(ack.state,'delivered');assert.equal(ack.cleanupStatus,'cleaned');
 assert.equal(await bucket.head(it.objectKey),null);
 assert.equal((await ok(await claimPost(c,'ack'))).state,'delivered');
 assert.equal((await ok(await claimPost(c,'status'))).state,'delivered');
});
test('lost/failed content never refunds after delivery started, expiry cleans without reopening a slot',async()=>{
 const it=await item(1),c=await reserve(it);await bucket.delete(it.objectKey);
 assert.equal((await claimPost(c,'content')).status,503);
 const status=await ok(await claimPost(c,'status'));assert.equal(status.state,'delivering');assert.equal(status.pullsLeft,0);
 assert.equal((await claimPost(c,'cancel')).status,409);
 await bucket.put(it.objectKey,it.bytes);await db.prepare('UPDATE locker_v2_claims SET recovery_until=? WHERE operation_id=?').bind(Date.now()-1,c.operationId).run();
 const expired=await ok(await claimPost(c,'status'));assert.equal(expired.pullsLeft,0);assert.equal(expired.state,'expired');assert.equal(expired.cleanupStatus,'cleaned');
});
test('thrown storage failure returns structured unknown outcome and preserves original delivery state',async()=>{
 const it=await item(1),c=await reserve(it);
 const failing={get:async()=>{throw Error('injected transport outage')},head:bucket.head.bind(bucket),delete:bucket.delete.bind(bucket)};
 const request=new Request(origin+`/v2/claims/${c.operationId}/content`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:c.token})});
 const response=await handleV2(request,{DB:db,LOCKER_BUCKET:failing,LOCKER_HMAC_SECRET:secret},{waitUntil(){}},'');
 assert.equal(response.status,503);assert.equal((await response.json()).error,'storage_unavailable');
 assert.equal((await ok(await claimPost(c,'status'))).state,'delivering');
 assert(await bucket.head(it.objectKey),'transient storage failure must not delete the last-slot object');
 const resumed=await claimPost(c,'content');assert.equal(resumed.status,200);
 assert.deepEqual(Buffer.from(await resumed.arrayBuffer()),it.bytes);
 assert.equal((await ok(await claimPost(c,'status'))).pullsLeft,0,'same claim never debits another allowance');
 assert(await bucket.head(it.objectKey),'successful resume still awaits ACK');
});
test('explicit deletion cancels claims and removes object, unlike stopping share',async()=>{
 const it=await item(2),c=await reserve(it),operationId=randomUUID();
 const deleted=await ok(await owner('DELETE',`/v2/items/${it.id}`,{operationId}));assert.equal(deleted.status,'deleted');assert.equal(deleted.cleanupStatus,'cleaned');
 assert.equal(await bucket.head(it.objectKey),null);assert.equal((await claimPost(c,'content')).status,410);
 assert.equal((await ok(await owner('DELETE',`/v2/items/${it.id}`,{operationId}))).status,'deleted');
});
test('cleanup failure is recorded without pretending deletion, then real retry converges',async()=>{
 const it=await item(1);await db.prepare('UPDATE locker_v2_items SET expire_at=? WHERE item_id=?').bind(Date.now()-1,it.id).run();
 const failedBucket={head:bucket.head.bind(bucket),get:bucket.get.bind(bucket),delete:async()=>{throw Error('injected R2 outage')}};
 await sweepV2({DB:db,LOCKER_BUCKET:failedBucket,LOCKER_HMAC_SECRET:secret});
 assert(await bucket.head(it.objectKey));assert.equal((await ok(await owner('GET',`/v2/items/${it.id}`))).cleanupStatus,'failed');
 assert.equal((await owner('POST',`/v2/items/${it.id}/claims`,{operationId:randomUUID(),expectedVersion:it.version})).status,410);
 await sweepV2({DB:db,LOCKER_BUCKET:bucket,LOCKER_HMAC_SECRET:secret});
 assert.equal(await bucket.head(it.objectKey),null);assert.equal((await ok(await owner('GET',`/v2/items/${it.id}`))).cleanupStatus,'cleaned');
});
test('legacy migration copies remote authoritative quota and closes old alias without deleting',async()=>{
 const objectKey='legacy/'+randomUUID();const bytes=new Uint8Array(20).fill(7);await bucket.put(objectKey,bytes);
 const slug=randomBytes(5).toString('hex'),id=randomUUID(),operationId=randomUUID(),version=randomBytes(32).toString('hex');
 await db.prepare('INSERT INTO locker(slug,object_key,code_hash,size,expire_at,max_pulls,pulls_left) VALUES (?,?,?,?,?,?,?)').bind(slug,objectKey,codeHash,20,Date.now()+86400_000,5,2).run();
 const b={operationId,itemId:id,version,expectedObjectKey:objectKey,expectedCipherSize:20};
 assert.equal((await owner('POST','/v2/migrate/'+slug,{...b,expectedObjectKey:'wrong/object'})).status,409);
 const migrated=await ok(await owner('POST','/v2/migrate/'+slug,b));
 assert.equal(migrated.pullsLeft,2);assert.equal(migrated.maxPulls,5);assert.equal(migrated.shareSlug,null);assert(await bucket.head(objectKey));
 assert.equal((await db.prepare('SELECT status FROM locker WHERE slug=?').bind(slug).first()).status,'revoked');
 assert.equal((await ok(await owner('POST','/v2/migrate/'+slug,b))).pullsLeft,2);
 await db.prepare('UPDATE locker SET expire_at=?,pulls_left=0 WHERE slug=?').bind(Date.now()-1000,slug).run();
 const expiredSlug=randomBytes(5).toString('hex'),expiredKey='legacy-expired/'+randomUUID();await bucket.put(expiredKey,bytes);
 await db.prepare('INSERT INTO locker(slug,object_key,code_hash,size,expire_at,max_pulls,pulls_left) VALUES (?,?,?,?,?,?,?)').bind(expiredSlug,expiredKey,codeHash,20,Date.now()-1000,1,1).run();
 await sweepV2({DB:db,LOCKER_BUCKET:bucket,LOCKER_HMAC_SECRET:secret});
 assert(await bucket.head(objectKey),'legacy cleanup must not destroy a migrated v2 object');
 assert.equal(await bucket.head(expiredKey),null,'unmigrated expired object must be cleaned');
});
