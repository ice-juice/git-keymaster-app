import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { api, errMessage, type GroupMeta, type NoteEntry } from "../../lib/ipc";
import { resolvePlatform } from "../../platform/resolve";
import { appendGroupIfNew, resolveGroupName } from "../../ui/GroupPicker";
import type { NoteMarkdownEditorHandle } from "../../ui/NoteMarkdownEditor";
import { showAppToast } from "../../ui/Toast";
import { i18n } from "../../lib/i18n";
import { useApp } from "../../store";
import { formatUpdatedAt } from "./useFilesModel";

export interface NoteDraftState {
  id?: string;
  title: string;
  markdown: string;
  group?: string;
  tags: string[];
  icon?: string;
  pinned: boolean;
}

export type NotesViewLayout = "split" | "edit" | "preview";
export type NotesMobileTab = "edit" | "preview";

const LAYOUT_KEY = "km.notes.viewLayout";
const DRAFT_PREFIX = "km.notes.draft.";

function emptyDraft(): NoteDraftState {
  return { title: "", markdown: "", tags: [], pinned: false };
}

function readLayout(): NotesViewLayout {
  try {
    const v = localStorage.getItem(LAYOUT_KEY);
    if (v === "edit" || v === "preview" || v === "split") return v;
  } catch {
    /* ignore */
  }
  return "split";
}

function draftKey(id?: string) {
  return `${DRAFT_PREFIX}${id || "new"}`;
}

