import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  api,
  errMessage,
  type BuiltinIconInfo,
  type GroupMeta,
  type ParsedTotpPreview,
  type TotpEntry,
  type TotpImportResult,
} from "../../lib/ipc";
import { copyWithClear, isNeedReauth, tryBiometricReauth } from "../../lib/secretsUi";
import { resolvePlatform } from "../../platform/resolve";
import { detectTotpInput } from "../../lib/totpInput";
import { i18n } from "../../lib/i18n";
import { firstOtpauth, pickQrFromGallery, scanQrWithCamera, totpImportUris } from "../../lib/qrCapture";
import { isMobilePlatform } from "../../lib/platform";
import { appendGroupIfNew, resolveGroupName } from "../../ui/GroupPicker";
import { applyGroupOrder, removeGroupMeta, renameGroupMeta, sortGroups } from "../../ui/groupOrder";
import type { GroupDialogState } from "../../ui/GroupDialog";
import { useApp } from "../../store";

const VIEW_KEY = "gam.totp.view";
const NOTE_MAX = 32;

export function clipNote(note?: string | null) {
  const text = (note || "").trim();
  if (!text) return "";
  return text.length > NOTE_MAX ? `${text.slice(0, NOTE_MAX)}…` : text;
}

export { NOTE_MAX };

