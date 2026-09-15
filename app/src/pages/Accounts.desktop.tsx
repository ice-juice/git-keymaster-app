import { Plus, ChevronsDown, ChevronsUp, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PageHead } from "../ui/common";
import { useAccountsModel } from "../shared/hooks/useAccountsModel";
import { AccountsDialogs, AccountsFilters, AccountsList } from "./Accounts.shared";

export function AccountsDesktop() {
  const { t } = useTranslation();
  const m = useAccountsModel();

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
            <strong>默认掩码安全模式：</strong>
            密码与关联 2FA 默认隐藏防窥；复制后写入剪贴板
            {m.revealCfg.clip > 0 ? `，${m.revealCfg.clip} 秒后自动清空` : ""}。
          </span>
        </div>
        <div className="security-banner-pills">
          {m.revealCfg.grace > 0 && <span className="sec-pill cyan">免密 {m.revealCfg.grace} 分钟</span>}
          <span className="sec-pill purple">端到端加密</span>
        </div>
      </div>

      <AccountsFilters m={m} />
      <AccountsList m={m} />
      <AccountsDialogs m={m} />
    </div>
  );
}
