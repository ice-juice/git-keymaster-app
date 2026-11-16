// Connect only to the independently launched notes-qa WebView2 process.
// The fixture uses synthetic notes and mocked note IPC, never a user's vault.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { chromium } = require(
  path.join(
    process.env.LOCALAPPDATA,
    "GitKeymasterDev/design-tools/node_modules/playwright-core",
  ),
);
const { open, out } = require("./test-note-editor.cjs");
async function main() {
  const port = Number(process.env.NOTES_QA_PORT || 9222);
  const processes = JSON.parse(
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "name = 'msedgewebview2.exe'" | Where-Object { $_.CommandLine -match '--remote-debugging-port=${port}' -and $_.CommandLine -notmatch '--type=' } | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress`,
      ],
      { encoding: "utf8" },
    ),
  );
  const processInfo = Array.isArray(processes) ? processes[0] : processes;
  assert(
    processInfo.CommandLine.includes("GitKeymasterDev\\notes-qa\\webview"),
    "Refuse to control a non-QA WebView",
  );
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  try {
    const context = browser.contexts()[0];
    const page = context.pages()[0];
    const t = await open(browser, {
      existingContext: context,
      existingPage: page,
      csp: true,
    });
    await page.locator(".md-live-heading").first().click();
    await page.keyboard.press("End");
    await page.keyboard.insertText(" · 原生窗口测试");
    await page.keyboard.press("Control+s");
    await page.waitForFunction(
      () => !window.__model.saving && !window.__model.isDirty,
    );
    assert(t.bodies.one.includes("原生窗口测试"));
    await page.locator(".note-title-input").click();
    await page.screenshot({ path: path.join(out, "windows-webview-live.png") });
    await page.getByRole("button", { name: "源码", exact: true }).click();
    await page.waitForTimeout(150);
    const geometry = await page.evaluate(() => {
      const a = document.querySelector(".cm-gutters").getBoundingClientRect(),
        b = document.querySelector(".cm-content").getBoundingClientRect();
      return {
        aligned: Math.abs(a.top - b.top) < 2,
        side: a.right <= b.left + 1,
        display: getComputedStyle(document.querySelector(".cm-scroller"))
          .display,
        nonce: [...document.querySelectorAll("style")].find((el) =>
          el.textContent.includes(".cm-scroller"),
        )?.nonce,
      };
    });
    assert.deepEqual(geometry, {
      aligned: true,
      side: true,
      display: "flex",
      nonce: "notes-test",
    });
    await page.screenshot({
      path: path.join(out, "windows-webview-source.png"),
    });
    assert.deepEqual(t.errors, []);
    fs.writeFileSync(
      path.join(out, "native-verification.json"),
      JSON.stringify(
        {
          date: new Date().toISOString(),
          appProcessId: processInfo.ParentProcessId,
          engine: await browser.version(),
          geometry,
          noteStorage: "synthetic IPC fixture",
          checks: [
            "native WebView2 editing",
            "Ctrl+S save payload",
            "nonce CSP stylesheet",
            "aligned source gutter",
          ],
        },
        null,
        2,
      ),
    );
    console.log(
      "PASS: isolated Windows WebView2 editing, save payload and nonce CSP layout",
    );
  } finally {
    await browser.close();
    fs.rmSync(path.resolve("app/.note-editor-test-desktop.tsx"), {
      force: true,
    });
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
