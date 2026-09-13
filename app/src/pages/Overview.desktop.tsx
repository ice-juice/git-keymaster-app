import { RefreshCw, Plus, Copy, Check, Activity, Edit3, AlertCircle } from "lucide-react";
import { PageHead, Empty, Badge } from "../ui/common";
import { getAvatarBg, useOverviewModel } from "../shared/hooks/useOverviewModel";
import { OverviewIdentityDialogs } from "./Overview.modals";

export function OverviewDesktop() {
  const m = useOverviewModel();

  return (
    <div className="stack-lg">
      <PageHead
        title="身份总览"
        desc="所有 Git 身份的密钥、配置、Agent 与连通状态"
        actions={
          <>
            <button
              type="button"
              className="btn"
              disabled={m.loadingAll || m.identities.length === 0}
              onClick={m.handleTestAll}
              title="重新检测配置、Agent与所有身份的SSH连通性"
            >
              <RefreshCw size={13} className={m.loadingAll ? "animate-spin" : ""} />
              <span>{m.loadingAll ? "体检中…" : "一键体检"}</span>
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={m.writesLocked}
              title={m.writesLocked ? "正在同步，暂不可新建" : undefined}
              onClick={m.goNewIdentity}
            >
              <Plus size={14} />
              <span>新建身份</span>
            </button>
          </>
        }
      />

      {m.err && (
        <div className="callout danger sm" style={{ marginBottom: 4 }}>
          <AlertCircle size={14} />
          <span>{m.err}</span>
        </div>
      )}

      <div className="stat-card-row">
        <div className="stat-card">
          <div className="stat-card-title">
            <span style={{ color: "var(--accent)" }}>◆</span>
            <span>身份总数</span>
          </div>
          <div className="stat-card-body">
            <div className="stat-card-val">{m.stats.totalIdentities}</div>
            <div className="stat-card-sub">已登记身份</div>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-card-title">
            <span style={{ color: "var(--amber)" }}>🔒</span>
            <span>已入库密钥</span>
          </div>
          <div className="stat-card-body">
            <div className="stat-card-val">{m.stats.totalKeys}</div>
            <div className="stat-card-sub" style={{ color: "var(--green)" }}>
              全部加密
            </div>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-card-title">
            <span style={{ color: "var(--green)" }}>🟢</span>
            <span>连通正常</span>
          </div>
          <div className="stat-card-body">
            <div className="stat-card-val">
              <span style={{ color: "var(--green)" }}>{m.stats.okCount}</span>
              <span style={{ fontSize: 13, color: "var(--text-mute)", fontWeight: 500 }}>
                {" "}
                / {m.stats.totalIdentities}
              </span>
            </div>
            <div className="stat-card-sub">
              {m.stats.okCount === m.stats.totalIdentities && m.stats.totalIdentities > 0
                ? "全部畅通"
                : "已体检"}
            </div>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-card-title">
            <span style={{ color: "var(--amber)" }}>▲</span>
            <span>待处理问题</span>
          </div>
          <div className="stat-card-body">
            <div
              className="stat-card-val"
              style={{ color: m.stats.issuesCount > 0 ? "var(--amber)" : "var(--text)" }}
            >
              {m.stats.issuesCount}
            </div>
            <div className="stat-card-sub">
              {m.stats.issuesCount > 0 ? "需关注修复" : "状态良好"}
            </div>
          </div>
        </div>
      </div>

      {m.identities.length === 0 ? (
        <div className="card" style={{ padding: "30px 10px" }}>
          <Empty icon="🧑‍💻" text="还没有配置 Git 身份。点击右上角「新建身份」开始添加。" />
        </div>
      ) : (
        <div className="grid c3">
          {m.identities.map((id, index) => {
            const keyRecord = m.keys.find((k) => k.id === id.keyId);
            const hasKey = !!keyRecord;
            const keyDot = hasKey ? "g" : "r";

            const block = m.configView?.blocks.find((b) => b.patterns.includes(id.hostAlias));
            const hasIdentitiesOnly = block?.options.some(
              ([k, v]) => k.toLowerCase() === "identitiesonly" && v.toLowerCase() === "yes",
            );
            const configDot = !block ? "r" : !hasIdentitiesOnly ? "y" : "g";

            const inAgent =
              m.agentStatus?.running &&
              m.agentStatus?.keys.some(
                (ak) =>
                  ak.identityName === id.name ||
                  (keyRecord && ak.agent.fingerprint === keyRecord.fingerprint),
              );
            const agentDot = inAgent ? "g" : "gray";

            const test = m.testResults[id.hostAlias];
            const testDot = test?.loading
              ? "y"
              : test?.result?.ok
                ? "g"
                : test?.result
                  ? "r"
                  : "gray";

            let calloutContent: {
              type: "warn" | "danger" | "info" | "good";
              text: string;
              actionText?: string;
              onAction?: () => void;
            } | null = null;

            if (!hasIdentitiesOnly && block) {
              calloutContent = {
                type: "warn",
                text: "▲ 配置缺少 IdentitiesOnly yes，可能串号",
                actionText: "一键修复",
                onAction: () => m.handleFixConfig(id),
              };
            } else if (!inAgent) {
              calloutContent = {
                type: "danger",
                text: "✕ 密钥未加载进 Agent",
                actionText: "一键加载",
                onAction: () => m.handleLoadToAgent(id.id),
              };
            } else if (test?.result) {
              if (test.result.ok) {
                calloutContent = {
                  type: "info",
                  text: `● 上次体检: ${test.result.account ? `Hi ${test.result.account} ✓ 账号匹配` : "连通成功"}`,
                };
              } else {
                calloutContent = {
                  type: "danger",
                  text: `✕ 连通失败: ${test.result.message || "请检查网络或公钥部署"}`,
                };
              }
            }

            const initialLetter = (id.name || "G").charAt(0).toUpperCase();
            const isDefault = index === 0;

            return (
              <div className="identity-card" key={id.id}>
                <div className="id-card-head">
                  <div className="id-avatar" style={{ background: getAvatarBg(id.name) }}>
                    {initialLetter}
                  </div>
                  <div className="id-head-meta">
                    <div className="id-name-row">
                      <span className="id-name" title={id.name}>
                        {id.name}
                      </span>
                      {isDefault && <Badge kind="info">默认</Badge>}
                      {id.strictMode && <Badge kind="warn">严格</Badge>}
                    </div>
                    <div className="id-sub" title={`${id.hostAlias} → ${id.realHost}`}>
                      {id.hostAlias === id.realHost
                        ? id.realHost
                        : `${id.hostAlias} → ${id.realHost}`}
                    </div>
                  </div>
                </div>

                <div className="status-bar-4">
                  <div className="status-col">
                    <span className={`status-dot ${keyDot}`} />
                    <span className="status-dot-label">密钥</span>
                  </div>
                  <div className="status-col">
                    <span className={`status-dot ${configDot}`} />
                    <span className="status-dot-label">配置</span>
                  </div>
                  <div className="status-col">
                    <span className={`status-dot ${agentDot}`} />
                    <span className="status-dot-label">Agent</span>
                  </div>
                  <div className="status-col">
                    <span className={`status-dot ${testDot}`} />
                    <span className="status-dot-label">连通</span>
                  </div>
                </div>

                {calloutContent && (
                  <div className={`id-callout ${calloutContent.type}`}>
                    <span
                      style={{
                        overflow: "hidden",
                        textOverflow: calloutContent.text.includes("\n") ? undefined : "ellipsis",
                        whiteSpace: calloutContent.text.includes("\n") ? "pre-wrap" : "nowrap",
                        flex: 1,
                      }}
                      title={calloutContent.text}
                    >
                      {calloutContent.text}
                    </span>
                    {calloutContent.actionText && (
                      <button
                        type="button"
                        style={{
                          fontWeight: 600,
                          textDecoration: "underline",
                          cursor: "pointer",
                          flexShrink: 0,
                          fontSize: 10.5,
                        }}
                        onClick={calloutContent.onAction}
                      >
                        {calloutContent.actionText}
                      </button>
                    )}
                  </div>
                )}

                {id.owners.length > 0 && (
                  <div className="owners-wrap">
                    {id.owners.map((owner) => (
                      <span className="owner-tag" key={owner}>
                        {owner}
                      </span>
                    ))}
                  </div>
                )}

                <div
                  className="row"
                  style={{
                    marginTop: "auto",
                    paddingTop: 6,
                    borderTop: "1px solid var(--border)",
                    justifyContent: "space-between",
                  }}
                >
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={m.writesLocked}
                    onClick={() => m.setEditingIdentity(id)}
                    title={m.writesLocked ? "正在同步，暂不可修改" : "修改备注、别名、邮箱、提交姓名等"}
                  >
                    <Edit3 size={12} />
                    <span>详情</span>
                  </button>

                  <div className="row" style={{ gap: 4 }}>
                    <button
                      type="button"
                      className="btn sm"
                      disabled={!id.keyId}
                      onClick={() => m.handleCopyPublic(id.keyId)}
                      title="复制此身份绑定的 OpenSSH 公钥"
                    >
                      {m.copiedKeyId === id.keyId ? (
                        <>
                          <Check size={12} style={{ color: "var(--green)" }} />
                          <span style={{ color: "var(--green)" }}>已复制</span>
                        </>
                      ) : (
                        <>
                          <Copy size={12} />
                          <span>复制公钥</span>
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      className="btn sm"
                      disabled={test?.loading}
                      onClick={() => m.handleTestConnection(id.hostAlias)}
                      title="测试与此身份的 SSH 连通性"
                    >
                      <Activity size={12} />
                      <span>{test?.loading ? "测试中…" : "体检"}</span>
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <OverviewIdentityDialogs
        editingIdentity={m.editingIdentity}
        confirmAliasChange={m.confirmAliasChange}
        deletingIdentity={m.deletingIdentity}
        onCloseEdit={() => m.setEditingIdentity(null)}
        onSave={m.handleSaveIdentity}
        onAskDelete={(id) => m.setDeletingIdentity(id)}
        onCancelAlias={() => m.setConfirmAliasChange(null)}
        onConfirmAlias={() => m.confirmAliasChange && m.executeUpdateIdentity(m.confirmAliasChange.updated)}
        onCancelDelete={() => m.setDeletingIdentity(null)}
        onConfirmDelete={() => m.deletingIdentity && m.handleDeleteIdentity(m.deletingIdentity.id)}
      />
    </div>
  );
}