export function useTotpModel() {
  const { writesLocked } = useApp();
  const [entries, setEntries] = useState<TotpEntry[]>([]);
  const [groups, setGroups] = useState<GroupMeta[]>([]);
  const [builtins, setBuiltins] = useState<BuiltinIconInfo[]>([]);
  const [q, setQ] = useState("");
  const [group, setGroup] = useState("全部");
  const [view, setView] = useState<"grid" | "list">(() =>
    localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid",
  );
  const [err, setErr] = useState("");
  const [codes, setCodes] = useState<Record<string, { code: string; remain: number; period: number }>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [reauth, setReauth] = useState<null | ((pw: string) => Promise<void>)>(null);
  const reauthCancel = useRef<(() => void) | null>(null);
  const [revealCfg, setRevealCfg] = useState({ grace: 5, clip: 20 });
  const [editor, setEditor] = useState<null | Partial<TotpEntry> & { secret?: string }>(null);
  const [secretDlg, setSecretDlg] = useState<null | { id: string; secret?: string; uri?: string; qr?: string }>(null);
  const [batchImport, setBatchImport] = useState<TotpImportResult | null>(null);
  const [groupDlg, setGroupDlg] = useState<GroupDialogState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TotpEntry | null>(null);
  const [pendingDeleteGroup, setPendingDeleteGroup] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);

  const load = useCallback(async () => {
    const [list, icons] = await Promise.all([api.totpList(), api.iconListBuiltin()]);
    setEntries(list.entries);
    setGroups(sortGroups(list.groups));
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
      setCodes((prev) => {
        const next = { ...prev };
        for (const id of Object.keys(next)) {
          const item = next[id];
          if (item.remain <= 1) {
            api
              .totpGenerateCode(id)
              .then((c) => {
                setCodes((cur) => ({
                  ...cur,
                  [id]: { code: c.code, remain: c.remainingSeconds, period: c.period },
                }));
              })
              .catch(() => {
                setCodes((cur) => {
                  const { [id]: _, ...rest } = cur;
                  return rest;
                });
              });
          } else {
            next[id] = { ...item, remain: item.remain - 1 };
          }
        }
        return next;
      });
    }, 1000);
    return () => window.clearInterval(t);
  }, []);

  const filtered = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return entries
      .filter((e) => group === "全部" || (e.group || "未分组") === group)
      .filter((e) => {
        if (!words.length) return true;
        const blob = [e.issuer, e.account, e.note, e.group, e.url].filter(Boolean).join(" ").toLowerCase();
        return words.every((w) => blob.includes(w));
      })
      .sort((a, b) => a.sortOrder - b.sortOrder || a.issuer.localeCompare(b.issuer));
  }, [entries, q, group]);

  function setViewMode(mode: "grid" | "list") {
    setView(mode);
    localStorage.setItem(VIEW_KEY, mode);
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

  async function reveal(id: string) {
    setErr("");
    const c = await withAuth((pw) => api.totpGenerateCode(id, pw));
    if (c) setCodes((m) => ({ ...m, [id]: { code: c.code, remain: c.remainingSeconds, period: c.period } }));
  }

  function hideCode(id: string) {
    setCodes((m) => {
      const n = { ...m };
      delete n[id];
      return n;
    });
  }

  async function copyCode(id: string) {
    let cur = codes[id];
    if (!cur) {
      const c = await withAuth((pw) => api.totpGenerateCode(id, pw));
      if (!c) return;
      cur = { code: c.code, remain: c.remainingSeconds, period: c.period };
      setCodes((m) => ({ ...m, [id]: cur }));
    }
    try {
      await copyWithClear(cur.code.replace(/\s/g, ""));
    } catch (e) {
      if (resolvePlatform() !== "mobile") setErr(errMessage(e) || i18n.t("totp.copyFail"));
      return;
    }
    setCopiedId(id);
    window.setTimeout(() => {
      setCopiedId((prev) => (prev === id ? null : prev));
    }, 1500);
  }

  async function openSecret(id: string) {
    setSecretDlg({ id });
  }

  async function confirmSecret(pw: string) {
    if (!secretDlg) return;
    const sec = await api.totpRevealSecret(secretDlg.id, pw);
    setSecretDlg({
      id: secretDlg.id,
      secret: sec.secretBase32,
      uri: sec.otpauthUri,
      qr: sec.qrPngBase64,
    });
  }

  async function saveEditor() {
    if (!editor) return;
    if (editor.id && editor.hasSeed === false && !editor.secret?.trim()) {
      setErr(i18n.t("totp.seedLost"));
      return;
    }
    setBusy(true);
    try {
      const nextGroup = resolveGroupName(groups, editor.group);
      const created = appendGroupIfNew(groups, nextGroup);
      if (created) {
        await api.totpSaveGroups(created);
        setGroups(created);
      }
      const args = {
        id: editor.id,
        issuer: editor.issuer || "",
        account: editor.account || "",
        secret: editor.secret,
        note: clipNote(editor.note) || undefined,
        url: editor.url || undefined,
        group: nextGroup,
        algorithm: editor.algorithm || "SHA1",
        digits: editor.digits || 6,
        period: editor.period || 30,
        icon: editor.icon || undefined,
      };
      if (editor.id) await api.totpUpdate(args);
      else await api.totpAdd(args);
      setEditor(null);
      await load();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function applyPreview(p: ParsedTotpPreview, secretFromUri?: string) {
    setEditor({
      issuer: p.issuer,
      account: p.account,
      algorithm: p.algorithm,
      digits: p.digits,
      period: p.period,
      icon: p.suggestedIcon || undefined,
      secret: secretFromUri || p.secret,
    });
  }

  function openImportResult(r: TotpImportResult) {
    if (r.entries.length === 0) {
      setErr(i18n.t("totp.scanNone"));
      return;
    }
    if (r.entries.length === 1) {
      applyPreview(r.entries[0], r.entries[0].secret);
      return;
    }
    setBatchImport(r);
  }

  async function ingestImportTexts(texts: string[]) {
    const uris = totpImportUris(texts);
    if (!uris.length) {
      setErr(i18n.t("totp.scanNone"));
      return;
    }
    const merged: ParsedTotpPreview[] = [];
    let skippedHotp = 0;
    let source = "otpauth";
    let batchIndex = 0;
    let batchSize = 1;
    for (const uri of uris) {
      const r = await api.totpParseImport(uri);
      merged.push(...r.entries);
      skippedHotp += r.skippedHotp || 0;
      if (r.source === "google-migration") {
        source = r.source;
        batchIndex = r.batchIndex;
        batchSize = r.batchSize;
      }
    }
    openImportResult({ source, entries: merged, skippedHotp, batchIndex, batchSize });
  }

  async function confirmBatchImport(selected: ParsedTotpPreview[], group?: string) {
    if (!selected.length) {
      setErr(i18n.t("totp.batchNoneSelected"));
      return;
    }
    setBusy(true);
    try {
      const nextGroup = resolveGroupName(groups, group);
      const created = appendGroupIfNew(groups, nextGroup);
      if (created) {
        await api.totpSaveGroups(created);
        setGroups(created);
      }
      for (const e of selected) {
        await api.totpAdd({
          issuer: e.issuer,
          account: e.account,
          secret: e.secret,
          algorithm: e.algorithm || "SHA1",
          digits: e.digits || 6,
          period: e.period || 30,
          icon: e.suggestedIcon || undefined,
          group: nextGroup,
        });
      }
      setBatchImport(null);
      await load();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function scanCamera() {
    setBusy(true);
    setErr("");
    try {
      const texts = await scanQrWithCamera({
        title: i18n.t("totp.scanTitle"),
        hint: i18n.t("totp.scanHint"),
      });
      if (!texts) return;
      if (!firstOtpauth(texts)) {
        setErr(i18n.t("totp.scanNone"));
        return;
      }
      await ingestImportTexts(texts);
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function importImage() {
    setBusy(true);
    setErr("");
    try {
      if (isMobilePlatform()) {
        const texts = await pickQrFromGallery();
        if (!texts) return;
        if (!firstOtpauth(texts)) {
          setErr(i18n.t("totp.scanPhotoNone"));
          return;
        }
        await ingestImportTexts(texts);
        return;
      }
      const path = await open({ filters: [{ name: i18n.t("common.imageFilter"), extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }] });
      if (typeof path !== "string") return;
      const r = await api.totpImportFromImage(path);
      openImportResult(r);
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function scanScreen() {
    setBusy(true);
    try {
      const hits = await api.totpScanScreen();
      if (hits.length === 0) setErr(i18n.t("totp.scanScreenNone"));
      else
        openImportResult({
          source: hits.some((h) => h.uri.toLowerCase().startsWith("otpauth-migration://"))
            ? "google-migration"
            : "otpauth",
          entries: hits.map((h) => ({
            ...h.parsed,
            suggestedIcon: null,
            secret: h.parsed.secret || detectTotpInput(h.uri).secret,
          })),
          skippedHotp: 0,
          batchIndex: 0,
          batchSize: 1,
        });
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveGroup(name: string, color: string | null) {
    if (groupDlg?.mode === "edit") {
      const oldName = groupDlg.name;
      const next = renameGroupMeta(groups, oldName, name, color);
      const remap = oldName !== name ? { from: oldName, to: name } : null;
      await api.totpSaveGroups(next, remap);
      setGroups(next);
      if (remap) {
        setEntries((prev) => prev.map((e) => (e.group === oldName ? { ...e, group: name } : e)));
        if (group === oldName) setGroup(name);
      }
      setGroupDlg(null);
      return;
    }
    const next = [...groups, { name, color, sortOrder: groups.length }];
    await api.totpSaveGroups(next);
    setGroups(next);
    setGroup(name);
    setGroupDlg(null);
  }

  function requestDeleteGroup(name: string) {
    if (writesLocked || !groups.some((g) => g.name === name)) return;
    setPendingDeleteGroup(name);
  }

  async function confirmDeleteGroup() {
    if (!pendingDeleteGroup) return;
    const name = pendingDeleteGroup;
    setBusy(true);
    try {
      const next = removeGroupMeta(groups, name);
      await api.totpSaveGroups(next, { from: name, to: null });
      setGroups(next);
      setEntries((prev) => prev.map((e) => (e.group === name ? { ...e, group: undefined } : e)));
      if (group === name) setGroup("未分组");
      setPendingDeleteGroup(null);
      setGroupDlg(null);
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function reorderGroups(orderedNames: string[]) {
    if (writesLocked) return;
    const prev = groups;
    const next = applyGroupOrder(groups, orderedNames);
    setGroups(next);
    try {
      await api.totpSaveGroups(next);
    } catch (e) {
      setGroups(prev);
      setErr(errMessage(e));
    }
  }

  function deleteEntry(e: TotpEntry) {
    setPendingDelete(e);
  }

  async function confirmDeleteEntry() {
    if (!pendingDelete) return;
    setBusy(true);
    try {
      await api.totpDelete(pendingDelete.id);
      setPendingDelete(null);
      await load();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function batchUpdateGroup(
    ids: string[],
    groupRaw?: string,
  ): Promise<{ ok: number; failedIds: string[] } | undefined> {
    if (writesLocked) {
      setErr(i18n.t("totp.batchGroupLocked"));
      return;
    }
    const unique = [...new Set(ids)];
    const targets = unique
      .map((id) => entries.find((e) => e.id === id))
      .filter((e): e is TotpEntry => !!e);
    if (!targets.length) {
      setErr(i18n.t("totp.batchGroupNeedPick"));
      return;
    }
    setBusy(true);
    setBatchProgress({ done: 0, total: targets.length });
    setErr("");
    try {
      const nextGroup = resolveGroupName(groups, groupRaw);
      const created = appendGroupIfNew(groups, nextGroup);
      if (created) {
        await api.totpSaveGroups(created);
        setGroups(created);
      }
      const failedIds: string[] = [];
      const failedLines: string[] = [];
      let done = 0;
      for (const e of targets) {
        if (e.hasSeed === false) {
          failedIds.push(e.id);
          failedLines.push(`${e.issuer} / ${e.account}：${i18n.t("totp.seedLostShort")}`);
        } else {
          try {
            await api.totpUpdate({
              id: e.id,
              issuer: e.issuer,
              account: e.account,
              note: e.note || undefined,
              url: e.url || undefined,
              group: nextGroup,
              algorithm: e.algorithm,
              digits: e.digits,
              period: e.period,
              icon: e.icon || undefined,
              sortOrder: e.sortOrder,
            });
          } catch (err) {
            failedIds.push(e.id);
            failedLines.push(`${e.issuer} / ${e.account}：${errMessage(err)}`);
          }
        }
        done += 1;
        setBatchProgress({ done, total: targets.length });
      }
      await load();
      if (failedIds.length) {
        const detail = failedLines.join("\n");
        setErr(
          failedIds.length === targets.length
            ? i18n.t("totp.batchGroupAllFailed", { n: failedIds.length, detail })
            : i18n.t("totp.batchGroupPartial", {
                ok: targets.length - failedIds.length,
                fail: failedIds.length,
                detail,
              }),
        );
      }
      return { ok: targets.length - failedIds.length, failedIds };
    } catch (e) {
      setErr(errMessage(e));
      return;
    } finally {
      setBusy(false);
      setBatchProgress(null);
    }
  }

  const groupTabs = [
    "全部",
    ...groups.map((g) => g.name),
    ...entries
      .map((e) => e.group || "未分组")
      .filter((n, i, a) => n !== "未分组" && !groups.some((g) => g.name === n) && a.indexOf(n) === i),
    "未分组",
  ];

  return {
    writesLocked,
    entries,
    groups,
    builtins,
    q,
    setQ,
    group,
    setGroup,
    view,
    setViewMode,
    err,
    setErr,
    codes,
    copiedId,
    reauth,
    reauthCancel,
    revealCfg,
    editor,
    setEditor,
    secretDlg,
    setSecretDlg,
    batchImport,
    setBatchImport,
    confirmBatchImport,
    ingestImportTexts,
    groupDlg,
    setGroupDlg,
    pendingDelete,
    setPendingDelete,
    pendingDeleteGroup,
    setPendingDeleteGroup,
    busy,
    batchProgress,
    batchUpdateGroup,
    filtered,
    groupTabs,
    reveal,
    hideCode,
    copyCode,
    openSecret,
    confirmSecret,
    saveEditor,
    applyPreview,
    importImage,
    scanCamera,
    scanScreen,
    saveGroup,
    requestDeleteGroup,
    confirmDeleteGroup,
    reorderGroups,
    deleteEntry,
    confirmDeleteEntry,
  };
}

export type TotpModel = ReturnType<typeof useTotpModel>;
