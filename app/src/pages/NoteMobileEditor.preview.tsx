import { useMemo, useRef, useState } from "react";
import { NoteMobileEditor } from "./NoteMobileEditor";
import type { NoteDraftState, NotesModel } from "../shared/hooks/useNotesModel";
import type { NoteMarkdownEditorHandle } from "../ui/NoteMarkdownEditor";

const SAMPLE_MD = `# 目录绑定

绑定发送目录到程序中，使用别名和备注进行管理以便后续检索。这是一段没有回车的长句，用来检查软折行：光标掉到下一视觉行时，源码里仍是同一行，预览也不该被当成已经回车。

把指定的接收目录绑定到程序中，并使用别名、备注描述来分组管理，方便后续分发视频时快速选择
文件管理和记录功能
（1）以视频的剧集命名为基本单位，记录当前发送目录历史下载在册的剧集目录清单
（2）当用户从发送目录把指定剧集分发到某一接收目录时，需要记录这一操作，并记录接收目录接收过的剧集清单。

自动扫描接收目录，监控剧集的预处理进度

在程序中有一个监控界面，罗列所有已绑定的接收目录，然后根据是否生成的特定文件来处理。
`;

/** 仅开发期网页预览：不连保险库，方便审查移动端编辑区。 */
export function NoteMobileEditorPreview() {
  const editorRef = useRef<NoteMarkdownEditorHandle | null>(null);
  const [draft, setDraft] = useState<NoteDraftState>({
    id: "preview",
    title: "开发内容",
    markdown: SAMPLE_MD,
    group: "工作",
    tags: ["程序猿", "技术"],
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
        {/* 仿真系统状态栏：展示时间与网络图标，直观验证是否被遮挡 */}
        <div className="note-preview-system-statusbar" aria-hidden="true">
          <span className="sys-time">09:41</span>
          <div className="sys-icons">
            <span>5G</span>
            <span className="sys-battery">100%</span>
          </div>
        </div>

        <div className="notes-mobile-detail" data-preview="notes">
          <NoteMobileEditor m={m} onInsertImage={() => {}} onBack={() => {}} />
        </div>

        {/* 仿真系统虚拟导航栏 / 手势指示条：在底部安全区留白内展示，绝不压盖操作按钮 */}
        <div className="note-preview-system-navbar" aria-hidden="true">
          <span className="sys-home-indicator" />
        </div>
      </div>
    </div>
  );
}
