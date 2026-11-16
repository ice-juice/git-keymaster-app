// Isolated synthetic notes only: never opens or writes a real vault.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE ||
    path.join(
      process.env.LOCALAPPDATA,
      "GitKeymasterDev/design-tools/node_modules/playwright-core",
    ),
);
const out = path.resolve("docs/design/note-live-editor");
const sample =
  '# 工作备忘录\n\n在正文中直接编辑，支持 **加粗**、*斜体* 和 ~~删除线~~。\n\n## 今日计划\n\n- [ ] 检查编辑与保存\n- [x] 保留原始 Markdown\n- 普通列表\n\n> 重要内容始终保存在本地工作空间。\n\n```js\nconst message = "你好，世界";\nconsole.log(message);\n```\n\n| 项目 | 进度 |\n| --- | --- |\n| 编辑体验 | 验收中 |\n| 数据保存 | 已检查 |\n\n[项目说明](https://example.com) 与 `inline code`\n\n---\n\n最后一段。';
async function open(
  browser,
  {
    mobile = false,
    width = 1100,
    height = 780,
    csp = false,
    existingContext,
    existingPage,
  } = {},
) {
  const context =
    existingContext ||
    (await browser.newContext({
      viewport: { width, height },
      isMobile: mobile,
      hasTouch: mobile,
    }));
  const page = existingPage || (await context.newPage());
  const errors = [];
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.error(e.message);
  });
  page.setDefaultTimeout(15000);
  const bodies = {
    one: sample,
    two: "# 第二篇\n\n独立笔记，不得串入上一篇撤销内容。",
  };
  const entries = Object.keys(bodies).map((id, i) => ({
    id,
    title: i ? "第二篇" : "编辑器验收示例",
    tags: [],
    pinned: false,
    sortOrder: i,
    createdAt: "2026-11-15T00:00:00Z",
    updatedAt: "2026-11-15T00:00:00Z",
  }));
  const saves = [];
  const behavior = { failSave: false };
  await page.exposeFunction("__invoke", async (cmd, args) => {
    if (cmd === "note_list") return { entries, groups: [] };
    if (cmd === "note_get_body") return { markdown: bodies[args.id] };
    if (cmd === "note_upsert") {
      if (behavior.failSave) throw Error("synthetic disk write failure");
      saves.push(structuredClone(args.args));
      const a = args.args;
      bodies[a.id || "new"] = a.markdown;
      return { ...entries[0], ...a, id: a.id || "new" };
    }
    if (cmd === "note_asset_get")
      return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
    return null;
  });
  await page.addInitScript(() => {
    window.__TAURI_INTERNALS__ = {
      invoke: (cmd, args) => window.__invoke(cmd, args),
      transformCallback: () => 1,
      unregisterCallback: () => {},
    };
    localStorage.setItem("gam.uiLocale", "zh");
    localStorage.setItem("gam.notesAutoSave", "off");
    localStorage.removeItem("km.notes.viewLayout.v2");
  });
  const entry = path.resolve(
    "app/.note-editor-test-" + (mobile ? "mobile" : "desktop") + ".tsx",
  );
  fs.writeFileSync(
    entry,
    `
    import {createElement as h, useEffect} from 'react';
    import {createRoot} from 'react-dom/client';
    import {EditorView} from '@codemirror/view';
    import {undoDepth} from '@codemirror/commands';
    import {useNotesModel} from './src/shared/hooks/useNotesModel';
    import {NoteEditorCard} from './src/pages/Notes.shared';
    import {NoteMobileEditor} from './src/pages/NoteMobileEditor';
    import {useApp} from './src/store';
    import {api} from './src/lib/ipc';
    import './src/index.css';
    import './src/lib/i18n';
    ${mobile ? "import './src/styles/mobile.css';" : ""}
    api.noteList=()=>window.__invoke('note_list',{});
    api.noteGetBody=id=>window.__invoke('note_get_body',{id});
    api.noteUpsert=args=>window.__invoke('note_upsert',{args});
    api.noteAssetGet=hash=>window.__invoke('note_asset_get',{hash});
    window.__theme = theme => {document.documentElement.dataset.theme=theme; useApp.setState({theme});};
    window.__lock = writesLocked => useApp.setState({writesLocked});
    window.__view = () => EditorView.findFromDOM(document.querySelector('.cm-content'));
    window.__undoDepth = () => undoDepth(window.__view().state);
    function Test() {const m=useNotesModel(); window.__model=m;
      useEffect(()=>{if(m.entries.length && !m.detailOpen) void m.selectNote('one')},[m.entries]);
      return h('div',{style:{height:'100dvh',padding:${mobile ? 0 : 20},display:'flex',minHeight:0,width:'100%'}},m.detailOpen ? ${mobile ? "h(NoteMobileEditor,{m,onInsertImage:()=>{},onBack:()=>{}})" : "h(NoteEditorCard,{m,layout:m.viewLayout,onLayout:m.setViewLayout,modes:['live','edit','split','preview'],onInsertImage:()=>{}})"} : 'Loading');
    }
    createRoot(document.getElementById('root')).render(h(Test));
  `,
  );
  await page.route("**/__notes_test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html data-platform="${mobile ? "mobile" : "desktop"}" data-theme="light"><head><meta name="viewport" content="width=device-width, initial-scale=1">${csp ? '<meta property="csp-nonce" nonce="notes-test"><meta http-equiv="Content-Security-Policy" content="style-src \'self\' \'unsafe-inline\' \'nonce-notes-test\'"><style nonce="notes-test"></style>' : ""}</head><body><div id="root"></div><script type="module">
    import RefreshRuntime from '/@react-refresh';
    RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;
    await import('/${path.basename(entry)}');
  </script></body></html>`,
    }),
  );
  await page.goto("http://127.0.0.1:5173/__notes_test");
  await page.locator(".cm-content").waitFor();
  await page.waitForTimeout(250);
  return { context, page, errors, bodies, saves, entry, behavior };
}
async function main() {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
  });
  try {
    const results = [];
    const t = await open(browser),
      p = t.page;
    const doc = () => p.evaluate(() => window.__view().state.doc.toString());
    const setDoc = async (text) => {
      await p.evaluate(
        (markdown) => window.__model.updateDraft({ markdown }),
        text,
      );
      await p.waitForTimeout(80);
    };
    const select = async (from, to = from) => {
      await p.evaluate(
        ({ from, to }) => {
          const v = window.__view();
          v.focus();
          v.dispatch({
            selection: { anchor: from, head: to },
            scrollIntoView: true,
          });
        },
        { from, to },
      );
      await p.waitForTimeout(50);
    };
    const blur = async () => {
      await p.locator(".note-title-input").click();
      await p.waitForTimeout(80);
    };
    assert.equal(await doc(), sample);
    assert.equal(await p.locator(".cm-gutters").count(), 0);
    assert.equal(await p.locator(".note-pane-preview").count(), 0);
    assert.equal(
      await p.locator(".md-live-heading").first().innerText(),
      "工作备忘录",
    );
    assert.equal(await p.locator(".md-live-task").count(), 2);
    await p.screenshot({ path: path.join(out, "desktop-live.png") });
    results.push("default live rendering leaves original Markdown unchanged");

    await p.locator(".md-live-heading").first().click();
    await p.keyboard.press("End");
    await p.keyboard.insertText(" · 直接编辑");
    assert((await doc()).startsWith("# 工作备忘录 · 直接编辑\n"));
    await p.keyboard.press("Control+z");
    assert.equal(await doc(), sample);
    await p.keyboard.press("Control+Shift+z");
    assert((await doc()).includes("直接编辑"));
    await blur();
    results.push("click rendered heading, type, undo and redo");

    await setDoc("标题\n\n选中这段文字\n\n尾段");
    await select(4, 10);
    await p.getByRole("button", { name: "粗体", exact: true }).click();
    assert.equal(await doc(), "标题\n\n**选中这段文字**\n\n尾段");
    await p.keyboard.press("Control+z");
    assert.equal(await doc(), "标题\n\n选中这段文字\n\n尾段");
    await p.keyboard.press("Control+b");
    assert((await doc()).includes("**选中这段文字**"));
    results.push("toolbar keeps selection, Ctrl+B and undo preserve Markdown");

    await setDoc("前一段\n\n需要标题\n\n后一段");
    await select(7);
    const more = p.getByRole("button", {name:"更多标题级别",exact:true});
    let headingUndoDepth = await p.evaluate(()=>window.__undoDepth());
    for (const level of [4,5,6]) {
      await more.click();
      await p.getByRole("menuitem", {name:`标题 ${level}`,exact:true}).click();
      assert.equal(await doc(), `前一段\n\n${"#".repeat(level)} 需要标题\n\n后一段`);
      assert.equal(await p.evaluate(()=>window.__undoDepth()),++headingUndoDepth);
      assert.equal(await p.getByRole("menu").count(),0);
    }
    await more.click();
    await p.screenshot({path:path.join(out,"toolbar-more-headings.png")});
    await p.keyboard.press("Escape");
    assert.equal(await p.getByRole("menu").count(),0);
    await more.focus();await p.keyboard.press("ArrowDown");await p.keyboard.press("ArrowDown");await p.keyboard.press("Enter");
    assert.equal(await doc(), "前一段\n\n##### 需要标题\n\n后一段");
    await p.keyboard.press("Control+z");
    assert.equal(await doc(), "前一段\n\n###### 需要标题\n\n后一段");
    await more.click();await p.locator('.note-title-input').click();
    assert.equal(await p.getByRole("menu").count(),0);
    await setDoc("前一段\n\n后一段");await select(4);
    await p.getByRole("button",{name:"插入表格",exact:true}).click();
    const withTable=await doc();
    assert(withTable.includes("| --- | --- | --- |"));
    assert(withTable.startsWith("前一段\n"));assert(withTable.endsWith("后一段"));
    await p.keyboard.press("Control+z");assert.equal(await doc(),"前一段\n\n后一段");
    results.push("desktop table insertion at caret and H4-H6 dropdown, keyboard navigation, dismissal and undo");

    await setDoc("中文输入：");
    await select(5);
    const cdp = await p.context().newCDPSession(p);
    await cdp.send("Input.imeSetComposition", {
      text: "测试中文",
      selectionStart: 4,
      selectionEnd: 4,
    });
    await cdp.send("Input.insertText", { text: "测试中文" });
    await p.keyboard.insertText("🙂");
    assert.equal(await doc(), "中文输入：测试中文🙂");
    assert.equal(
      await p.evaluate(() => window.__model.draft.markdown),
      await doc(),
    );
    results.push("Chromium IME composition and emoji stay synchronized");

    await setDoc(sample);
    await blur();
    await p.locator(".md-live-task").first().check();
    assert((await doc()).includes("- [x] 检查编辑与保存"));
    const cell = p.locator(".md-live-cell").filter({ hasText: "验收中" });
    await cell.fill("已完成");
    assert((await doc()).includes("| 编辑体验 | 已完成 |"));
    assert.equal(await p.locator(".md-live-table").count(), 1);
    await p.keyboard.press("Control+z");
    assert((await doc()).includes("| 编辑体验 | 验收中 |"));
    await p.locator(".md-live-cell").filter({ hasText: "验收中" }).fill("A|B");
    assert((await doc()).includes("A\\|B"));
    const cellCount = await p.locator(".md-live-cell").count();
    await p.locator(".md-live-cell").filter({ hasText: "A|B" }).fill("");
    assert.equal(await p.locator(".md-live-cell").count(), cellCount);
    await p.keyboard.insertText("重新填写");
    assert((await doc()).includes("| 编辑体验 | 重新填写 |"));
    await p
      .locator(".md-live-cell")
      .filter({ hasText: "重新填写" })
      .evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(range);
      });
    await p.getByRole("button", { name: "粗体", exact: true }).click();
    assert((await doc()).includes("| 编辑体验 | **重新填写** |"));
    await blur();
    assert.equal(
      await p.locator(".md-live-cell strong").innerText(),
      "重新填写",
    );
    await p.screenshot({ path: path.join(out, "desktop-table.png") });
    results.push(
      "task toggles and directly editable table cells, undo and escaped pipe",
    );

    await p.getByRole("button", { name: "保存", exact: true }).click();
    await p.waitForFunction(() => !window.__model.saving);
    assert.equal(t.bodies.one, await doc());
    const saved = await doc();
    await p.evaluate(() => window.__model.selectNote("two"));
    await p.waitForFunction(() => window.__model.draft.id === "two");
    await p.locator(".cm-content").click();
    await p.keyboard.press("Control+z");
    assert.equal(await doc(), t.bodies.two);
    await p.evaluate(() => window.__model.selectNote("one"));
    await p.waitForFunction(() => window.__model.draft.id === "one");
    assert.equal(await doc(), saved);
    results.push(
      "save payload/readback and note switch undo isolation (mock IPC)",
    );

    await select((await doc()).length);
    await p.keyboard.insertText("\n需要保存的修改");
    const unsaved = await doc();
    t.behavior.failSave = true;
    await p.evaluate(() => window.__model.selectNote("two"));
    await p.waitForFunction(() => !!window.__model.leaveConfirm);
    await p.evaluate(() => window.__model.confirmLeave(true));
    assert.equal(await doc(), unsaved);
    assert.equal(await p.evaluate(() => window.__model.draft.id), "one");
    assert.equal(await p.evaluate(() => !!window.__model.leaveConfirm), true);
    t.behavior.failSave = false;
    await p.evaluate(() => {
      window.__model.setLeaveConfirm(null);
      window.__model.setErr("");
    });
    await p.locator(".cm-content").click();
    await p.keyboard.press("Control+s");
    await p.waitForFunction(
      () => !window.__model.saving && !window.__model.isDirty,
    );
    assert.equal(t.bodies.one, unsaved);
    results.push(
      "failed save keeps unsaved note and leave confirmation; Ctrl+S saves successfully",
    );

    await select((await doc()).length);
    await p.keyboard.insertText("撤销模式测试");
    for (const label of ["预览", "即时编辑"])
      await p.getByRole("button", { name: label, exact: true }).click();
    await p.locator(".cm-content").click();
    await p.keyboard.press("Control+z");
    assert.equal(await doc(), unsaved);
    await setDoc(saved);
    await blur();

    for (const label of ["源码", "对比", "预览", "即时编辑"]) {
      await p.getByRole("button", { name: label, exact: true }).click();
      if (label !== "预览") assert.equal(await doc(), saved);
    }
    results.push("all optional modes preserve text");
    await p.evaluate(() => window.__lock(true));
    await p.waitForTimeout(100);
    assert.equal(
      await p.locator(".cm-content").getAttribute("contenteditable"),
      "false",
    );
    for (const task of await p.locator(".md-live-task").all())
      assert(await task.isDisabled());
    assert.equal(
      await p
        .locator('.md-live-cell[contenteditable="plaintext-only"]')
        .count(),
      0,
    );
    await p.evaluate(() =>
      window.__model.editorRef.current.insertAtCursor("MUST NOT WRITE"),
    );
    assert.equal(await doc(), saved);
    await p.evaluate(() => window.__lock(false));
    results.push("write lock covers text, table, tasks and toolbar commands");

    const complex =
      '# 原始内容\r\n\r\n[引用][ref]\r\n\r\n[ref]: https://example.com "Title"\r\n\r\n<div>保留 HTML 原文</div>\r\n\r\n![](kmasset://' +
      "a".repeat(64) +
      ")\r\n\r\n![remote](https://example.com/private.png)";
    let remoteRequests = 0;
    p.on("request", (r) => {
      if (r.url().includes("example.com")) remoteRequests++;
    });
    await setDoc(complex);
    await blur();
    // CodeMirror normalizes line separators to LF; content and unknown syntax must survive.
    assert.equal(await doc(), complex.replaceAll("\r\n", "\n"));
    await p.locator(".md-live-image img").waitFor();
    assert.equal(remoteRequests, 0);
    results.push(
      "vault images render, remote images do not fetch, unknown syntax preserved",
    );

    await setDoc(
      Array.from({ length: 1600 }, (_, i) =>
        i % 10 === 0 ? `## 段落 ${i}` : `第 ${i} 行中文与 **格式** abc 123`,
      ).join("\n"),
    );
    await select((await doc()).length);
    await p.keyboard.insertText("\n末尾输入");
    assert((await doc()).endsWith("\n末尾输入"));
    assert.equal(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    results.push("1600-line note scrolls and accepts edits at the end");
    assert.deepEqual(t.errors, []);
    await t.context.close();

    for (const options of [
      { width: 980, height: 620 },
      { width: 840, height: 520 },
      { mobile: true, width: 390, height: 844 },
      { mobile: true, width: 320, height: 640 },
    ]) {
      const x = await open(browser, options);
      for (const theme of ["light", "dark", "navy"]) {
        await x.page.evaluate((theme) => window.__theme(theme), theme);
        await x.page.waitForTimeout(100);
        assert.equal(
          await x.page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
        );
        const geometry = await x.page.evaluate(() => {
          const el = document.querySelector(".cm-scroller");
          const r = el.getBoundingClientRect();
          return {
            height: r.height,
            bottom: r.bottom,
            display: getComputedStyle(el).display,
            contentOverflow: el.scrollWidth - el.clientWidth,
          };
        });
        await x.page.screenshot({
          path: path.join(
            out,
            `${options.width}x${options.height}-${theme}.png`,
          ),
        });
        assert.equal(geometry.display, "flex");
        assert(geometry.height > 100);
        assert(
          geometry.bottom <= options.height,
          JSON.stringify({ options, theme, geometry }),
        );
        assert(
          geometry.contentOverflow < 2,
          JSON.stringify({ options, theme, geometry }),
        );
      }
      if (options.mobile) {
        await x.page.evaluate(()=>{const view=window.__view();view.focus();view.dispatch({selection:{anchor:0}})});
        await x.page.getByRole('button',{name:'标题',exact:true}).tap();
        await x.page.getByRole('option',{name:'标题 6',exact:true}).tap();
        assert((await x.page.evaluate(()=>window.__model.draft.markdown)).startsWith('###### '));
        await x.page.locator(".md-live-heading").first().tap();
        await x.page.keyboard.press("End");
        await x.page.keyboard.insertText("移动编辑");
        assert(
          (await x.page.evaluate(() => window.__model.draft.markdown)).includes(
            "移动编辑",
          ),
        );
      }
      assert.deepEqual(x.errors, []);
      await x.context.close();
    }
    results.push("4 desktop/mobile dimensions × 3 themes, mobile tap editing");

    const secure = await open(browser, { csp: true });
    await secure.page
      .getByRole("button", { name: "源码", exact: true })
      .click();
    const geometry = await secure.page.evaluate(() => {
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
    await secure.page.screenshot({
      path: path.join(out, "csp-source-fixed.png"),
    });
    assert.deepEqual(secure.errors, []);
    await secure.context.close();
    results.push(
      "Tauri-equivalent nonce CSP keeps CodeMirror stylesheet and source gutter intact",
    );
    fs.writeFileSync(
      path.join(out, "verification.json"),
      JSON.stringify({ date: new Date().toISOString(), results }, null, 2),
    );
    console.log(JSON.stringify({ passed: results.length, results }, null, 2));
  } finally {
    await browser.close();
    for (const kind of ["desktop", "mobile"])
      fs.rmSync(path.resolve(`app/.note-editor-test-${kind}.tsx`), {
        force: true,
      });
  }
}
if (require.main === module)
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
module.exports = { open, sample, out };
