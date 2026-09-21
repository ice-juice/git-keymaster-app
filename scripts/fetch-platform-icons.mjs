/**
 * 从 Simple Icons（CC0-1.0）拉取单色品牌标，写入前端图标库。
 * https://simpleicons.org
 *
 * 较新的 CDN 下架过一部分品牌，脚本会再试旧版本里仍为 CC0 的同一图形。
 * 用法：node scripts/fetch-platform-icons.mjs
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outFile = join(root, "app", "src", "shared", "builtinIconArt.ts");

/** [id, slugs, 无填充色时用的品牌色]。id 与已保存的 builtin: 引用保持一致。 */
const catalog = [
  ["github", ["github"], "#181717"],
  ["gitlab", ["gitlab"], "#FC6D26"],
  ["gitee", ["gitee"], "#C71D23"],
  ["google", ["google"], "#4285F4"],
  ["microsoft", ["microsoft"], "#5E5E5E"],
  ["apple", ["apple"], "#000000"],
  ["aws", ["amazonwebservices", "amazonaws"], "#FF9900"],
  ["cloudflare", ["cloudflare"], "#F38020"],
  ["openai", ["openai"], "#412991"],
  ["vercel", ["vercel"], "#000000"],
  ["docker", ["docker"], "#2496ED"],
  ["linux", ["linux"], "#FCC624"],
  ["npm", ["npm"], "#CB3837"],
  ["telegram", ["telegram"], "#26A5E4"],
  ["discord", ["discord"], "#5865F2"],
  ["twitter", ["x", "twitter"], "#000000"],
  ["aliyun", ["alibabacloud"], "#FF6A00"],
  ["slack", ["slack"], "#4A154B"],
  ["notion", ["notion"], "#000000"],
  ["bitbucket", ["bitbucket"], "#0052CC"],
  ["azure", ["microsoftazure"], "#0078D4"],
  ["digitalocean", ["digitalocean"], "#0080FF"],
  ["figma", ["figma"], "#F24E1E"],
  ["dropbox", ["dropbox"], "#0061FF"],
  ["proton", ["proton"], "#6D4AFF"],
  ["1password", ["1password"], "#0572EC"],
  ["bitwarden", ["bitwarden"], "#175DDC"],
  ["facebook", ["facebook"], "#0866FF"],
  ["instagram", ["instagram"], "#FF0069"],
  ["youtube", ["youtube"], "#FF0000"],
  ["tiktok", ["tiktok"], "#000000"],
  ["reddit", ["reddit"], "#FF4500"],
  ["linkedin", ["linkedin"], "#0A66C2"],
  ["pinterest", ["pinterest"], "#BD081C"],
  ["snapchat", ["snapchat"], "#FFFC00"],
  ["twitch", ["twitch"], "#9146FF"],
  ["weibo", ["sinaweibo"], "#E6162D"],
  ["bilibili", ["bilibili"], "#00A1D6"],
  ["zhihu", ["zhihu"], "#0084FF"],
  ["xiaohongshu", ["xiaohongshu"], "#FF2442"],
  ["threads", ["threads"], "#000000"],
  ["mastodon", ["mastodon"], "#6364FF"],
  ["bluesky", ["bluesky"], "#1185FE"],
  ["wechat", ["wechat"], "#07C160"],
  ["qq", ["qq", "tencentqq"], "#12B7F5"],
  ["whatsapp", ["whatsapp"], "#25D366"],
  ["signal", ["signal"], "#3A76F0"],
  ["messenger", ["messenger"], "#00B2FF"],
  ["line", ["line"], "#00C300"],
  ["viber", ["viber"], "#7360F2"],
  ["skype", ["skype"], "#00AFF0"],
  ["teams", ["microsoftteams"], "#6264A7"],
  ["zoom", ["zoom"], "#0B5CFF"],
  ["kakaotalk", ["kakaotalk"], "#FFCD00"],
  ["element", ["element"], "#0DBD8B"],
  ["kuaishou", ["kuaishou"], "#FF4906"],
  ["douban", ["douban"], "#007722"],
  ["steam", ["steam"], "#000000"],
  ["spotify", ["spotify"], "#1DB954"],
  ["netflix", ["netflix"], "#E50914"],
  ["paypal", ["paypal"], "#003087"],
  ["amazon", ["amazon", "amazonaws"], "#FF9900"],
  ["taobao", ["taobao"], "#FF5000"],
  ["alipay", ["alipay"], "#1677FF"],
  ["baidu", ["baidu"], "#2932E1"],
  ["outlook", ["microsoftoutlook"], "#0078D4"],
  ["gmail", ["gmail"], "#EA4335"],
  ["yahoo", ["yahoo"], "#6001D2"],
  ["claude", ["claude"], "#D97757"],
  ["anthropic", ["anthropic"], "#191919"],
  ["gemini", ["googlegemini"], "#8E75B2"],
  ["deepseek", ["deepseek"], "#4D6BFE"],
  ["perplexity", ["perplexity"], "#20808D"],
  ["huggingface", ["huggingface"], "#FFD21E"],
  ["mistral", ["mistralai"], "#FF7000"],
  ["copilot", ["githubcopilot"], "#000000"],
  ["poe", ["poe"], "#5D5CDE"],
  ["suno", ["suno"], "#000000"],
  ["qwen", ["qwen"], "#615CED"],
  ["kimi", ["kimi"], "#000000"],
  ["minimax", ["minimax"], "#F23F5D"],
  ["ollama", ["ollama"], "#000000"],
  ["cursor", ["cursor"], "#000000"],
  ["metaai", ["metaai"], "#0668E1"],
  ["openrouter", ["openrouter"], "#6566F1"],
  ["coze", ["coze"], "#4D53E8"],
  ["dify", ["dify"], "#1C64F2"],
  ["binance", ["binance"], "#F0B90B"],
  ["okx", ["okx"], "#000000"],
  ["coinbase", ["coinbase"], "#0052FF"],
  ["kucoin", ["kucoin"], "#01BC8D"],
];

