import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_PASSWORD_OPTS,
  generatePassword,
  passwordRootTooLong,
  type GeneratePasswordOpts,
} from "../../shared/password";
import { Card } from "../../ui/common";
import { PasswordRootControls, PasswordStrengthBar } from "../../ui/PasswordGenerate";
import { CopyField, ToolSubPage } from "./ToolsShared";

export function ToolsPasswordPage() {
  const { t } = useTranslation();
  const [opts, setOpts] = useState<GeneratePasswordOpts>(DEFAULT_PASSWORD_OPTS);
  const [pw, setPw] = useState("");
  const [hint, setHint] = useState("");

  function patch(partial: Partial<GeneratePasswordOpts>) {
    setOpts((prev) => ({ ...prev, ...partial }));
    setHint("");
  }

  function generate() {
    const charsetOk = opts.lower || opts.upper || opts.digits || opts.symbols;
    if (!charsetOk && !passwordRootTooLong(opts)) {
      setHint(t("home.pwNeedCharset"));
      return;
    }
    try {
      setPw(generatePassword(opts));
      setHint("");
    } catch {
      setHint(t("home.pwNeedCharset"));
    }
  }

  return (
    <ToolSubPage title={t("home.toolPassword")} desc={t("home.toolPasswordDesc")}>
      <Card>
        <div className="stack">
          <label className="pw-gen-row">
            <span>{t("home.pwLength")}</span>
            <input
              type="range"
              min={8}
              max={64}
              value={opts.length}
              onChange={(e) => patch({ length: Number(e.target.value) })}
            />
            <strong>{opts.length}</strong>
          </label>
          <PasswordRootControls layout="desktop" opts={opts} onChange={patch} />
          <div className="tools-checks">
            <label className="pw-gen-check">
              <input type="checkbox" checked={opts.lower} onChange={(e) => patch({ lower: e.target.checked })} />
              <span>{t("home.pwLower")}</span>
            </label>
            <label className="pw-gen-check">
              <input type="checkbox" checked={opts.upper} onChange={(e) => patch({ upper: e.target.checked })} />
              <span>{t("home.pwUpper")}</span>
            </label>
            <label className="pw-gen-check">
              <input type="checkbox" checked={opts.digits} onChange={(e) => patch({ digits: e.target.checked })} />
              <span>{t("home.pwDigits")}</span>
            </label>
            <label className="pw-gen-check">
              <input type="checkbox" checked={opts.symbols} onChange={(e) => patch({ symbols: e.target.checked })} />
              <span>{t("home.pwSymbols")}</span>
            </label>
            <label className="pw-gen-check">
              <input
                type="checkbox"
                checked={opts.excludeAmbiguous}
                onChange={(e) => patch({ excludeAmbiguous: e.target.checked })}
              />
              <span>{t("home.pwNoAmbiguous")}</span>
            </label>
          </div>
          {hint && <div className="hint">{hint}</div>}
          <div>
            <button type="button" className="btn primary" onClick={generate}>
              {t("home.pwGenerate")}
            </button>
          </div>
          <CopyField label={t("home.pwResult")} value={pw} secret rows={2} />
          <PasswordStrengthBar password={pw} />
        </div>
      </Card>
    </ToolSubPage>
  );
}
