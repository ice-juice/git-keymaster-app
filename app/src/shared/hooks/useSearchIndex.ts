import { useCallback, useState } from "react";
import { api, type AccountEntry, type FileEntry, type Identity, type NoteEntry, type TotpEntry } from "../../lib/ipc";

export type SearchKind = "identity" | "totp" | "account" | "file" | "note";

export type SearchItem = {
  id: string;
  kind: SearchKind;
  title: string;
  subtitle: string;
  path: string;
  haystack: string;
};

function blob(parts: Array<string | null | undefined | string[]>): string {
  return parts
    .flatMap((p) => (Array.isArray(p) ? p : [p]))
    .filter((p): p is string => !!p && !!p.trim())
    .join(" ")
    .toLowerCase();
}

function identityItem(e: Identity): SearchItem {
  return {
    id: e.id,
    kind: "identity",
    title: e.name,
    subtitle: [e.platform, e.hostAlias, e.email].filter(Boolean).join(" · "),
    path: `/?focus=${encodeURIComponent(e.id)}`,
    haystack: blob([e.name, e.platform, e.hostAlias, e.realHost, e.user, e.email, e.gitUserName, e.owners]),
  };
}

function totpItem(e: TotpEntry): SearchItem {
  return {
    id: e.id,
    kind: "totp",
    title: e.issuer || e.account,
    subtitle: [e.account, e.group].filter(Boolean).join(" · "),
    path: `/totp?focus=${encodeURIComponent(e.id)}`,
    haystack: blob([e.issuer, e.account, e.note, e.group]),
  };
}

function accountItem(e: AccountEntry): SearchItem {
  return {
    id: e.id,
    kind: "account",
    title: e.displayName?.trim() || e.username,
    subtitle: [e.platform, e.username, e.group].filter(Boolean).join(" · "),
    path: `/accounts?focus=${encodeURIComponent(e.id)}`,
    haystack: blob([e.platform, e.username, e.displayName, e.note, e.url, e.group, e.tags]),
  };
}

function fileItem(e: FileEntry): SearchItem {
  return {
    id: e.id,
    kind: "file",
    title: e.name,
    subtitle: [e.originalName !== e.name ? e.originalName : "", e.group, e.note].filter(Boolean).join(" · "),
    path: `/files?focus=${encodeURIComponent(e.id)}`,
    haystack: blob([e.name, e.originalName, e.note, e.group]),
  };
}

function noteItem(e: NoteEntry): SearchItem {
  return {
    id: e.id,
    kind: "note",
    title: e.title.trim() || "",
    subtitle: [e.group, ...(e.tags || [])].filter(Boolean).join(" · "),
    path: `/notes?focus=${encodeURIComponent(e.id)}`,
    haystack: blob([e.title, e.group, e.tags]),
  };
}

export function scoreSearchItem(item: SearchItem, words: string[]): number | null {
  if (words.length === 0) return 0;
  let score = 0;
  const title = item.title.toLowerCase();
  for (const word of words) {
    const titleIdx = title.indexOf(word);
    const hayIdx = item.haystack.indexOf(word);
    if (titleIdx < 0 && hayIdx < 0) return null;
    if (titleIdx === 0) score += 5;
    else if (titleIdx > 0) score += 3;
    else if (hayIdx === 0) score += 2;
    else score += 1;
  }
  return score;
}

export function filterSearchItems(items: SearchItem[], query: string): SearchItem[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return items;
  return items
    .map((item) => ({ item, score: scoreSearchItem(item, words) }))
    .filter((row): row is { item: SearchItem; score: number } => row.score !== null)
    .sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title))
    .map((row) => row.item);
}

export function useSearchIndex() {
  const [items, setItems] = useState<SearchItem[]>([]);
  const [loading, setLoading] = useState(false);

  const ensureLoaded = useCallback(async () => {
    setLoading(true);
    try {
      const settled = await Promise.allSettled([
        api.listIdentities(),
        api.totpList(),
        api.accountList(),
        api.fileList(),
        api.noteList(),
      ]);
      const next: SearchItem[] = [];
      const identities = settled[0].status === "fulfilled" ? settled[0].value : [];
      const totp = settled[1].status === "fulfilled" ? settled[1].value.entries : [];
      const accounts = settled[2].status === "fulfilled" ? settled[2].value.entries : [];
      const files = settled[3].status === "fulfilled" ? settled[3].value.entries : [];
      const notes = settled[4].status === "fulfilled" ? settled[4].value.entries : [];
      for (const e of identities) next.push(identityItem(e));
      for (const e of totp) next.push(totpItem(e));
      for (const e of accounts) next.push(accountItem(e));
      for (const e of files) next.push(fileItem(e));
      for (const e of notes) next.push(noteItem(e));
      setItems(next);
    } finally {
      setLoading(false);
    }
  }, []);

  const clear = useCallback(() => setItems([]), []);

  return { items, loading, ensureLoaded, clear };
}
