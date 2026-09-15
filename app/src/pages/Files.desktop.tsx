import { LayoutGrid, List, Plus, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PageHead } from "../ui/common";
import { formatBytes, useFilesModel } from "../shared/hooks/useFilesModel";
import { FileCard, FilesDialogs, FilesEmpty, FilesFilters, FilesTable } from "./Files.shared";

export function FilesDesktop() {
  const { t } = useTranslation();
  const m = useFilesModel();

  return (
    <div className="stack-lg">
      <PageHead
        title={t("pages.filesTitle")}
        desc={t("pages.filesDesc")}
        actions={
          <>
            <div className="view-switcher">
              <button type="button" className={"view-btn" + (m.viewMode === "grid" ? " on" : "")} onClick={() => m.setViewMode("grid")}>
                <LayoutGrid size={13} /> {t("pages.filesViewGrid")}
              </button>
              <button type="button" className={"view-btn" + (m.viewMode === "table" ? " on" : "")} onClick={() => m.setViewMode("table")}>
                <List size={13} /> {t("pages.filesViewTable")}
              </button>
            </div>
            <button type="button" className="btn primary sm" disabled={m.writesLocked} onClick={() => void m.startUpload()}>
              <Plus size={13} /> {t("pages.filesUpload")}
            </button>
          </>
        }
      />

      <div className="security-banner">
        <div className="security-banner-text">
          <ShieldCheck size={16} style={{ color: "var(--accent)", flexShrink: 0 }} />
          <span>
            <strong>{t("files.usageTitle")}</strong>
            {t("files.usageBanner", { count: m.totalCount, size: formatBytes(m.usageBytes) })}
          </span>
        </div>
        <div className="security-banner-pills">
          <span className="sec-pill purple">{t("files.pillLimit")}</span>
          <span className="sec-pill purple">{t("files.pillAead")}</span>
          {m.revealCfg.grace > 0 && <span className="sec-pill cyan">{t("files.pillGrace", { n: m.revealCfg.grace })}</span>}
        </div>
      </div>

      <FilesFilters m={m} />

      {m.filteredEntries.length === 0 ? (
        <FilesEmpty m={m} />
      ) : m.viewMode === "table" ? (
        <FilesTable m={m} />
      ) : (
        <div className="files-grid">
          {m.filteredEntries.map((e) => (
            <FileCard key={e.id} e={e} m={m} />
          ))}
        </div>
      )}

      <FilesDialogs m={m} />
    </div>
  );
}
