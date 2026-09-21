import type { BuiltinIconInfo } from "../lib/ipc";

/**
 * 用户可能输入的词 → 内置图标 id。
 * 与 app/src-tauri/src/icons.rs 里的别名保持一致。
 */
const ICON_ALIASES: Record<string, string> = {
  x: "twitter",
  "x.com": "twitter",
  推特: "twitter",
  fb: "facebook",
  "fb.com": "facebook",
  meta: "facebook",
  脸书: "facebook",
  ig: "instagram",
  "youtu.be": "youtube",
  yt: "youtube",
  "t.me": "telegram",
  电报: "telegram",
  wa: "whatsapp",
  "wa.me": "whatsapp",
  微信: "wechat",
  weixin: "wechat",
  "weixin.qq": "wechat",
  微博: "weibo",
  哔哩哔哩: "bilibili",
  b站: "bilibili",
  "b23.tv": "bilibili",
  小红书: "xiaohongshu",
  xhs: "xiaohongshu",
  rednote: "xiaohongshu",
  知乎: "zhihu",
  抖音: "douyin",
  快手: "kuaishou",
  豆瓣: "douban",
  支付宝: "alipay",
  淘宝: "taobao",
  tb: "taobao",
  百度: "baidu",
  阿里云: "aliyun",
  alibabacloud: "aliyun",
  腾讯云: "tencentcloud",
  gh: "github",
  chatgpt: "openai",
  克劳德: "claude",
  "claude.ai": "claude",
  gemini: "gemini",
  bard: "gemini",
  双子座: "gemini",
  aistudio: "gemini",
  深度求索: "deepseek",
  hf: "huggingface",
  "hf.co": "huggingface",
  通义: "qwen",
  千问: "qwen",
  tongyi: "qwen",
  moonshot: "kimi",
  月之暗面: "kimi",
  扣子: "coze",
  币安: "binance",
  bnb: "binance",
  欧易: "okx",
  okex: "okx",
  icloud: "apple",
  protonmail: "proton",
  "proton.me": "proton",
  amazonaws: "aws",
  microsoftteams: "teams",
  hotmail: "outlook",
  谷歌: "google",
  npmjs: "npm",
  kakao: "kakaotalk",
  bsky: "bluesky",
};

function stemHost(value: string): string {
  return value.replace(/\.(com|cn|net|org|io|co|cc|app|dev|me|tv|be|ai)$/i, "");
}

function lookup(token: string, builtins: { id: string; name: string }[]): string | undefined {
  const alias = ICON_ALIASES[token];
  if (alias && builtins.some((item) => item.id === alias)) return alias;
  const hit = builtins.find(
    (item) => item.id.toLowerCase() === token || item.name.toLowerCase() === token,
  );
  return hit?.id;
}

/** 当前账号是否已经对应某个内置平台。上传过的自定义图标不会挡住名称匹配。 */
export function findBuiltinAccount(
  builtins: { id: string; name: string }[],
  platform?: string | null,
  icon?: string | null,
): { id: string; name: string } | undefined {
  if (icon?.startsWith("builtin:")) {
    const id = icon.slice("builtin:".length);
    const byIcon = builtins.find((item) => item.id === id);
    if (byIcon) return byIcon;
  }
  const query = (platform || "").trim().toLowerCase();
  if (!query) return undefined;
  return builtins.find((item) => item.id.toLowerCase() === query || item.name.toLowerCase() === query);
}

/** 已是内置平台，或还没填名字时走内置列表；已经写了自定义名字才走自己填写。 */
export function platformEntryMode(
  builtins: { id: string; name: string }[],
  platform?: string | null,
  icon?: string | null,
): "builtin" | "custom" {
  if (findBuiltinAccount(builtins, platform, icon)) return "builtin";
  if ((platform || "").trim()) return "custom";
  return "builtin";
}

/** 平台名、域名或别名解析成内置图标 id。 */
export function resolveBuiltinQuery(
  raw: string,
  builtins: { id: string; name: string }[],
): string | undefined {
  const query = raw.trim().toLowerCase();
  if (!query) return undefined;
  const direct = lookup(query, builtins);
  if (direct) return direct;
  const stem = stemHost(query);
  if (stem !== query) return lookup(stem, builtins);
  return undefined;
}

export function iconSearchBlob(id: string, name: string): string {
  const extras = Object.entries(ICON_ALIASES)
    .filter(([, target]) => target === id)
    .map(([key]) => key);
  return [id, name, ...extras].join(" ").toLowerCase();
}

export function filterBuiltinIcons(builtins: BuiltinIconInfo[], query: string): BuiltinIconInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return builtins;
  return builtins.filter((item) => iconSearchBlob(item.id, item.name).includes(q));
}
