import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, ChevronRight, Copy, Edit3, FileLock2, KeyRound, NotebookPen, Shield } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/ipc";
import { Badge, Empty } from "../ui/common";
import { formatBytes } from "../shared/hooks/useFilesModel";
import { useOverviewModel } from "../shared/hooks/useOverviewModel";
import { OverviewIdentityDialogs } from "./Overview.modals";

function getAvatarBg(name: string): string {
  const colors = [
    "#6366f1",
    "#ec4899",
    "#8b5cf6",
    "#10b981",
    "#f59e0b",
    "#3b82f6",
    "#06b6d4",
    "#f97316",
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

export function OverviewMobile() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const m = useOverviewModel();
  const [vault, setVault] = useState({ count: 0, usage: 0 });
  const [notes, setNotes] = useState({ count: 0, pinned: 0 });

  useEffect(() => {
    api
      .fileList()
      .then((r) => setVault({ count: r.entries.length, usage: r.usageBytes }))
      .catch(() => {});
    api
      .noteList()
      .then((r) => setNotes({ count: r.entries.length, pinned: r.entries.filter((e) => e.pinned).length }))
      .catch(() => {});
  }, [m.writesLocked]);

  return (
    <div className="stack-lg">
      {/* 顶部统计卡片 */}
      <div className="stat-card-row">
        <div className="stat-card">
          <div className="stat-card-title">
            <Shield size={14} style={{ color: "var(--accent)" }} />
            <span>{t("pages.idCount")}</span>
          </div>
          <div className="stat-card-body">
            <div className="stat-card-val">{m.stats.totalIdentities}</div>
            <div className="stat-card-sub">{t("pages.idRegistered")}</div>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-card-title">
            <KeyRound size={14} style={{ color: "var(--amber)" }} />
            <span>{t("pages.keyCount")}</span>
          </div>
          <div className="stat-card-body">
            <div className="stat-card-val">{m.stats.totalKeys}</div>
            <div className="stat-card-sub" style={{ color: "var(--green)" }}>
              {t("pages.allEncrypted")}
            </div>
          </div>
        </div>
      </div>

      <button type="button" className="m-vault-entry" onClick={() => nav("/files", { replace: true })}>
        <span className="m-vault-entry-icon">
          <FileLock2 size={18} />
        </span>
        <span className="m-vault-entry-copy">
          <span className="m-vault-entry-title">{t("pages.filesEntry")}</span>
          <span className="m-vault-entry-sub">
            {t("pages.filesEntrySub", { count: vault.count, size: formatBytes(vault.usage) })}
          </span>
        </span>
        <ChevronRight size={18} className="m-vault-entry-arrow" />
      </button>

      <button type="button" className="m-vault-entry" onClick={() => nav("/notes", { replace: true })}>
        <span className="m-vault-entry-icon">
          <NotebookPen size={18} />
        </span>
        <span className="m-vault-entry-copy">
          <span className="m-vault-entry-title">{t("pages.notesEntry")}</span>
          <span className="m-vault-entry-sub">
            {t("pages.notesEntrySub", { count: notes.count, pinned: notes.pinned })}
          </span>
        </span>
        <ChevronRight size={18} className="m-vault-entry-arrow" />
      </button>

      {m.identities.length === 0 ? (
        <div className="card" style={{ padding: "30px 10px" }}>
          <Empty icon="🧑‍💻" text={t("pages.noIdentities")} />
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {m.identities.map((id, index) => {
            const keyRecord = m.keys.find((k) => k.id === id.keyId);
            const hasKey = !!keyRecord;
            const keyDot = hasKey ? "g" : "r";
            const initialLetter = (id.name || "G").charAt(0).toUpperCase();
            const isDefault = index === 0;

            return (
              <div className="m-id-card" key={id.id}>
                {/* 1. 卡片头 */}
                <div className="m-id-card-head">
                  <div className="m-id-avatar" style={{ background: getAvatarBg(id.name) }}>
                    {initialLetter}
                  </div>
                  <div className="m-id-head-meta">
                    <div className="m-id-name-line">
                      <span className="m-id-name">{id.name}</span>
                      {isDefault && <Badge kind="info">{t("pages.default")}</Badge>}
                      {id.strictMode && <Badge kind="warn">{t("overview.strict")}</Badge>}
                    </div>
                    <div className="m-id-route" title={`${id.hostAlias} → ${id.realHost}`}>
                      {id.hostAlias === id.realHost ? id.realHost : `${id.hostAlias} → ${id.realHost}`}
                    </div>
                  </div>
                </div>

                {/* 2. 状态胶囊与所有者 */}
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  <div className="m-id-key-pill">
                    <span className={`status-dot ${keyDot}`} />
                    <span>{hasKey ? t("overview.keyBound") : t("overview.keyUnbound")}</span>
                  </div>

                  {id.owners.map((owner) => (
                    <span className="owner-tag" key={owner}>
                      {owner}
                    </span>
                  ))}
                </div>

                {/* 3. 底部操作栏 */}
                <div className="m-id-actions">
                  <button
                    type="button"
                    className="btn ghost sm"
                    style={{ flex: "0 0 80px" }}
                    disabled={m.writesLocked}
                    onClick={() => m.setEditingIdentity(id)}
                    title={t("overview.editTipShort")}
                  >
                    <Edit3 size={13} />
                    <span>{t("overview.detail")}</span>
                  </button>

                  <button
                    type="button"
                    className={"btn sm " + (m.copiedKeyId === id.keyId ? "good" : "primary")}
                    style={{ flex: 1 }}
                    disabled={!id.keyId}
                    onClick={() => m.handleCopyPublic(id.keyId)}
                  >
                    {m.copiedKeyId === id.keyId ? (
                      <>
                        <Check size={13} />
                        <span>{t("overview.copiedPub")}</span>
                      </>
                    ) : (
                      <>
                        <Copy size={13} />
                        <span>{t("overview.copyPub")}</span>
                      </>
                    )}
                  </button>
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
