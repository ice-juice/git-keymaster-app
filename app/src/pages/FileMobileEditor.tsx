import { useRef } from "react";
import {
  ChevronLeft,
  File,
  FileText,
  FolderLock,
  Plus,
  Trash2,
  Check,
  AlertCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { GroupPicker } from "../ui/GroupPicker";
import {
  editorAttachments,
  editorHasAttachment,
  editorOversize,
  formatBytes,
  type FileEditState,
  type FilesModel,
} from "../shared/hooks/useFilesModel";
import { useOverlayBack } from "../shared/mobileBack";

export function FileMobileEditor({
  m,
  onClose,
}: {
  m: FilesModel;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const addRef = useRef<HTMLInputElement>(null);
  const editor = m.editor;

  useOverlayBack(!!editor, onClose);

  if (!editor) return null;

  const atts = editorAttachments(editor);
  const empty = !editorHasAttachment(editor);
  const oversize = editorOversize(editor);
  const canSave = !!editor.name.trim() && !oversize && !m.busy && !empty && !m.writesLocked;
  const isEditing = !!editor.id;

  function patch(p: Partial<FileEditState>) {
    m.setEditor((prev) => (prev ? { ...prev, ...p } : null));
  }

  function removeAtt(key: string) {
    if (!editor) return;
    patch({
      kept: editor.kept.filter((a) => a.id !== key),
      pending: editor.pending.filter((a) => a.key !== key),
    });
  }

  return (
    <div className="m-subpage-stage">
      {/* 隐藏的附件选择 input */}
      <input
        ref={addRef}
        type="file"
        hidden
        multiple
        onChange={(e) => {
          const files = [...(e.target.files || [])];
          e.target.value = "";
          if (files.length) m.acceptPickedFiles(files);
        }}
      />

      {/* 1. 顶部导航栏 */}
      <header className="m-subpage-nav">
        <button
          type="button"
          className="m-subpage-nav-back"
          aria-label={t("common.back")}
          onClick={onClose}
        >
          <ChevronLeft size={22} />
          <span>{t("common.back")}</span>
        </button>

        <h1 className="m-subpage-nav-title">
          {isEditing ? t("files.editTitle") : t("files.uploadTitle")}
        </h1>

        <button
          type="button"
          className="m-subpage-nav-save"
          disabled={!canSave}
          onClick={() => void m.saveFileMeta(editor)}
        >
          <Check size={15} />
          <span>
            {m.busy
              ? t("files.saving")
              : isEditing
                ? t("files.save")
                : t("files.encryptIn")}
          </span>
        </button>
      </header>

      {/* 2. 表单内容主滚动区 */}
      <main className="m-subpage-content">
        {/* 卡片 1: 标题与分组 */}
        <section className="m-form-card">
          <div className="m-form-card-title">
            <div className="row" style={{ gap: 6 }}>
              <FolderLock size={15} style={{ color: "var(--accent)" }} />
              <span>{t("files.customName")} & {t("files.group")}</span>
            </div>
          </div>

          <div className="m-field">
            <label className="m-field-label">{t("files.customName")}</label>
            <input
              className="input"
              autoFocus={!isEditing}
              value={editor.name}
              placeholder={t("files.customName")}
              onFocus={(e) => {
                const n = editor.name;
                const dot = n.lastIndexOf(".");
                if (dot > 0) e.currentTarget.setSelectionRange(0, dot);
                else e.currentTarget.select();
              }}
              onChange={(e) => patch({ name: e.target.value })}
            />
            <div className="m-field-hint">{t("files.customNameTip")}</div>
          </div>

          <div className="m-field">
            <label className="m-field-label">{t("files.group")}</label>
            <GroupPicker
              groups={m.groups}
              value={editor.group}
              onChange={(name) => patch({ group: name || undefined })}
              onReorder={m.writesLocked ? undefined : m.reorderGroups}
            />
          </div>
        </section>

        {/* 卡片 2: 附件清单 */}
        <section className="m-form-card">
          <div className="m-form-card-title">
            <div className="row" style={{ gap: 6 }}>
              <File size={15} style={{ color: "var(--accent)" }} />
              <span>{t("files.attachments")}</span>
            </div>
            <span className="badge info">
              {t("files.fileCount", { n: atts.length })}
            </span>
          </div>

          <div className="stack" style={{ gap: 8 }}>
            {atts.length === 0 ? (
              <div
                className="muted"
                style={{
                  padding: "16px",
                  textAlign: "center",
                  background: "var(--gray-soft)",
                  borderRadius: "12px",
                  fontSize: "13px",
                }}
              >
                {t("files.needOneAttachment")}
              </div>
            ) : (
              atts.map((a) => (
                <div key={a.key} className="m-att-item">
                  <div className="m-att-info">
                    <div className="m-att-name" title={a.originalName}>
                      {a.originalName}
                    </div>
                    <div className="m-att-meta">
                      {a.size > 0 ? formatBytes(a.size) : t("files.sizeOnSave")}
                      {a.existing ? "" : ` · ${t("files.pendingAdd")}`}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="m-att-del-btn"
                    disabled={m.busy}
                    aria-label={t("files.removeAttachment")}
                    onClick={() => removeAtt(a.key)}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))
            )}

            <button
              type="button"
              className="btn sm"
              style={{ width: "100%", justifyContent: "center", minHeight: 40, marginTop: 4 }}
              disabled={m.busy || m.writesLocked}
              onClick={() => addRef.current?.click()}
            >
              <Plus size={15} />
              <span>{t("files.addFiles")}</span>
            </button>

            {empty && (
              <div className="callout danger sm" style={{ margin: "4px 0 0" }}>
                <AlertCircle size={14} />
                <span>{t("files.needOneAttachment")}</span>
              </div>
            )}
            {oversize && (
              <div className="callout danger sm" style={{ margin: "4px 0 0" }}>
                <AlertCircle size={14} />
                <span>{t("files.overLimit")}</span>
              </div>
            )}
          </div>
        </section>

        {/* 卡片 3: 备注信息 */}
        <section className="m-form-card">
          <div className="m-form-card-title">
            <div className="row" style={{ gap: 6 }}>
              <FileText size={15} style={{ color: "var(--accent)" }} />
              <span>{t("files.note")}</span>
            </div>
          </div>

          <div className="m-field">
            <textarea
              className="input"
              rows={3}
              placeholder={t("files.notePlaceholder")}
              value={editor.note || ""}
              onChange={(e) => patch({ note: e.target.value })}
              style={{ minHeight: 70 }}
            />
          </div>
        </section>

        {/* 卡片 4: 危险操作 (仅在编辑现有文件时展示) */}
        {isEditing && (
          <section className="m-form-card" style={{ marginTop: 4 }}>
            <button
              type="button"
              className="m-danger-btn"
              disabled={m.writesLocked || m.busy}
              onClick={() => {
                onClose();
                const currentEntry = m.entries.find((e) => e.id === editor.id);
                if (currentEntry) {
                  m.setPendingDelete(currentEntry);
                }
              }}
            >
              <Trash2 size={16} />
              <span>{t("files.delete")}</span>
            </button>
          </section>
        )}
      </main>
    </div>
  );
}
