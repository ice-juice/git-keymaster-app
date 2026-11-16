import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, errMessage } from "../lib/ipc";
import { copyWithClear } from "../lib/secretsUi";
import { useApp } from "../store";
import { SecurityMigration } from "./SecurityMigration";

/** A prepared recovery key does not replace the working key until confirmed. */
export function RecoveryKeyRotation() {
  const { t } = useTranslation();
  const status = useApp((s) => s.status);
  const [password, setPassword] = useState("");
  const [preparation, setPreparation] = useState<{ token: string; recoveryKey: string } | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const token = useRef("");
  const generation = useRef(0);
  const inFlight = useRef(false);

  useLayoutEffect(() => {
    setPassword(""); setPreparation(null); setConfirmation(""); setDone(false);
    return () => {
    generation.current += 1;
    const pending = token.current;
    token.current = "";
    if (pending) void api.cancelRecoveryKey(pending).catch(() => {});
    };
  }, [status?.workspaceId, status?.unlocked]);

  async function prepare() {
    if (inFlight.current || !status?.unlocked || !password) return;
    inFlight.current = true;
    const epoch = generation.current;
    setBusy(true); setError(""); setDone(false);
    try {
      const result = await api.rotateRecoveryKey(password);
      if (epoch !== generation.current) {
        void api.cancelRecoveryKey(result.token).catch(() => {});
        return;
      }
      token.current = result.token;
      setPreparation(result); setConfirmation("");
    } catch (e) { if (epoch === generation.current) setError(errMessage(e)); }
    finally { setPassword(""); inFlight.current = false; setBusy(false); }
  }

  async function cancel() {
    if (inFlight.current) return;
    const pending = token.current;
    token.current = ""; generation.current += 1;
    setPreparation(null); setConfirmation(""); setPassword(""); setError("");
    if (pending) await api.cancelRecoveryKey(pending).catch(() => {});
  }

  async function commit() {
    if (inFlight.current || !preparation || confirmation.trim() !== preparation.recoveryKey) return;
    inFlight.current = true;
    const epoch = generation.current;
    setBusy(true); setError("");
    try {
      await api.commitRecoveryKey(preparation.token, confirmation);
      if (epoch !== generation.current) return;
      token.current = ""; setPreparation(null); setConfirmation(""); setDone(true);
    } catch (e) { if (epoch === generation.current) setError(errMessage(e)); }
    finally { inFlight.current = false; setBusy(false); }
  }

  return <div className="stack">
    <p className="muted">{t("securityFix.rotationIntro", { defaultValue: "先验证访问密码并保存新恢复码，再确认生效。取消不会更改现有恢复码。" })}</p>
    {error && <div className="callout danger" role="alert">{error}</div>}
    {done && <div className="callout good" role="status">{t("securityFix.rotationDone", { defaultValue: "新恢复码已生效。旧码不再适用于当前保险库头部；持有旧备份的人仍可能解密旧数据。" })}</div>}
    {preparation ? <>
      <div className="callout info">{t("securityFix.rotationPending", { defaultValue: "新码尚未生效。请保存在独立安全位置，并在 5 分钟内输入完整新码确认。" })}</div>
      <div className="reckey" style={{ overflowWrap: "anywhere" }}>{preparation.recoveryKey}</div>
      <button type="button" className="btn sm" disabled={busy} onClick={() => void copyWithClear(preparation.recoveryKey).catch(e => setError(errMessage(e)))}>{t("common.copy")}</button>
      <label className="field">
        <span className="field-label">{t("securityFix.rotationConfirm", { defaultValue: "输入已保存的完整新恢复码" })}</span>
        <input className="input" autoComplete="off" spellCheck={false} value={confirmation} disabled={busy} onChange={e => setConfirmation(e.target.value)} />
      </label>
      <div className="row">
        <button type="button" className="btn primary" disabled={busy || confirmation.trim() !== preparation.recoveryKey} onClick={() => void commit()}>{t("securityFix.rotationCommit", { defaultValue: "已安全保存，启用新码" })}</button>
        <button type="button" className="btn ghost" disabled={busy} onClick={() => void cancel()}>{t("common.cancel")}</button>
      </div>
    </> : <form className="stack" onSubmit={e => { e.preventDefault(); void prepare(); }}>
      <label className="field">
        <span className="field-label">{t("securityFix.rotationPassword", { defaultValue: "访问密码（本次操作重新验证）" })}</span>
        <input className="input" type="password" autoComplete="current-password" value={password} disabled={busy} onChange={e => setPassword(e.target.value)} />
      </label>
      <button type="submit" className="btn danger" disabled={busy || !password || !status?.unlocked}>{t("securityFix.rotationPrepare", { defaultValue: "验证并生成待确认恢复码" })}</button>
    </form>}
    {!preparation && <RecoveryPasswordReset />}
    {!preparation && <SecurityMigration />}
  </div>;
}

function RecoveryPasswordReset() {
  const { t } = useTranslation();
  const status = useApp(s => s.status);
  const [recovery, setRecovery] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const pending = useRef(false);
  const generation = useRef(0);
  useLayoutEffect(() => {
    setRecovery(""); setPassword(""); setConfirm(""); setError(""); setMessage("");
    return () => { generation.current += 1; };
  }, [status?.workspaceId, status?.unlocked]);
  async function reset() {
    if (pending.current || !recovery || password !== confirm || [...password].length < 8) return;
    pending.current = true; setBusy(true); setError(""); setMessage("");
    const epoch = generation.current;
    try {
      await api.resetAccessPasswordWithRecovery(recovery, password);
      if (generation.current !== epoch) return;
      setMessage(t("securityFix.passwordRecovered", { defaultValue: "访问密码已重设，请使用新密码验证。主密钥未变更；如怀疑凭据泄露，请迁移到新的保险库。" }));
    } catch (e) { if (generation.current === epoch) setError(errMessage(e)); }
    finally { setRecovery(""); setPassword(""); setConfirm(""); pending.current = false; setBusy(false); }
  }
  return <details>
    <summary>{t("securityFix.forgotAccessPassword", { defaultValue: "忘记访问密码？使用恢复码重设" })}</summary>
    <form className="stack" onSubmit={e => { e.preventDefault(); void reset(); }}>
      <label className="field"><span className="field-label">{t("settings.recoveryCell")}</span><input className="input" type="password" autoComplete="off" value={recovery} disabled={busy} onChange={e => setRecovery(e.target.value)} /></label>
      <label className="field"><span className="field-label">{t("settings.newPw")}</span><input className="input" type="password" autoComplete="new-password" value={password} disabled={busy} onChange={e => setPassword(e.target.value)} /></label>
      <label className="field"><span className="field-label">{t("settings.confirmPw")}</span><input className="input" type="password" autoComplete="new-password" value={confirm} disabled={busy} onChange={e => setConfirm(e.target.value)} /></label>
      {error && <div role="alert" className="callout danger">{error}</div>}
      {message && <div role="status" className="callout info">{message}</div>}
      <button className="btn danger" type="submit" disabled={busy || !recovery || password !== confirm || [...password].length < 8}>{t("securityFix.resetPassword", { defaultValue: "验证恢复码并重设密码" })}</button>
    </form>
  </details>;
}
