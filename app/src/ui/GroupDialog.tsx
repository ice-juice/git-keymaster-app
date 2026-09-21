import { useState } from "react";
import { FolderPlus, Pencil } from "lucide-react";
import { useTranslation } from "react-i18next";
import { errMessage, type GroupMeta } from "../lib/ipc";
import { ConfirmDangerDialog } from "./common";

export const GROUP_COLORS = [
  "#6366f1",
  "#0ea5e9",
  "#10b981",
  "#f59e0b",
  "#f43f5e",
  "#8b5cf6",
  "#64748b",
];

export const GROUP_PRESET_KEYS = [
  { key: "work" as const, color: "#6366f1" },
  { key: "personal" as const, color: "#10b981" },
  { key: "cloud" as const, color: "#0ea5e9" },
  { key: "dev" as const, color: "#f59e0b" },
];

export type GroupDialogState =
  | { mode: "create" }
  | { mode: "edit"; name: string; color?: string | null };

export function GroupDialog({
  existing,
  initial,
  onCancel,
  onConfirm,
}: {
  existing: string[];
  initial?: { name: string; color?: string | null };
  onCancel: () => void;
  onConfirm: (name: string, color: string | null) => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const editing = !!initial?.name;
  const [name, setName] = useState(initial?.name ?? "");
  const [color, setColor] = useState<string | null>(initial?.color ?? GROUP_COLORS[0]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const taken = new Set(
    existing
      .filter((n) => !editing || n.trim().toLowerCase() !== initial!.name.trim().toLowerCase())
      .map((n) => n.trim().toLowerCase()),
  );
  const presets = GROUP_PRESET_KEYS
    .map((p) => ({ name: t(`group.${p.key}`), color: p.color }))
    .filter((p) => !taken.has(p.name.toLowerCase()));

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed) return setErr(t("group.needName"));
    if (taken.has(trimmed.toLowerCase())) return setErr(t("group.dupName"));
    setBusy(true);
    setErr("");
    try {
      await onConfirm(trimmed, color);
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wizard-overlay">
      <div className="card group-dialog">
        <div className="card-head">
          <div className="card-title row" style={{ gap: 8 }}>
            {editing ? (
              <Pencil size={14} style={{ color: "var(--accent)" }} />
            ) : (
              <FolderPlus size={14} style={{ color: "var(--accent)" }} />
            )}
            {editing ? t("group.titleEdit") : t("group.title")}
          </div>
        </div>
        <div className="card-body stack">
          <div className="muted">{editing ? t("group.hintEdit") : t("group.hint")}</div>

          <div className="field">
            <label className="field-label">{t("group.name")}</label>
            <input
              className="input"
              autoFocus
              maxLength={24}
              placeholder={t("group.namePh")}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (err) setErr("");
              }}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
          </div>

          <div className="field">
            <label className="field-label">{t("group.color")}</label>
            <div className="color-dots">
              {GROUP_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={"color-dot" + (color === c ? " on" : "")}
                  style={{ background: c }}
                  title={c}
                  onClick={() => setColor(c)}
                />
              ))}
              <button
                type="button"
                className={"color-dot none" + (color === null ? " on" : "")}
                title={t("group.noColor")}
                onClick={() => setColor(null)}
              />
            </div>
          </div>

          {!editing && presets.length > 0 && (
            <div className="field">
              <label className="field-label">{t("group.presets")}</label>
              <div className="choice-row">
                {presets.map((p) => (
                  <button
                    key={p.name}
                    type="button"
                    className={"choice" + (name === p.name ? " on" : "")}
                    onClick={() => {
                      setName(p.name);
                      setColor(p.color);
                      if (err) setErr("");
                    }}
                  >
                    <span className="group-tab-dot" style={{ background: p.color }} />
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {err && <div className="callout danger sm">{err}</div>}

          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="btn ghost sm" onClick={onCancel}>
              {t("common.cancel")}
            </button>
            <button type="button" className="btn primary sm" disabled={busy} onClick={submit}>
              {busy
                ? editing
                  ? t("group.saving")
                  : t("group.creating")
                : editing
                  ? t("group.save")
                  : t("group.create")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function groupManageHandlers(m: {
  writesLocked: boolean;
  groups: GroupMeta[];
  setGroupDlg: (next: GroupDialogState) => void;
  requestDeleteGroup: (name: string) => void;
}) {
  return {
    onCreate: () => m.setGroupDlg({ mode: "create" }),
    onEdit: m.writesLocked
      ? undefined
      : (key: string) => {
          const g = m.groups.find((item) => item.name === key);
          if (g) m.setGroupDlg({ mode: "edit", name: g.name, color: g.color ?? null });
        },
    onDelete: m.writesLocked ? undefined : m.requestDeleteGroup,
  };
}

export function GroupManageDialogs({
  groups,
  groupDlg,
  pendingDeleteGroup,
  busy,
  onCancel,
  onConfirm,
  onCancelDelete,
  onConfirmDelete,
  deleteCount,
}: {
  groups: GroupMeta[];
  groupDlg: GroupDialogState | null;
  pendingDeleteGroup: string | null;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (name: string, color: string | null) => Promise<void> | void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  deleteCount: number;
}) {
  const { t } = useTranslation();
  return (
    <>
      {groupDlg && (
        <GroupDialog
          existing={groups.map((g) => g.name)}
          initial={groupDlg.mode === "edit" ? { name: groupDlg.name, color: groupDlg.color } : undefined}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      )}
      {pendingDeleteGroup && (
        <ConfirmDangerDialog
          title={t("group.deleteTitle")}
          message={t("group.deleteMsg", { name: pendingDeleteGroup })}
          detail={t("group.deleteDetail", { n: deleteCount })}
          busy={busy}
          onCancel={onCancelDelete}
          onConfirm={onConfirmDelete}
        />
      )}
    </>
  );
}
