import { useEffect, useState } from "react";
import { ChevronDown, Copy, Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { copyWithClear } from "../lib/secretsUi";
import { FieldLabel } from "./common";

export type ExtraFieldDraft = {
  key: string;
  value: string;
  revealed: boolean;
  existing: boolean;
};

function defaultExpanded(rows: ExtraFieldDraft[]): boolean[] {
  // 有名字默认折叠；无名（含刚添加）默认展开，方便立刻填写。
  return rows.map((row) => !row.key.trim());
}

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
  const [expanded, setExpanded] = useState(() => defaultExpanded(draft));

  useEffect(() => {
    setExpanded((prev) => {
      if (prev.length === draft.length) return prev;
      if (draft.length > prev.length) {
        return [
          ...prev,
          ...draft.slice(prev.length).map((row) => !row.key.trim()),
        ];
      }
      // 外部缩短且未走本地删除时，按默认规则重建
      return defaultExpanded(draft);
    });
  }, [draft.length]);

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

  function isOpen(index: number) {
    return expanded[index] ?? !draft[index]?.key.trim();
  }

  function toggleOpen(index: number) {
    setExpanded((prev) => {
      const next = draft.map((_, i) => prev[i] ?? !draft[i]?.key.trim());
      next[index] = !next[index];
      return next;
    });
  }

  return (
    <div className="field extra-fields">
      <FieldLabel name={t("accounts.extraFields")} tip={t("accounts.extraFieldsTip")} />
      <div className={"extra-fields-box" + (compact ? " compact" : "")}>
        <div className="extra-fields-list">
          {draft.map((row, index) => {
            const masked = row.existing && !row.revealed && canReveal;
            const open = isOpen(index);
            const summary = row.key.trim() || t("accounts.extraFieldUnnamed");
            return (
              <div
                key={index}
                className={
                  "extra-field-row" +
                  (compact ? " compact" : "") +
                  (open ? " is-open" : " is-collapsed")
                }
              >
                <div className="extra-field-header">
                  <button
                    type="button"
                    className={"extra-field-toggle" + (compact ? " extra-field-touch" : "")}
                    aria-expanded={open}
                    title={open ? t("accounts.collapseExtraField") : t("accounts.expandExtraField")}
                    onClick={() => toggleOpen(index)}
                  >
                    <ChevronDown
                      size={14}
                      className={"chevron" + (open ? "" : " rot")}
                    />
                    <span className={"extra-field-summary" + (row.key.trim() ? "" : " is-placeholder")}>
                      {summary}
                    </span>
                  </button>
                  <div className="extra-field-actions">
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
                      onClick={() => {
                        onChange(
                          draft.filter((_, i) => i !== index),
                          true,
                        );
                        setExpanded((prev) => prev.filter((_, i) => i !== index));
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                {open ? (
                  <div className="extra-field-inputs">
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
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <button
          type="button"
          className={"btn ghost sm extra-field-add" + (compact ? " extra-field-touch" : "")}
          disabled={disabled}
          onClick={() => {
            onChange([...draft, { key: "", value: "", revealed: true, existing: false }], true);
            setExpanded((prev) => [...prev, true]);
          }}
        >
          <Plus size={14} />
          <span>{t("accounts.addExtraField")}</span>
        </button>
      </div>
    </div>
  );
}
