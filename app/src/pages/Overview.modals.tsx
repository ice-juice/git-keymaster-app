import { useState } from "react";
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
    if (!name.trim()) return setErr("请填写身份备注名");
    if (!hostAlias.trim()) return setErr("请填写 Host 别名");
    if (!realHost.trim()) return setErr("请填写真实主机地址");

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
            <div className="card-title">微调身份配置：{identity.name}</div>
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
                <label className="field-label">身份备注名 *</label>
                <input
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="如 nova-labs"
                  required
                />
              </div>

              <div className="field">
                <label className="field-label">Git 平台</label>
                <select
                  className="input"
                  value={platform}
                  onChange={(e) => setPlatform(e.target.value)}
                >
                  <option value="github">GitHub</option>
                  <option value="gitlab">GitLab</option>
                  <option value="gitee">Gitee</option>
                  <option value="codeup">阿里云 Codeup</option>
                  <option value="custom">自建 / 自定义</option>
                </select>
              </div>
            </div>

            <div className="grid c2">
              <div className="field">
                <label className="field-label">Host 别名 *</label>
                <input
                  className="input mono"
                  value={hostAlias}
                  onChange={(e) => setHostAlias(e.target.value)}
                  placeholder="如 github-nova-labs"
                  required
                />
                <div className="hint">用于 git clone git@{hostAlias || "alias"}:...</div>
              </div>

              <div className="field">
                <label className="field-label">真实服务器 Host *</label>
                <input
                  className="input mono"
                  value={realHost}
                  onChange={(e) => setRealHost(e.target.value)}
                  placeholder="如 github.com"
                  required
                />
              </div>
            </div>

            {isAliasModified && (
              <div className="callout warn sm">
                ⚠️ 修改 Host 别名会同步改写 ~/.ssh/config。如果已有本地仓库使用了原别名，需同步更新 remote 地址。
              </div>
            )}

            <div className="grid c2">
              <div className="field">
                <label className="field-label">SSH 登录用户名</label>
                <input
                  className="input mono"
                  value={user}
                  onChange={(e) => setUser(e.target.value)}
                  placeholder="默认 git"
                />
              </div>

              <div className="field">
                <label className="field-label">提交邮箱 (user.email)</label>
                <input
                  className="input"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="用于 commit 记录"
                />
              </div>
            </div>

            <div className="field">
              <label className="field-label">提交人姓名 (user.name)</label>
              <input
                className="input"
                value={gitUserName}
                onChange={(e) => setGitUserName(e.target.value)}
                placeholder="可选，留空则保持仓库默认"
              />
            </div>

            <div className="field">
              <label className="field-label">归属标识 / Organization 组织前缀</label>
              <input
                className="input mono"
                value={ownersText}
                onChange={(e) => setOwnersText(e.target.value)}
                placeholder="以逗号分隔，如 nova-labs, polar-box, acme-*"
              />
              <div className="hint">当识别包含这些组织名的仓库地址时，将自动推荐并映射该身份。</div>
            </div>

            <div className="field" style={{ marginTop: 2 }}>
              <div className="between" style={{ padding: "6px 0" }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 11.5 }}>严格私钥安全模式</div>
                  <div className="hint">严格模式下私钥永不落盘 ~/.ssh，仅存加密库；必须依赖 ssh-agent。</div>
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
              <span>删除身份</span>
            </button>

            <div className="row" style={{ gap: 6 }}>
              <button type="button" className="btn ghost sm" onClick={onClose}>
                取消
              </button>
              <button type="submit" className="btn primary sm" disabled={busy}>
                {busy ? "保存中…" : "保存修改"}
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
  return (
    <div className="wizard-overlay" style={{ zIndex: 60 }}>
      <div className="card" style={{ width: 440, maxWidth: "95%", border: "1px solid var(--amber)" }}>
        <div className="card-head" style={{ background: "var(--amber-soft)" }}>
          <div className="row" style={{ gap: 6, color: "var(--amber)" }}>
            <AlertTriangle size={16} />
            <div className="card-title" style={{ color: "var(--amber)", fontWeight: 700 }}>
              关键项修改确认：Host 别名变更
            </div>
          </div>
        </div>

        <div className="card-body stack" style={{ gap: 10, padding: "14px 16px" }}>
          <div style={{ fontSize: 12, lineHeight: 1.5 }}>
            你正在修改身份「<strong>{original.name}</strong>」的核心 Host 别名：
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
            <div style={{ color: "var(--red)" }}>- 旧别名: {original.hostAlias}</div>
            <div style={{ color: "var(--green)", marginTop: 2 }}>+ 新别名: {updated.hostAlias}</div>
          </div>

          <div className="callout warn sm">
            ⚠️ <strong>风险提醒：</strong>
            <br />
            如果已有本地 Git 仓库绑定了原别名（其 Remote 地址形如{" "}
            <code>git@{original.hostAlias}:owner/repo.git</code>），修改后这些仓库的拉取和推送将无法找到 Host！
            <br />
            你需要在「仓库与克隆」页面或通过 git remote 命令同步更新别名地址。
          </div>
        </div>

        <div className="card-head" style={{ justifyContent: "flex-end", gap: 8, borderTop: "1px solid var(--border)", borderBottom: "none" }}>
          <button type="button" className="btn ghost sm" onClick={onCancel}>
            返回修改
          </button>
          <button type="button" className="btn primary sm" onClick={onConfirm}>
            我已知晓风险，确认修改
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
  return (
    <div className="wizard-overlay" style={{ zIndex: 60 }}>
      <div className="card" style={{ width: 400, maxWidth: "95%", border: "1px solid var(--red)" }}>
        <div className="card-head" style={{ background: "var(--red-soft)" }}>
          <div className="row" style={{ gap: 6, color: "var(--red)" }}>
            <Trash2 size={16} />
            <div className="card-title" style={{ color: "var(--red)", fontWeight: 700 }}>
              删除身份确认
            </div>
          </div>
        </div>

        <div className="card-body stack" style={{ gap: 10, padding: "14px 16px" }}>
          <div>
            确定要删除身份「<strong>{identity.name}</strong>」（别名 <code>{identity.hostAlias}</code>）吗？
          </div>
          <div className="callout danger sm">
            此操作将从加密库移除该身份配置，并自动清理 ~/.ssh/config 中的对应 Host 托管段落。关联的密钥不会被删除。
          </div>
        </div>

        <div className="card-head" style={{ justifyContent: "flex-end", gap: 8, borderTop: "1px solid var(--border)", borderBottom: "none" }}>
          <button type="button" className="btn ghost sm" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="btn danger sm" onClick={onConfirm}>
            确认删除
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
