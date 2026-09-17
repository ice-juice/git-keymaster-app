import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { api, errMessage, type GroupMeta, type NoteEntry } from "../../lib/ipc";
import { markdownToPdfBytes } from "../../lib/notePdf";
import { resolvePlatform } from "../../platform/resolve";
import { appendGroupIfNew, resolveGroupName } from "../../ui/GroupPicker";
import type { NoteMarkdownEditorHandle } from "../../ui/NoteMarkdownEditor";
import { showAppToast } from "../../ui/Toast";
import { i18n } from "../../lib/i18n";
import { useApp } from "../../store";
import { getNotesAutoSave } from "../../lib/prefs";
import { formatUpdatedAt } from "./useFilesModel";
import * as noteDrafts from "../noteDrafts";

export type NoteExportFormat = "md_raw" | "md_inline" | "pdf";
export type NoteExportScope = "selected" | "filtered";

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

function readOfflineDraft(id?: string): { draft: NoteDraftState; savedAt: string } | null {
  return noteDrafts.readDraft<NoteDraftState>(id);
}

function writeOfflineDraft(draft: NoteDraftState) {
  noteDrafts.writeDraft(draft.id, draft);
}

function clearOfflineDraft(id?: string) {
  noteDrafts.clearDraft(id);
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

function safeExportStem(title: string): string {
  const s = title.trim().replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").slice(0, 80);
  return s || "note";
}

function uniqueExportName(title: string, ext: string, used: Set<string>): string {
  const stem = safeExportStem(title);
  let name = `${stem}.${ext}`;
  let n = 2;
  while (used.has(name.toLowerCase())) {
    name = `${stem} (${n}).${ext}`;
    n += 1;
  }
  used.add(name.toLowerCase());
  return name;
}

function joinExportPath(dir: string, file: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.endsWith("/") || dir.endsWith("\\") ? `${dir}${file}` : `${dir}${sep}${file}`;
}

async function writeNoteExport(entry: NoteEntry, dest: string, format: NoteExportFormat) {
  if (format === "pdf") {
    const markdown = await api.noteExportContent(entry.id, "md_inline");
    const pdf = await markdownToPdfBytes(entry.title.trim() || "note", markdown);
    await api.noteWriteExportFile(dest, Array.from(pdf));
    return;
  }
  await api.noteExport(entry.id, dest, format);
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
  const draftTimer = useRef<number | null>(null);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const draftRef = useRef<NoteDraftState>(draft);
  const saveGenRef = useRef(0);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [exporting, setExporting] = useState(false);
  const skipNextOpenRef = useRef(false);
  draftRef.current = draft;

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

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedCount = useMemo(
    () => filteredEntries.reduce((n, e) => n + (selectedSet.has(e.id) ? 1 : 0), 0),
    [filteredEntries, selectedSet],
  );
  const allFilteredSelected = filteredEntries.length > 0 && selectedCount === filteredEntries.length;

  useEffect(() => {
    const live = new Set(entries.map((e) => e.id));
    setSelectedIds((prev) => {
      const next = prev.filter((id) => live.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [entries]);

  const activeNote = entries.find((e) => e.id === activeId) || null;
  const isDirty =
    draft.title !== savedRef.current.title ||
    draft.markdown !== savedRef.current.markdown ||
    (draft.group || "") !== (savedRef.current.group || "") ||
    draft.pinned !== savedRef.current.pinned ||
    draft.tags.join("\u0001") !== savedRef.current.tags.join("\u0001");
  dirtyRef.current = isDirty;
  savingRef.current = saving;

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
    setDraft((prev) => {
      const next = { ...prev, ...patch };
      draftRef.current = next;
      return next;
    });
  }

  function liveDraft(): NoteDraftState {
    const current = draftRef.current;
    const markdown = editorRef.current?.getMarkdown();
    if (markdown === undefined || markdown === current.markdown) return current;
    const next = { ...current, markdown };
    draftRef.current = next;
    return next;
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
    if (writesLocked || savingRef.current) return;
    const snapshot = liveDraft();
    const gen = ++saveGenRef.current;
    savingRef.current = true;
    setSaving(true);
    try {
      const created = appendGroupIfNew(groups, snapshot.group);
      if (created) {
        await api.noteSaveGroups(created);
        if (gen !== saveGenRef.current) return;
        setGroups(created);
      }
      const groupName = resolveGroupName(created || groups, snapshot.group);
      const saved = await api.noteUpsert({
        id: snapshot.id,
        title: snapshot.title,
        format: "markdown",
        tags: snapshot.tags,
        group: groupName,
        pinned: snapshot.pinned,
        markdown: snapshot.markdown,
      });
      if (gen !== saveGenRef.current) return;
      const latest = liveDraft();
      const next = {
        ...latest,
        id: saved.id,
        group: groupName,
      };
      draftRef.current = next;
      setDraft(next);
      const stillSame =
        latest.title === snapshot.title &&
        latest.markdown === snapshot.markdown &&
        (latest.group || "") === (snapshot.group || "") &&
        latest.pinned === snapshot.pinned &&
        latest.tags.join("\u0001") === snapshot.tags.join("\u0001");
      if (stillSame) rememberSaved(next);
      setActiveId(saved.id);
      setActiveBody(stillSame ? snapshot.markdown : latest.markdown);
      clearOfflineDraft(snapshot.id);
      if (saved.id !== snapshot.id) clearOfflineDraft(saved.id);
      await load();
    } catch (e) {
      if (gen === saveGenRef.current) setErr(errMessage(e));
    } finally {
      if (gen === saveGenRef.current) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  }, [groups, load, writesLocked]);

  const onEditorFocusLeave = useCallback(() => {
    if (!getNotesAutoSave() || writesLocked || savingRef.current || !dirtyRef.current) return;
    if (editorRef.current?.isComposing()) return;
    void saveCurrentNote();
  }, [saveCurrentNote, writesLocked]);

  async function selectNote(id: string | null) {
    if (id === activeId && (id !== null || !detailOpen)) return;
    const go = async () => {
      saveGenRef.current += 1;
      setOfflineDraft(null);
      setLeaveConfirm(null);
      if (!id) {
        setActiveId(null);
        setDetailOpen(false);
        const d = emptyDraft();
        draftRef.current = d;
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
        draftRef.current = d;
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
      saveGenRef.current += 1;
      setLeaveConfirm(null);
      const d = emptyDraft();
      setActiveId(null);
      draftRef.current = d;
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
    draftRef.current = offlineDraft.draft;
    setDraft(offlineDraft.draft);
    editorRef.current?.setMarkdown(offlineDraft.draft.markdown);
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
        saveGenRef.current += 1;
        setActiveId(null);
        const d = emptyDraft();
        draftRef.current = d;
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
      const nextPinned = !entry.pinned;
      if (draft.id === id) {
        updateDraft({ pinned: nextPinned });
        savedRef.current = { ...savedRef.current, pinned: nextPinned };
      }
      await load();
    } catch (e) {
      setErr(errMessage(e));
    }
  }

  function enterSelectionMode(id?: string) {
    setSelectionMode(true);
    if (id) {
      setSelectedIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    }
  }

  function exitSelectionMode() {
    setSelectionMode(false);
    setSelectedIds([]);
  }

  function markSkipNextOpen() {
    skipNextOpenRef.current = true;
  }

  function activateNote(id: string) {
    if (skipNextOpenRef.current) {
      skipNextOpenRef.current = false;
      return;
    }
    if (selectionMode) {
      toggleSelect(id);
      return;
    }
    void selectNote(id);
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function toggleSelectAllFiltered() {
    if (!selectionMode) return;
    if (allFilteredSelected) {
      const drop = new Set(filteredEntries.map((e) => e.id));
      setSelectedIds((prev) => prev.filter((id) => !drop.has(id)));
      return;
    }
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const e of filteredEntries) next.add(e.id);
      return [...next];
    });
  }

  function openExport() {
    setExportModal(true);
  }

  async function exportNotes(format: NoteExportFormat, scope: NoteExportScope) {
    const list =
      scope === "selected" ? filteredEntries.filter((e) => selectedSet.has(e.id)) : filteredEntries;
    if (!list.length) {
      setErr(i18n.t("notes.exportNeedNotes"));
      return;
    }
    setExporting(true);
    try {
      const used = new Set<string>();
      const names = list.map((e) => uniqueExportName(e.title, format === "pdf" ? "pdf" : "md", used));
      if (list.length === 1) {
        const dest = await save({
          defaultPath: names[0],
          filters:
            format === "pdf"
              ? [{ name: "PDF", extensions: ["pdf"] }]
              : [{ name: "Markdown", extensions: ["md"] }],
        });
        if (!dest) return;
        await writeNoteExport(list[0], dest, format);
        setExportModal(false);
        showAppToast(i18n.t("notes.toastExported", { path: dest }));
        return;
      }
      const dir = await open({ directory: true, multiple: false });
      if (!dir || Array.isArray(dir)) return;
      for (let i = 0; i < list.length; i++) {
        await writeNoteExport(list[i], joinExportPath(dir, names[i]), format);
      }
      setExportModal(false);
      showAppToast(i18n.t("notes.toastExportedMany", { n: list.length, path: dir }));
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setExporting(false);
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
    exporting,
    selectedIds,
    selectedSet,
    selectedCount,
    selectionMode,
    allFilteredSelected,
    enterSelectionMode,
    exitSelectionMode,
    markSkipNextOpen,
    activateNote,
    toggleSelect,
    toggleSelectAllFiltered,
    setExportModal,
    openExport,
    onEditorFocusLeave,
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
    exportNotes,
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
