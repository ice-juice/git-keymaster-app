import { FileText, FolderLock, Lock, Shield } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { formatHomeStat, useHomeStats } from "../shared/hooks/useHomeStats";
import { OverviewMobileTools } from "./Overview.mobileTools";

export function OverviewMobile() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const home = useHomeStats();

  return (
    <div className="stack-lg">
      <div className="stat-card-row">
        <button type="button" className="stat-card stat-card-nav" onClick={() => nav("/totp")}>
          <div className="stat-card-title">
            <Shield size={14} style={{ color: "var(--accent)" }} />
            <span>{t("home.statTotp")}</span>
          </div>
          <div className="stat-card-body">
            <div className="stat-card-val">{formatHomeStat(home.totp)}</div>
            <div className="stat-card-sub">{t("home.statTotpSub")}</div>
          </div>
        </button>

        <button type="button" className="stat-card stat-card-nav" onClick={() => nav("/accounts")}>
          <div className="stat-card-title">
            <Lock size={14} style={{ color: "var(--amber)" }} />
            <span>{t("home.statAccounts")}</span>
          </div>
          <div className="stat-card-body">
            <div className="stat-card-val">{formatHomeStat(home.account)}</div>
            <div className="stat-card-sub">{t("home.statAccountsSub")}</div>
          </div>
        </button>

        <button type="button" className="stat-card stat-card-nav" onClick={() => nav("/notes")}>
          <div className="stat-card-title">
            <FileText size={14} style={{ color: "var(--green)" }} />
            <span>{t("home.statNotes")}</span>
          </div>
          <div className="stat-card-body">
            <div className="stat-card-val">{formatHomeStat(home.note)}</div>
            <div className="stat-card-sub">{t("home.statNotesSub")}</div>
          </div>
        </button>

        <button type="button" className="stat-card stat-card-nav" onClick={() => nav("/files")}>
          <div className="stat-card-title">
            <FolderLock size={14} style={{ color: "var(--accent)" }} />
            <span>{t("home.statFiles")}</span>
          </div>
          <div className="stat-card-body">
            <div className="stat-card-val">{formatHomeStat(home.file)}</div>
            <div className="stat-card-sub">{t("home.statFilesSub")}</div>
          </div>
        </button>
      </div>

      <OverviewMobileTools />
    </div>
  );
}
