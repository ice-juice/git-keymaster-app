import { useRef } from "react";
import { useOverlayBack } from "../shared/mobileBack";
import { Download, Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { resolvePlatform } from "../platform/resolve";
import { Badge, ConfirmDangerDialog, Empty, ErrorDialog, FieldLabel } from "../ui/common";
import { GroupManageDialogs, groupManageHandlers } from "../ui/GroupDialog";
import { GroupPicker } from "../ui/GroupPicker";
import { GroupTabs } from "../ui/GroupTabs";
import { ReauthDialog } from "../ui/ReauthDialog";
import {
  editorAttachments,
  editorHasAttachment,
  editorOversize,
  formatBytes,
  formatUpdatedAt,
  type FileEditState,
  type FilesModel,
} from "../shared/hooks/useFilesModel";
import { entryAttachments, type FileEntry } from "../lib/ipc";

function attachmentSummary(e: FileEntry, t: (key: string, opts?: Record<string, unknown>) => string) {
  const atts = entryAttachments(e);
  if (atts.length <= 1) return e.originalName;
  return t("files.fileCountSummary", { n: atts.length, names: atts.map((a) => a.originalName).join("、") });
}

function groupLabel(g: string, t: (key: string, opts?: Record<string, unknown>) => string) {
  if (g === "全部") return t("files.all");
  if (g === "未分组") return t("files.ungrouped");
  return g;
}

export function FilesFilters({ m, hideSearch }: { m: FilesModel; hideSearch?: boolean }) {
  const { t } = useTranslation();
  const manage = groupManageHandlers(m);
  return (
    <div className="group-filter-row">
      <GroupTabs
        value={m.group}
        onChange={m.setGroup}
        items={m.tabs.map((g) => ({
          key: g,
          label: groupLabel(g, t),
          count: g === "全部" ? m.entries.length : m.entries.filter((e) => (e.group || "未分组") === g).length,
          color: m.groups.find((item) => item.name === g)?.color,
          sortable: g !== "全部" && g !== "未分组",
        }))}
        onCreate={manage.onCreate}
        onEdit={manage.onEdit}
        onDelete={manage.onDelete}
        onReorder={m.writesLocked ? undefined : m.reorderGroups}
        createLabel={t("files.newGroup")}
        createDisabled={m.writesLocked}
      />
      {!hideSearch && (
        <input
          ref={m.searchRef}
          className="input"
          style={{ maxWidth: 280 }}
          placeholder={t("files.search")}
          value={m.q}
          onChange={(e) => m.setQ(e.target.value)}
        />
      )}
    </div>
  );
}

export function FileCard({ e, m }: { e: FileEntry; m: FilesModel }) {
  const { t } = useTranslation();
  const color = m.groups.find((g) => g.name === e.group)?.color;
  const summary = attachmentSummary(e, t);
  return (
    <div className="file-card" data-focus-id={e.id}>
      {e.group && (
        <div className="file-card-head">
          <Badge kind="info">
            {color && <span className="group-tab-dot" style={{ background: color, marginRight: 4 }} />}
            {e.group}
          </Badge>
        </div>
      )}
      <div className="file-card-name" title={e.name}>
        {e.name}
      </div>
      <div className="file-card-orig" title={summary}>
        {entryAttachments(e).length > 1 ? summary : t("files.originalPrefix", { name: e.originalName })}
      </div>
      <div className="file-card-meta">
        {formatBytes(e.size)} · {formatUpdatedAt(e.updatedAt)}
      </div>
      {e.note?.trim() && (
        <div className="file-card-note" title={e.note}>
          {e.note}
        </div>
      )}
      <div className="file-card-actions">
        <button type="button" className="btn sm primary" disabled={!!m.exportingId} onClick={() => void m.exportFile(e)}>
          <Download size={13} /> {t("files.actionExport")}
        </button>
        <button type="button" className="btn sm" disabled={m.writesLocked} onClick={() => m.setEditor(editFromEntry(e))}>
          <Pencil size={13} /> {t("files.actionEdit")}
        </button>
        <button type="button" className="btn sm danger" disabled={m.writesLocked} onClick={() => m.setPendingDelete(e)}>
          <Trash2 size={13} /> {t("files.actionDelete")}
        </button>
      </div>
    </div>
  );
}

export function FilesTable({ m }: { m: FilesModel }) {
  const { t } = useTranslation();
  const col = (by: "name" | "size" | "updated", label: string) => (
    <button type="button" className="file-th-btn" onClick={() => m.setSort(by)}>
      {label}
      {m.sortBy === by ? (m.sortOrder === "asc" ? " ↑" : " ↓") : ""}
    </button>
  );
  return (
    <div className="file-table-wrap">
      <table className="file-table">
        <thead>
          <tr>
            <th>{col("name", t("files.colName"))}</th>
            <th>{t("files.colGroup")}</th>
            <th>{col("size", t("files.colSize"))}</th>
            <th>{col("updated", t("files.colUpdated"))}</th>
            <th>{t("files.colNote")}</th>
            <th style={{ width: 180 }}>{t("files.colActions")}</th>
          </tr>
        </thead>
        <tbody>
          {m.filteredEntries.map((e) => (
            <tr key={e.id} data-focus-id={e.id}>
              <td>
                <div className="file-card-name" title={e.name}>
                  {e.name}
                </div>
                <div className="file-card-orig" title={attachmentSummary(e, t)}>
                  {attachmentSummary(e, t)}
                </div>
              </td>
              <td>{e.group || t("files.ungrouped")}</td>
              <td>{formatBytes(e.size)}</td>
              <td>{formatUpdatedAt(e.updatedAt)}</td>
              <td className="file-card-note" title={e.note || ""}>
                {e.note || t("common.emDash")}
              </td>
              <td>
                <div className="row" style={{ gap: 4 }}>
                  <button type="button" className="btn ghost sm" disabled={!!m.exportingId} onClick={() => void m.exportFile(e)}>
                    {t("files.actionExport")}
                  </button>
                  <button type="button" className="btn ghost sm" disabled={m.writesLocked} onClick={() => m.setEditor(editFromEntry(e))}>
                    {t("files.actionEdit")}
                  </button>
                  <button type="button" className="btn ghost sm" disabled={m.writesLocked} onClick={() => m.setPendingDelete(e)}>
                    {t("files.actionDelete")}
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FilesEmpty({ m }: { m: FilesModel }) {
  const { t } = useTranslation();
  return <Empty icon="🗄️" text={m.q ? t("files.emptySearch") : t("files.emptyDesktop")} />;
}

export function FileEditModal({ m }: { m: FilesModel }) {
  const { t } = useTranslation();
  const addRef = useRef<HTMLInputElement>(null);
  const editor = m.editor;
  if (!editor) return null;
  const draft = editor;
  const atts = editorAttachments(draft);
  const empty = !editorHasAttachment(editor);
  const oversize = editorOversize(editor);
  const canSave = !!editor.name.trim() && !oversize && !m.busy && !empty;

  function patch(p: Partial<FileEditState>) {
    m.setEditor({ ...draft, ...p });
  }

  function removeAtt(key: string) {
    patch({
      kept: draft.kept.filter((a) => a.id !== key),
      pending: draft.pending.filter((a) => a.key !== key),
    });
  }

  return (
    <div className="wizard-overlay">
      <div className="card" style={{ width: 520, maxWidth: "96vw" }}>
        <div className="card-head">
          <div className="card-title">{editor.id ? t("files.editTitle") : t("files.uploadTitle")}</div>
        </div>
        <div className="card-body stack">
          <div className="field">
            <FieldLabel name={t("files.customName")} tip={t("files.customNameTip")} />
            <input
              className="input"
              autoFocus
              value={editor.name}
              onFocus={(e) => {
                const n = editor.name;
                const dot = n.lastIndexOf(".");
                if (dot > 0) e.currentTarget.setSelectionRange(0, dot);
                else e.currentTarget.select();
              }}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </div>

          <div className="field">
            <FieldLabel name={t("files.attachments")} tip={t("files.attachmentsTip")} />
            <div className="file-att-list">
              {atts.length === 0 ? (
                <div className="file-att-empty">{t("files.needOneAttachment")}</div>
              ) : (
                atts.map((a) => (
                  <div key={a.key} className="file-att-row">
                    <div className="file-att-copy">
                      <div className="file-att-name" title={a.originalName}>
                        {a.originalName}
                      </div>
                      <div className="file-att-meta">
                        {a.size > 0 ? formatBytes(a.size) : t("files.sizeOnSave")}
                        {a.existing ? "" : ` · ${t("files.pendingAdd")}`}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn ghost sm"
                      disabled={m.busy}
                      title={t("files.removeAttachment")}
                      onClick={() => removeAtt(a.key)}
                    >
                      <Trash2 size={13} /> {t("files.removeAttachment")}
                    </button>
                  </div>
                ))
              )}
            </div>
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
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <button
                type="button"
                className="btn sm"
                disabled={m.busy || m.writesLocked}
                onClick={() => {
                  if (resolvePlatform() === "mobile") addRef.current?.click();
                  else void m.pickMoreFiles();
                }}
              >
                <Plus size={13} /> {t("files.addFiles")}
              </button>
            </div>
          </div>

          <div className="field">
            <label className="field-label">{t("files.group")}</label>
            <GroupPicker
              groups={m.groups}
              value={editor.group}
              onChange={(name) => patch({ group: name || undefined })}
              onReorder={m.writesLocked ? undefined : m.reorderGroups}
            />
          </div>

          <div className="field">
            <label className="field-label">{t("files.note")}</label>
            <textarea
              className="input"
              rows={3}
              placeholder={t("files.notePlaceholder")}
              value={editor.note || ""}
              onChange={(e) => patch({ note: e.target.value })}
            />
          </div>

          {empty && <div className="callout danger sm">{t("files.needOneAttachment")}</div>}
          {oversize && <div className="callout danger sm">{t("files.overLimit")}</div>}
        </div>
        <div className="card-foot" style={{ justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn ghost sm" disabled={m.busy} onClick={() => m.setEditor(null)}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn primary sm" disabled={!canSave} onClick={() => void m.saveFileMeta(editor)}>
            {m.busy ? t("files.saving") : editor.id ? t("files.save") : t("files.encryptIn")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function FilesDialogs({ m, skipEditor }: { m: FilesModel; skipEditor?: boolean }) {
  const { t } = useTranslation();
  useOverlayBack(!skipEditor && !!m.editor, () => m.setEditor(null));
  useOverlayBack(!!m.exportPick, () => m.setExportPick(null));
  useOverlayBack(!!m.pendingDelete, () => m.setPendingDelete(null));
  useOverlayBack(!!m.reauth, () => m.reauthCancel.current?.());
  useOverlayBack(!!m.groupDlg, () => m.setGroupDlg(null));
  useOverlayBack(!!m.pendingDeleteGroup, () => m.setPendingDeleteGroup(null));
  return (
    <>
      <ErrorDialog message={m.err} onClose={() => m.setErr("")} />
      {m.reauth && (
        <ReauthDialog
          hint={t("files.reauthHint")}
          onCancel={() => m.reauthCancel.current?.()}
          onConfirm={(pw) => m.reauth!(pw)}
        />
      )}
      <GroupManageDialogs
        groups={m.groups}
        groupDlg={m.groupDlg}
        pendingDeleteGroup={m.pendingDeleteGroup}
        busy={m.busy}
        onCancel={() => m.setGroupDlg(null)}
        onConfirm={m.saveGroup}
        onCancelDelete={() => m.setPendingDeleteGroup(null)}
        onConfirmDelete={() => void m.confirmDeleteGroup()}
        deleteCount={m.entries.filter((e) => e.group === m.pendingDeleteGroup).length}
      />
      {!skipEditor && m.editor && <FileEditModal m={m} />}
      {m.exportPick && (
        <div className="wizard-overlay">
          <div className="card" style={{ width: 420, maxWidth: "96vw" }}>
            <div className="card-head">
              <div className="card-title">{t("files.exportPickTitle")}</div>
            </div>
            <div className="card-body stack">
              {entryAttachments(m.exportPick).map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className="btn"
                  disabled={!!m.exportingId}
                  onClick={() => void m.exportFile(m.exportPick!, a)}
                >
                  {a.originalName} · {formatBytes(a.size)}
                </button>
              ))}
            </div>
            <div className="card-foot" style={{ justifyContent: "flex-end" }}>
              <button type="button" className="btn ghost sm" onClick={() => m.setExportPick(null)}>
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}
      {m.pendingDelete && (
        <ConfirmDangerDialog
          title={t("files.deleteTitle")}
          message={
            m.pendingDelete.originalName
              ? t("files.deleteMsgOrig", { name: m.pendingDelete.name, original: m.pendingDelete.originalName })
              : t("files.deleteMsg", { name: m.pendingDelete.name })
          }
          detail={t("files.deleteDetail")}
          busy={m.busy}
          onCancel={() => m.setPendingDelete(null)}
          onConfirm={() => void m.deleteFile(m.pendingDelete!.id)}
        />
      )}
    </>
  );
}

export function editFromEntry(e: FileEntry): FileEditState {
  return {
    id: e.id,
    name: e.name,
    kept: entryAttachments(e),
    pending: [],
    group: e.group || undefined,
    note: e.note || undefined,
    icon: e.icon || undefined,
  };
}
