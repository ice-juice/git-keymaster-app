import { Plus, ChevronsDown, ChevronsUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PageHead, SecurityNote } from "../ui/common";
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
  const allFolded = m.platforms.length > 0 && m.platforms.every(([platform]) => m.collapsed[platform]);

  return (
    <div className="stack-lg">
      <PageHead
        title={t("pages.accountsTitle")}
        desc={t("pages.accountsDesc")}
        note={
          <SecurityNote>
            <span>
              <strong>{t("accounts.maskTitle")}</strong>
              {t("accounts.maskBody")}
              {m.revealCfg.clip > 0 ? t("accounts.maskClear", { n: m.revealCfg.clip }) : ""}。
            </span>
            <div className="security-banner-pills">
              {m.revealCfg.grace > 0 && <span className="sec-pill cyan">{t("accounts.pillGrace", { n: m.revealCfg.grace })}</span>}
              <span className="sec-pill purple">{t("accounts.pillE2ee")}</span>
            </div>
          </SecurityNote>
        }
        actions={
          <>
            <button
              type="button"
              className={"btn sm" + (allFolded ? " is-folded" : "")}
              aria-pressed={allFolded}
              onClick={() => (allFolded ? m.expandAll() : m.collapseAll())}
            >
              {allFolded ? <ChevronsDown size={13} /> : <ChevronsUp size={13} />}
              {allFolded ? t("pages.expandAll") : t("pages.collapseAll")}
            </button>
            <button type="button" className="btn primary sm" disabled={m.writesLocked} onClick={() => m.setEditor({})}>
              <Plus size={13} /> {t("pages.addAccount")}
            </button>
          </>
        }
      />

      <AccountsFilters m={m} />
      <AccountsList m={m} />
      <AccountsDialogs m={m} />
    </div>
  );
}
