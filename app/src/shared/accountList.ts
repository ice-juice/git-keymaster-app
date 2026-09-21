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
