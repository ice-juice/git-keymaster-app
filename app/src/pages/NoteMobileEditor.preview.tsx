import { useMemo, useRef, useState } from "react";
import { NoteMobileEditor } from "./NoteMobileEditor";
import type { NoteDraftState, NotesModel } from "../shared/hooks/useNotesModel";
import type { NoteMarkdownEditorHandle } from "../ui/NoteMarkdownEditor";

const SAMPLE_MD = `**操作步骤（图形界面）**：

1. 运行 wf.msc 打开「高级安全 Windows 防火墙」
2. 在左侧选择「入站规则」，点击「新建规则」
3. 协议类型选择 TCP，指定本地端口
4. 允许连接，并把规则应用到所有网络位置

完成后可用 \`Get-NetFirewallRule\` 核对规则是否生效。
`;

/** 仅开发期网页预览：不连保险库，方便审查移动端编辑区。 */
export function NoteMobileEditorPreview() {
  const editorRef = useRef<NoteMarkdownEditorHandle | null>(null);
  const [draft, setDraft] = useState<NoteDraftState>({
    id: "preview",
    title: "Windows防火墙配置",
    markdown: SAMPLE_MD,
    group: "研究",
    tags: ["windows"],
    pinned: false,
  });
  const [mobileTab, setMobileTab] = useState<"edit" | "preview">("edit");
  const [isDirty, setIsDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const m = useMemo(() => {
    const model = {
      draft,
      isDirty,
      saving,
      writesLocked: false,
      mobileTab,
      setMobileTab,
      editorRef,
      groups: [
        { name: "研究", color: "#4f46e5", sortOrder: 0 },
        { name: "工作", color: "#0d9488", sortOrder: 1 },
      ],
      activeNote: {
        id: "preview",
        title: draft.title,
        excerpt: "",
        group: draft.group,
        tags: draft.tags,
        pinned: draft.pinned,
        updatedAt: new Date().toISOString(),
        sortOrder: 0,
      },
      offlineDraft: null,
      updateDraft(patch: Partial<NoteDraftState>) {
        setDraft((prev) => ({ ...prev, ...patch }));
        setIsDirty(true);
      },
      async saveCurrentNote() {
        setSaving(true);
        await new Promise((r) => setTimeout(r, 280));
        setSaving(false);
        setIsDirty(false);
      },
      onEditorFocusLeave() {},
      insertAtCursor(text: string) {
        editorRef.current?.insertAtCursor(text);
        setIsDirty(true);
      },
      wrapSelection(before: string, after?: string) {
        editorRef.current?.wrapSelection(before, after);
        setIsDirty(true);
      },
      formatUpdatedAt() {
        return "刚刚";
      },
      async togglePin() {
        setDraft((prev) => ({ ...prev, pinned: !prev.pinned }));
        setIsDirty(true);
      },
      openExport() {},
      setPendingDelete() {},
      setGroupDlg() {},
    };
    return model as unknown as NotesModel;
  }, [draft, isDirty, saving, mobileTab]);

  return (
    <div className="note-preview-phone-stage">
      <div className="note-preview-phone" aria-label="390×844 手机预览">
        <div className="notes-mobile-detail" data-preview="notes">
          <NoteMobileEditor m={m} onInsertImage={() => {}} onBack={() => {}} />
        </div>
      </div>
    </div>
  );
}
