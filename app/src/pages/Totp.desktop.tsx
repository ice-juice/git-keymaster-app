import { Plus, Scan, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PageHead, Empty } from "../ui/common";
import { useTotpModel } from "../shared/hooks/useTotpModel";
import { TotpDialogs, TotpEntries, TotpFilters, TotpViewSwitcher } from "./Totp.shared";

export function TotpDesktop() {
  const { t } = useTranslation();
  const m = useTotpModel();

  return (
    <div className="stack-lg">
      <PageHead
        title={t("pages.totpTitle")}
        desc={t("pages.totpDesc")}
        actions={
          <>
            <TotpViewSwitcher view={m.view} setViewMode={m.setViewMode} />
            <button type="button" className="btn sm" disabled={m.busy} onClick={m.scanScreen}>
              <Scan size={13} /> {t("pages.scanScreen")}
            </button>
            <button type="button" className="btn sm" onClick={m.importImage}>
              {t("pages.importImage")}
            </button>
            <button type="button" className="btn primary sm" disabled={m.writesLocked} onClick={() => m.setEditor({})}>
              <Plus size={13} /> {t("pages.add")}
            </button>
          </>
        }
      />

      <div className="security-banner">
        <div className="security-banner-text">
          <ShieldCheck size={16} style={{ color: "var(--accent)", flexShrink: 0 }} />
          <span>
            <strong>默认掩码安全模式：</strong>
            验证码默认隐藏防窥；复制后写入剪贴板
            {m.revealCfg.clip > 0 ? `，${m.revealCfg.clip} 秒后自动清空` : ""}。
          </span>
        </div>
        <div className="security-banner-pills">
          {m.revealCfg.grace > 0 && <span className="sec-pill cyan">免密 {m.revealCfg.grace} 分钟</span>}
          <span className="sec-pill purple">端到端加密</span>
        </div>
      </div>

      <TotpFilters m={m} />
      {m.filtered.length === 0 ? (
        <Empty text="还没有 TOTP 条目。可以手动添加，或扫描屏幕二维码导入。" />
      ) : (
        <TotpEntries m={m} />
      )}
      <TotpDialogs m={m} includeScanHits />
    </div>
  );
}
