import { RefreshCw, Plus, Copy, Check, Activity, Edit3, AlertCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PageHead, Empty, Badge } from "../ui/common";
import { getAvatarBg, useOverviewModel } from "../shared/hooks/useOverviewModel";
import { OverviewIdentityDialogs } from "./Overview.modals";
import { useItemFocus } from "../shared/hooks/useItemFocus";

export function OverviewDesktop() {
  const { t } = useTranslation();
  const m = useOverviewModel();
  useItemFocus(m.identities.length > 0);

  return (
    <div className="stack-lg">
      <PageHead
        title={t("pages.overviewTitle")}
        desc={t("pages.overviewDesc")}
        actions={
          <>
            <button
              type="button"
              className="btn"
              disabled={m.loadingAll || m.identities.length === 0}
              onClick={m.handleTestAll}
              title={t("overview.healthTitle")}
            >
              <RefreshCw size={13} className={m.loadingAll ? "animate-spin" : ""} />
              <span>{m.loadingAll ? t("pages.healthChecking") : t("pages.healthCheck")}</span>
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={m.writesLocked}
              title={m.writesLocked ? t("overview.syncLockedNew") : undefined}
              onClick={m.goNewIdentity}
            >
              <Plus size={14} />
              <span>{t("pages.newIdentity")}</span>
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
            <span>{t("pages.idCount")}</span>
          </div>
          <div className="stat-card-body">
            <div className="stat-card-val">{m.stats.totalIdentities}</div>
            <div className="stat-card-sub">{t("pages.idRegistered")}</div>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-card-title">
            <span style={{ color: "var(--amber)" }}>🔒</span>
            <span>{t("pages.keyCount")}</span>
          </div>
          <div className="stat-card-body">
            <div className="stat-card-val">{m.stats.totalKeys}</div>
            <div className="stat-card-sub" style={{ color: "var(--green)" }}>
              {t("pages.allEncrypted")}
            </div>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-card-title">
            <span style={{ color: "var(--green)" }}>🟢</span>
            <span>{t("overview.connectedOk")}</span>
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
                ? t("overview.allClear")
                : t("overview.checked")}
            </div>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-card-title">
            <span style={{ color: "var(--amber)" }}>▲</span>
            <span>{t("overview.issues")}</span>
          </div>
          <div className="stat-card-body">
            <div
              className="stat-card-val"
              style={{ color: m.stats.issuesCount > 0 ? "var(--amber)" : "var(--text)" }}
            >
              {m.stats.issuesCount}
            </div>
            <div className="stat-card-sub">
              {m.stats.issuesCount > 0 ? t("overview.needFix") : t("overview.healthy")}
            </div>
          </div>
        </div>
      </div>

      {m.identities.length === 0 ? (
        <div className="card" style={{ padding: "30px 10px" }}>
          <Empty icon="🧑‍💻" text={t("overview.empty")} />
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
                text: t("overview.fixIdentitiesOnly"),
                actionText: t("overview.fixNow"),
                onAction: () => m.handleFixConfig(id),
              };
            } else if (!inAgent) {
              calloutContent = {
                type: "danger",
                text: t("overview.keyNotInAgent"),
                actionText: t("overview.loadNow"),
                onAction: () => m.handleLoadToAgent(id.id),
              };
            } else if (test?.result) {
              if (test.result.ok) {
                calloutContent = {
                  type: "info",
                  text: test.result.account
                    ? t("overview.lastOkNamed", { account: test.result.account })
                    : t("overview.lastOk"),
                };
              } else {
                calloutContent = {
                  type: "danger",
                  text: t("overview.lastFail", { msg: test.result.message || t("overview.failFallback") }),
                };
              }
            }

            const initialLetter = (id.name || "G").charAt(0).toUpperCase();
            const isDefault = index === 0;

            return (
              <div className="identity-card" key={id.id} data-focus-id={id.id}>
                <div className="id-card-head">
                  <div className="id-avatar" style={{ background: getAvatarBg(id.name) }}>
                    {initialLetter}
                  </div>
                  <div className="id-head-meta">
                    <div className="id-name-row">
                      <span className="id-name" title={id.name}>
                        {id.name}
                      </span>
                      {isDefault && <Badge kind="info">{t("pages.default")}</Badge>}
                      {id.strictMode && <Badge kind="warn">{t("overview.strict")}</Badge>}
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
                    <span className="status-dot-label">{t("overview.dotKey")}</span>
                  </div>
                  <div className="status-col">
                    <span className={`status-dot ${configDot}`} />
                    <span className="status-dot-label">{t("overview.dotConfig")}</span>
                  </div>
                  <div className="status-col">
                    <span className={`status-dot ${agentDot}`} />
                    <span className="status-dot-label">Agent</span>
                  </div>
                  <div className="status-col">
                    <span className={`status-dot ${testDot}`} />
                    <span className="status-dot-label">{t("overview.dotConn")}</span>
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
                    title={m.writesLocked ? t("overview.syncLockedEdit") : t("overview.editTip")}
                  >
                    <Edit3 size={12} />
                    <span>{t("overview.detail")}</span>
                  </button>

                  <div className="row" style={{ gap: 4 }}>
                    <button
                      type="button"
                      className="btn sm"
                      disabled={!id.keyId}
                      onClick={() => m.handleCopyPublic(id.keyId)}
                      title={t("overview.copyPubTip")}
                    >
                      {m.copiedKeyId === id.keyId ? (
                        <>
                          <Check size={12} style={{ color: "var(--green)" }} />
                          <span style={{ color: "var(--green)" }}>{t("overview.copied")}</span>
                        </>
                      ) : (
                        <>
                          <Copy size={12} />
                          <span>{t("overview.copyPub")}</span>
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      className="btn sm"
                      disabled={test?.loading}
                      onClick={() => m.handleTestConnection(id.hostAlias)}
                      title={t("overview.testTip")}
                    >
                      <Activity size={12} />
                      <span>{test?.loading ? t("overview.testing") : t("overview.health")}</span>
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
