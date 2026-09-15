/**
 * 备忘录未保存草稿的暂存区——**只在内存里**。
 *
 * 这里原先用的是 `localStorage`。WebView 的 localStorage 在磁盘上是一个没有加密的
 * LevelDB（Windows 落在 WebView2 用户数据目录下），于是备忘录正文——用户拿它记
 * 私钥口令、恢复码、服务器密码——会以明文留在保险库外面，锁定、退出、重装都不清。
 * 保险库本体加密得再好也白搭，而且这属于用户完全无从察觉的泄密。
 *
 * 代价：进程被强杀时恢复不了草稿。应用内切换笔记、切页面再回来都照旧。
 */

const DRAFT_PREFIX = "km.notes.draft.";

const memory = new Map<string, { draft: unknown; savedAt: string }>();

export function draftKey(id?: string) {
  return `${DRAFT_PREFIX}${id || "new"}`;
}

/** 清掉历史版本留在磁盘上的明文草稿，让老用户升级后也干净。 */
export function purgeLegacyDiskDrafts() {
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k?.startsWith(DRAFT_PREFIX)) stale.push(k);
    }
    stale.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* 隐私模式等场景下 localStorage 不可用，忽略 */
  }
}

export function readDraft<T>(id?: string): { draft: T; savedAt: string } | null {
  const hit = memory.get(draftKey(id));
  return hit ? { draft: hit.draft as T, savedAt: hit.savedAt } : null;
}

export function writeDraft(id: string | undefined, draft: unknown) {
  memory.set(draftKey(id), { draft, savedAt: new Date().toISOString() });
}

export function clearDraft(id?: string) {
  memory.delete(draftKey(id));
}

/** 锁定时连内存草稿一起丢掉，否则重新解锁还能看到上一次的明文。 */
export function clearAllDrafts() {
  memory.clear();
  purgeLegacyDiskDrafts();
}
