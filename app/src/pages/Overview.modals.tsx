import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Edit3, Trash2, X } from "lucide-react";
import { errMessage, type Identity, type UpdateIdentityArgs } from "../lib/ipc";

export function EditIdentityModal({
  identity,
  onClose,
  onSave,
  onDelete,
}: {
  identity: Identity;
  onClose: () => void;
  onSave: (form: UpdateIdentityArgs) => Promise<void>;
  onDelete: (identity: Identity) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(identity.name);
  const [platform, setPlatform] = useState(identity.platform);
  const [hostAlias, setHostAlias] = useState(identity.hostAlias);
  const [realHost, setRealHost] = useState(identity.realHost);
  const [user, setUser] = useState(identity.user || "git");
  const [email, setEmail] = useState(identity.email || "");
  const [gitUserName, setGitUserName] = useState(identity.gitUserName || "");
  const [strictMode, setStrictMode] = useState(identity.strictMode);
  const [ownersText, setOwnersText] = useState(identity.owners.join(", "));
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const isAliasModified = hostAlias.trim() !== identity.hostAlias;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    if (!name.trim()) return setErr(t("overview.needName"));
    if (!hostAlias.trim()) return setErr(t("overview.needAlias"));
    if (!realHost.trim()) return setErr(t("overview.needHost"));

    const owners = ownersText
      .split(/[,\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    setBusy(true);
    try {
      await onSave({
        id: identity.id,
        name: name.trim(),
        platform,
        hostAlias: hostAlias.trim(),
        realHost: realHost.trim(),
        user: user.trim() || "git",
        email: email.trim() || undefined,
        gitUserName: gitUserName.trim() || undefined,
        strictMode,
        owners,
      });
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wizard-overlay">
      <div className="card" style={{ width: 490, maxWidth: "96%", maxHeight: "90vh", display: "flex", flexDirection: "column" }}>
        <div className="card-head">
          <div className="row" style={{ gap: 6 }}>
            <Edit3 size={15} style={{ color: "var(--accent)" }} />
            <div className="card-title">{t("overview.editTitle", { name: identity.name })}</div>
          </div>
          <button type="button" className="btn ghost sm" onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
          <div className="card-body" style={{ overflow: "auto", flex: 1, display: "flex", flexDirection: "column", gap: 10 }}>
            {err && <div className="callout danger sm">{err}</div>}

            <div className="grid c2">
              <div className="field">
                <label className="field-label">{t("overview.nameLabel")}</label>
                <input
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t("overview.namePh")}
                  required
                />
              </div>

              <div className="field">
                <label className="field-label">{t("overview.platform")}</label>
                <select
                  className="input"
                  value={platform}
                  onChange={(e) => setPlatform(e.target.value)}
                >
                  <option value="github">GitHub</option>
                  <option value="gitlab">GitLab</option>
                  <option value="gitee">{t("overview.platGitee")}</option>
                  <option value="codeup">{t("overview.platCodeup")}</option>
                  <option value="custom">{t("overview.platCustom")}</option>
                </select>
              </div>
            </div>

            <div className="grid c2">
              <div className="field">
                <label className="field-label">{t("overview.aliasLabel")}</label>
                <input
                  className="input mono"
                  value={hostAlias}
                  onChange={(e) => setHostAlias(e.target.value)}
                  placeholder={t("overview.aliasPh")}
                  required
                />
                <div className="hint">{t("overview.aliasHint", { alias: hostAlias || t("overview.aliasFallback") })}</div>
              </div>

              <div className="field">
                <label className="field-label">{t("overview.hostLabel")}</label>
                <input
                  className="input mono"
                  value={realHost}
                  onChange={(e) => setRealHost(e.target.value)}
                  placeholder={t("overview.hostPh")}
                  required
                />
              </div>
            </div>

            {isAliasModified && (
              <div className="callout warn sm">{t("overview.aliasWarn")}</div>
            )}

            <div className="grid c2">
              <div className="field">
                <label className="field-label">{t("overview.sshUser")}</label>
                <input
                  className="input mono"
                  value={user}
                  onChange={(e) => setUser(e.target.value)}
                  placeholder={t("overview.sshUserPh")}
                />
              </div>

              <div className="field">
                <label className="field-label">{t("overview.email")}</label>
                <input
                  className="input"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t("overview.emailPh")}
                />
              </div>
            </div>

            <div className="field">
              <label className="field-label">{t("overview.gitName")}</label>
              <input
                className="input"
                value={gitUserName}
                onChange={(e) => setGitUserName(e.target.value)}
                placeholder={t("overview.gitNamePh")}
              />
            </div>

            <div className="field">
              <label className="field-label">{t("overview.owners")}</label>
              <input
                className="input mono"
                value={ownersText}
                onChange={(e) => setOwnersText(e.target.value)}
                placeholder={t("overview.ownersPh")}
              />
              <div className="hint">{t("overview.ownersHint")}</div>
            </div>

            <div className="field" style={{ marginTop: 2 }}>
              <div className="between" style={{ padding: "6px 0" }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 11.5 }}>{t("overview.strictMode")}</div>
                  <div className="hint">{t("overview.strictHint")}</div>
                </div>
                <div
                  className={`switch ${strictMode ? "" : "off"}`}
                  onClick={() => setStrictMode(!strictMode)}
                />
              </div>
            </div>
          </div>

          <div
            className="card-head"
            style={{
              justifyContent: "space-between",
              borderRadius: "0 0 var(--radius-lg) var(--radius-lg)",
              borderTop: "1px solid var(--border)",
              borderBottom: "none",
            }}
          >
            <button
              type="button"
              className="btn danger sm"
              onClick={() => onDelete(identity)}
            >
              <Trash2 size={13} />
              <span>{t("overview.deleteIdentity")}</span>
            </button>

            <div className="row" style={{ gap: 6 }}>
              <button type="button" className="btn ghost sm" onClick={onClose}>
                {t("common.cancel")}
              </button>
              <button type="submit" className="btn primary sm" disabled={busy}>
                {busy ? t("repos.saving") : t("overview.saveChanges")}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

export function ConfirmAliasModal({
  original,
  updated,
  onCancel,
  onConfirm,
}: {
  original: Identity;
  updated: UpdateIdentityArgs;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="wizard-overlay" style={{ zIndex: 60 }}>
      <div className="card" style={{ width: 440, maxWidth: "95%", border: "1px solid var(--amber)" }}>
        <div className="card-head" style={{ background: "var(--amber-soft)" }}>
          <div className="row" style={{ gap: 6, color: "var(--amber)" }}>
            <AlertTriangle size={16} />
            <div className="card-title" style={{ color: "var(--amber)", fontWeight: 700 }}>
              {t("overview.confirmAliasTitle")}
            </div>
          </div>
        </div>

        <div className="card-body stack" style={{ gap: 10, padding: "14px 16px" }}>
          <div style={{ fontSize: 12, lineHeight: 1.5 }}>
            {t("overview.confirmAliasLead", { name: original.name })}
          </div>

          <div
            style={{
              background: "var(--panel-2)",
              padding: "8px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              fontSize: 11.5,
              fontFamily: "var(--mono)",
            }}
          >
            <div style={{ color: "var(--red)" }}>{t("overview.oldAlias", { alias: original.hostAlias })}</div>
            <div style={{ color: "var(--green)", marginTop: 2 }}>{t("overview.newAlias", { alias: updated.hostAlias })}</div>
          </div>

          <div className="callout warn sm">
            {t("overview.confirmAliasRisk", { alias: original.hostAlias })}
          </div>
        </div>

        <div className="card-head" style={{ justifyContent: "flex-end", gap: 8, borderTop: "1px solid var(--border)", borderBottom: "none" }}>
          <button type="button" className="btn ghost sm" onClick={onCancel}>
            {t("overview.backEdit")}
          </button>
          <button type="button" className="btn primary sm" onClick={onConfirm}>
            {t("overview.confirmAlias")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function DeleteIdentityModal({
  identity,
  onCancel,
  onConfirm,
}: {
  identity: Identity;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="wizard-overlay" style={{ zIndex: 60 }}>
      <div className="card" style={{ width: 400, maxWidth: "95%", border: "1px solid var(--red)" }}>
        <div className="card-head" style={{ background: "var(--red-soft)" }}>
          <div className="row" style={{ gap: 6, color: "var(--red)" }}>
            <Trash2 size={16} />
            <div className="card-title" style={{ color: "var(--red)", fontWeight: 700 }}>
              {t("overview.deleteTitle")}
            </div>
          </div>
        </div>

        <div className="card-body stack" style={{ gap: 10, padding: "14px 16px" }}>
          <div>{t("overview.deleteMsg", { name: identity.name, alias: identity.hostAlias })}</div>
          <div className="callout danger sm">{t("overview.deleteDetail")}</div>
        </div>

        <div className="card-head" style={{ justifyContent: "flex-end", gap: 8, borderTop: "1px solid var(--border)", borderBottom: "none" }}>
          <button type="button" className="btn ghost sm" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn danger sm" onClick={onConfirm}>
            {t("common.confirmDelete")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function OverviewIdentityDialogs({
  editingIdentity,
  confirmAliasChange,
  deletingIdentity,
  onCloseEdit,
  onSave,
  onAskDelete,
  onCancelAlias,
  onConfirmAlias,
  onCancelDelete,
  onConfirmDelete,
}: {
  editingIdentity: Identity | null;
  confirmAliasChange: { original: Identity; updated: UpdateIdentityArgs } | null;
  deletingIdentity: Identity | null;
  onCloseEdit: () => void;
  onSave: (form: UpdateIdentityArgs) => Promise<void>;
  onAskDelete: (identity: Identity) => void;
  onCancelAlias: () => void;
  onConfirmAlias: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}) {
  return (
    <>
      {editingIdentity && (
        <EditIdentityModal
          identity={editingIdentity}
          onClose={onCloseEdit}
          onSave={onSave}
          onDelete={onAskDelete}
        />
      )}
      {confirmAliasChange && (
        <ConfirmAliasModal
          original={confirmAliasChange.original}
          updated={confirmAliasChange.updated}
          onCancel={onCancelAlias}
          onConfirm={onConfirmAlias}
        />
      )}
      {deletingIdentity && (
        <DeleteIdentityModal
          identity={deletingIdentity}
          onCancel={onCancelDelete}
          onConfirm={onConfirmDelete}
        />
      )}
    </>
  );
}
