import { useEffect, useState } from "react";
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
  MoreHorizontal,
  Trash2,
} from "lucide-react";
import { api, type AccountEntry, type BuiltinIconInfo } from "../lib/ipc";
import { Badge, Empty } from "../ui/common";
import { IconMark } from "../ui/IconMark";
import { CountdownRing } from "../ui/CountdownRing";
import { MobileListToolbar } from "../ui/MobileListToolbar";
import { useTranslation } from "react-i18next";
import { pushMobileBack } from "../shared/mobileBack";
import { useAccountsModel, type AccountsModel } from "../shared/hooks/useAccountsModel";
import { AccountsDialogs, AccountsFilters } from "./Accounts.shared";
import { AccountMobileEditor } from "./AccountMobileEditor";
import { useItemFocus } from "../shared/hooks/useItemFocus";

function AccountMobileCard({
  e,
  m,
  onMore,
}: {
  e: AccountEntry;
  m: AccountsModel;
  onMore: () => void;
}) {
  const { t } = useTranslation();
  const linked = e.totpRef ? m.totpShown[e.totpRef] : undefined;
  const isCopiedPw = m.copiedKey === `pw-${e.id}`;
  const isCopiedUser = m.copiedKey === `user-${e.id}`;
  const isCopiedTotp = e.totpRef ? m.copiedKey === `totp-${e.totpRef}` : false;
  const pwMissing = e.hasPassword === false;

  const meta = [e.displayName, e.note].filter(Boolean).join(" · ");

  return (
    <div className="m-account-card" data-focus-id={e.id}>
      <div className="m-account-top">
        <div className="m-account-id">
          <div className="m-account-user-title">
            <button
              type="button"
              className={"m-account-user-copy" + (isCopiedUser ? " is-copied" : "")}
              title={t("accounts.copyUser")}
              onClick={() => m.copyUsername(e.id, e.username)}
            >
              {isCopiedUser ? <Check size={14} /> : <Copy size={14} />}
            </button>
            <span className="m-account-username">{e.username}</span>
            {e.pinned && <Badge kind="warn">{t("accounts.pinned")}</Badge>}
            {e.tags?.map((tag) => (
              <Badge key={tag}>{tag}</Badge>
            ))}
          </div>
          {meta && <div className="m-account-meta-line">{meta}</div>}
        </div>
        <div className="m-account-ops">
          <button
            type="button"
            className="m-account-op-btn"
            disabled={m.writesLocked}
            title={t("common.edit")}
            onClick={() => m.setEditor({ ...e })}
          >
            <Edit3 size={14} />
          </button>
          <button type="button" className="m-account-op-btn" title={t("accounts.more")} onClick={onMore}>
            <MoreHorizontal size={16} />
          </button>
        </div>
      </div>

      {pwMissing && (
        <div className="callout danger sm" style={{ margin: 0 }}>
          {t("accounts.pwLost")}
        </div>
      )}

      <div className="m-account-pwd-bar">
        <span className="m-account-pwd-text">
          {m.pwShown[e.id] || "••••••••"}
        </span>
        <div className="m-account-pwd-btns">
          <button
            type="button"
            className="m-account-icon-btn"
            title={m.pwShown[e.id] ? t("accounts.hidePw") : pwMissing ? t("accounts.pwLostShort") : t("accounts.showPw")}
            disabled={pwMissing}
            onClick={() => (m.pwShown[e.id] ? m.hidePw(e.id) : m.revealPw(e.id))}
          >
            {m.pwShown[e.id] ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
          <button
            type="button"
            className={"m-account-pwd-copy" + (isCopiedPw ? " is-copied" : "")}
            title={pwMissing ? t("accounts.pwLostShort") : t("accounts.copyPw")}
            disabled={pwMissing}
            onClick={() => m.copyPw(e.id)}
          >
            {isCopiedPw ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>
      </div>

      {e.totpRef && (
        <div className="m-account-totp-bar">
          <div className="m-account-totp-code">
            <span className="linked-totp-badge">2FA</span>
            {linked ? (
              <>
                <span>{linked.code}</span>
                <CountdownRing remain={linked.remain} period={linked.period} size={18} />
              </>
            ) : (
              <span className="muted" style={{ letterSpacing: "0.1em" }}>••••••</span>
            )}
          </div>
          <button
            type="button"
            className={"m-account-icon-btn" + (isCopiedTotp ? " is-on" : "")}
            onClick={() => (linked ? m.copyLinkedTotp(e.totpRef!) : m.revealLinkedTotp(e.totpRef!))}
          >
            {linked ? (isCopiedTotp ? <Check size={15} /> : <Copy size={15} />) : <Eye size={15} />}
          </button>
        </div>
      )}
    </div>
  );
}

const PLATFORM_COLORS = ["#2563eb", "#db2777", "#d97706", "#7c3aed", "#dc2626", "#0284c7", "#65a30d", "#ea580c"];

function platformAccent(platform: string, icon: string | undefined | null, builtins: BuiltinIconInfo[]): string {
  if (icon?.startsWith("builtin:")) {
    const found = builtins.find((b) => b.id === icon.slice("builtin:".length))?.color;
    if (found) return found;
  }
  let hash = 0;
  for (let i = 0; i < platform.length; i++) hash = (hash * 31 + platform.charCodeAt(i)) >>> 0;
  return PLATFORM_COLORS[hash % PLATFORM_COLORS.length];
}

function AccountsMobileList({ m }: { m: AccountsModel }) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<AccountEntry | null>(null);

  useEffect(() => {
    if (!menu) return;
    return pushMobileBack(() => {
      setMenu(null);
      return true;
    });
  }, [menu]);

  if (m.platforms.length === 0) {
    return <Empty text={m.q ? t("accounts.emptySearch") : t("accounts.emptyMobile")} />;
  }

  return (
    <div className="m-platform-stack">
      {m.platforms.map(([platform, list]) => {
        const folded = !!m.collapsed[platform];
        const iconItem = list.find((e) => e.icon)?.icon || list[0]?.icon;
        const urlItem = list.find((e) => e.url)?.url;
        const accent = platformAccent(platform, iconItem, m.builtins);

        return (
          <section
            key={platform}
            className={"m-platform-group" + (folded ? " is-folded" : "")}
            style={{ ["--m-platform-accent" as string]: accent }}
          >
            <div
              className="m-platform-header"
              role="button"
              tabIndex={0}
              aria-expanded={!folded}
              onClick={() =>
                m.setCollapsed((prev) => ({ ...prev, [platform]: !prev[platform] }))
              }
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  m.setCollapsed((prev) => ({ ...prev, [platform]: !prev[platform] }));
                }
              }}
            >
              <div className="m-platform-header-left">
                <ChevronDown
                  size={16}
                  className={"m-platform-chevron" + (folded ? " is-folded" : "")}
                />
                <IconMark icon={iconItem} builtins={m.builtins} label={platform} size={32} color={accent} />
                <div className="m-platform-copy">
                  <span className="m-platform-name-row">
                    <span className="m-platform-name">{platform}</span>
                    <button
                      type="button"
                      className="m-platform-rename"
                      title={t("accounts.editPlatform")}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        m.setEditingPlatformModal({
                          platform,
                          icon: list.find((e) => e.icon)?.icon ?? undefined,
                        });
                      }}
                    >
                      <Pencil size={13} />
                    </button>
                  </span>
                  <span className="m-platform-count">{t("accounts.accountCount", { n: list.length })}</span>
                </div>
                {urlItem && (
                  <span
                    role="button"
                    tabIndex={0}
                    className="m-platform-link"
                    title={t("accounts.openSite")}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      void api.openUrl(urlItem);
                    }}
                  >
                    <ExternalLink size={14} />
                  </span>
                )}
              </div>
            </div>

            {!folded && (
              <div className="m-account-list">
                {list.map((e) => (
                  <AccountMobileCard key={e.id} e={e} m={m} onMore={() => setMenu(e)} />
                ))}
                <button
                  type="button"
                  className="m-platform-add-row"
                  disabled={m.writesLocked}
                  onClick={() =>
                    m.setEditor({
                      platform,
                      url: list.find((e) => e.url)?.url,
                      icon: list.find((e) => e.icon)?.icon ?? undefined,
                      isPlatformLocked: true,
                    })
                  }
                >
                  <Plus size={16} />
                  <span>{t("pages.addAccount")}</span>
                </button>
              </div>
            )}
          </section>
        );
      })}

      {menu && (
        <div className="m-list-sheet-overlay" role="presentation" onClick={() => setMenu(null)}>
          <div className="m-list-sheet" role="menu" onClick={(ev) => ev.stopPropagation()}>
            <div className="m-list-sheet-handle" />
            <div className="m-list-sheet-title">{menu.username}</div>
            <button
              type="button"
              className="m-list-sheet-item"
              onClick={() => {
                m.openHistory(menu.id);
                setMenu(null);
              }}
            >
              <span className="m-list-sheet-icon">
                <Clock size={18} />
              </span>
              <span className="m-list-sheet-copy">
                <span className="m-list-sheet-label">{t("accounts.historyShort")}</span>
              </span>
            </button>
            <button
              type="button"
              className="m-list-sheet-item is-danger"
              disabled={m.writesLocked}
              onClick={() => {
                m.setPendingDelete({
                  id: menu.id,
                  platform: menu.platform?.trim() || t("accounts.unnamed"),
                  username: menu.username?.trim() || "",
                });
                setMenu(null);
              }}
            >
              <span className="m-list-sheet-icon">
                <Trash2 size={18} />
              </span>
              <span className="m-list-sheet-copy">
                <span className="m-list-sheet-label">{t("common.delete")}</span>
              </span>
            </button>
            <button type="button" className="m-list-sheet-cancel" onClick={() => setMenu(null)}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function AccountsMobile() {
  const { t } = useTranslation();
  const m = useAccountsModel();
  useItemFocus(true, () => {
    m.setGroup("全部");
    m.setQ("");
    m.setCollapsed({});
  });

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
      <AccountsDialogs m={m} compact skipEditor />

      {m.editor && (
        <AccountMobileEditor
          m={m}
          onClose={() => m.setEditor(null)}
        />
      )}
    </div>
  );
}
