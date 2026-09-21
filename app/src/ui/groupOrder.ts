import type { GroupMeta } from "../lib/ipc";

export type GroupMove = "up" | "down" | "top" | "bottom";

const VIRTUAL_GROUP_KEYS = new Set(["全部", "未分组", ""]);

export function isVirtualGroupKey(key: string) {
  return VIRTUAL_GROUP_KEYS.has(key);
}

export function sortGroups(groups: GroupMeta[]): GroupMeta[] {
  return groups
    .map((g, i) => ({ g, i }))
    .sort((a, b) => a.g.sortOrder - b.g.sortOrder || a.i - b.i)
    .map(({ g }) => g);
}

export function moveGroupNames(names: string[], key: string, action: GroupMove): string[] | null {
  const i = names.indexOf(key);
  if (i < 0) return null;
  if ((action === "up" || action === "top") && i === 0) return null;
  if ((action === "down" || action === "bottom") && i === names.length - 1) return null;
  const next = names.slice();
  next.splice(i, 1);
  if (action === "up") next.splice(i - 1, 0, key);
  else if (action === "down") next.splice(i + 1, 0, key);
  else if (action === "top") next.unshift(key);
  else next.push(key);
  return next;
}

export function applyGroupOrder(groups: GroupMeta[], orderedNames: string[]): GroupMeta[] {
  const byName = new Map(groups.map((g) => [g.name, g]));
  const seen = new Set<string>();
  const next: GroupMeta[] = [];
  for (const name of orderedNames) {
    const trimmed = name.trim();
    if (!trimmed || isVirtualGroupKey(trimmed) || seen.has(trimmed)) continue;
    const g = byName.get(trimmed) ?? { name: trimmed, color: null, sortOrder: next.length };
    seen.add(g.name);
    next.push({ ...g, sortOrder: next.length });
  }
  for (const g of groups) {
    if (seen.has(g.name)) continue;
    next.push({ ...g, sortOrder: next.length });
  }
  return next;
}