function readOfflineDraft(id?: string): { draft: NoteDraftState; savedAt: string } | null {
  try {
    const raw = localStorage.getItem(draftKey(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { draft: NoteDraftState; savedAt: string };
    if (!parsed?.draft) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeOfflineDraft(draft: NoteDraftState) {
  try {
    localStorage.setItem(draftKey(draft.id), JSON.stringify({ draft, savedAt: new Date().toISOString() }));
  } catch {
    /* ignore */
  }
}

function clearOfflineDraft(id?: string) {
  try {
    localStorage.removeItem(draftKey(id));
  } catch {
    /* ignore */
  }
}

function haystack(e: NoteEntry): string {
  return [e.title, e.group, e.excerpt, ...(e.tags || [])].filter(Boolean).join(" ").toLowerCase();
}

export function extractKmassetHashes(md: string): string[] {
  const out: string[] = [];
  const needle = "kmasset://";
  let i = 0;
  while (i < md.length) {
    const at = md.indexOf(needle, i);
    if (at < 0) break;
    const hash = md.slice(at + needle.length, at + needle.length + 64).toLowerCase();
    if (/^[0-9a-f]{64}$/.test(hash) && !out.includes(hash)) out.push(hash);
    i = at + needle.length + 64;
  }
  return out;
}

export function useNotesModel() {
  const { writesLocked } = useApp();
  const [entries, setEntries] = useState<NoteEntry[]>([]);
  const [groups, setGroups] = useState<GroupMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeBody, setActiveBody] = useState("");
  const [draft, setDraft] = useState<NoteDraftState>(emptyDraft);
  const [q, setQ] = useState("");
  const [group, setGroup] = useState("全部");
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [viewLayout, setViewLayoutState] = useState<NotesViewLayout>(readLayout);
  const [mobileTab, setMobileTab] = useState<NotesMobileTab>("edit");
  const [saving, setSaving] = useState(false);
  const [assetUploading, setAssetUploading] = useState(false);
  const [exportModal, setExportModal] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<NoteEntry | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [groupDlg, setGroupDlg] = useState(false);
  const [offlineDraft, setOfflineDraft] = useState<{ draft: NoteDraftState; savedAt: string } | null>(null);
  const [leaveConfirm, setLeaveConfirm] = useState<null | (() => void)>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const editorRef = useRef<NoteMarkdownEditorHandle | null>(null);
  const savedRef = useRef({ title: "", markdown: "", group: undefined as string | undefined, tags: [] as string[], pinned: false });
  const autosaveTimer = useRef<number | null>(null);
  const draftTimer = useRef<number | null>(null);

  const load = useCallback(async () => {
    const data = await api.noteList();
    setEntries(data.entries);
    setGroups(data.groups);
  }, []);

  useEffect(() => {
    load().catch((e) => setErr(errMessage(e)));
  }, [load]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) for (const t of e.tags || []) if (t.trim()) set.add(t.trim());
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [entries]);

  const tabs = useMemo(() => ["全部", ...groups.map((g) => g.name), "未分组"], [groups]);

  const filteredEntries = useMemo(() => {
    const words = q.trim().toLowerCase().split(/[\s,，\t]+/).filter(Boolean);
    const list = entries.filter((e) => {
      if (group !== "全部" && (e.group || "未分组") !== group) return false;
      if (selectedTag && !(e.tags || []).includes(selectedTag)) return false;
      if (!words.length) return true;
      const blob = haystack(e);
      return words.every((w) => blob.includes(w));
    });
    list.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
    return list;
  }, [entries, q, group, selectedTag]);

  const activeNote = entries.find((e) => e.id === activeId) || null;
  const isDirty =
    draft.title !== savedRef.current.title ||
    draft.markdown !== savedRef.current.markdown ||
    (draft.group || "") !== (savedRef.current.group || "") ||
    draft.pinned !== savedRef.current.pinned ||
    draft.tags.join("\u0001") !== savedRef.current.tags.join("\u0001");

  function rememberSaved(next: NoteDraftState) {
    savedRef.current = {
      title: next.title,
      markdown: next.markdown,
      group: next.group,
      tags: [...next.tags],
      pinned: next.pinned,
    };
  }

  function setViewLayout(v: NotesViewLayout) {
    setViewLayoutState(v);
    try {
      localStorage.setItem(LAYOUT_KEY, v);
    } catch {
      /* ignore */
    }
  }

  function updateDraft(patch: Partial<NoteDraftState>) {
    setDraft((prev) => ({ ...prev, ...patch }));
  }

  useEffect(() => {
    if (draftTimer.current) window.clearTimeout(draftTimer.current);
    draftTimer.current = window.setTimeout(() => {
      if (isDirty) writeOfflineDraft(draft);
    }, 1000);
    return () => {
      if (draftTimer.current) window.clearTimeout(draftTimer.current);
    };
  }, [draft, isDirty]);

  const saveCurrentNote = useCallback(async () => {
    if (writesLocked) return;
    setSaving(true);
    try {
      const created = appendGroupIfNew(groups, draft.group);
      if (created) {
        await api.noteSaveGroups(created);
        setGroups(created);
      }
      const groupName = resolveGroupName(created || groups, draft.group);
      const saved = await api.noteUpsert({
        id: draft.id,
        title: draft.title,
        format: "markdown",
        tags: draft.tags,
        group: groupName,
        pinned: draft.pinned,
        markdown: draft.markdown,
      });
      const next = { ...draft, id: saved.id, group: groupName };
      setDraft(next);
      rememberSaved(next);
      setActiveId(saved.id);
      setActiveBody(draft.markdown);
      clearOfflineDraft(draft.id);
      if (saved.id !== draft.id) clearOfflineDraft(saved.id);
      await load();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setSaving(false);
    }
  }, [draft, groups, load, writesLocked]);

  useEffect(() => {
    if (!isDirty || writesLocked) return;
    if (autosaveTimer.current) window.clearTimeout(autosaveTimer.current);
    autosaveTimer.current = window.setTimeout(() => {
      void saveCurrentNote();
    }, 1500);
    return () => {
      if (autosaveTimer.current) window.clearTimeout(autosaveTimer.current);
    };
  }, [isDirty, draft, saveCurrentNote, writesLocked]);

  async function selectNote(id: string | null) {
    if (id === activeId && (id !== null || !detailOpen)) return;
    const go = async () => {
      setOfflineDraft(null);
      setLeaveConfirm(null);
      if (!id) {
        setActiveId(null);
        setDetailOpen(false);
        const d = emptyDraft();
        setDraft(d);
        setActiveBody("");
        rememberSaved(d);
        return;
      }
      setBusy(true);
      try {
        const body = await api.noteGetBody(id);
        const entry = entries.find((e) => e.id === id);
        const d: NoteDraftState = {
          id,
          title: entry?.title || "",
          markdown: body.markdown,
          group: entry?.group || undefined,
          tags: entry?.tags || [],
          pinned: entry?.pinned || false,
        };
        setActiveId(id);
        setDetailOpen(true);
        setActiveBody(body.markdown);
        setDraft(d);
        rememberSaved(d);
        const cached = readOfflineDraft(id);
        if (cached && cached.savedAt > (entry?.updatedAt || "") && cached.draft.markdown !== body.markdown) {
          setOfflineDraft(cached);
        }
      } catch (e) {
        setErr(errMessage(e));
      } finally {
        setBusy(false);
      }
    };
    if (isDirty) {
      setLeaveConfirm(() => go);
      return;
    }
    await go();
  }

  function createNote() {
    const open = () => {
      setLeaveConfirm(null);
      const d = emptyDraft();
      setActiveId(null);
      setDraft(d);
      setActiveBody("");
      rememberSaved(d);
      setDetailOpen(true);
      setMobileTab("edit");
      const cached = readOfflineDraft();
      setOfflineDraft(cached);
    };
    if (isDirty && detailOpen) {
      setLeaveConfirm(() => open);
      return;
    }
    open();
  }

  function restoreOfflineDraft() {
    if (!offlineDraft) return;
    setDraft(offlineDraft.draft);
    setOfflineDraft(null);
  }

  function discardOfflineDraft() {
    clearOfflineDraft(draft.id);
    setOfflineDraft(null);
  }

  function insertAtCursor(text: string) {
    if (editorRef.current) {
      editorRef.current.insertAtCursor(text);
      return;
    }
    updateDraft({ markdown: `${draft.markdown}${draft.markdown.endsWith("\n") || !draft.markdown ? "" : "\n"}${text}` });
  }

  function wrapSelection(before: string, after = before) {
    if (editorRef.current) {
      editorRef.current.wrapSelection(before, after);
      return;
    }
    updateDraft({ markdown: `${before}${draft.markdown}${after}` });
  }

  async function persistGroupsIfNeeded(nextGroup?: string) {
    const created = appendGroupIfNew(groups, nextGroup);
    if (created) {
      await api.noteSaveGroups(created);
      setGroups(created);
      return resolveGroupName(created, nextGroup);
    }
    return resolveGroupName(groups, nextGroup);
  }

  async function uploadAndInsertAsset(file?: { name?: string; bytes?: Uint8Array; path?: string }) {
    if (writesLocked) return null;
    setAssetUploading(true);
    try {
      let path = file?.path;
      let bytes = file?.bytes ? Array.from(file.bytes) : undefined;
      if (!path && !bytes) {
        if (resolvePlatform() === "mobile") return null;
        const selected = await open({
          multiple: false,
          directory: false,
          filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
        });
        if (!selected || Array.isArray(selected)) return null;
        path = selected;
      }
      const { hash } = await api.noteAssetAdd({ path, bytes });
      insertAtCursor(`![](kmasset://${hash})`);
      return hash;
    } catch (e) {
      setErr(errMessage(e));
      return null;
    } finally {
      setAssetUploading(false);
    }
  }

  async function deleteNote(id: string) {
    setBusy(true);
    try {
      await api.noteDelete(id);
      setPendingDelete(null);
      clearOfflineDraft(id);
      if (activeId === id) {
        setActiveId(null);
        const d = emptyDraft();
        setDraft(d);
        setActiveBody("");
        rememberSaved(d);
        setDetailOpen(false);
      }
      await load();
      showAppToast(i18n.t("notes.toastDeleted"));
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function togglePin(id: string) {
    const entry = entries.find((e) => e.id === id);
    if (!entry || writesLocked) return;
    try {
      const body = id === draft.id ? draft.markdown : (await api.noteGetBody(id)).markdown;
      await api.noteUpsert({
        id,
        title: entry.title,
        format: "markdown",
        tags: entry.tags,
        group: entry.group || undefined,
        pinned: !entry.pinned,
        markdown: body,
      });
      if (draft.id === id) updateDraft({ pinned: !entry.pinned });
      await load();
    } catch (e) {
      setErr(errMessage(e));
    }
  }

  async function exportNote(mode: "md_raw" | "md_inline") {
    if (!draft.id) return;
    try {
      const dest = await save({
        defaultPath: `${(draft.title || "note").replace(/[\\/:*?"<>|]/g, "_")}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!dest) return;
      await api.noteExport(draft.id, dest, mode);
      setExportModal(false);
      showAppToast(i18n.t("notes.toastExported", { path: dest }));
    } catch (e) {
      setErr(errMessage(e));
    }
  }

  async function saveGroup(name: string, color: string | null) {
    const next = [...groups, { name, color, sortOrder: groups.length }];
    await api.noteSaveGroups(next);
    setGroups(next);
    setGroup(name);
    setGroupDlg(false);
  }

  async function confirmLeave(saveFirst: boolean) {
    const go = leaveConfirm;
    setLeaveConfirm(null);
    if (saveFirst) await saveCurrentNote();
    else rememberSaved(draft);
    await go?.();
  }

  return {
    writesLocked,
    entries,
    groups,
    allTags,
    activeId,
    activeNote,
    activeBody,
    draft,
    isDirty,
    saving,
    q,
    setQ,
    group,
    setGroup,
    selectedTag,
    setSelectedTag,
    viewLayout,
    setViewLayout,
    mobileTab,
    setMobileTab,
    assetUploading,
    exportModal,
    setExportModal,
    pendingDelete,
    setPendingDelete,
    err,
    setErr,
    busy,
    filteredEntries,
    tabs,
    groupDlg,
    setGroupDlg,
    offlineDraft,
    leaveConfirm,
    setLeaveConfirm,
    detailOpen,
    editorRef,
    load,
    selectNote,
    createNote,
    updateDraft,
    saveCurrentNote,
    deleteNote,
    togglePin,
    uploadAndInsertAsset,
    exportNote,
    insertAtCursor,
    wrapSelection,
    saveGroup,
    persistGroupsIfNeeded,
    restoreOfflineDraft,
    discardOfflineDraft,
    confirmLeave,
    formatUpdatedAt,
  };
}

export type NotesModel = ReturnType<typeof useNotesModel>;
