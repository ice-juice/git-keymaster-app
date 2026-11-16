// Actual React UI with an isolated, in-memory IPC fixture. Native OS behavior is
// separately verified; this harness never opens a user's vault or changes OS settings.
const path = require("node:path");
const fs = require("node:fs");
const assert = require("node:assert/strict");
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE ||
    path.join(
      process.env.LOCALAPPDATA,
      "GitKeymasterDev/design-tools/node_modules/playwright-core",
    ),
);
const url = process.env.GKM_UI_URL || "http://127.0.0.1:5173";
const out = path.resolve("docs/design/first-run-onboarding/implementation");
fs.mkdirSync(out, { recursive: true });
const prefs = {
  theme: "light",
  startupAnimation: true,
  unlockAnimation: true,
  unlockStyle: "minimal",
  screenProtection: true,
  autoLockMinutes: 5,
  lockOnSleep: true,
  clipboardClearSeconds: 20,
  revealGraceMinutes: 1,
  maskAccounts: true,
  clipboardWatch: false,
  launchAtLogin: false,
};
function fixture() {
  return {
    view: {
      record: {
        version: 1,
        status: "notStarted",
        revision: 0,
        step: 0,
        draft: { ...prefs },
        pending: null,
        lastRequestId: null,
        lastError: null,
        uiPending: false,
        offerBiometrics: true,
      },
      allowScreenshots: true,
      capability: "exclude",
      captureLimited: false,
      launchAtLoginSupported: true,
      screenLockDetectable: true,
      configError: false,
    },
    calls: [],
    commits: 0,
    failCommitReply: false,
    failEffect: false,
    failReads: false,
    unlocked: false,
  };
}
async function open(browser, data, options = {}) {
  const context = await browser.newContext({
    viewport: { width: 980, height: 700 },
    locale: "zh-CN",
    colorScheme: "light",
    ...options,
  });
  const errors = [];
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.exposeFunction("__testInvoke", async (cmd, args = {}) => {
    data.calls.push(cmd);
    const r = data.view.record;
    if (cmd === "onboarding_get") {
      if (data.failReads) throw Error("offline");
      return structuredClone(data.view);
    }
    if (cmd === "onboarding_save_draft") {
      await new Promise((resolve) => setTimeout(resolve, 15));
      assert.equal(args.revision, r.revision);
      r.draft = args.preferences;
      r.step = args.step;
      r.status = "inProgress";
      r.revision++;
      return structuredClone(data.view);
    }
    if (cmd === "onboarding_commit") {
      data.commits++;
      r.pending = { requestId: args.requestId, preferences: r.draft };
      r.revision++;
      if (data.failEffect) throw Error("simulated OS error");
      data.view.allowScreenshots = !r.draft.screenProtection;
      r.pending = null;
      r.status = "completed";
      r.uiPending = true;
      r.lastRequestId = args.requestId;
      if (data.failCommitReply) {
        data.failCommitReply = false;
        throw Error("simulated lost response");
      }
      return structuredClone(data.view);
    }
    if (cmd === "onboarding_ack_ui") {
      assert.equal(args.requestId, r.lastRequestId);
      r.uiPending = false;
      r.revision++;
      if (data.failAckReply) { data.failAckReply=false; throw Error('simulated lost UI acknowledgement'); }
      return structuredClone(data.view);
    }
    if (cmd === "onboarding_skip") {
      assert.equal(args.revision, r.revision);
      r.status = "skipped";
      r.draft = null;
      r.revision++;
      return structuredClone(data.view);
    }
    if (cmd === "onboarding_reopen") {
      r.status = "inProgress";
      r.step = 0;
      r.draft = {
        ...args.preferences,
        screenProtection: !data.view.allowScreenshots,
      };
      r.revision++;
      return structuredClone(data.view);
    }
    if (cmd === "onboarding_dismiss_biometrics") {
      r.offerBiometrics = false;
      return null;
    }
    if (cmd === "vault_status")
      return {
        initialized: data.unlocked,
        unlocked: data.unlocked,
        workspaceId: data.unlocked ? "synthetic-workspace" : null,
        workspacePath: null,
        autoLockMinutes: 15,
        launchAtLogin: false,
        graceDays: 0,
        graceActive: false,
        graceExpiresAt: null,
        closeAction: null,
        mobileBackgroundRun: false,
      };
    if (cmd === "get_screen_capture_settings")
      return {
        allowScreenshots: data.view.allowScreenshots,
        capability: data.view.capability,
      };
    if (cmd === "get_ui_locale") return data.locale || "zh";
    if (cmd === "biometric_status")
      return {
        available: true,
        enabled: false,
        strong: true,
        kind: "fingerprint",
        revealEnabled: false,
        revealSecret: false,
        stale: false,
      };
    if (cmd === "get_reveal_settings")
      return {
        revealGraceMinutes: 5,
        clipboardClearSeconds: 20,
        accountHistoryLimit: 10,
      };
    if (cmd === "vault_try_grace_unlock") return false;
    if (cmd === "plugin:event|listen") return 1;
    if (cmd.includes("is_maximized")) return false;
    if (cmd === "get_app_config") return {};
    return null;
  });
  await page.addInitScript(
    ({ locale, startup }) => {
      let callback = 0;
      window.__TAURI_INTERNALS__ = {
        invoke: (cmd, args) => window.__testInvoke(cmd, args),
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main" },
        },
        transformCallback: (fn) => {
          const id = ++callback;
          window["_" + id] = fn;
          return id;
        },
        unregisterCallback: () => {},
        convertFileSrc: (x) => x,
      };
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
        unregisterListener: () => {},
      };
      localStorage.setItem("gam.uiLocale", locale);
      if (startup) localStorage.setItem("gam.startupAnim", "on");
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (window.__failUi && key === "gam.startupAnim")
          throw Error("synthetic storage failure");
        return set.call(this, key, value);
      };
    },
    { locale: data.locale || "zh", startup: !!data.startup },
  );
  await page.goto(
    url + (options.isMobile ? "?platform=mobile" : "") + (data.route || ""),
  );
  return { page, context, errors };
}
async function settled(page) {
  await page.waitForFunction(
    () => !document.body.innerText.includes("正在保存草稿"),
  );
}
async function toConfirm(page) {
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await settled(page);
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await settled(page);
}
async function run() {
  const browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ||
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
  });
  const results = [];
  try {
    // Complete save, back-navigation, restart and local-storage handoff.
    let data = fixture(),
      test = await open(browser, data),
      page = test.page;
    await page.getByRole("heading", { name: "选择你的使用体验" }).waitFor();
    assert.equal(data.view.allowScreenshots, true);
    await page.screenshot({
      path: path.join(out, "experience.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await settled(page);
    const capture = page.getByRole("checkbox", { name: /开启截图与录屏防护/ });
    assert(await capture.isChecked());
    assert.equal(data.view.allowScreenshots, true);
    await capture.uncheck();
    await settled(page);
    assert.equal(data.view.allowScreenshots, true);
    await page.reload();
    await page.getByRole("heading", { name: "决定内容如何被保护" }).waitFor();
    assert.equal(
      await page
        .getByRole("checkbox", { name: /开启截图与录屏防护/ })
        .isChecked(),
      false,
    );
    await page.getByRole("checkbox", { name: /开启截图与录屏防护/ }).check();
    await settled(page);
    await page
      .getByLabel("离开多久后自动锁定", { exact: true })
      .selectOption("15");
    await page
      .getByLabel("离开多久后自动锁定", { exact: true })
      .selectOption("5");
    await settled(page);
    assert.equal(data.view.record.draft.autoLockMinutes, 5);
    await page.screenshot({
      path: path.join(out, "security.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await settled(page);
    await page.getByRole("button", { name: "保存并继续", exact: true }).click();
    await page
      .getByRole("heading", { name: "确认你的选择" })
      .waitFor({ state: "hidden" });
    assert.equal(data.view.allowScreenshots, false);
    assert.equal(data.view.record.uiPending, false);
    assert.equal(data.commits, 1);
    assert.equal(
      await page.evaluate(() => localStorage.getItem("gam.startupAnim")),
      "on",
    );
    await page.reload();
    await page.locator(".ob-main").waitFor({ state: "hidden" });
    assert.equal(data.commits, 1);
    assert.deepEqual(test.errors, []);
    results.push("save, draft restart, rapid changes, UI acknowledgement");
    await test.context.close();

    data = fixture();
    test = await open(browser, data);
    page = test.page;
    await page.getByRole("button", { name: "稍后设置", exact: true }).click();
    await page.locator(".ob-main").waitFor({ state: "hidden" });
    assert.equal(data.view.allowScreenshots, true);
    assert.equal(data.view.record.status, "skipped");
    assert.equal(data.commits, 0);
    results.push("skip preserves initial capture permission");
    await test.context.close();

    data = fixture();
    data.failCommitReply = true;
    test = await open(browser, data);
    page = test.page;
    await toConfirm(page);
    await page.getByRole("button", { name: "保存并继续", exact: true }).click();
    await page
      .getByRole("button", { name: "完成界面偏好保存", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "完成界面偏好保存", exact: true })
      .click();
    await page.locator(".ob-main").waitFor({ state: "hidden" });
    assert.equal(data.commits, 1);
    results.push("lost commit response recovered without replay");
    await test.context.close();

    data = fixture();
    test = await open(browser, data);
    page = test.page;
    await toConfirm(page);
    await page.evaluate(() => (window.__failUi = true));
    await page.getByRole("button", { name: "保存并继续", exact: true }).click();
    await page
      .getByRole("button", { name: "完成界面偏好保存", exact: true })
      .waitFor();
    assert.equal(data.view.record.uiPending, true);
    await page.evaluate(() => (window.__failUi = false));
    await page
      .getByRole("button", { name: "完成界面偏好保存", exact: true })
      .click();
    await page.locator(".ob-main").waitFor({ state: "hidden" });
    assert.equal(data.commits, 1);
    results.push("partial local preference failure is recoverable");
    await test.context.close();

    data = fixture();
    data.view.configError = true;
    test = await open(browser, data);
    page = test.page;
    await page.getByText(/本机配置无法读取/).waitFor();
    assert.equal(await page.locator(".ob-main").count(), 0);
    results.push("unreadable configuration blocks setup");
    await test.context.close();

    data = fixture();
    data.view.record.status = "legacy";
    data.view.allowScreenshots = false;
    test = await open(browser, data);
    page = test.page;
    await page.locator(".ob-loading").waitFor({ state: "hidden" });
    assert.equal(await page.locator(".ob-main").count(), 0);
    assert.equal(data.view.allowScreenshots, false);
    results.push("legacy users are not reset");
    await test.context.close();

    data = fixture();
    data.view.capability = "unsupported";
    data.view.launchAtLoginSupported = false;
    test = await open(browser, data);
    page = test.page;
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await settled(page);
    const unsupported = page.getByRole("checkbox", {
      name: /开启截图与录屏防护/,
    });
    assert(await unsupported.isDisabled());
    assert.equal(await unsupported.isChecked(), false);
    results.push("unsupported capture disabled");
    await test.context.close();

    data = fixture();
    data.view.capability = "overlay";
    data.view.launchAtLoginSupported = false;
    data.view.screenLockDetectable = false;
    test = await open(browser, data, {
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    page = test.page;
    await page.getByRole("button", { name: "下一步", exact: true }).tap();
    await settled(page);
    await page.evaluate(() => {
      window.__kmAndroidSafeInsets = { top: 34, bottom: 24, left: 0, right: 0 };
      window.dispatchEvent(new Event("km-android-safe-insets"));
    });
    assert(
      await page
        .locator(".ob-sidebar")
        .evaluate((el) => parseFloat(getComputedStyle(el).paddingTop) >= 48),
    );
    assert(
      await page
        .getByRole("checkbox", { name: /开启后台预览保护/ })
        .isChecked(),
    );
    await page.getByText(/iOS 无法阻止系统截屏/).waitFor();
    const dimensions = await page.evaluate(() => ({
      width: innerWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    assert(dimensions.scroll <= dimensions.width + 1);
    await page.screenshot({
      path: path.join(out, "mobile-overlay.png"),
      fullPage: true,
    });
    results.push("mobile layout, native safe insets and honest iOS capability");
    await test.context.close();
    data = fixture();
    data.locale = "en";
    data.startup = true;
    test = await open(browser, data);
    page = test.page;
    await page
      .getByRole("heading", { name: "Choose your experience" })
      .waitFor();
    assert.equal(await page.locator(".startup-animation").count(), 0);
    results.push("English locale and no forced animation before first use");
    await test.context.close();

    data = fixture();
    data.failEffect = true;
    test = await open(browser, data);
    page = test.page;
    await toConfirm(page);
    await page.getByRole("button", { name: "保存并继续", exact: true }).click();
    await page
      .getByRole("button", { name: "继续完成原保存", exact: true })
      .waitFor();
    assert(
      await page
        .getByRole("button", { name: "稍后设置", exact: true })
        .isDisabled(),
    );
    const originalId = data.view.record.pending.requestId;
    data.failEffect = false;
    await page
      .getByRole("button", { name: "继续完成原保存", exact: true })
      .click();
    await page.locator(".ob-main").waitFor({ state: "hidden" });
    assert.equal(data.view.record.lastRequestId, originalId);
    results.push("partial OS failure resumes the original operation");
    await test.context.close();

    data = fixture();
    data.view.record.status = "legacy";
    data.view.record.offerBiometrics = false;
    data.view.allowScreenshots = false;
    data.unlocked = true;
    data.route = "/#/settings";
    test = await open(browser, data);
    page = test.page;
    await page
      .getByRole("button", { name: "重新查看初次使用引导", exact: true })
      .click();
    await page.getByRole("heading", { name: "选择你的使用体验" }).waitFor();
    assert.equal(data.view.record.draft.screenProtection, true);
    await page.getByRole("button", { name: "稍后设置", exact: true }).click();
    await page
      .getByRole("button", { name: "重新查看初次使用引导", exact: true })
      .waitFor();
    assert.equal(data.view.allowScreenshots, false);
    results.push("settings reopen keeps existing capture protection");
    await test.context.close();

    data = fixture();
    data.view.record.status = "completed";
    data.unlocked = true;
    data.route = "/#/settings";
    test = await open(browser, data);
    page = test.page;
    await page.getByRole("heading", { name: "让下次验证更方便" }).waitFor();
    await page
      .getByRole("button", { name: "开启本机生物识别", exact: true })
      .click();
    assert(
      await page
        .getByRole("button", { name: "开启本机生物识别", exact: true })
        .isDisabled(),
    );
    await page.getByRole("button", { name: "以后再说", exact: true }).click();
    assert.equal(data.view.record.offerBiometrics, false);
    assert(!data.calls.includes("biometric_enable"));
    results.push(
      "post-workspace biometric prompt can be declined without enabling",
    );
    await test.context.close();

    data = fixture(); data.failAckReply = true;
    test = await open(browser, data); page = test.page;
    await toConfirm(page);
    await page.getByRole('button', { name: '保存并继续', exact: true }).click();
    await page.locator('.ob-main').waitFor({ state: 'hidden' });
    assert.equal(data.commits, 1);
    assert.equal(data.view.record.uiPending, false);
    results.push('lost final acknowledgement resolves by readback without a new commit');
    await test.context.close();

    data = fixture();
    test = await open(browser, data, { reducedMotion: 'reduce' }); page = test.page;
    await page.getByRole('heading', { name: '选择你的使用体验' }).waitFor();
    assert(await page.getByRole('button', { name: '预览启动动效', exact: true }).isDisabled());
    assert(await page.getByRole('button', { name: '预览解锁动画', exact: true }).isDisabled());
    results.push('system reduced motion disables animation previews');
    await test.context.close();

    fs.writeFileSync(
      path.join(out, "ui-verification.json"),
      JSON.stringify({ passed: true, results }, null, 2),
    );
    console.log(JSON.stringify({ passed: true, results }, null, 2));
  } finally {
    await browser.close();
  }
}
module.exports = { open, fixture, settled };
if (require.main === module) run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
