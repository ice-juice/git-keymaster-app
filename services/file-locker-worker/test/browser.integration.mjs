// Real browser + local workerd/D1/R2 + real framed ciphertext. No external cloud.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID, randomBytes, createHash, createHmac } from 'node:crypto';
import path from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';

const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || path.join(process.env.LOCALAPPDATA,'GitKeymasterDev/design-tools/node_modules/playwright-core'));
const secret='browser-test-isolated-owner-secret';
let mf,browser;
const out=path.resolve('../../docs/design/locker-redesign/implementation');
async function run(){
 await mkdir(out,{recursive:true});
 const bundle=await build({entryPoints:['src/index.ts'],bundle:true,format:'esm',platform:'neutral',write:false,target:'es2022'});
 mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-01',d1Databases:['DB'],r2Buckets:['LOCKER_BUCKET'],bindings:{LOCKER_HMAC_SECRET:secret}}));
 const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('LOCKER_BUCKET');
 for(const name of ['0001_locker.sql','0002_locker_v2.sql']) for(const sql of (await readFile('migrations/'+name,'utf8')).split('\n').filter(l=>!l.trim().startsWith('--')).join('\n').split(';').map(x=>x.trim()).filter(Boolean)) await db.prepare(sql).run();
 const base=String(await mf.ready).replace(/\/$/,'');
 async function owner(method,route,body){const text=JSON.stringify(body),ts=String(Math.floor(Date.now()/1000)),nonce=randomBytes(16).toString('hex');const sig=createHmac('sha256',secret).update(`${ts}\n${nonce}\n${method}\n${route}\n${createHash('sha256').update(text).digest('hex')}`).digest('hex');const res=await mf.dispatchFetch(base+route,{method,body:text,headers:{'content-type':'application/json','x-locker-timestamp':ts,'x-locker-nonce':nonce,'x-locker-signature':sig}});assert.equal(res.status,200,await res.clone().text());return res.json();}
 function authenticatedFragment(key,slug,name,size){const encoded=Buffer.from(name).toString('base64url');const auth=createHmac('sha256',key).update('gam-locker-share-auth-key-v2').digest();const tag=createHmac('sha256',auth).update(`gam-locker-share-v2\n${base}\n${slug}\n${size}\n${encoded}`).digest('base64url');return `v2.${key.toString('base64url')}.${size}.${encoded}.${tag}`;}
 async function fixture(chunkSize=8*1024*1024){
  const id=randomUUID(),key=randomBytes(32),plain=Buffer.from('真实浏览器领取校验\n'+id),header=Buffer.alloc(9);
  header.set([71,75,66,49,1]);header.writeUInt32LE(chunkSize,5);
  const chunks=[header];for(let offset=0,index=0;offset<plain.length;offset+=chunkSize,index++){const nonce=randomBytes(24),aad=Buffer.alloc(8);aad.writeBigUInt64LE(BigInt(index));chunks.push(nonce,xchacha20poly1305(key,nonce,aad).encrypt(plain.subarray(offset,offset+chunkSize)));}
  const data=Buffer.concat(chunks),objectKey='browser-test/'+id;await bucket.put(objectKey,data);const version=randomBytes(32).toString('hex');
  await owner('PUT','/v2/items/'+id,{operationId:randomUUID(),version,objectKey,codeHash:createHmac('sha256','gam-locker-code-v1').update('123456').digest('hex'),cipherSize:data.length,expireAt:new Date(Date.now()+86400000).toISOString(),maxPulls:1,pullsLeft:1});
  const slug=randomBytes(5).toString('hex');await owner('POST',`/v2/items/${id}/share`,{operationId:randomUUID(),slug});
  return {id,key,plain,data,objectKey,slug,url:base+'/d/'+slug+'#'+authenticatedFragment(key,slug,'领取验收.txt',plain.length)};
 }
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const context=await browser.newContext({acceptDownloads:true,viewport:{width:980,height:760}}),page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 const first=await fixture();let contentRequests=0,ackDropped=false;const sentUrls=[];
 page.on('request',r=>{sentUrls.push(r.url());if(r.url().endsWith('/content'))contentRequests++});
 // Legacy and tampered integrity metadata fail before lookup/reservation.
 for(const rejected of [first.url.split('#')[0]+'#'+first.key.toString('base64url'),first.url.replace('.'+first.plain.length+'.','.'+(first.plain.length-1)+'.'),first.url.replace(Buffer.from('领取验收.txt').toString('base64url'),Buffer.from('伪造名称.txt').toString('base64url'))]){
  await page.goto(rejected);await page.getByLabel('6 位取件码').fill('123456');await page.getByRole('button',{name:'查询文件',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#error').textContent.includes('完整性'));
  assert.equal((await db.prepare('SELECT pulls_left FROM locker_v2_items WHERE item_id=?').bind(first.id).first()).pulls_left,1);
 }
 await page.route('**/v2/claims/*/ack',async route=>{const response=await route.fetch();if(!ackDropped){ackDropped=true;await route.abort('failed')}else await route.fulfill({response})});
 await page.goto(first.url);assert.equal(await page.locator('body').getAttribute('data-locker-protocol'),'2');await page.getByLabel('6 位取件码').fill('１２３ ４５６');await page.getByRole('button',{name:'查询文件',exact:true}).click();
 await page.getByRole('heading',{name:'领取验收.txt'}).waitFor();
 const before=await db.prepare('SELECT pulls_left FROM locker_v2_items WHERE item_id=?').bind(first.id).first();assert.equal(before.pulls_left,1);
 await page.screenshot({path:path.join(out,'browser-pickup.png'),fullPage:true});
 const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'领取并保存',exact:true}).click()]);
 assert.equal(download.suggestedFilename(),'领取验收.txt');assert.deepEqual(await readFile(await download.path()),first.plain);
 await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('已确认内容交付'));
 assert.equal(contentRequests,1,'ACK response loss must not fetch another copy');
 assert.equal(await bucket.head(first.objectKey),null);
 assert(sentUrls.every(url=>!url.includes(first.key.toString('base64url'))),'fragment content key must never be sent');
 await page.screenshot({path:path.join(out,'browser-delivered.png'),fullPage:true});
 const storage=await page.evaluate(()=>JSON.stringify(sessionStorage));assert(!storage.includes(first.key.toString('base64url')));assert(!storage.includes('123456'));
 // Lost reserve response + stop-share + reload must recover the original operation.
 const second=await fixture();await page.unrouteAll({behavior:'wait'});let reserveDropped=false;
 await page.route('**/v2/shares/*/claims',async route=>{const response=await route.fetch();if(!reserveDropped){reserveDropped=true;await route.abort('failed')}else await route.fulfill({response})});
 await page.goto(second.url);await page.getByLabel('6 位取件码').fill('123456');await page.getByRole('button',{name:'查询文件',exact:true}).click();await page.getByRole('heading',{name:'领取验收.txt'}).waitFor();await page.getByRole('button',{name:'领取并保存',exact:true}).click();await page.getByRole('button',{name:'继续本次领取',exact:true}).waitFor();
 const opBefore=await page.evaluate(()=>JSON.parse(sessionStorage.getItem(Object.keys(sessionStorage).find(k=>k===`locker.claim.v2.${document.body.dataset.slug}`))).operationId);
 await owner('DELETE',`/v2/items/${second.id}/share`,{operationId:randomUUID()});
 await page.reload();assert(await page.getByLabel('6 位取件码').isEnabled());await page.getByLabel('6 位取件码').fill('123456');
 const [recovered]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'继续本次领取',exact:true}).click()]);assert.deepEqual(await readFile(await recovered.path()),second.plain);
 const count=await db.prepare('SELECT COUNT(*) AS n FROM locker_v2_claims WHERE item_id=?').bind(second.id).first();assert.equal(count.n,1);assert((await db.prepare('SELECT operation_id FROM locker_v2_claims WHERE item_id=?').bind(second.id).first()).operation_id===opBefore);
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(out,'browser-mobile.png'),fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 // A malicious response can serve a header or authenticated whole-chunk prefix with
 // a matching HTTP length. It must never cause save or acknowledgement.
 let badDownloads=0,badAcks=0;page.on('download',()=>badDownloads++);page.on('request',r=>{if(r.url().endsWith('/ack'))badAcks++});
 for(const prefixSize of [9,9+24+4+16]){
 const corrupt=await fixture(4);await page.unrouteAll({behavior:'wait'});
 await page.route('**/v2/claims/*/content',async route=>{const response=await route.fetch();const raw=await response.body();await route.fulfill({response,body:raw.subarray(0,prefixSize),headers:{...response.headers(),'content-length':String(prefixSize)}})});
 await page.goto(corrupt.url);await page.getByLabel('6 位取件码').fill('123456');await page.getByRole('button',{name:'查询文件',exact:true}).click();await page.getByRole('heading',{name:'领取验收.txt'}).waitFor();await page.getByRole('button',{name:'领取并保存',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#error').textContent.includes('解密校验'));
 assert.equal(badDownloads,0);assert.equal(badAcks,0);assert(await bucket.head(corrupt.objectKey));assert.equal((await db.prepare('SELECT state FROM locker_v2_claims WHERE item_id=?').bind(corrupt.id).first()).state,'delivering');
 }
 assert.deepEqual(errors,[]);
 const result={result:'passed',scope:'real Chromium and local workerd/D1/R2; no cloud deployment',checks:['lookup does not consume','actual ciphertext decrypt/download hash matches','ACK loss uses status, no second content','fragment key never transmitted or stored','lost reserve response + stop-share + reload reuses original op with code re-entry','single quota debit','390px layout','legacy/tampered size/name fragments rejected before claim','header-only and authenticated whole-chunk truncation prevent download and ACK'],date:new Date().toISOString()};
 await writeFile(path.join(out,'browser-service-check.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
try{await run()}finally{await browser?.close();await mf?.dispose()}
