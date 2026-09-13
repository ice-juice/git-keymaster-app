import { Plus, Scan, ShieldCheck } from "lucide-react";
import { PageHead, Empty } from "../ui/common";
import { useTotpModel } from "../shared/hooks/useTotpModel";
import { TotpDialogs, TotpEntries, TotpFilters, TotpViewSwitcher } from "./Totp.shared";

export function TotpDesktop() {
  const m = useTotpModel();

  return (
    <div className="stack-lg">
      <PageHead
        title="2FA / TOTP"
        desc="默认掩码保护，点击眼睛查看验证码。支持卡片/列表切换。"
        actions={
          <>
            <TotpViewSwitcher view={m.view} setViewMode={m.setViewMode} />
            <button type="button" className="btn sm" disabled={m.busy} onClick={m.scanScreen}>
              <Scan size={13} /> 扫描屏幕
            </button>
            <button type="button" className="btn sm" onClick={m.importImage}>
              导入图片
            </button>
            <button type="button" className="btn primary sm" disabled={m.writesLocked} onClick={() => m.setEditor({})}>
              <Plus size={13} /> 添加
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
