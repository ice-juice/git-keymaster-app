export type AccountSortable = {
  username: string;
  pinned: boolean;
  tags?: string[];
  lastUsedAt?: string | null;
  sortOrder: number;
};

export function primaryAccountTag(tags?: string[] | null): string {
  return (tags || []).map((t) => t.trim()).filter(Boolean)[0] || "";
}

/** 置顶优先，再按主标签归类（无标签垫后），然后沿用最近使用 / 手工序 / 用户名。 */
export function compareAccountsInPlatform(a: AccountSortable, b: AccountSortable): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  const ta = primaryAccountTag(a.tags);
  const tb = primaryAccountTag(b.tags);
  if (!ta && tb) return 1;
  if (ta && !tb) return -1;
  const tagCmp = ta.localeCompare(tb);
  if (tagCmp) return tagCmp;
  const la = a.lastUsedAt || "";
  const lb = b.lastUsedAt || "";
  if (la !== lb) return lb.localeCompare(la);
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.username.localeCompare(b.username);
}

export function collectAccountTags(
  entries: Array<{ tags?: string[] | null; group?: string | null }>,
  group: string,
  groupOf: (e: { tags?: string[] | null; group?: string | null }) => string = (e) => e.group || "未分组",
): string[] {
  return tagsInAccounts(
    group === "全部" ? entries : entries.filter((e) => groupOf(e) === group),
  );
}

export function tagsInAccounts(entries: Array<{ tags?: string[] | null }>): string[] {
  const set = new Set<string>();
  for (const e of entries) {
    for (const tag of e.tags || []) {
      const t = tag.trim();
      if (t) set.add(t);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

export function activeAccountTag(tags: string[], selected?: string | null): string | null {
  return selected && tags.includes(selected) ? selected : null;
}

export function visibleAccountsForTag<T extends { tags?: string[] | null }>(
  entries: T[],
  tag: string | null | undefined,
): T[] {
  if (!tag) return entries;
  return entries.filter((e) => (e.tags || []).some((item) => item.trim() === tag));
}

export function toggleAccountTag(tags: string[] | undefined, tag: string): string[] {
  const name = tag.trim();
  const current = (tags || []).map((item) => item.trim()).filter(Boolean);
  if (!name) return current;
  return current.includes(name) ? current.filter((item) => item !== name) : [...current, name];
}

/** 与 platformFamily 的非内置分支一致：trim 后小写；空名称没有归并键。 */
function defaultPlatformFamily(platform: string): string {
  const trimmed = platform.trim();
  return trimmed ? trimmed.toLowerCase() : "";
}

/**
 * 当前平台名下已经用过的标签。
 * 平台名先 trim；空名称直接为空，不会把「平台名为空」的账号算进来。
 * familyOf 要和列表聚合用同一套：编辑器传入 platformFamily 时，内置站别名归到同一平台。
 * 不按账号 id 排除正在编辑的那一条，避免它自己的标签从「已有标签」里消失。
 */
export function tagsForPlatform(
  entries: Array<{ platform?: string | null; tags?: string[] | null }>,
  platform: string,
  familyOf: (name: string) => string = defaultPlatformFamily,
): string[] {
  const trimmed = platform.trim();
  if (!trimmed) return [];
  const family = familyOf(trimmed);
  if (!family) return [];
  return tagsInAccounts(
    entries.filter((entry) => {
      const name = (entry.platform || "").trim();
      if (!name) return false;
      return familyOf(name) === family;
    }),
  );
}

/** 把输入并入标签。空白丢掉，已有的不重复添加。多个词按空白切开。 */
export function appendAccountTags(tags: string[] | undefined | null, raw: string): string[] {
  const current = (tags || []).map((item) => item.trim()).filter(Boolean);
  const seen = new Set(current);
  const additions: string[] = [];
  for (const part of raw.split(/\s+/)) {
    const name = part.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    additions.push(name);
  }
  if (additions.length === 0) {
    if (tags && tags.length === current.length && tags.every((item, index) => item === current[index])) return tags;
    return current;
  }
  return [...current, ...additions];
}
