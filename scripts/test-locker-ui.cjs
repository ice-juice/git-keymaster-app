// Real React locker UI, isolated in-memory IPC. Never opens a real vault, file,
// system picker, clipboard, or remote service. Worker/Rust tests cover protocol.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || path.join(process.env.LOCALAPPDATA,'GitKeymasterDev/design-tools/node_modules/playwright-core'));
const base=process.env.GKM_UI_URL || 'http://127.0.0.1:5173';
const out=path.resolve('docs/design/locker-redesign/implementation');
function fixture(){
 const now=new Date().toISOString();
 return {
  entries:[{id:'00000000-0000-4000-8000-000000000001',name:'项目交接说明.pdf',originalName:'项目交接说明.pdf',mime:'application/pdf',size:24576,createdAt:now,expireAt:new Date(Date.now()+86400000).toISOString(),maxPulls:3,pullsLeft:2,share:{slug:'qaShare001',registeredAt:now},accessStatus:'active',cleanupStatus:'none',syncStatus:'confirmed',legacy:false,endedAt:null,lastError:null},
   {id:'00000000-0000-4000-8000-000000000002',name:'自己的设计文件.zip',originalName:'自己的设计文件.zip',size:1024,createdAt:now,expireAt:new Date(Date.now()+86400000).toISOString(),maxPulls:1,pullsLeft:1,share:null,accessStatus:'active',cleanupStatus:'none',syncStatus:'confirmed',legacy:false,endedAt:null,lastError:null}],
  connection:{storageConfigured:true,serviceConfigured:true,protocolVersion:2,serviceReady:true,storageVerified:true,serviceVerified:true,checkedAt:now,error:null},
  worker:{baseUrl:'https://locker.example.invalid',workersDevUrl:'https://locker.example.invalid',hasSecret:true,hasApiToken:false,tokenLast4:'',lastMethod:''},
  operations:new Map(),calls:[],openPath:'C:\\qa-fixtures\\delivery.zip',savePath:'C:\\qa-fixtures\\received.pdf',
  failList:false,failShare:false,failPutReply:false,failReceiveReply:false,failLookup:false,needAuth:false,holdPut:null,holdLookup:null,receiveStatus:'completed',
 };
}
async function open(browser,data=fixture(),options={}){
 const {mobile=false,width=980,height=620,locale='zh'}=options;
 const context=options.existingContext||await browser.newContext({viewport:{width,height},hasTouch:mobile,isMobile:mobile,locale:locale==='en'?'en-US':'zh-CN'});
 const page=options.existingPage||await context.newPage(),errors=[];page.setDefaultTimeout(15000);
 page.on('pageerror',e=>{errors.push(e.message);console.error(e.message)});
 if(options.existingPage)page.on('console',msg=>{if(msg.type()==='error')console.error('WebView console:',msg.text())});
 // Native Tauri makes its invoke property immutable. Intercept only the local
 // Vite test module, leaving the application binary and real IPC untouched.
 if(options.existingPage)await page.route(/\/node_modules\/\.vite\/deps\/core-[^/]+\.js(?:\?.*)?$/,async route=>{
  const response=await route.fetch();const body=await response.text();
  await route.fulfill({response,body:body.replace('return window.__TAURI_INTERNALS__.invoke(cmd, args, options);','return window.__lockerInvoke(cmd, args);')});
 });
 await page.exposeFunction('__lockerInvoke',async(cmd,args={})=>{
  data.calls.push({cmd,args:structuredClone(args)});
  if(cmd==='locker_list'){if(data.failList)throw{code:'IO',message:'synthetic network failure'};return {entries:structuredClone(data.entries)}}
  if(cmd==='locker_connection_status')return structuredClone(data.connection);
  if(cmd==='locker_get_worker_config')return structuredClone(data.worker);
  if(cmd==='locker_operations_list')return {operations:[...data.operations.values()].map(v=>structuredClone(v))};
  if(cmd==='locker_operation_status')return structuredClone(data.operations.get(args.operationId)||null);
  if(cmd==='locker_operation_resume'){
   const op=data.operations.get(args.operationId);if(!op)throw Error('operation missing');op.status='completed';op.recoverable=false;op.error=null;return structuredClone(op);
  }
  if(cmd==='locker_operation_retarget'){
   const op=data.operations.get(args.operationId);assert(op?.canRetarget);assert.equal(args.destination.kind,'disk');
   op.destPath=args.destination.path;op.status='completed';op.recoverable=false;op.canRetarget=false;op.error=null;return structuredClone(op);
  }
  if(cmd==='locker_deploy_status')return {running:false,method:'',currentStep:1,totalSteps:12,headline:'',steps:[],accounts:[],waitingForAccount:false,cancelable:false,workersDevUrl:'',currentUrl:'',keptCustomAddress:false,hasSecret:true,error:null,finished:false,note:null};
  if(cmd==='locker_source_stat')return {name:'delivery.zip',size:8192};
  if(cmd==='plugin:dialog|open')return data.openPath;
  if(cmd==='plugin:dialog|save')return data.savePath;
  if(cmd.startsWith('locker_put_')){
   const id=args.opts?.operationId;assert(id,'upload operation ID required');
   if(data.holdPut)await data.holdPut;
   const item={...data.entries[0],id:crypto.randomUUID(),name:args.opts?.name||'delivery.zip',originalName:'delivery.zip',share:null,maxPulls:args.opts?.unlimitedPulls?null:(args.opts?.maxPulls||1),pullsLeft:args.opts?.unlimitedPulls?null:(args.opts?.maxPulls||1)};
   item.shareRequested=!!args.opts?.shareRequested;item.shareStatus=item.shareRequested?'pending':'none';data.entries.unshift(item);
   data.operations.set(id,{operationId:id,kind:'put',status:'completed',phase:'completed',itemId:item.id,name:item.name,destPath:null,fileId:null,pullsLeft:item.pullsLeft,cleanupStatus:'none',error:null,recoverable:false,updatedAt:new Date().toISOString()});
   if(data.failPutReply)throw{code:'IO',message:'synthetic lost upload response'};
   return {id:item.id,code:'123456'};
  }
  if(cmd==='locker_reveal_code')return {code:'123456'};
  if(cmd==='locker_share'){
   const item=data.entries.find(v=>v.id===args.id);
   if(data.failShare){if(item){item.shareStatus='failed';item.shareError='synthetic share failure'}throw{code:'IO',message:'synthetic share failure'}}
   if(item){item.share={slug:'qaShare002',registeredAt:new Date().toISOString()};item.shareStatus='active';item.shareError=null}
   return {slug:'qaShare002',url:'https://locker.example.invalid/d/qaShare002#'+'a'.repeat(64)};
  }
  if(cmd==='locker_revoke_share'){const item=data.entries.find(v=>v.id===args.id);if(item){item.share=null;item.shareStatus='stopped'}return null}
  if(cmd==='locker_delete'){const item=data.entries.find(v=>v.id===args.id);if(item){item.accessStatus='deleted';item.cleanupStatus='pending';item.share=null;item.endedAt=new Date().toISOString()}return null}
  if(cmd==='locker_clear_history'){data.entries=data.entries.filter(v=>v.cleanupStatus!=='cleaned');return null}
  if(cmd==='locker_lookup'){
   if(data.holdLookup)await data.holdLookup;
   if(data.needAuth&&!args.password)throw{code:'NEED_REAUTH',message:'需要访问密码'};
   if(data.failLookup)throw{code:'INVALID',message:'取件码不正确'};
   const source=args.source;const item=data.entries.find(v=>v.id===source.id)||data.entries[0];
   if(!source.id&&source.code!=='123456')throw{code:'INVALID',message:'取件码不正确'};
   return {id:item.id,name:item.name,originalName:item.originalName,size:item.size,sizeIsEstimate:!!source.shareUrl,expireAt:item.expireAt,maxPulls:item.maxPulls,pullsLeft:item.pullsLeft,inFlightClaims:item.inFlightClaims||0,version:'qa-version-one',source:source.shareUrl?'share':'own',protocolVersion:2,legacy:false};
  }
  if(cmd==='locker_receive'){
   if(data.needReceiveAuth&&!args.password)throw{code:'NEED_REAUTH',message:'需要访问密码'};
   assert(args.operationId);assert.equal(args.snapshotVersion,'qa-version-one');assert(['disk','vault'].includes(args.destination.kind));
   const op={operationId:args.operationId,kind:'receive',status:data.receiveStatus,phase:data.receiveStatus==='saved'?'confirming':'completed',itemId:data.entries[0].id,name:data.entries[0].name,destPath:args.destination.path||null,fileId:args.destination.kind==='vault'?'qa-vault-file':null,pullsLeft:1,cleanupStatus:'none',error:null,recoverable:data.receiveStatus!=='completed',updatedAt:new Date().toISOString()};
   data.operations.set(args.operationId,op);
   if(data.failReceiveReply)throw{code:'IO',message:'synthetic lost receive response'};
   return structuredClone(op);
  }
  if(cmd==='file_list')return {entries:[],groups:[]};
  if(cmd==='biometric_status')return {available:false,enabled:false,revealEnabled:false};
  if(cmd==='clipboard_write')return {secretCleared:false};
  if(cmd==='get_reveal_settings')return {clipboardClearSeconds:20};
  if(cmd==='locker_save_worker_config'){data.worker.baseUrl=args.baseUrl;return structuredClone(data.worker)}
  if(cmd==='plugin:event|listen')return 1;
  if(cmd==='get_ui_locale')return locale;
  if(cmd==='locker_probe_worker')return {ok:true,url:args.url,checks:[{id:'health',ok:true,status:200,detail:'protocol v2'}],hint:null};
  if(cmd==='locker_migrate_legacy'){const item=data.entries.find(v=>v.id===args.id);if(item){item.legacy=false;item.quotaOrigin=item.share?'legacyService':'legacyWorkspace'}return null}
  return null;
 });
 await page.addInitScript(({locale})=>{
  window.__TAURI_INTERNALS__={invoke:(cmd,args)=>window.__lockerInvoke(cmd,args),transformCallback:()=>1,unregisterCallback:()=>{},convertFileSrc:x=>x,metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}}};
  window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
  localStorage.setItem('gam.uiLocale',locale);
 },{locale});
 const entry=path.resolve('app/.locker-ui-test.tsx');
 fs.writeFileSync(entry,`
 import {createElement as h} from 'react';
 import {createRoot} from 'react-dom/client';
 import {MemoryRouter} from 'react-router-dom';
 import {ToolsLockerPage} from './src/pages/tools/ToolsLockerPage';
 import {useApp} from './src/store';
 import './src/index.css';import './src/lib/i18n';
 ${mobile?"import './src/styles/mobile.css';":''}
 useApp.setState({writesLocked:false});
 window.__lockerLock=value=>useApp.setState({writesLocked:value});
 window.__lockerSession=unlocked=>useApp.setState({status:{...useApp.getState().status,unlocked,workspaceId:'qa-workspace'}});
 window.__lockerTheme=theme=>{document.documentElement.dataset.theme=theme;useApp.setState({theme})};
 createRoot(document.getElementById('root')).render(h(MemoryRouter,{initialEntries:['/tools/locker']},h('main',{style:{height:'100dvh',overflow:'auto',padding:16}},h(ToolsLockerPage))));
 `);
 await page.route('**/__locker_ui_test',r=>r.fulfill({contentType:'text/html',body:`<!doctype html><html data-platform="${mobile?'mobile':'desktop'}" data-theme="light"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;await import('/${path.basename(entry)}');</script></body></html>`}));
 await page.goto(base+'/__locker_ui_test');
 return {page,context,data,errors,entry};
}
module.exports={open,fixture,out};
if(require.main===module)(async()=>{
 fs.mkdirSync(out,{recursive:true});const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 const results=[];
 const ready=async t=>t.page.locator('.locker-v2-file-row').filter({hasText:'项目交接说明.pdf'}).first().waitFor();
 const count=(data,cmd)=>data.calls.filter(c=>c.cmd===cmd).length;
 const done=async t=>{assert.deepEqual(t.errors,[]);await t.context.close()};
 const deposit=async p=>{await p.getByRole('button',{name:'寄存文件',exact:true}).first().click();await p.getByRole('button',{name:'选择文件',exact:true}).click();await p.getByText('delivery.zip',{exact:true}).first().waitFor()};
 const lookup=async p=>{await p.getByRole('button',{name:'取件',exact:true}).click();await p.getByLabel('取件码',{exact:true}).fill('１２３ ４５６');await p.getByRole('button',{name:'查询文件',exact:true}).click();await p.getByRole('button',{name:'领取并保存',exact:true}).waitFor()};
 try{
  let data=fixture(),t=await open(browser,data),p=t.page;await ready(t);
  await p.screenshot({path:path.join(out,'workbench-initial.png'),fullPage:true});
  await p.getByRole('textbox',{name:'搜索文件名'}).fill('missing');await p.getByText('没有匹配的寄存文件',{exact:true}).waitFor();
  await p.getByRole('button',{name:'清空搜索',exact:true}).click();assert.equal(await p.locator('.locker-v2-file-row').count(),2);
  data.failList=true;await p.getByRole('button',{name:'刷新',exact:true}).click();await p.getByText(/列表加载失败/).waitFor();assert.equal(await p.locator('.locker-v2-file-row').count(),2);
  data.failList=false;await p.getByRole('button',{name:'刷新',exact:true}).first().click();
  results.push('search/reset and failed refresh preserve current records');
  await deposit(p);assert.equal(data.calls.filter(c=>c.cmd.startsWith('locker_put_')).length,0);
  assert.equal(await p.getByRole('combobox',{name:/^有效期/}).inputValue(),'24h');assert.equal(await p.getByRole('combobox',{name:/^可领取次数/}).inputValue(),'1');
  assert(await p.getByRole('radio',{name:/自己取用/}).isChecked());
  await p.getByRole('combobox',{name:/^有效期/}).selectOption('custom');await p.getByLabel('自定义小时数',{exact:true}).fill('-3');
  assert(await p.getByRole('button',{name:'开始寄存',exact:true}).isDisabled());await p.getByRole('combobox',{name:/^有效期/}).selectOption('24h');
  await p.getByRole('radio',{name:/分享给他人/}).check();data.failShare=true;
  await p.getByRole('button',{name:'开始寄存',exact:true}).dblclick();await p.getByText('文件已寄存，分享暂未生成。不需要重新上传。',{exact:false}).waitFor();
  assert.equal(count(data,'locker_put_from_path'),1);assert.equal(data.calls.find(c=>c.cmd==='locker_put_from_path').args.opts.maxPulls,1);
  await p.screenshot({path:path.join(out,'partial-share.png'),fullPage:true});
  data.failShare=false;await p.getByRole('button',{name:'重试生成分享',exact:true}).click();await p.getByRole('button',{name:'复制交接信息',exact:true}).waitFor();assert.equal(count(data,'locker_put_from_path'),1);
  results.push('staged selection, integer rules, defaults, duplicate submit guard, partial share retry without reupload');await done(t);

  data=fixture();let finishPut;data.holdPut=new Promise(resolve=>finishPut=resolve);t=await open(browser,data);p=t.page;await ready(t);await deposit(p);await p.getByRole('button',{name:'开始寄存',exact:true}).click();await p.getByRole('button',{name:'返回寄存柜',exact:true}).first().click();await p.locator('.locker-v2-recovery summary').waitFor();assert.equal(count(data,'locker_put_from_path'),1);finishPut();await p.locator('.locker-v2-file-row').filter({hasText:'delivery.zip'}).waitFor();assert.equal(await p.locator('.locker-v2-recovery').count(),0);assert.equal(await p.getByText('123 456',{exact:true}).count(),0);results.push('back during upload keeps pending operation visible and does not expose completed code on home');await done(t);

  data=fixture();data.failShare=true;t=await open(browser,data);p=t.page;await ready(t);await deposit(p);await p.getByRole('radio',{name:/分享给他人/}).check();await p.getByRole('button',{name:'开始寄存',exact:true}).click();await p.getByRole('button',{name:'重试生成分享',exact:true}).waitFor();await done(t);
  t=await open(browser,data);p=t.page;await ready(t);await p.getByText('分享未完成',{exact:true}).waitFor();await p.locator('.locker-v2-file-row').filter({hasText:'delivery.zip'}).getByRole('button',{name:'查看详情',exact:true}).click();data.failShare=false;await p.getByRole('button',{name:'重试生成分享',exact:true}).click();await p.getByRole('button',{name:'查看取件码',exact:true}).click();await p.getByRole('button',{name:'复制交接信息',exact:true}).waitFor();assert.equal(count(data,'locker_put_from_path'),1);results.push('partial share intent survives fresh page and retries original stored item');await done(t);

  data=fixture();data.failPutReply=true;t=await open(browser,data);p=t.page;await ready(t);await deposit(p);await p.getByRole('button',{name:'开始寄存',exact:true}).click();await p.getByText('文件已寄存',{exact:true}).first().waitFor();assert.equal(count(data,'locker_put_from_path'),1);assert(count(data,'locker_operation_status')>=1);results.push('lost upload reply resolves original operation without duplicate upload');await done(t);

  data=fixture();t=await open(browser,data);p=t.page;await ready(t);await p.getByRole('button',{name:'取件',exact:true}).click();
  await p.getByLabel('取件码',{exact:true}).fill('abc');await p.getByRole('button',{name:'查询文件',exact:true}).click();await p.getByText('请输入 6 位数字取件码。',{exact:true}).waitFor();assert.equal(count(data,'locker_lookup'),0);
  await p.getByLabel('取件码',{exact:true}).fill('１２３ ４５６');await p.getByRole('button',{name:'查询文件',exact:true}).click();await p.getByRole('button',{name:'领取并保存',exact:true}).waitFor();
  assert.equal(data.calls.find(c=>c.cmd==='locker_lookup').args.source.code,'123456');
  await p.getByLabel('取件码',{exact:true}).fill('999999');assert.equal(await p.getByRole('button',{name:'领取并保存',exact:true}).count(),0);
  await p.getByLabel('取件码',{exact:true}).fill('123456');await p.getByRole('button',{name:'查询文件',exact:true}).click();await p.getByRole('button',{name:'领取并保存',exact:true}).waitFor();
  data.savePath=null;await p.getByRole('button',{name:'领取并保存',exact:true}).click();assert.equal(count(data,'locker_receive'),0);
  data.savePath='C:\\qa-fixtures\\received.pdf';data.failReceiveReply=true;await p.getByRole('button',{name:'领取并保存',exact:true}).click();await p.getByRole('heading',{name:'文件已保存',exact:true}).waitFor();
  assert.equal(count(data,'locker_receive'),1);assert.equal(count(data,'locker_pull'),0);assert.equal(count(data,'locker_pull_bytes'),0);
  results.push('code validation/normalization, invalidate lookup, cancelled picker consumes nothing, lost receive reply resolved');await done(t);

  data=fixture();data.receiveStatus='saved';t=await open(browser,data);p=t.page;await ready(t);await lookup(p);await p.getByRole('radio',{name:/文件保险库/}).check();await p.getByRole('button',{name:'领取并保存',exact:true}).click();await p.getByText(/文件已保存，领取结果仍待服务端确认/).waitFor();
  const original=data.calls.find(c=>c.cmd==='locker_receive').args;assert.equal(original.destination.kind,'vault');assert.equal(count(data,'file_add_bytes'),0);
  await p.getByRole('button',{name:'继续原操作',exact:true}).click();await p.getByRole('button',{name:'前往文件保险库',exact:true}).waitFor();
  assert.equal(count(data,'locker_receive'),1);assert.equal(data.calls.find(c=>c.cmd==='locker_operation_resume').args.operationId,original.operationId);results.push('atomic vault destination and saved-but-unacknowledged recovery retain original operation');await done(t);

  data=fixture();data.needReceiveAuth=true;data.failReceiveReply=true;t=await open(browser,data);p=t.page;await ready(t);await lookup(p);await p.getByRole('button',{name:'领取并保存',exact:true}).click();await p.locator('input[type=password]').fill('synthetic-qa-password');await p.locator('input[type=password]').press('Enter');await p.getByRole('heading',{name:'文件已保存',exact:true}).waitFor();assert.equal(await p.locator('input[type=password]').count(),0);const authCalls=data.calls.filter(c=>c.cmd==='locker_receive');assert.equal(authCalls.length,2);assert.equal(authCalls[0].args.operationId,authCalls[1].args.operationId);assert.equal(data.operations.size,1);assert(count(data,'locker_operation_status')>=1);results.push('accepted reauthentication followed by lost mutation response closes dialog and checks original operation');await done(t);

  data=fixture();t=await open(browser,data);p=t.page;await ready(t);await p.getByRole('button',{name:'查看详情',exact:true}).first().click();await p.getByRole('button',{name:'停止分享',exact:true}).click();await p.getByRole('button',{name:'确认',exact:true}).click();await p.getByRole('button',{name:'生成分享入口',exact:true}).waitFor();assert.equal(count(data,'locker_revoke_share'),1);assert.equal(count(data,'locker_delete'),0);assert.equal(data.entries.length,2);
  await p.getByRole('button',{name:'删除寄存文件',exact:true}).click();await p.getByRole('button',{name:'取消',exact:true}).click();assert.equal(count(data,'locker_delete'),0);
  await p.getByRole('button',{name:'删除寄存文件',exact:true}).click();await p.getByRole('button',{name:'确认',exact:true}).click();await p.getByText(/已禁用.*待清理/).first().waitFor();assert.equal(data.entries.length,2);assert.equal(data.entries[0].cleanupStatus,'pending');results.push('stop sharing preserves item; delete requires confirmation and retains pending cleanup');await done(t);

  data=fixture();data.entries[0].pullsLeft=0;data.entries[0].inFlightClaims=1;data.entries[0].accessStatus='exhausted';t=await open(browser,data);p=t.page;await ready(t);await p.getByText('领取处理中 · 暂无空闲名额',{exact:true}).waitFor();assert.equal(await p.locator('.locker-v2-file-row').count(),2);await lookup(p);assert(await p.getByRole('button',{name:'领取并保存',exact:true}).isDisabled());results.push('reserved last allowance stays in progress and forbids new receive');await done(t);

  data=fixture();data.connection={...data.connection,serviceReady:false,serviceVerified:false,protocolVersion:1};t=await open(browser,data);p=t.page;await ready(t);await deposit(p);assert(await p.getByRole('button',{name:'开始寄存',exact:true}).isDisabled());await p.getByRole('combobox',{name:/^可领取次数/}).selectOption('unlimited');assert(!(await p.getByRole('button',{name:'开始寄存',exact:true}).isDisabled()));await p.getByRole('radio',{name:/分享给他人/}).check();assert(await p.getByRole('button',{name:'开始寄存',exact:true}).isDisabled());results.push('old service gates finite/shared operations while explicit unlimited self remains available');await done(t);

  data=fixture();data.needAuth=true;t=await open(browser,data);p=t.page;await ready(t);await p.getByRole('button',{name:'取件',exact:true}).click();await p.getByLabel('取件码',{exact:true}).fill('123456');await p.getByRole('button',{name:'查询文件',exact:true}).click();await p.locator('input[type=password]').waitFor();await p.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await p.getByRole('button',{name:'领取并保存',exact:true}).count(),0);assert(!(await p.getByRole('button',{name:'查询文件',exact:true}).isDisabled()));results.push('cancelled reauthentication does not continue lookup or leave UI busy');await done(t);

  data=fixture();let release;data.holdLookup=new Promise(resolve=>release=resolve);t=await open(browser,data);p=t.page;await ready(t);await p.getByRole('button',{name:'取件',exact:true}).click();await p.getByLabel('取件码',{exact:true}).fill('123456');await p.getByRole('button',{name:'查询文件',exact:true}).click();await p.evaluate(()=>window.__lockerSession(false));release();await p.getByText('请先解锁工作空间。',{exact:true}).waitFor();assert.equal(await p.getByRole('button',{name:'领取并保存',exact:true}).count(),0);results.push('locking during async lookup discards old-session results');await done(t);

  for(const options of [{width:980,height:620},{width:840,height:520},{width:390,height:844,mobile:true},{width:320,height:640,mobile:true},{width:980,height:620,locale:'en'}]){
   data=fixture();t=await open(browser,data,options);p=t.page;await ready(t);
   for(const theme of ['light','dark','navy']){await p.evaluate(theme=>window.__lockerTheme(theme),theme);assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await p.screenshot({path:path.join(out,`home-${options.width}-${options.locale||'zh'}-${theme}.png`),fullPage:true})}
   if(options.locale!=='en'){
    await p.getByRole('button',{name:'寄存文件',exact:true}).first().click();
    if(options.mobile)await p.locator('input[type=file]').setInputFiles({name:'mobile.txt',mimeType:'text/plain',buffer:Buffer.from('synthetic')});else await p.getByRole('button',{name:'选择文件',exact:true}).click();
    await p.getByRole('button',{name:'开始寄存',exact:true}).waitFor();assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await p.screenshot({path:path.join(out,`deposit-${options.width}.png`),fullPage:true});
   }
   await done(t);
  }
  results.push('five viewport/locale combinations × three themes, narrow form and mobile file staging');

  data=fixture();const recoveryId=crypto.randomUUID();data.operations.set(recoveryId,{operationId:recoveryId,kind:'receive',status:'failed',phase:'saving',itemId:data.entries[0].id,name:data.entries[0].name,destPath:'C:\\qa-fixtures\\occupied.pdf',fileId:null,pullsLeft:0,cleanupStatus:'none',error:'目标位置无法写入',recoverable:true,canRetarget:true,updatedAt:new Date().toISOString()});
  t=await open(browser,data);p=t.page;await ready(t);await p.locator('.locker-v2-recovery summary').click();await p.getByRole('button',{name:'查看状态',exact:true}).click();data.savePath=null;await p.getByRole('button',{name:'另存到其他位置',exact:true}).click();assert.equal(count(data,'locker_operation_retarget'),0);
  data.savePath='C:\\qa-fixtures\\new-location.pdf';await p.getByRole('button',{name:'另存到其他位置',exact:true}).click();await p.getByRole('heading',{name:'文件已保存',exact:true}).waitFor();assert.equal(count(data,'locker_receive'),0);assert.equal(data.calls.find(c=>c.cmd==='locker_operation_retarget').args.operationId,recoveryId);assert.equal(await p.getByRole('button',{name:'另存到其他位置',exact:true}).count(),0);results.push('safe retarget preserves original claim and operation; cancelled picker has no effect');await done(t);

  data=fixture();data.entries[0].legacy=true;data.entries[0].share=null;t=await open(browser,data);p=t.page;await ready(t);await p.getByRole('button',{name:'查看详情',exact:true}).first().click();await p.getByRole('button',{name:'升级领取规则',exact:true}).click();await p.getByText(/无法核对其他旧设备的历史取用/).waitFor();await p.getByRole('button',{name:'取消',exact:true}).click();assert.equal(count(data,'locker_migrate_legacy'),0);await p.getByRole('button',{name:'升级领取规则',exact:true}).click();await p.getByRole('button',{name:'确认',exact:true}).click();await p.getByText('领取规则已升级。',{exact:true}).waitFor();assert.equal(count(data,'locker_migrate_legacy'),1);assert.equal(data.entries[0].pullsLeft,2);assert.equal(data.entries[0].quotaOrigin,'legacyWorkspace');results.push('legacy private migration explicitly warns, requires confirmation and preserves remaining quota');await done(t);
  fs.writeFileSync(path.join(out,'ui-check.json'),JSON.stringify({date:new Date().toISOString(),scope:'actual React UI with isolated synthetic IPC',results},null,2));console.log(JSON.stringify({passed:results.length,results},null,2));
 }
 finally{await browser.close();fs.rmSync(path.resolve('app/.locker-ui-test.tsx'),{force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
