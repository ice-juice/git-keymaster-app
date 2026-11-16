// Isolated real React component + synthetic IPC; never connects to a native vault.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || path.join(process.env.LOCALAPPDATA, 'GitKeymasterDev/design-tools/node_modules/playwright-core'));
const origin = process.env.GKM_SECURITY_URL || 'http://127.0.0.1:15276';
const out = path.resolve('docs/security-fixes/evidence');
fs.mkdirSync(out, { recursive: true });

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const results = [];
  try {
    for (const width of [980, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 780 }, locale: 'zh-CN' });
      const page = await context.newPage();
      const calls = [];
      const errors = [];
      const key = 'GAM1-SYNTHETIC-RECOVERY-CODE';
      let migrated = false;
      page.on('pageerror', e => { errors.push(e.message); console.error(e.message); });
      page.on('response', r => { if(r.status() >= 400) console.error(r.status(), r.url()); });
      await page.exposeFunction('__securityInvoke', async (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === 'rotate_recovery_key') {
          if (args.password !== 'synthetic password ') throw { code: 'BAD_PASSWORD', message: '密码错误' };
          return { token: 'synthetic-operation', recoveryKey: key, workspaceId: 'synthetic-vault' };
        }
        if (cmd === 'commit_recovery_key') {
          assert.equal(args.token, 'synthetic-operation'); assert.equal(args.recoveryKey, key); return null;
        }
        if (cmd === 'cancel_recovery_key') return null;
        if (cmd === 'reset_access_password_with_recovery') { assert.equal(args.recoveryKey, key); return null; }
        if (cmd === 'security_migration_prepare') {
          assert.equal(args.accessPassword, 'synthetic password ');
          assert.equal(args.newPassword, 'brand new synthetic password');
          return { token:'synthetic-migration', recoveryKey:key, workspaceId:'synthetic-new-vault', path:'E:/synthetic-new-vault', sourcePath:'synthetic-path', summary:{accountCount:1,totpCount:1,fileCount:1,noteCount:1,keyCount:1,blobCount:1} };
        }
        if (cmd === 'security_migration_cancel') return null;
        if (cmd === 'security_migration_activate') {
          if(args.recoveryKey !== key) throw {code:'INVALID',message:'恢复码不匹配'};
          migrated = true; return null;
        }
        if (cmd === 'vault_status') return { initialized:true,unlocked:true,workspaceId:migrated?'synthetic-new-vault':'synthetic-vault',workspacePath:migrated?'E:/synthetic-new-vault':'synthetic-path' };
        throw Error('Unexpected IPC ' + cmd);
      });
      await page.addInitScript(() => {
        localStorage.setItem('gam.uiLocale', 'zh');
        window.__TAURI_INTERNALS__ = { invoke: (cmd, args) => window.__securityInvoke(cmd, args) };
      });
      await page.route('**/__security-harness', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/src/index.css"></head><body><main id="root" style="max-width:650px;margin:20px auto;padding:12px"></main><script type="module">
import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;
await import('/src/ui/securityRecoveryHarness.tsx');
</script></body></html>` }));
      await page.goto(origin + '/__security-harness');
      const prepare = page.getByRole('button', { name: '验证并生成待确认恢复码', exact: true });
      await prepare.waitFor(); assert.equal(await prepare.isDisabled(), true);
      await page.getByLabel('访问密码（本次操作重新验证）', { exact: true }).fill('synthetic password ');
      await prepare.click();
      await page.getByText(key, { exact: true }).waitFor();
      await page.screenshot({ path: path.join(out, `recovery-prepared-${width}.png`), fullPage:true });
      assert.equal(calls.filter(c => c.cmd === 'commit_recovery_key').length, 0);
      const commit = page.getByRole('button', { name: '已安全保存，启用新码', exact: true });
      assert.equal(await commit.isDisabled(), true);
      await page.getByLabel('输入已保存的完整新恢复码').fill('wrong'); assert.equal(await commit.isDisabled(), true);
      await page.getByLabel('输入已保存的完整新恢复码').fill(key); await commit.click();
      await page.getByRole('status').waitFor(); assert.equal(calls.filter(c => c.cmd === 'commit_recovery_key').length, 1);
      await page.getByLabel('访问密码（本次操作重新验证）', { exact: true }).fill('synthetic password '); await prepare.click();
      await page.getByText(key, { exact: true }).waitFor(); await page.getByRole('button', { name: '取消', exact: true }).click();
      await prepare.waitFor(); assert.equal(calls.filter(c => c.cmd === 'commit_recovery_key').length, 1);
      assert.ok(calls.some(c => c.cmd === 'cancel_recovery_key'));
      await page.getByLabel('访问密码（本次操作重新验证）', { exact: true }).fill('synthetic password '); await prepare.click();
      await page.getByText(key, { exact: true }).waitFor();
      await page.evaluate(() => window.__securityStore.setState({ status: { initialized:true,unlocked:false,workspaceId:'synthetic-vault',workspacePath:'synthetic-path' } }));
      await page.waitForFunction(() => !document.body.innerText.includes('GAM1-SYNTHETIC-RECOVERY-CODE'));
      assert.equal(await prepare.isDisabled(), true);
      await page.evaluate(() => window.__securityStore.setState({ status: { initialized:true,unlocked:true,workspaceId:'synthetic-vault',workspacePath:'synthetic-path' } }));
      await page.getByRole('button', {name:'主密钥疑似泄露：创建全新安全副本',exact:true}).click();
      await page.getByLabel('全新目标目录（必须不存在）').fill('E:/synthetic-new-vault');
      await page.getByLabel('当前访问密码',{exact:true}).fill('synthetic password ');
      await page.getByLabel('新的访问密码',{exact:true}).fill('brand new synthetic password');
      await page.getByLabel('再次输入新密码',{exact:true}).fill('brand new synthetic password');
      await page.getByRole('button',{name:'验证当前密码并创建副本',exact:true}).click();
      await page.getByRole('button',{name:'确认并切换到新库',exact:true}).waitFor();
      assert.equal(migrated,false);
      await page.getByLabel('输入已保存的新恢复码',{exact:true}).fill('wrong');
      await page.getByRole('button',{name:'确认并切换到新库',exact:true}).click();
      await page.getByText('恢复码不匹配',{exact:true}).waitFor(); assert.equal(migrated,false);
      await page.getByLabel('输入已保存的新恢复码',{exact:true}).fill(key);
      await page.screenshot({path:path.join(out,`migration-prepared-${width}.png`),fullPage:true});
      await page.getByRole('button',{name:'确认并切换到新库',exact:true}).click();
      await page.waitForFunction(() => window.__securityStore.getState().status.workspaceId === 'synthetic-new-vault');
      assert.equal(migrated,true);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false);
      await page.screenshot({ path: path.join(out, `recovery-${width}.png`), fullPage:true });
      assert.deepEqual(errors, []);
      results.push({ width, prepareDoesNotCommit:true, confirmationRequired:true, cancelPreservesOldKey:true, lockClearsDisplayedKey:true, migrationPrepareDoesNotSwitch:true, migrationRejectsWrongConfirmation:true, migrationActivatesOnlyAfterConfirmation:true, overflow:false });
      await context.close();
    }
    fs.writeFileSync(path.join(out, 'recovery-ui.json'), JSON.stringify({ date:new Date().toISOString(), results }, null, 2));
    console.log(JSON.stringify(results));
  } finally { await browser.close(); }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
