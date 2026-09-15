import { AlertTriangle, X } from "lucide-react";
import { useTranslation } from "react-i18next";

function changeItemKeys(os?: string): string[] {
  if (os === "macos") {
    return ["agent.unifyItemGitOpenssh", "agent.unifyItemZsh", "agent.unifyItemAgentScript"];
  }
  if (os === "linux") {
    return ["agent.unifyItemGitOpenssh", "agent.unifyItemBash", "agent.unifyItemAgentScript"];
  }
  return [
    "agent.unifyItemGitBundled",
    "agent.unifyItemEnv",
    "agent.unifyItemPwsh",
    "agent.unifyItemGitBash",
    "agent.unifyItemAgentScript",
  ];
}

export function EnvUnifyDialog({
  open,
  busy,
  error,
  os,
  ssh,
  sock,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  busy?: boolean;
  error?: string;
  os?: string;
  ssh?: string | null;
  sock?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  if (!open) return null;
  const items = changeItemKeys(os);
  const sshLabel = os === "windows" ? t("agent.unifySshGit") : t("agent.unifySshLocal");

  return (
    <div className="close-overlay" role="dialog" aria-labelledby="env-unify-title" aria-modal="true">
      <div className="close-dialog env-unify-dialog">
        <div className="close-dialog-titlebar">
          <span id="env-unify-title">{t("agent.unifyTitle")}</span>
          <button type="button" className="close-dialog-x" onClick={onCancel} disabled={busy} aria-label={t("common.close")}>
            <X size={14} />
          </button>
        </div>
        <div className="close-dialog-body">
          <div className="close-dialog-warn" aria-hidden>
            <AlertTriangle size={34} strokeWidth={2.2} />
          </div>
          <div className="close-dialog-content">
            <div className="close-dialog-q">{t("agent.unifyQ", { agent: sshLabel })}</div>
            <ul className="env-unify-list">
              {items.map((key) => (
                <li key={key}>{t(key)}</li>
              ))}
            </ul>
            {(ssh || sock) && (
              <div className="mono muted sm env-unify-meta">
                {ssh && (
                  <>
                    {t("agent.unifySsh", { path: ssh })}
                    <br />
                  </>
                )}
                {sock && <>{t("agent.unifySock", { path: sock })}</>}
              </div>
            )}
            <div className="muted sm" style={{ marginTop: 8 }}>
              {t("agent.unifyHint")}
            </div>
            {error && (
              <div className="err-text env-unify-error" style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>
                {error}
              </div>
            )}
          </div>
        </div>
        <div className="close-dialog-footer env-unify-actions">
          <button type="button" className="btn" disabled={busy} onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn primary" disabled={busy} onClick={onConfirm}>
            {busy ? t("agent.unifyApplying") : t("agent.unifyConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
