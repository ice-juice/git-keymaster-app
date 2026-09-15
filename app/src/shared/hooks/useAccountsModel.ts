import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  errMessage,
  type AccountEntry,
  type BuiltinIconInfo,
  type GroupMeta,
  type HistoryMeta,
  type TotpEntry,
} from "../../lib/ipc";
import { copyWithClear, isNeedReauth, tryBiometricReauth } from "../../lib/secretsUi";
import { resolvePlatform } from "../../platform/resolve";
import { resolvePlatformBrand, platformFamily } from "../../lib/accountInput";
import { appendGroupIfNew, resolveGroupName } from "../../ui/GroupPicker";
import { useApp } from "../../store";

export function useAccountsModel() {
  const { writesLocked } = useApp();
  const [entries, setEntries] = useState<AccountEntry[]>([]);
  const [groups, setGroups] = useState<GroupMeta[]>([]);
  const [totps, setTotps] = useState<TotpEntry[]>([]);
  const [builtins, setBuiltins] = useState<BuiltinIconInfo[]>([]);
  const [q, setQ] = useState("");
  const [group, setGroup] = useState("全部");
  const [err, setErr] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [reauth, setReauth] = useState<null | ((pw: string) => Promise<void>)>(null);
  const reauthCancel = useRef<(() => void) | null>(null);
  const [revealCfg, setRevealCfg] = useState({ grace: 5, clip: 20 });
  const [editor, setEditor] = useState<null | (Partial<AccountEntry> & { password?: string; isPlatformLocked?: boolean })>(null);
  const [editingPlatformModal, setEditingPlatformModal] = useState<null | { platform: string; icon?: string }>(null);
  const [historyFor, setHistoryFor] = useState<null | { id: string; items: HistoryMeta[]; shown?: Record<number, string> }>(null);
  const [pwShown, setPwShown] = useState<Record<string, string>>({});
  const [totpShown, setTotpShown] = useState<Record<string, { code: string; remain: number; period: number }>>({});
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [groupDlg, setGroupDlg] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{
    id: string;
    platform: string;
    username: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [acc, totp, icons] = await Promise.all([api.accountList(), api.totpList(), api.iconListBuiltin()]);
    setEntries(acc.entries);
    setGroups(acc.groups);
    setTotps(totp.entries);
    setBuiltins(icons);
  }, []);

  useEffect(() => {
    load().catch((e) => setErr(errMessage(e)));
  }, [load]);

  useEffect(() => {
    api
      .getRevealSettings()
      .then((s) => setRevealCfg({ grace: s.revealGraceMinutes, clip: s.clipboardClearSeconds }))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const t = window.setInterval(() => {
      setTotpShown((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const id of Object.keys(next)) {
          const item = next[id];
          if (item.remain <= 1) {
            api
              .totpGenerateCode(id)
              .then((c) => {
                setTotpShown((cur) => ({
                  ...cur,
                  [id]: { code: c.code, remain: c.remainingSeconds, period: c.period },
                }));
              })
              .catch(() => {
                setTotpShown((cur) => {
                  const { [id]: _, ...rest } = cur;
                  return rest;
                });
              });
          } else {
            next[id] = { ...item, remain: item.remain - 1 };
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 1000);
    return () => window.clearInterval(t);
  }, []);

  function triggerCopied(key: string) {
    setCopiedKey(key);
    window.setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? null : prev));
    }, 1500);
  }

  async function copyUsername(id: string, username: string) {
    try {
      await copyWithClear(username, undefined, false);
    } catch (e) {
      if (resolvePlatform() !== "mobile") setErr(errMessage(e) || "复制失败");
      return;
    }
    triggerCopied(`user-${id}`);
  }

  async function withAuth<T>(fn: (pw?: string) => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (e) {
      if (!isNeedReauth(e)) {
        setErr(errMessage(e));
        return;
      }
      if (await tryBiometricReauth()) {
        try {
          return await fn();
        } catch (err) {
          if (!isNeedReauth(err)) {
            setErr(errMessage(err));
            return;
          }
        }
      }
      return await new Promise<T | undefined>((resolve) => {
        reauthCancel.current = () => {
          reauthCancel.current = null;
          setReauth(null);
          resolve(undefined);
        };
        setReauth(() => async (pw: string) => {
          try {
            const r = await fn(pw);
            reauthCancel.current = null;
            setReauth(null);
            resolve(r);
          } catch (err) {
            throw new Error(errMessage(err));
          }
        });
      });
    }
  }

  const filtered = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return entries.filter((e) => {
      if (group !== "全部" && (e.group || "未分组") !== group) return false;
      if (!words.length) return true;
      const blob = [e.platform, e.username, e.displayName, e.note, e.url, ...(e.tags || [])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return words.every((w) => blob.includes(w));
    });
  }, [entries, q, group]);

  const platforms = useMemo(() => {
    const map = new Map<string, AccountEntry[]>();
    for (const e of filtered) {
      const family = platformFamily(e.platform, builtins);
      const list = map.get(family) || [];
      list.push(e);
      map.set(family, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        const ta = a.lastUsedAt || "";
        const tb = b.lastUsedAt || "";
        if (ta !== tb) return tb.localeCompare(ta);
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
        return a.username.localeCompare(b.username);
      });
    }
    return [...map.values()]
      .map((list) => {
        const brand = resolvePlatformBrand(
          list[0].platform,
          list.find((e) => e.icon)?.icon,
          list,
          builtins,
        );
        return [brand.platform, list] as [string, AccountEntry[]];
      })
      .sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered, builtins]);

  async function revealPw(id: string) {
    const pw = await withAuth((p) => api.accountRevealPassword(id, p));
    if (pw) {
      setPwShown((m) => ({ ...m, [id]: pw }));
      await api.accountTouch(id);
    }
  }

  function hidePw(id: string) {
    setPwShown((m) => {
      const n = { ...m };
      delete n[id];
      return n;
    });
  }

  async function copyPw(id: string) {
    let pw = pwShown[id];
    if (!pw) {
      const got = await withAuth((p) => api.accountRevealPassword(id, p));
      if (!got) return;
      pw = got;
      setPwShown((m) => ({ ...m, [id]: pw }));
    }
    try {
      await copyWithClear(pw);
    } catch (e) {
      if (resolvePlatform() !== "mobile") setErr(errMessage(e) || "复制失败");
      return;
    }
    await api.accountTouch(id);
    triggerCopied(`pw-${id}`);
  }

  async function revealLinkedTotp(totpId: string) {
    const c = await withAuth((p) => api.totpGenerateCode(totpId, p));
    if (c) setTotpShown((m) => ({ ...m, [totpId]: { code: c.code, remain: c.remainingSeconds, period: c.period } }));
  }

  async function copyLinkedTotp(totpId: string) {
    let item = totpShown[totpId];
    if (!item) {
      const c = await withAuth((p) => api.totpGenerateCode(totpId, p));
      if (!c) return;
      item = { code: c.code, remain: c.remainingSeconds, period: c.period };
      setTotpShown((m) => ({ ...m, [totpId]: item }));
    }
    try {
      await copyWithClear(item.code.replace(/\s/g, ""));
    } catch (e) {
      if (resolvePlatform() !== "mobile") setErr(errMessage(e) || "复制失败");
      return;
    }
    triggerCopied(`totp-${totpId}`);
  }

  async function saveEditor() {
    if (!editor) return;
    setBusy(true);
    try {
      const nextGroup = resolveGroupName(groups, editor.group);
      const created = appendGroupIfNew(groups, nextGroup);
      if (created) {
        await api.accountSaveGroups(created);
        setGroups(created);
      }
      const username = (editor.username || "").trim();
      const platformInput = (editor.platform || "").trim();

      if (!platformInput) {
        setErr("平台名称不能为空");
        return;
      }
      if (!username) {
        setErr("用户名不能为空");
        return;
      }
      if (!editor.id && !editor.password?.trim()) {
        setErr("请填写密码");
        return;
      }

      const brand = resolvePlatformBrand(
        platformInput,
        editor.icon,
        entries.filter((e) => e.id !== editor.id),
        builtins,
      );
      const platform = brand.platform;
      const dup = entries.some(
        (e) =>
          e.id !== editor.id &&
          e.platform.trim().toLowerCase() === platform.toLowerCase() &&
          e.username.trim().toLowerCase() === username.toLowerCase(),
      );
      if (dup && !window.confirm(`已存在 ${platform} / ${username}，仍要保存吗？`)) {
        return;
      }
      if (editor.id && editor.hasPassword === false && !editor.password?.trim()) {
        setErr("这条账号的密码已丢失，请重新填入密码。");
        return;
      }
      const cleanPassword = editor.password?.trim() || undefined;
      const args = {
        id: editor.id,
        platform,
        username,
        password: cleanPassword,
        displayName: editor.displayName || undefined,
        url: editor.url || undefined,
        note: editor.note || undefined,
        group: nextGroup,
        tags: editor.tags,
        icon: brand.icon,
        pinned: editor.pinned,
        totpRef: editor.totpRef || undefined,
      };
      if (editor.id) await api.accountUpdate(args);
      else await api.accountAdd(args);
      setEditor(null);
      await load();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveGroup(name: string, color: string | null) {
    const next = [...groups, { name, color, sortOrder: groups.length }];
    await api.accountSaveGroups(next);
    setGroups(next);
    setGroup(name);
    setGroupDlg(false);
  }

  function deleteEditorAccount() {
    if (!editor?.id) return;
    setPendingDelete({
      id: editor.id,
      platform: editor.platform?.trim() || "未命名平台",
      username: editor.username?.trim() || "",
    });
  }

  async function confirmDeleteEditorAccount() {
    if (!pendingDelete) return;
    setBusy(true);
    try {
      await api.accountDelete(pendingDelete.id);
      setPendingDelete(null);
      setEditor(null);
      await load();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function openHistory(id: string) {
    const items = await api.accountHistoryList(id);
    setHistoryFor({ id, items });
  }

  async function revealHistory(index: number) {
    if (!historyFor) return;
    const pw = await withAuth((p) => api.accountRevealHistory(historyFor.id, index, p));
    if (pw) setHistoryFor({ ...historyFor, shown: { ...historyFor.shown, [index]: pw } });
  }

  async function rollbackHistory(index: number, replacedAt: string) {
    if (!historyFor) return;
    if (!window.confirm(`确认将密码回滚到此历史版本（${replacedAt}）？`)) return;
    await api.accountRollbackHistory(historyFor.id, index);
    setHistoryFor(null);
    await load();
  }

  async function clearHistory() {
    if (!historyFor) return;
    if (!window.confirm("确定要清空该账号的所有历史版本记录吗？此操作不可逆。")) return;
    await api.accountClearHistory(historyFor.id);
    setHistoryFor({ id: historyFor.id, items: [] });
  }

  async function updatePlatformBrand(oldPlatform: string, newPlatformName: string, newIcon?: string) {
    const trimmedName = newPlatformName.trim();
    if (!trimmedName) {
      setErr("平台名称不能为空");
      return;
    }

    const family = platformFamily(oldPlatform, builtins);
    const targets = entries.filter(
      (e) => platformFamily(e.platform, builtins) === family,
    );
    if (targets.length === 0) return;

    setBusy(true);
    try {
      for (const item of targets) {
        await api.accountUpdate({
          id: item.id,
          platform: trimmedName,
          username: item.username,
          displayName: item.displayName || undefined,
          url: item.url || undefined,
          note: item.note || undefined,
          group: item.group || undefined,
          tags: item.tags,
          icon: newIcon || undefined,
          pinned: item.pinned,
          totpRef: item.totpRef || undefined,
        });
      }
      setEditingPlatformModal(null);
      await load();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const tabs = ["全部", ...groups.map((g) => g.name), "未分组"];

  return {
    writesLocked,
    entries,
    groups,
    totps,
    builtins,
    q,
    setQ,
    group,
    setGroup,
    err,
    setErr,
    collapsed,
    setCollapsed,
    reauth,
    reauthCancel,
    revealCfg,
    editor,
    setEditor,
    historyFor,
    setHistoryFor,
    pwShown,
    totpShown,
    copiedKey,
    groupDlg,
    setGroupDlg,
    pendingDelete,
    setPendingDelete,
    editingPlatformModal,
    setEditingPlatformModal,
    busy,
    platforms,
    tabs,
    expandAll: () => setCollapsed({}),
    collapseAll: () => setCollapsed(Object.fromEntries(platforms.map(([p]) => [p, true]))),
    copyUsername,
    revealPw,
    hidePw,
    copyPw,
    revealLinkedTotp,
    copyLinkedTotp,
    saveEditor,
    saveGroup,
    deleteEditorAccount,
    confirmDeleteEditorAccount,
    updatePlatformBrand,
    openHistory,
    revealHistory,
    rollbackHistory,
    clearHistory,
    withAuth,
  };
}

export type AccountsModel = ReturnType<typeof useAccountsModel>;