const sources = [
  (slug) => `https://cdn.simpleicons.org/${slug}`,
  (slug) => `https://cdn.jsdelivr.net/npm/simple-icons@15.22.0/icons/${slug}.svg`,
  (slug) => `https://cdn.jsdelivr.net/npm/simple-icons@14.15.0/icons/${slug}.svg`,
  (slug) => `https://cdn.jsdelivr.net/npm/simple-icons@11.14.0/icons/${slug}.svg`,
  (slug) => `https://cdn.jsdelivr.net/npm/simple-icons@9.21.0/icons/${slug}.svg`,
  (slug) => `https://api.iconify.design/simple-icons/${slug}.svg`,
];

function parseSvg(svg, fallback) {
  const color = svg.match(/fill="(#[0-9A-Fa-f]{6})"/i)?.[1] || fallback;
  const paths = [...svg.matchAll(/\bd="([^"]+)"/g)].map((m) => m[1]);
  if (!paths.length) return null;
  return { color, paths };
}

async function load(slugs, fallback) {
  for (const slug of slugs) {
    for (const source of sources) {
      const url = source(slug);
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const icon = parseSvg(await res.text(), fallback);
        if (icon) return icon;
      } catch {
        /* 换下一个来源 */
      }
    }
  }
  return null;
}

const art = {};
const missing = [];
for (const [id, slugs, hex] of catalog) {
  const icon = await load(slugs, hex);
  if (!icon) {
    missing.push(id);
    continue;
  }
  art[id] = icon;
  process.stdout.write(`ok ${id} ${icon.color}\n`);
}

if (art.tiktok && !art.douyin) {
  art.douyin = { ...art.tiktok, color: "#111111" };
  process.stdout.write("ok douyin (tiktok mark)\n");
}
if (art.cloudflare) art["cloudflare-r2"] = art.cloudflare;

const body = Object.entries(art)
  .map(([id, icon]) => {
    const paths = icon.paths.map((p) => JSON.stringify(p)).join(", ");
    return `  ${JSON.stringify(id)}: { color: ${JSON.stringify(icon.color)}, paths: [${paths}] },`;
  })
  .join("\n");

writeFileSync(
  outFile,
  `/* 由 scripts/fetch-platform-icons.mjs 生成。
 * 图形来自 Simple Icons，许可 CC0-1.0：https://simpleicons.org
 * 请改目录后重跑脚本，不要手改本文件。
 */
export type BuiltinIconArt = { color: string; paths: string[] };

export const builtinIconArt: Record<string, BuiltinIconArt> = {
${body}
};
`,
);

process.stdout.write(`wrote ${Object.keys(art).length} icons\n`);
if (missing.length) process.stderr.write(`missing: ${missing.join(", ")}\n`);
