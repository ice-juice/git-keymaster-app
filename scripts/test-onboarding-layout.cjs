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
const { open, fixture, settled } = require("./test-onboarding-ui.cjs");
const out = path.resolve("docs/design/first-run-onboarding/ui-refinement");
fs.mkdirSync(out, { recursive: true });
async function rect(page, selector) {
  return page.locator(selector).boundingBox();
}
async function checkLayout(page, label) {
  const viewport = page.viewportSize();
  const header = await rect(page, ".ob-main>header");
  const nav = await rect(page, ".ob-sidebar nav");
  const footer = await rect(page, ".ob-footer");
  const primary = await rect(page, ".ob-footer .primary");
  const clip = await page.evaluate(() => ({
    w: document.documentElement.clientWidth,
    sw: document.documentElement.scrollWidth,
    h: document.documentElement.clientHeight,
    sh: document.documentElement.scrollHeight,
  }));
  assert(
    clip.sw <= clip.w + 1 && clip.sh <= clip.h + 1,
    `${label}: outer overflow ${JSON.stringify(clip)}`,
  );
  assert(
    footer.y >= header.y + header.height &&
      footer.y + footer.height <= viewport.height + 1,
    `${label}: footer outside viewport`,
  );
  assert(
    primary.height >= 39 && primary.width >= 94,
    `${label}: primary action too small ${JSON.stringify(primary)}`,
  );
  const scroll = page.locator(".ob-content");
  assert.equal(
    await scroll.count(),
    1,
    `${label}: a dedicated content scroller is required`,
  );
  await scroll.evaluate((el) => (el.scrollTop = el.scrollHeight));
  const afterHeader = await rect(page, ".ob-main>header"),
    afterNav = await rect(page, ".ob-sidebar nav"),
    afterFooter = await rect(page, ".ob-footer");
  for (const [before, after, name] of [
    [header, afterHeader, "header"],
    [nav, afterNav, "steps"],
    [footer, afterFooter, "footer"],
  ]) {
    assert(
      Math.abs(before.y - after.y) < 1,
      `${label}: ${name} moves with content`,
    );
  }
  // Last content must be reachable above the non-overlapping footer.
  const last = await page.locator(".ob-content>section").last().boundingBox();
  assert(
    last.y + last.height <= footer.y + 1,
    `${label}: end of content obscured by footer`,
  );
  await scroll.evaluate((el) => (el.scrollTop = 0));
  const center = {
    x: primary.x + primary.width / 2,
    y: primary.y + primary.height / 2,
  };
  assert(
    await page.evaluate(
      (p) =>
        !!document.elementFromPoint(p.x, p.y)?.closest(".ob-footer .primary"),
      center,
    ),
    `${label}: primary button is covered`,
  );
}
(async () => {
  const browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ||
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
  });
  const results = [];
  try {
    for (const [width, height, mobile, locale] of [
      [980, 620, false, "zh"],
      [840, 520, false, "zh"],
      [1136, 720, false, "zh"],
      [390, 844, true, "zh"],
      [320, 640, true, "zh"],
      [840, 520, false, "en"],
      [390, 844, true, "en"],
    ]) {
      const data = fixture();
      data.locale = locale;
      const test = await open(browser, data, {
        viewport: { width, height },
        hasTouch: mobile,
        isMobile: mobile,
      });
      const page = test.page;
      const label = `${width}x${height}-${locale}`;
      await page.locator(".ob-main h1").waitFor();
      if (process.env.GKM_LAYOUT_BASELINE) {
        await page.screenshot({ path: path.join(out, `before-${label}.png`) });
      }
      for (let step = 0; step < 3; step++) {
        await page.locator(".ob-sidebar nav button").nth(step).click();
        await settled(page);
        assert.equal(
          await page.locator(".ob-content").evaluate((el) => el.scrollTop),
          0,
          `${label}: step must start at top`,
        );
        await checkLayout(page, `${label} step ${step}`);
        if (step === 0) {
          const animations = page.locator(".ob-animation");
          assert.equal(await animations.count(), 2);
          for (let i = 0; i < 2; i++) {
            const block = animations.nth(i);
            await block.getByRole("checkbox").uncheck();
            await settled(page);
            for (const b of await block.locator("button").all())
              assert(
                await b.isDisabled(),
                `${label}: disabled animation still has enabled controls`,
              );
            await block.getByRole("checkbox").check();
            await settled(page);
          }
        }
        if (step < 2) {
          const details = page.locator(".ob-content details");
          await details.locator("summary").click();
          await checkLayout(page, `${label} expanded ${step}`);
          await details.locator("summary").click();
          await checkLayout(page, `${label} collapsed ${step}`);
        }
        await page.screenshot({
          path: path.join(out, `${label}-step-${step + 1}.png`),
        });
        if(width===980 && locale==='zh' && step===0){
          const summary=await rect(page,'.ob-content summary');
          const footer=await rect(page,'.ob-footer');
          assert(summary.y+summary.height<=footer.y-6, `Default experience page should fit: summary=${JSON.stringify(summary)} footer=${JSON.stringify(footer)}`);
        }
      }
      await page.locator(".ob-sidebar nav button").first().click();
      await settled(page);
      const originalStoredTheme=await page.evaluate(()=>localStorage.getItem('gam.theme'));
      for (const theme of ["dark", "navy", "light"]) {
        await page.locator(`.ob-theme-${theme}`).click();
        await settled(page);
        await checkLayout(page, `${label} ${theme}`);
        assert.equal(await page.locator('.app-shell').getAttribute('data-theme'),theme,`${label}: title bar and content must preview the same theme`);
        assert.equal(await page.evaluate(()=>localStorage.getItem('gam.theme')),originalStoredTheme,`${label}: preview must not save the actual preference`);
        if (width === 980 && theme === "dark")
          await page.screenshot({ path: path.join(out, "desktop-dark.png") });
      }
      const primary=page.locator('.ob-footer .primary');
      await primary.focus(); await page.keyboard.press('Enter'); await settled(page);
      assert.equal(await page.locator('.ob-sidebar nav button').nth(1).getAttribute('aria-current'),'step');
      await page.locator('.ob-sidebar nav button').first().click();await settled(page);
      if(mobile){await primary.tap();await settled(page);assert.equal(await page.locator('.ob-sidebar nav button').nth(1).getAttribute('aria-current'),'step');}
      await page.setViewportSize({
        width: mobile ? 360 : 840,
        height: mobile ? 740 : 520,
      });
      await page.locator(".ob-sidebar nav button").nth(1).click();
      await settled(page);
      await checkLayout(page, `${label} resized`);
      assert.deepEqual(test.errors, []);
      results.push(label);
      await test.context.close();
    }
    fs.writeFileSync(
      path.join(out, "layout-verification.json"),
      JSON.stringify(
        {
          passed: true,
          layouts: results,
          checks: [
            "all steps",
            "expanded settings",
            "independent content scroll",
            "pinned heading and step navigation",
            "visible hit-tested footer",
            "reachable final content",
            "disabled animation controls",
            "theme changes",
            "theme preview does not persist preferences",
            "keyboard and touch navigation",
            "window resizing",
            "no page errors",
          ],
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ passed: true, layouts: results }, null, 2));
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
