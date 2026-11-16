// Dedicated isolated Windows WebView2 profile only. No user vault/cloud access.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {chromium}=require(path.join(process.env.LOCALAPPDATA,'GitKeymasterDev/design-tools/node_modules/playwright-core'));
const {open,fixture,out}=require('./test-locker-ui.cjs');
(async()=>{
 const port=Number(process.env.LOCKER_QA_PORT||9234);
 const raw=execFileSync('powershell.exe',['-NoProfile','-Command',`Get-CimInstance Win32_Process -Filter "name = 'msedgewebview2.exe'" | Where-Object { $_.CommandLine -match '--remote-debugging-port=${port}' -and $_.CommandLine -notmatch '--type=' } | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress`],{encoding:'utf8'});
 const all=JSON.parse(raw),info=Array.isArray(all)?all[0]:all;assert(info.CommandLine.includes('GitKeymasterDev\\locker-qa-'),'Refuse non-QA WebView');
 const browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
 try{
  const context=browser.contexts()[0],page=context.pages()[0];page.setDefaultTimeout(20000);
  await page.waitForFunction(()=>!!window.__TAURI_INTERNALS__?.invoke);
  const native=await page.evaluate(async()=>{const invoke=window.__TAURI_INTERNALS__.invoke;const status=await invoke('vault_status');const checks=[];for(const command of ['locker_list','locker_operations_list','locker_operation_status']){try{await invoke(command,command==='locker_operation_status'?{operationId:'00000000-0000-4000-8000-000000000001'}:{});checks.push({command,registered:true})}catch(e){if(String(e?.message||e).includes('not found'))throw e;checks.push({command,registered:true,errorCode:e?.code||null})}}return {initialized:status.initialized,unlocked:status.unlocked,checks}});
  assert.equal(native.initialized,false);assert.equal(native.unlocked,false);
  await page.screenshot({path:path.join(out,'native-release-startup.png')});
  const data=fixture(),t=await open(browser,data,{existingContext:context,existingPage:page});
  await page.locator('.locker-v2-file-row').first().waitFor();
  await page.screenshot({path:path.join(out,'native-workbench.png')});
  await page.getByRole('button',{name:'寄存文件',exact:true}).first().click();await page.getByRole('button',{name:'选择文件',exact:true}).click();await page.getByRole('button',{name:'开始寄存',exact:true}).click();await page.getByRole('heading',{name:'文件已寄存',exact:true}).waitFor();assert.equal(data.calls.filter(c=>c.cmd==='locker_put_from_path').length,1);
  await page.screenshot({path:path.join(out,'native-deposit-result.png')});assert.deepEqual(t.errors,[]);
  const evidence={date:new Date().toISOString(),engine:await browser.version(),processId:info.ParentProcessId,realNative:native,ui:'actual React rendered in native WebView2 with synthetic IPC; no real vault or cloud operation',checks:['release app starts in isolated profile','native locker IPC is registered','native workbench layout','staged deposit through result']};fs.writeFileSync(path.join(out,'native-check.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
 }finally{await browser.close();fs.rmSync(path.resolve('app/.locker-ui-test.tsx'),{force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
