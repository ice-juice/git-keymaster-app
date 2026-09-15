import {
  ChevronDown,
  Clock,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Pencil,
  Plus,
  Check,
  Edit3,
} from "lucide-react";
import { api, type AccountEntry } from "../lib/ipc";
import { Badge, Empty } from "../ui/common";
import { IconMark } from "../ui/IconMark";
import { CountdownRing } from "../ui/CountdownRing";
import { MobileListToolbar } from "../ui/MobileListToolbar";
import { useTranslation } from "react-i18next";
import { useAccountsModel, type AccountsModel } from "../shared/hooks/useAccountsModel";
import { AccountsDialogs, AccountsFilters } from "./Accounts.shared";

function AccountMobileCard({ e, m }: { e: AccountEntry; m: AccountsModel }) {
  const { t } = useTranslation();
  const linked = e.totpRef ? m.totpShown[e.totpRef] : undefined;
  const isCopiedUser = m.copiedKey === `user-${e.id}`;
  const isCopiedPw = m.copiedKey === `pw-${e.id}`;
  const isCopiedTotp = e.totpRef ? m.copiedKey === `totp-${e.totpRef}` : false;
  const pwMissing = e.hasPassword === false;

  return (
    <div className="m-account-card">
      {/* 1. 账号身份与标签 */}
      <div className="m-account-card-user-row">
        <div className="m-account-user-title">
          <span className="m-account-username">{e.username}</span>
          {e.pinned && <Badge kind="warn">{t("accounts.pinned")}</Badge>}
          {e.tags?.map((tag) => (
            <Badge key={tag}>{tag}</Badge>
          ))}
        </div>
        <div className="m-account-meta-line">
          {e.displayName && <span>{e.displayName}</span>}
          {e.displayName && e.note && <span>·</span>}
          {e.note && <span className="muted">{e.note}</span>}
          {(e.displayName || e.note) && e.lastUsedAt && <span>·</span>}
          {e.lastUsedAt && (
            <span className="muted" title={t("accounts.lastUsed")}>
              {t("accounts.usedAt", { time: e.lastUsedAt.slice(0, 16) })}
            </span>
          )}
        </div>
      </div>

      {pwMissing && (
        <div className="callout danger sm" style={{ margin: 0 }}>
          {t("accounts.pwLost")}
        </div>
      )}

      {/* 2. 密码展示与快捷复制行 */}
      <div className="m-account-pwd-bar">
        <span className="m-account-pwd-text">
          {m.pwShown[e.id] || "••••••••"}
        </span>
        <div className="m-account-pwd-btns">
          {m.pwShown[e.id] ? (
            <button
              type="button"
              className="btn ghost sm"
              style={{ padding: "4px 6px" }}
              title={t("accounts.hidePw")}
              onClick={() => m.hidePw(e.id)}
            >
              <EyeOff size={14} />
            </button>
          ) : (
            <button
              type="button"
              className="btn ghost sm"
              style={{ padding: "4px 6px" }}
              title={pwMissing ? t("accounts.pwLostShort") : t("accounts.showPw")}
              disabled={pwMissing}
              onClick={() => m.revealPw(e.id)}
            >
              <Eye size={14} />
            </button>
          )}

          <button
            type="button"
            className={"btn sm " + (isCopiedPw ? "good" : "primary")}
            style={{ padding: "4px 10px", minHeight: 32 }}
            title={pwMissing ? t("accounts.pwLostShort") : t("accounts.copyPw")}
            disabled={pwMissing}
            onClick={() => m.copyPw(e.id)}
          >
            {isCopiedPw ? (
              <>
                <Check size={12} /> {t("common.copied")}
              </>
            ) : (
              <>
                <Copy size={12} /> {t("accounts.password")}
              </>
            )}
          </button>
        </div>
      </div>

      {/* 3. 若有关联 2FA，展示专属横条 */}
      {e.totpRef && (
        <div className="m-account-totp-bar">
          <div className="m-account-totp-code">
            <span className="linked-totp-badge">2FA</span>
            {linked ? (
              <>
                <span>{linked.code}</span>
                <CountdownRing remain={linked.remain} period={linked.period} size={20} />
              </>
            ) : (
              <span className="muted" style={{ letterSpacing: "0.1em" }}>••••••</span>
            )}
          </div>
          <div className="row" style={{ gap: 4 }}>
            {!linked && (
              <button
                type="button"
                className="btn ghost sm"
                style={{ padding: "3px 6px" }}
                onClick={() => m.revealLinkedTotp(e.totpRef!)}
              >
                <Eye size={13} />
              </button>
            )}
            {linked && (
              <button
                type="button"
                className={"btn sm " + (isCopiedTotp ? "good" : "primary")}
                style={{ padding: "3px 8px", minHeight: 28, fontSize: 11.5 }}
                onClick={() => m.copyLinkedTotp(e.totpRef!)}
              >
                {isCopiedTotp ? <Check size={11} /> : <Copy size={11} />}
                <span>{isCopiedTotp ? t("common.copied") : t("accounts.copy2fa")}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* 4. 底栏操作按钮组 */}
      <div className="m-account-actions-row">
        <button
          type="button"
          className={"btn sm " + (isCopiedUser ? "good" : "ghost")}
          title={t("accounts.copyUser")}
          onClick={() => m.copyUsername(e.id, e.username)}
        >
          {isCopiedUser ? <Check size={12} /> : <Copy size={12} />}
          <span>{isCopiedUser ? t("accounts.copiedAccount") : t("accounts.copyAccount")}</span>
        </button>

        <button
          type="button"
          className="btn ghost sm"
          title={t("accounts.history")}
          onClick={() => m.openHistory(e.id)}
        >
          <Clock size={12} />
          <span>{t("accounts.historyShort")}</span>
        </button>

        <button
          type="button"
          className="btn sm"
          disabled={m.writesLocked}
          title={t("accounts.edit")}
          onClick={() => m.setEditor({ ...e })}
        >
          <Edit3 size={12} />
          <span>{t("common.edit")}</span>
        </button>
      </div>
    </div>
  );
}

function AccountsMobileList({ m }: { m: AccountsModel }) {
  const { t } = useTranslation();
  if (m.platforms.length === 0) {
    return <Empty text={m.q ? t("accounts.emptySearch") : t("accounts.emptyMobile")} />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {m.platforms.map(([platform, list]) => {
        const folded = !!m.collapsed[platform];
        const iconItem = list.find((e) => e.icon)?.icon || list[0]?.icon;
        const urlItem = list.find((e) => e.url)?.url;

        return (
          <div key={platform} style={{ display: "flex", flexDirection: "column" }}>
            {/* 平台分组 Header */}
            <div
              className="m-platform-header"
              onClick={() =>
                m.setCollapsed((prev) => ({ ...prev, [platform]: !prev[platform] }))
              }
            >
              <div className="m-platform-header-left">
                <ChevronDown
                  size={16}
                  style={{
                    color: "var(--text-mute)",
                    transform: folded ? "rotate(-90deg)" : "none",
                    transition: "transform 0.15s ease",
                  }}
                />
                <IconMark icon={iconItem} builtins={m.builtins} label={platform} size={28} />
                <span className="m-platform-name">{platform}</span>
                {urlItem && (
                  <span
                    role="button"
                    tabIndex={0}
                    className="btn ghost sm"
                    style={{ padding: "2px 4px", display: "inline-flex", alignItems: "center" }}
                    title={t("accounts.openSite")}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      void api.openUrl(urlItem);
                    }}
                  >
                    <ExternalLink size={12} />
                  </span>
                )}
                <Badge kind="info">{list.length}</Badge>
              </div>

              <div className="m-platform-ops" onClick={(ev) => ev.stopPropagation()}>
                <button
                  type="button"
                  className="btn ghost sm"
                  style={{ padding: "4px 8px", fontSize: 12 }}
                  title={t("accounts.editPlatform")}
                  onClick={() =>
                    m.setEditingPlatformModal({
                      platform,
                      icon: list.find((e) => e.icon)?.icon ?? undefined,
                    })
                  }
                >
                  <Pencil size={12} />
                  <span>{t("accounts.rename")}</span>
                </button>

                <button
                  type="button"
                  className="btn sm"
                  style={{ padding: "4px 10px", fontSize: 12 }}
                  onClick={() =>
                    m.setEditor({
                      platform,
                      url: list.find((e) => e.url)?.url,
                      icon: list.find((e) => e.icon)?.icon ?? undefined,
                      isPlatformLocked: true,
                    })
                  }
                >
                  <Plus size={12} />
                  <span>{t("pages.add")}</span>
                </button>
              </div>
            </div>

            {/* 展开的账号卡片列表 */}
            {!folded && (
              <div className="m-account-list">
                {list.map((e) => (
                  <AccountMobileCard key={e.id} e={e} m={m} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function AccountsMobile() {
  const { t } = useTranslation();
  const m = useAccountsModel();

  return (
    <div className="stack-lg">
      <MobileListToolbar
        query={m.q}
        onQueryChange={m.setQ}
        placeholder={t("accounts.searchShort")}
        addLabel={t("pages.add")}
        addDisabled={m.writesLocked}
        onAdd={() => m.setEditor({})}
      />

      <AccountsFilters m={m} hideSearch />
      <AccountsMobileList m={m} />
      <AccountsDialogs m={m} compact />
    </div>
  );
}
