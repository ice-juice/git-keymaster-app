import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { errMessage } from "../lib/ipc";

export function ReauthDialog({
  title,
  hint,
  onCancel,
  onConfirm,
}: {
  title?: string;
  hint?: string;
  onCancel: () => void;
  onConfirm: (password: string) => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submitting = useRef(false);

  async function submit() {
    if (submitting.current) return;
    if (!pw.length) return setErr(t("reauth.needPassword"));
    submitting.current = true;
    setBusy(true);
    setErr("");
    try {
      await onConfirm(pw);
      setPw("");
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="wizard-overlay">
      <div className="card" style={{ width: 380, maxWidth: "94vw" }}>
        <div className="card-head">
          <div className="card-title">{title || t("reauth.title")}</div>
        </div>
        <div className="card-body stack">
          <div className="muted">{hint || t("reauth.hint")}</div>
          <div className="field">
            <label className="field-label">{t("reauth.password")}</label>
            <input
              className="input"
              type="password"
              autoFocus
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
          </div>
          {err && <div className="callout danger sm">{err}</div>}
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="btn ghost sm" onClick={() => { setPw(""); onCancel(); }}>
              {t("common.cancel")}
            </button>
            <button type="button" className="btn primary sm" disabled={busy} onClick={submit}>
              {busy ? t("reauth.verifying") : t("reauth.confirm")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
