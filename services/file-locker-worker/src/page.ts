function esc(s: string): string {
  return s.replace(/[&<>"'"'"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/**
 * 防止内联脚本里出现 script 结束标签。
 * 不能把所有 `<` 换成 `\u003c`：那在字符串里合法，但 `a < b`、`a << b` 会变成非法运算符，整段脚本无法解析，下载按钮就完全没反应。
 */
export function inlineScript(js: string): string {
  return js.replace(/<\/script/gi, "<\\/script");
}

const STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: #f3f0e8;
  color: #1c1915;
  font: 16px/1.5 ui-sans-serif, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif;
}
main {
  width: min(420px, calc(100% - 32px));
  background: #fffdf8;
  border: 1px solid #e4dccb;
  border-radius: 16px;
  padding: 28px 24px 22px;
  box-shadow: 0 12px 40px rgba(60, 40, 10, 0.06);
}
h1 { font-size: 22px; font-weight: 650; margin: 0 0 8px; }
p { margin: 0; color: #5c564c; }
label { display: block; margin: 22px 0 8px; font-size: 14px; }
input {
  width: 100%;
  font: 600 28px/1 ui-monospace, "Cascadia Mono", Consolas, monospace;
  letter-spacing: 0.28em;
  padding: 12px 12px 12px 16px;
  border: 1px solid #d9d0c0;
  border-radius: 10px;
  background: #fff;
}
input:focus { outline: 2px solid #8a6a32; border-color: transparent; }
button {
  margin-top: 16px;
  width: 100%;
  border: 0;
  border-radius: 10px;
  padding: 12px 16px;
  background: #2c2416;
  color: #f7f1e4;
  font: 600 16px/1.2 inherit;
  cursor: pointer;
}
button:disabled { opacity: 0.55; cursor: default; }
#error { min-height: 1.5em; margin-top: 12px; color: #8a2e24; }
footer { margin-top: 18px; font-size: 13px; color: #6f685e; }
`;

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}

export function renderMissing(): string {
  return shell("链接已失效", "<h1>链接已失效</h1><p>这份分享不存在，或已经销毁。</p>");
}

export function renderExpired(): string {
  return shell("链接已过期", "<h1>链接已过期</h1><p>到达销毁时间后，文件和分享一起删除了。</p>");
}

export function renderPickup(slug: string, pageScript: string): string {
  const script = pageScript ? `<script>${inlineScript(pageScript)}</script>` : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>取件</title>
<style>${STYLE}</style>
</head>
<body data-slug="${esc(slug)}">
<main>
<h1>取件</h1>
<p>输入对方告诉你的 6 位取件码。解密在这台设备上完成。</p>
<form id="pick" action="#" method="post" onsubmit="return false">
<label for="code">取件码</label>
<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" placeholder="......" required>
<button id="go" type="submit">下载</button>
<p id="error" role="alert"></p>
</form>
<footer>解密密钥只留在地址 # 后面，不会发给服务器。服务器只核对取件码，不保存明文。</footer>
</main>
<noscript><p>需要启用 JavaScript。文件在你的浏览器里解密，服务器解不了。</p></noscript>
${script}
</body>
</html>`;
}