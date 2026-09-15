import { useState } from "react";
import { FolderPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { errMessage } from "../lib/ipc";

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

export function GroupDialog({
  existing,
  onCancel,
  onConfirm,
}: {
  existing: string[];
  onCancel: () => void;
  onConfirm: (name: string, color: string | null) => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [color, setColor] = useState<string | null>(GROUP_COLORS[0]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const taken = new Set(existing.map((n) => n.trim().toLowerCase()));
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
            <FolderPlus size={14} style={{ color: "var(--accent)" }} />
            {t("group.title")}
          </div>
        </div>
        <div className="card-body stack">
          <div className="muted">{t("group.hint")}</div>

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

          {presets.length > 0 && (
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
              {busy ? t("group.creating") : t("group.create")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
