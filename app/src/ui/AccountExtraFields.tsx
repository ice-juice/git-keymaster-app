import { Copy, Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { copyWithClear } from "../lib/secretsUi";
import { FieldLabel } from "./common";

export type ExtraFieldDraft = {
  key: string;
  value: string;
  revealed: boolean;
  existing: boolean;
};

export function AccountExtraFields({
  compact,
  draft,
  disabled,
  canReveal,
  onChange,
  onReveal,
}: {
  compact?: boolean;
  draft: ExtraFieldDraft[];
  disabled?: boolean;
  canReveal: boolean;
  onChange: (next: ExtraFieldDraft[], dirty?: boolean) => void;
  onReveal: () => Promise<Record<string, string> | undefined>;
}) {
  const { t } = useTranslation();

  function update(index: number, patch: Partial<ExtraFieldDraft>, dirty = true) {
    onChange(
      draft.map((row, i) => (i === index ? { ...row, ...patch } : row)),
      dirty,
    );
  }

  async function revealRow(index: number) {
    const row = draft[index];
    if (!row) return;
    if (!row.existing || row.revealed || !canReveal) {
      update(index, { revealed: !row.revealed }, false);
      return;
    }
    await onReveal();
  }

  async function copyRow(index: number) {
    const row = draft[index];
    if (!row) return;
    let value = row.value;
    if (row.existing && !row.revealed && canReveal) {
      const fields = await onReveal();
      if (!fields) return;
      value = fields[row.key] ?? "";
    }
    if (!value) return;
    await copyWithClear(value);
  }

  return (
    <div className="field extra-fields">
      <FieldLabel name={t("accounts.extraFields")} tip={t("accounts.extraFieldsTip")} />
      <div className="stack" style={{ gap: compact ? 10 : 8 }}>
        {draft.map((row, index) => {
          const masked = row.existing && !row.revealed && canReveal;
          return (
            <div key={index} className={"extra-field-row" + (compact ? " compact" : "")}>
              <input
                className="input"
                placeholder={t("accounts.extraFieldKeyPh")}
                value={row.key}
                disabled={disabled}
                onChange={(e) => update(index, { key: e.target.value })}
              />
              <input
                className="input"
                type={masked || !row.revealed ? "password" : "text"}
                autoComplete="off"
                placeholder={masked ? "••••••••" : t("accounts.extraFieldValuePh")}
                value={masked ? "" : row.value}
                disabled={disabled || masked}
                onChange={(e) => update(index, { value: e.target.value, revealed: true })}
              />
              <button
                type="button"
                className={"btn ghost sm" + (compact ? " extra-field-touch" : "")}
                title={row.revealed ? t("accounts.hideField") : t("accounts.revealField")}
                onClick={() => void revealRow(index)}
              >
                {row.revealed ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
              <button
                type="button"
                className={"btn ghost sm" + (compact ? " extra-field-touch" : "")}
                title={t("accounts.copyField")}
                disabled={masked && !canReveal}
                onClick={() => void copyRow(index)}
              >
                <Copy size={14} />
              </button>
              <button
                type="button"
                className={"btn ghost sm" + (compact ? " extra-field-touch" : "")}
                title={t("accounts.removeExtraField")}
                disabled={disabled}
                onClick={() => onChange(draft.filter((_, i) => i !== index), true)}
              >
                <Trash2 size={14} />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className={"btn ghost sm" + (compact ? " extra-field-touch" : "")}
          disabled={disabled}
          onClick={() =>
            onChange([...draft, { key: "", value: "", revealed: true, existing: false }], true)
          }
        >
          <Plus size={14} />
          <span>{t("accounts.addExtraField")}</span>
        </button>
      </div>
    </div>
  );
}
