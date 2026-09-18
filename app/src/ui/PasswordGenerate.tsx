import { useEffect, useRef, useState } from "react";
import { Settings2, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { copyWithClear } from "../lib/secretsUi";
import { pwStrengthKey } from "../shared/hooks/useInitModel";
import {
  DEFAULT_PASSWORD_OPTS,
  generatePassword,
  type GeneratePasswordOpts,
} from "../shared/password";

export function PasswordStrengthBar({ password }: { password: string }) {
  const { t } = useTranslation();
  if (!password) return null;
  const key = pwStrengthKey(password);
  return (
    <div className={"pw-strength pw-strength-" + key}>
      <div className="pw-strength-track" aria-hidden>
        <span />
        <span />
        <span />
      </div>
      <span className="pw-strength-label">{t(`init.${key}`)}</span>
    </div>
  );
}

export function PasswordGenerateControls({
  compact,
  password,
  onFill,
}: {
  compact?: boolean;
  password: string;
  onFill: (pw: string) => void;
}) {
  const { t } = useTranslation();
  const [opts, setOpts] = useState<GeneratePasswordOpts>(DEFAULT_PASSWORD_OPTS);
  const [open, setOpen] = useState(false);
  const [hint, setHint] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(ev: Event) {
      if (!rootRef.current?.contains(ev.target as Node)) setOpen(false);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function patch(partial: Partial<GeneratePasswordOpts>) {
    setOpts((prev) => ({ ...prev, ...partial }));
    setHint("");
  }

  async function generate() {
    if (!opts.lower && !opts.upper && !opts.digits && !opts.symbols) {
      setHint(t("accounts.pwNeedCharset"));
      setOpen(true);
      return;
    }
    try {
      const pw = generatePassword(opts);
      onFill(pw);
      await copyWithClear(pw);
      setHint("");
      setOpen(false);
    } catch {
      setHint(t("accounts.pwNeedCharset"));
    }
  }

  return (
    <div className={"pw-gen" + (compact ? " compact" : "") + (open ? " is-open" : "")} ref={rootRef}>
      <div className="pw-gen-actions">
        <button
          type="button"
          className={"btn sm" + (compact ? " pw-gen-touch" : "")}
          onClick={() => void generate()}
        >
          <Sparkles size={compact ? 15 : 13} />
          <span>{t("accounts.generate")}</span>
        </button>
        <button
          type="button"
          className={"btn ghost sm pw-gen-gear" + (open ? " is-open" : "") + (compact ? " pw-gen-touch" : "")}
          aria-expanded={open}
          aria-haspopup="dialog"
          title={t("accounts.generateOpts")}
          onClick={() => setOpen((v) => !v)}
        >
          <Settings2 size={compact ? 15 : 13} />
        </button>
        {open && (
          <div className="pw-gen-pop" role="dialog" aria-label={t("accounts.generateOpts")}>
            <label className="pw-gen-row">
              <span>{t("accounts.pwLength")}</span>
              <input
                type="range"
                min={8}
                max={64}
                value={opts.length}
                onChange={(e) => patch({ length: Number(e.target.value) })}
              />
              <strong>{opts.length}</strong>
            </label>
            <label className="pw-gen-check">
              <input type="checkbox" checked={opts.lower} onChange={(e) => patch({ lower: e.target.checked })} />
              <span>{t("accounts.pwLower")}</span>
            </label>
            <label className="pw-gen-check">
              <input type="checkbox" checked={opts.upper} onChange={(e) => patch({ upper: e.target.checked })} />
              <span>{t("accounts.pwUpper")}</span>
            </label>
            <label className="pw-gen-check">
              <input type="checkbox" checked={opts.digits} onChange={(e) => patch({ digits: e.target.checked })} />
              <span>{t("accounts.pwDigits")}</span>
            </label>
            <label className="pw-gen-check">
              <input type="checkbox" checked={opts.symbols} onChange={(e) => patch({ symbols: e.target.checked })} />
              <span>{t("accounts.pwSymbols")}</span>
            </label>
            <label className="pw-gen-check">
              <input
                type="checkbox"
                checked={opts.excludeAmbiguous}
                onChange={(e) => patch({ excludeAmbiguous: e.target.checked })}
              />
              <span>{t("accounts.pwNoAmbiguous")}</span>
            </label>
          </div>
        )}
      </div>
      {hint && <div className="hint">{hint}</div>}
      <PasswordStrengthBar password={password} />
    </div>
  );
}
