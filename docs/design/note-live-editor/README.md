# 备忘录即时编辑：修复与验收

日期：2026-11-15。分支：`dev`。

## 用户可见变化

- 桌面端、移动端默认进入「即时编辑」。直接点击有格式的正文即可输入，不需要先切到源码再切回预览。
- 标题、粗体、斜体、删除线、引用、列表、代码块、链接、分隔线和图片即时呈现。光标进入相关 Markdown 结构时可就地调整标记，离开后恢复呈现。
- 任务框可直接勾选；表格单元格可直接输入、清空、重新填写，支持中文、撤销、管道符转义和工具栏粗体操作。单元格失焦后呈现行内格式。
- 提供 Ctrl/Cmd+B、I、S；保存仍遵循原有手动保存及失焦自动保存设置。
- 桌面工具栏补齐「插入表格」；H1–H3 右侧增加「更多」菜单选择 H4–H6，支持方向键、Enter、Escape 与点击外部关闭。移动端标题菜单同步支持 H1–H6。每次工具栏格式操作独立撤销。
- 源码、对比、只读预览仍作为可选工具保留。切到只读预览不再销毁编辑器，因此返回时保留撤销历史；切换到另一篇笔记则隔离撤销历史。
- 保存失败时，「保存后离开」保留当前草稿与确认状态，不再错误地切走。

## 错位根因与修复

原编辑器依赖 CodeMirror / style-mod 动态注入的样式。项目的 HTML 中有内联启动样式，Tauri 会向 `style` 标签及 CSP 的 `style-src` 注入 nonce。存在 nonce 后，`unsafe-inline` 不会放行缺少 nonce 的动态样式。CodeMirror 未获得 nonce，基础 flex 布局等规则被阻止，行号区与正文分离。

现将现有 `style[nonce]` 的 `.nonce` 属性传给 `EditorView.cspNonce`，没有放宽应用 CSP；静态样式同时提供关键布局兜底。回归通过带 nonce 的 CSP 重现条件，检查动态样式获得正确 nonce、行号在正文左侧且顶部对齐。

即时呈现使用 CodeMirror decorations 和 Markdown 语法树，编辑底稿始终是 Markdown，不通过 HTML 反向转换保存。未识别语法保留源码；既有 CodeMirror 的换行规范化行为不变。图片仅加载工作空间资源或内嵌光栅图片，不自动请求笔记里的远程图片地址。

## 验收结果

运行 `node scripts/test-note-editor.cjs`：14 组场景通过。使用真实 React 页面与编辑器，笔记 IPC 是隔离的内存夹具。新增覆盖工具栏在光标处插入表格、H4–H6 切换、菜单键盘操作/关闭、独立撤销，以及移动端 H6。

覆盖：默认显示不改正文；点击排版标题直接输入；撤销/重做；工具栏选区与快捷键；Chromium 中文 IME 与 emoji；任务框；表格清空及重填、撤销、管道符、选区格式；保存请求与回读；切换笔记撤销隔离；保存失败留在原文；切换模式保留内容及撤销；只读保护；工作空间图片与远程图片不请求；1600 行长文末尾输入；带 nonce 的 CSP。

布局：980×620、840×520、390×844、320×640，浅色/深色/黛蓝三种主题。检查编辑器自身及页面无横向溢出、编辑区未越过视口、移动端可触摸后输入。截图人工复查发现窄屏正文被裁切，修复 flex 尺寸后重新运行验收。

运行 `node scripts/test-note-editor-native.cjs`：独立 Windows WebView2 窗口通过直接编辑、Ctrl+S 保存请求、nonce CSP、源码行号对齐检查。脚本只允许连接用户数据目录为 `GitKeymasterDev/notes-qa/webview` 的实例。使用同一组合成笔记及模拟笔记 IPC，不打开用户工作空间。

其他检查：

- `npm run test:unit`：167/167 通过。
- `npm run build`：TypeScript 与生产构建通过。
- 新增即时呈现模块 oxlint 无警告；涉及既有页面的 lint 无错误，仍有既有 refs/effect 等警告。
- `git diff --check` 通过。

本次未修改 Rust 存储逻辑；以上保存验收覆盖真实编辑器到 IPC 参数、失败处理与夹具回读，不代表重新验证了原生加密文件落盘。移动端使用浏览器设备模拟，未作 Android/iOS 真机或 macOS 验收。此次功能不等同于实现 Typora 的全部扩展语法，例如数学公式与流程图仍保留原始文本。

## 截图与机器记录

- [桌面即时编辑](desktop-live.png)
- [表格直接编辑与格式](desktop-table.png)
- [更多标题与表格工具栏](toolbar-more-headings.png)
- [手机浅色](390x844-light.png)
- [窄屏深色](320x640-dark.png)
- [Windows 原生即时编辑](windows-webview-live.png)
- [Windows 原生源码对齐](windows-webview-source.png)
- [浏览器验收记录](verification.json)
- [原生窗口验收记录](native-verification.json)

## 复跑

先运行项目 Vite 开发服务（`app` 目录下 `npm run dev`），然后在仓库根目录执行 `node scripts/test-note-editor.cjs`。测试使用本机 `GitKeymasterDev/design-tools` 下的 Playwright Core 和已安装的 Chrome，可通过 `PLAYWRIGHT_MODULE` 覆盖依赖位置。临时测试入口由脚本创建并在退出时删除，不进入正式产品路由。

原生脚本需要预先启动独立 QA 实例，令 APPDATA、TEMP、TMP 及 `WEBVIEW2_USER_DATA_FOLDER` 均指向 `GitKeymasterDev/notes-qa` 下的独立子目录。当前 debug 构建默认调试端口是 9222（可通过 `NOTES_QA_PORT` 指定连接端口）。不得连接日常使用的实例。
