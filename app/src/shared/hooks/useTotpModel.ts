import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  api,
  errMessage,
  type BuiltinIconInfo,
  type GroupMeta,
  type ParsedTotpPreview,
  type ScreenHit,
  type TotpEntry,
} from "../../lib/ipc";
import { copyWithClear, isNeedReauth, tryBiometricReauth } from "../../lib/secretsUi";
import { detectTotpInput } from "../../lib/totpInput";
import { firstOtpauth, pickQrFromGallery, scanQrWithCamera } from "../../lib/qrCapture";
import { isMobilePlatform } from "../../lib/platform";
import { appendGroupIfNew, resolveGroupName } from "../../ui/GroupPicker";
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
  const [scanHits, setScanHits] = useState<ScreenHit[] | null>(null);
  const [groupDlg, setGroupDlg] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<TotpEntry | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [list, icons] = await Promise.all([api.totpList(), api.iconListBuiltin()]);
    setEntries(list.entries);
    setGroups(list.groups);
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
    await copyWithClear(cur.code.replace(/\s/g, ""));
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
    if (editor.id && editor.hasSeed !== true && !editor.secret?.trim()) {
      setErr("这条记录的种子已丢失，请重新填入密钥或 otpauth 链接。");
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

  async function importFromOtpauth(uri: string) {
    const p = await api.totpParseUri(uri);
    applyPreview(p, detectTotpInput(uri).secret);
  }

  async function scanCamera() {
    setBusy(true);
    setErr("");
    try {
      const texts = await scanQrWithCamera({
        title: "扫描 2FA 密钥二维码",
        hint: "对准包含 otpauth 密钥的二维码，自动识别",
      });
      if (!texts) return;
      const uri = firstOtpauth(texts);
      if (!uri) {
        setErr("未识别到有效的 2FA/otpauth 二维码");
        return;
      }
      await importFromOtpauth(uri);
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
        const uri = firstOtpauth(texts);
        if (!uri) {
          setErr("照片中未识别到 otpauth 二维码");
          return;
        }
        await importFromOtpauth(uri);
        return;
      }
      const path = await open({ filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }] });
      if (typeof path !== "string") return;
      const p = await api.totpImportFromImage(path);
      applyPreview(p);
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
      if (hits.length === 0) setErr("屏幕中未识别到 otpauth 二维码");
      else if (hits.length === 1)
        applyPreview({ ...hits[0].parsed, suggestedIcon: null, secret: detectTotpInput(hits[0].uri).secret });
      else setScanHits(hits);
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveGroup(name: string, color: string | null) {
    const next = [...groups, { name, color, sortOrder: groups.length }];
    await api.totpSaveGroups(next);
    setGroups(next);
    setGroup(name);
    setGroupDlg(false);
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
    scanHits,
    setScanHits,
    groupDlg,
    setGroupDlg,
    pendingDelete,
    setPendingDelete,
    busy,
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
    deleteEntry,
    confirmDeleteEntry,
  };
}

export type TotpModel = ReturnType<typeof useTotpModel>;
