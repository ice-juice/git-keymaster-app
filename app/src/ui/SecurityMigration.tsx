import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { errMessage } from "../lib/ipc";
import { copyWithClear } from "../lib/secretsUi";
import { resolvePlatform } from "../platform/resolve";
import { useApp } from "../store";

type Prepared = {
  token: string; recoveryKey: string; workspaceId: string; path: string; sourcePath: string;
  summary: { accountCount: number; totpCount: number; fileCount: number; noteCount: number; keyCount: number; blobCount: number };
};

/** Fresh-MK migration creates a verified independent copy. Cancellation never deletes it. */
export function SecurityMigration() {
  const { i18n } = useTranslation();
  const text = (zh: string, en: string) => i18n.resolvedLanguage?.startsWith("zh") ? zh : en;
  const status = useApp(s => s.status);
  const [expanded, setExpanded] = useState(false);
  const [path, setPath] = useState("");
  const [access, setAccess] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retained, setRetained] = useState("");
  const pending = useRef(false);
  const token = useRef("");
  const generation = useRef(0);
  useEffect(() => {
    setAccess(""); setPassword(""); setRepeat(""); setConfirmation(""); setPrepared(null); setBusy(false);
    return () => {
      generation.current += 1;
      const old = token.current; token.current = "";
      if (old) void invoke("security_migration_cancel", { token: old }).catch(() => {});
    };
  }, [status?.workspaceId, status?.unlocked]);
  if (resolvePlatform() === "mobile") return null;

  async function chooseParent() {
    const parent = await open({ directory: true, multiple: false });
    if (typeof parent === "string") {
      const slash = parent.includes("\\") ? "\\" : "/";
      setPath(`${parent.replace(/[\\/]$/, "")}${slash}secure-vault-${Date.now()}`);
    }
  }
  async function prepare() {
    if (pending.current || !status?.unlocked) return;
    if (password !== repeat) { setError(text("两次新密码不一致", "New passwords do not match")); return; }
    pending.current = true; setBusy(true); setError("");
    const epoch = generation.current;
    try {
      const result = await invoke<Prepared>("security_migration_prepare", { targetPath: path, accessPassword: access, newPassword: password });
      if (epoch !== generation.current) {
        void invoke("security_migration_cancel", { token: result.token }).catch(() => {}); return;
      }
      token.current = result.token; setPrepared(result); setRetained(result.path);
    } catch (e) { if (epoch === generation.current) setError(errMessage(e)); }
    finally {
      pending.current = false;
      if (epoch === generation.current) { setAccess(""); setPassword(""); setRepeat(""); setBusy(false); }
    }
  }
  async function cancel() {
    if (pending.current) return;
    const old = token.current; token.current = "";
    generation.current += 1; setPrepared(null); setConfirmation("");
    if (old) await invoke("security_migration_cancel", { token: old }).catch(() => {});
  }
  async function activate() {
    if (pending.current || !prepared || !confirmation) return;
    pending.current = true; setBusy(true); setError("");
    const epoch = generation.current;
    try {
      await invoke("security_migration_activate", { token: prepared.token, recoveryKey: confirmation });
      if (epoch !== generation.current) return;
      token.current = ""; setConfirmation(""); setPrepared(null);
      await useApp.getState().refresh();
    } catch (e) { if (epoch === generation.current) setError(errMessage(e)); }
    finally { pending.current = false; if (epoch === generation.current) setBusy(false); }
  }

  return <section className="stack" style={{ marginTop: 16 }}>
    <button type="button" className="btn danger-frame" onClick={() => setExpanded(!expanded)}>{text("主密钥疑似泄露：创建全新安全副本", "Suspected master-key exposure: create a fresh secure copy")}</button>
    {expanded && <>
      <div className="callout warn">{text("这会生成全新主密钥与恢复码，在新目录验证副本。原库不会删除。旧云历史、已泄露资料和第三方账号密码不会被撤销；请另行轮换账号密码、SSH密钥及外部令牌。迁移不包含云端寄存文件本体，也不会自动部署SSH或配置新云同步。", "Creates a new master key and recovery key in a verified separate vault. The original stays intact. Old cloud history, exposed information and external credentials are not revoked: rotate account passwords, SSH keys and tokens separately. Remote locker payloads are excluded. SSH deployment and cloud sync are not configured automatically.")}</div>
      {error && <div className="callout danger" role="alert">{error}</div>}
      {retained && <p className="muted">{text("已创建副本（取消切换也保留）：", "Created copy (also retained on cancellation): ")}{retained}</p>}
      {!prepared ? <form className="stack" onSubmit={e => { e.preventDefault(); void prepare(); }}>
        <label>{text("全新目标目录（必须不存在）", "New destination directory (must not exist)")}<input className="input" value={path} disabled={busy} onChange={e => setPath(e.target.value)} /></label>
        <button type="button" className="btn sm" disabled={busy} onClick={() => void chooseParent().catch(e => setError(errMessage(e)))}>{text("选择父目录", "Choose parent directory")}</button>
        <label>{text("当前访问密码", "Current access password")}<input className="input" type="password" autoComplete="current-password" value={access} disabled={busy} onChange={e => setAccess(e.target.value)} /></label>
        <label>{text("新的访问密码", "New access password")}<input className="input" type="password" autoComplete="new-password" value={password} disabled={busy} onChange={e => setPassword(e.target.value)} /></label>
        <label>{text("再次输入新密码", "Repeat new password")}<input className="input" type="password" autoComplete="new-password" value={repeat} disabled={busy} onChange={e => setRepeat(e.target.value)} /></label>
        <button className="btn danger" disabled={busy || !status?.unlocked || !path || !access || !password}>{busy ? text("正在复制与校验…", "Copying and verifying…") : text("验证当前密码并创建副本", "Verify current password and create copy")}</button>
      </form> : <div className="stack">
        <p>{text("副本已验证。先离线保存新恢复码，再输入保存的恢复码确认切换。切换时旧云同步、免验证会话和生物识别绑定将停用，需要重新配置。", "Copy verified. Save the new recovery key offline, then enter it to confirm activation. Old cloud sync, grace sessions and biometric binding will be disabled and must be configured again.")}</p>
        <p>{text("账号 / TOTP / 文件 / 笔记 / SSH密钥 / 附件：", "Accounts / TOTP / files / notes / SSH keys / blobs: ")}{[prepared.summary.accountCount, prepared.summary.totpCount, prepared.summary.fileCount, prepared.summary.noteCount, prepared.summary.keyCount, prepared.summary.blobCount].join(" / ")}</p>
        <code style={{ overflowWrap: "anywhere" }}>{prepared.recoveryKey}</code>
        <button type="button" className="btn sm" disabled={busy} onClick={() => void copyWithClear(prepared.recoveryKey).catch(e => setError(errMessage(e)))}>{text("复制新恢复码", "Copy new recovery key")}</button>
        <label>{text("输入已保存的新恢复码", "Enter the new recovery key you saved")}<input className="input" value={confirmation} autoComplete="off" spellCheck={false} disabled={busy} onChange={e => setConfirmation(e.target.value)} /></label>
        <div className="row"><button type="button" className="btn danger" disabled={busy || !confirmation} onClick={() => void activate()}>{text("确认并切换到新库", "Confirm and activate new vault")}</button><button type="button" className="btn ghost" disabled={busy} onClick={() => void cancel()}>{text("取消切换，保留副本", "Cancel switch, keep copy")}</button></div>
      </div>}
    </>}
  </section>;
}
