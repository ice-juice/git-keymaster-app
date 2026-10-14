import { useEffect, useRef, useState } from "react";
import { Settings2, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { copyWithClear } from "../lib/secretsUi";
import { pwStrengthKey } from "../shared/hooks/useInitModel";
import {
  DEFAULT_PASSWORD_OPTS,
  generatePassword,
  PASSWORD_ROOT_POSITIONS,
  passwordRootTooLong,
  type GeneratePasswordOpts,
  type PasswordRootPosition,
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

const ROOT_PLACE_KEY: Record<PasswordRootPosition, "tools.passwordRootHead" | "tools.passwordRootTail" | "tools.passwordRootMid"> = {
  head: "tools.passwordRootHead",
  tail: "tools.passwordRootTail",
  mid: "tools.passwordRootMid",
};

/** 工具页滑块与 +/− 共用的长度范围。生成函数内部另有更宽的夹取。 */
const PASSWORD_LENGTH_MIN = 8;
const PASSWORD_LENGTH_MAX = 64;

function PasswordLengthRow({
  length,
  onChange,
  layout,
}: {
  length: number;
  onChange: (length: number) => void;
  layout: "desktop" | "mobile";
}) {
  const { t } = useTranslation();
  const inputId = layout === "desktop" ? "pw-length-desktop" : "pw-length-mobile";
  const atMin = length <= PASSWORD_LENGTH_MIN;
  const atMax = length >= PASSWORD_LENGTH_MAX;

  function setLength(next: number) {
    const clamped = Math.min(PASSWORD_LENGTH_MAX, Math.max(PASSWORD_LENGTH_MIN, Math.round(next)));
    if (clamped !== length) onChange(clamped);
  }

  const rowClass = layout === "mobile" ? "m-tool-range" : "pw-gen-row";

  return (
    <div className={rowClass}>
      <label htmlFor={inputId}>{t("home.pwLength")}</label>
      <input
        id={inputId}
        type="range"
        min={PASSWORD_LENGTH_MIN}
        max={PASSWORD_LENGTH_MAX}
        value={Math.min(PASSWORD_LENGTH_MAX, Math.max(PASSWORD_LENGTH_MIN, length))}
        onChange={(e) => setLength(Number(e.target.value))}
      />
      <span className="pw-len-step">
        <button
          type="button"
          className="btn sm pw-len-step-btn"
          aria-label={t("home.pwLengthDecrease")}
          disabled={atMin}
          onClick={() => setLength(length - 1)}
        >
          −
        </button>
        <strong>{length}</strong>
        <button
          type="button"
          className="btn sm pw-len-step-btn"
          aria-label={t("home.pwLengthIncrease")}
          disabled={atMax}
          onClick={() => setLength(length + 1)}
        >
          +
        </button>
      </span>
    </div>
  );
}

export function PasswordRootControls({
  opts,
  onChange,
  layout,
}: {
  opts: GeneratePasswordOpts;
  onChange: (partial: Partial<GeneratePasswordOpts>) => void;
  layout: "desktop" | "mobile";
}) {
  const { t } = useTranslation();
  const position = opts.rootPosition ?? "head";
  const buttonClass = layout === "mobile" ? "m-tool-tab" : "view-btn";
  const buttons = PASSWORD_ROOT_POSITIONS.map((id) => (
    <button
      key={id}
      type="button"
      role="radio"
      aria-checked={position === id}
      className={buttonClass + (position === id ? " on" : "")}
      onClick={() => onChange({ rootPosition: id })}
    >
      {t(ROOT_PLACE_KEY[id])}
    </button>
  ));
  const rootInput = (
    <input
      id={layout === "desktop" ? "pw-root-desktop" : undefined}
      className="input"
      value={opts.root ?? ""}
      placeholder={t("tools.passwordRootPh")}
      autoComplete="off"
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      onChange={(e) => onChange({ root: e.target.value })}
    />
  );
  const note = passwordRootTooLong(opts) ? <div className="muted sm">{t("tools.passwordRootTooLong")}</div> : null;
  const lengthRow = (
    <PasswordLengthRow length={opts.length} layout={layout} onChange={(length) => onChange({ length })} />
  );

  if (layout === "mobile") {
    return (
      <>
        <label className="m-tool-field">
          <span>{t("tools.passwordRoot")}</span>
          {rootInput}
        </label>
        {lengthRow}
        <div className="m-tool-tabs" role="radiogroup" aria-label={t("tools.passwordRoot")}>
          {buttons}
        </div>
        {note}
      </>
    );
  }

  return (
    <div className="stack">
      <div className="field">
        <label className="field-label" htmlFor="pw-root-desktop">
          {t("tools.passwordRoot")}
        </label>
        {rootInput}
      </div>
      {lengthRow}
      <div className="view-switcher" role="radiogroup" aria-label={t("tools.passwordRoot")}>
        {buttons}
      </div>
      {note}
    </div>
  );
}
