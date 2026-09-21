import { Plus, ChevronsDown, ChevronsUp, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PageHead } from "../ui/common";
import { useAccountsModel } from "../shared/hooks/useAccountsModel";
import { AccountsDialogs, AccountsFilters, AccountsList } from "./Accounts.shared";
import { useItemFocus } from "../shared/hooks/useItemFocus";

export function AccountsDesktop() {
  const { t } = useTranslation();
  const m = useAccountsModel();
  useItemFocus(true, () => {
    m.setGroup("全部");
    m.setQ("");
    m.clearPlatformTags();
    m.setCollapsed({});
  });

  return (
    <div className="stack-lg">
      <PageHead
        title={t("pages.accountsTitle")}
        desc={t("pages.accountsDesc")}
        actions={
          <>
            <button type="button" className="btn sm" onClick={m.expandAll}>
              <ChevronsDown size={13} /> {t("pages.expandAll")}
            </button>
            <button type="button" className="btn sm" onClick={m.collapseAll}>
              <ChevronsUp size={13} /> {t("pages.collapseAll")}
            </button>
            <button type="button" className="btn primary sm" disabled={m.writesLocked} onClick={() => m.setEditor({})}>
              <Plus size={13} /> {t("pages.addAccount")}
            </button>
          </>
        }
      />

      <div className="security-banner">
        <div className="security-banner-text">
          <ShieldCheck size={16} style={{ color: "var(--accent)", flexShrink: 0 }} />
          <span>
            <strong>{t("accounts.maskTitle")}</strong>
            {t("accounts.maskBody")}
            {m.revealCfg.clip > 0 ? t("accounts.maskClear", { n: m.revealCfg.clip }) : ""}。
          </span>
        </div>
        <div className="security-banner-pills">
          {m.revealCfg.grace > 0 && <span className="sec-pill cyan">{t("accounts.pillGrace", { n: m.revealCfg.grace })}</span>}
          <span className="sec-pill purple">{t("accounts.pillE2ee")}</span>
        </div>
      </div>

      <AccountsFilters m={m} />
      <AccountsList m={m} />
      <AccountsDialogs m={m} />
    </div>
  );
}
