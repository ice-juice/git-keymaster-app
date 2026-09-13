/** 识别账号表单里粘贴的是网址还是平台名，并尽量回填平台 / URL / 图标。 */

export interface BuiltinHint {
  id: string;
  name: string;
}

export interface DetectedAccountSource {
  kind: "empty" | "url" | "name";
  platform: string;
  url?: string;
  icon?: string;
  message: string;
}

export function detectAccountSource(raw: string, builtins: BuiltinHint[]): DetectedAccountSource {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { kind: "empty", platform: "", message: "填网站名，或直接粘贴登录页网址。" };
  }

  if (looksLikeUrl(trimmed)) {
    const url = normalizeUrl(trimmed);
    let host = "";
    try {
      host = new URL(url).hostname.replace(/^www\./i, "");
    } catch {
      host = trimmed;
    }
    const icon = suggestIcon(host, builtins);
    const platform = friendlyPlatform(host, builtins);
    return {
      kind: "url",
      platform,
      url,
      icon,
      message: `已识别网址，平台填为「${platform}」。`,
    };
  }

  const icon = suggestIcon(trimmed, builtins);
  return {
    kind: "name",
    platform: trimmed,
    icon,
    message: icon ? `将使用「${builtins.find((b) => `builtin:${b.id}` === icon)?.name}」图标。` : "保存时会按平台名自动匹配图标。",
  };
}

export function suggestIcon(name: string, builtins: BuiltinHint[]): string | undefined {
  const q = name.trim().toLowerCase();
  if (!q) return undefined;
  const stem = q.replace(/\.(com|cn|net|org|io|me|co|cc)$/i, "");
  const hit = builtins.find((i) => {
    const id = i.id.toLowerCase();
    const bName = i.name.toLowerCase();
    return q === id || q === bName || stem === id || stem === bName;
  });
  return hit ? `builtin:${hit.id}` : undefined;
}

/** 同一平台的归并键：能精准匹配内置站用图标 id，其余用小写平台名。 */
export function platformFamily(platform: string, builtins: BuiltinHint[]): string {
  const trimmed = platform.trim();
  if (!trimmed) return "";
  const icon = suggestIcon(trimmed, builtins);
  if (icon) return icon;
  return trimmed.toLowerCase();
}

export function resolvePlatformBrand(
  platform: string,
  icon: string | null | undefined,
  existing: { platform: string; icon?: string | null }[],
  builtins: BuiltinHint[],
): { platform: string; icon?: string } {
  const rawTrimmed = platform.trim();
  if (!rawTrimmed) return { platform: "", icon: icon ? icon.trim() || undefined : undefined };

  const family = platformFamily(rawTrimmed, builtins);
  const siblings = existing.filter((e) => platformFamily(e.platform, builtins) === family);

  let canonicalName = siblings[0]?.platform;
  if (!canonicalName && family.startsWith("builtin:")) {
    const b = builtins.find((item) => `builtin:${item.id}` === family);
    if (b && (rawTrimmed.toLowerCase() === b.id.toLowerCase() || rawTrimmed.toLowerCase() === b.name.toLowerCase())) {
      canonicalName = b.name;
    }
  }

  const finalName = canonicalName || rawTrimmed;

  const resolved =
    (icon && icon.trim()) ||
    siblings.find((e) => e.icon)?.icon ||
    suggestIcon(finalName, builtins);

  return { platform: finalName, icon: resolved || undefined };
}

function looksLikeUrl(s: string): boolean {
  if (/^https?:\/\//i.test(s)) return true;
  return /^[\w.-]+\.[a-z]{2,}([/:?#].*)?$/i.test(s);
}

function normalizeUrl(s: string): string {
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s}`;
}

function friendlyPlatform(host: string, builtins: BuiltinHint[]): string {
  const icon = suggestIcon(host, builtins);
  if (icon) {
    const id = icon.slice("builtin:".length);
    return builtins.find((b) => b.id === id)?.name || host;
  }
  const head = host.split(".")[0] || host;
  return head.charAt(0).toUpperCase() + head.slice(1);
}
