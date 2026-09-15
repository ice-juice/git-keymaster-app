import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { api, entryAttachments, errMessage, type FileAttachment, type FileEntry, type GroupMeta } from "../../lib/ipc";
import { isNeedReauth, tryBiometricReauth } from "../../lib/secretsUi";
import { resolvePlatform } from "../../platform/resolve";
import { appendGroupIfNew, resolveGroupName } from "../../ui/GroupPicker";
import { showAppToast } from "../../ui/Toast";
import { i18n } from "../../lib/i18n";
import { useApp } from "../../store";

export const FILE_PER_FILE_LIMIT_BYTES = 100 * 1024 * 1024;

export interface FilePendingAtt {
  key: string;
  originalName: string;
  size: number;
  filePath?: string;
  fileBytes?: Uint8Array;
}

export interface FileEditState {
  id?: string;
  name: string;
  kept: FileAttachment[];
  pending: FilePendingAtt[];
  group?: string;
  note?: string;
  icon?: string;
}

function nextPendingKey() {
  return `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function editorAttachments(e: FileEditState): Array<{ key: string; originalName: string; size: number; existing?: boolean }> {
  return [
    ...e.kept.map((a) => ({ key: a.id, originalName: a.originalName, size: a.size, existing: true })),
    ...e.pending.map((a) => ({ key: a.key, originalName: a.originalName, size: a.size, existing: false })),
  ];
}

export function editorHasAttachment(e: FileEditState) {
  return e.kept.length + e.pending.length > 0;
}

export function editorOversize(e: FileEditState) {
  return e.pending.some((a) => a.size > FILE_PER_FILE_LIMIT_BYTES);
}

export type FilesSortBy = "updated" | "name" | "size";
export type FilesViewMode = "grid" | "table";

const VIEW_KEY = "km.files.viewMode";

function readViewMode(): FilesViewMode {
  try {
    return localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "table";
  } catch {
    return "table";
  }
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatUpdatedAt(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace("T", " ");
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return i18n.t("common.justNow");
  if (diff < 3600_000) return i18n.t("common.minutesAgo", { n: Math.floor(diff / 60_000) });
  if (diff < 86400_000) return i18n.t("common.hoursAgo", { n: Math.floor(diff / 3600_000) });
  if (diff < 2 * 86400_000) return i18n.t("common.yesterday");
  return iso.slice(0, 10);
}

function haystack(e: FileEntry): string {
  return [e.name, e.originalName, e.note, e.group, e.mime, ...entryAttachments(e).map((a) => a.originalName)]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function useFilesModel() {
  const { writesLocked } = useApp();
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [groups, setGroups] = useState<GroupMeta[]>([]);
  const [usageBytes, setUsageBytes] = useState(0);
  const [q, setQ] = useState("");
  const [group, setGroup] = useState("全部");
  const [viewMode, setViewModeState] = useState<FilesViewMode>(readViewMode);
  const [sortBy, setSortBy] = useState<FilesSortBy>("updated");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [editor, setEditor] = useState<FileEditState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<FileEntry | null>(null);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [reauth, setReauth] = useState<null | ((pw: string) => Promise<void>)>(null);
  const reauthCancel = useRef<(() => void) | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [groupDlg, setGroupDlg] = useState(false);
  const [sheetEntry, setSheetEntry] = useState<FileEntry | null>(null);
  const [exportPick, setExportPick] = useState<FileEntry | null>(null);
  const [revealCfg, setRevealCfg] = useState({ grace: 5, clip: 20 });
  const searchRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    const data = await api.fileList();
    setEntries(data.entries);
    setGroups(data.groups);
    setUsageBytes(data.usageBytes);
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
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        if (resolvePlatform() === "mobile") return;
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function setViewMode(v: FilesViewMode) {
    setViewModeState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* ignore */
    }
  }

  function setSort(by: FilesSortBy) {
    setSortBy((prev) => {
      if (prev === by) {
        setSortOrder((o) => (o === "asc" ? "desc" : "asc"));
        return prev;
      }
      setSortOrder(by === "name" ? "asc" : "desc");
      return by;
    });
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

  const filteredEntries = useMemo(() => {
    const words = q.trim().toLowerCase().split(/[\s,，\t]+/).filter(Boolean);
    const list = entries.filter((e) => {
      if (group !== "全部" && (e.group || "未分组") !== group) return false;
      if (!words.length) return true;
      const blob = haystack(e);
      return words.every((w) => blob.includes(w));
    });
    const dir = sortOrder === "asc" ? 1 : -1;
    list.sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      if (sortBy === "name") return a.name.localeCompare(b.name) * dir;
      if (sortBy === "size") return (a.size - b.size) * dir;
      return a.updatedAt.localeCompare(b.updatedAt) * dir;
    });
    return list;
  }, [entries, q, group, sortBy, sortOrder]);

  const tabs = useMemo(() => ["全部", ...groups.map((g) => g.name), "未分组"], [groups]);
  const totalCount = entries.length;

  function openEditorForPick(partial: FileEditState) {
    setEditor(partial);
    setErr("");
  }

  function defaultGroup() {
    return group !== "全部" && group !== "未分组" ? group : undefined;
  }

  async function startUpload() {
    if (writesLocked) return;
    if (resolvePlatform() === "mobile") return;
    try {
      const selected = await open({ multiple: true, directory: false });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      if (!paths.length) return;
      const pending = paths.map((path) => ({
        key: nextPendingKey(),
        originalName: path.replace(/^.*[/\\]/, "") || "file",
        size: 0,
        filePath: path,
      }));
      openEditorForPick({
        name: pending[0].originalName,
        kept: [],
        pending,
        group: defaultGroup(),
      });
    } catch (e) {
      setErr(errMessage(e));
    }
  }

  async function pickMoreFiles() {
    if (writesLocked || !editor) return;
    if (resolvePlatform() === "mobile") return;
    try {
      const selected = await open({ multiple: true, directory: false });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      const extra: FilePendingAtt[] = paths.map((path) => ({
        key: nextPendingKey(),
        originalName: path.replace(/^.*[/\\]/, "") || "file",
        size: 0,
        filePath: path,
      }));
      setEditor({ ...editor, pending: [...editor.pending, ...extra] });
    } catch (e) {
      setErr(errMessage(e));
    }
  }

  function acceptPickedFile(file: File) {
    acceptPickedFiles([file]);
  }

  function acceptPickedFiles(files: File[]) {
    if (writesLocked || !files.length) return;
    const over = files.find((f) => f.size > FILE_PER_FILE_LIMIT_BYTES);
    if (over) {
      setErr(i18n.t("files.overLimit"));
      return;
    }
    void Promise.all(files.map((file) => file.arrayBuffer().then((buf) => ({ file, buf })))).then((items) => {
      const extra: FilePendingAtt[] = items.map(({ file, buf }) => ({
        key: nextPendingKey(),
        originalName: file.name || "file",
        size: file.size,
        fileBytes: new Uint8Array(buf),
      }));
      setEditor((cur) => {
        if (cur) return { ...cur, pending: [...cur.pending, ...extra] };
        return {
          name: extra[0].originalName,
          kept: [],
          pending: extra,
          group: defaultGroup(),
        };
      });
    });
  }

  async function persistGroupsIfNeeded(nextGroup?: string) {
    const created = appendGroupIfNew(groups, nextGroup);
    if (created) {
      await api.fileSaveGroups(created);
      setGroups(created);
      return resolveGroupName(created, nextGroup);
    }
    return resolveGroupName(groups, nextGroup);
  }

  async function saveFileMeta(meta: FileEditState) {
    const name = meta.name.trim();
    if (!name) {
      setErr(i18n.t("files.needName"));
      return;
    }
    if (!editorHasAttachment(meta)) {
      setErr(i18n.t("files.needOneAttachment"));
      return;
    }
    if (editorOversize(meta)) {
      setErr(i18n.t("files.overLimit"));
      return;
    }
    setBusy(true);
    try {
      const nextGroup = await persistGroupsIfNeeded(meta.group);
      const args = { name, note: meta.note?.trim() || undefined, group: nextGroup };
      const addPaths = meta.pending.map((p) => p.filePath).filter((p): p is string => !!p);
      const addBytes = meta.pending
        .filter((p) => p.fileBytes && !p.filePath)
        .map((p) => ({ originalName: p.originalName, bytes: Array.from(p.fileBytes!) }));
      if (meta.id) {
        await api.fileUpdate(meta.id, {
          ...args,
          icon: meta.icon,
          keepAttachmentIds: meta.kept.map((a) => a.id),
          addPaths: addPaths.length ? addPaths : undefined,
          addBytes: addBytes.length ? addBytes : undefined,
        });
      } else if (addPaths.length && !addBytes.length) {
        await api.fileAddFromPaths(addPaths, args);
      } else if (addBytes.length && !addPaths.length) {
        await api.fileAddBytesMany(addBytes, args);
      } else if (addPaths.length && addBytes.length) {
        const created = await api.fileAddFromPaths(addPaths, args);
        await api.fileUpdate(created.id, {
          keepAttachmentIds: entryAttachments(created).map((a) => a.id),
          addBytes,
        });
      } else {
        setErr(i18n.t("files.needOneAttachment"));
        return;
      }
      setEditor(null);
      await load();
      showAppToast(meta.id ? i18n.t("files.toastUpdated") : i18n.t("files.toastAdded"));
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function deleteFile(id: string) {
    setBusy(true);
    try {
      await api.fileDelete(id);
      setPendingDelete(null);
      setSheetEntry(null);
      await load();
      showAppToast(i18n.t("files.toastDeleted"));
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function exportFile(entry: FileEntry, attachment?: FileAttachment) {
    const atts = entryAttachments(entry);
    if (atts.length === 0) {
      setErr(i18n.t("files.noExport"));
      return;
    }
    if (!attachment && atts.length > 1) {
      setExportPick(entry);
      return;
    }
    const att = attachment || atts[0];
    try {
      const dest = await save({ defaultPath: att.originalName || entry.name });
      if (!dest) return;
      setExportingId(entry.id);
      const ok = await withAuth((pw) => api.fileExport(entry.id, dest, pw, att.id));
      if (ok !== undefined) {
        showAppToast(i18n.t("files.toastExported", { path: dest }));
        setSheetEntry(null);
        setExportPick(null);
      }
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setExportingId(null);
    }
  }

  async function saveGroup(name: string, color: string | null) {
    const next = [...groups, { name, color, sortOrder: groups.length }];
    await api.fileSaveGroups(next);
    setGroups(next);
    setGroup(name);
    setGroupDlg(false);
  }

  return {
    writesLocked,
    entries,
    groups,
    usageBytes,
    totalCount,
    q,
    setQ,
    group,
    setGroup,
    viewMode,
    setViewMode,
    sortBy,
    sortOrder,
    setSort,
    editor,
    setEditor,
    pendingDelete,
    setPendingDelete,
    exportingId,
    reauth,
    reauthCancel,
    err,
    setErr,
    busy,
    revealCfg,
    filteredEntries,
    tabs,
    groupDlg,
    setGroupDlg,
    sheetEntry,
    setSheetEntry,
    exportPick,
    setExportPick,
    searchRef,
    load,
    startUpload,
    pickMoreFiles,
    acceptPickedFile,
    acceptPickedFiles,
    saveFileMeta,
    deleteFile,
    exportFile,
    saveGroup,
    withAuth,
  };
}

export type FilesModel = ReturnType<typeof useFilesModel>;
