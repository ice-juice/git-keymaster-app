import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import { api, type GitProvider } from "../lib/ipc";

function asLines(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string" && value.trim()) return [value];
  return [];
}

export function PatGuideDialog({
  provider,
  tokenUrl,
  onClose,
}: {
  provider: GitProvider;
  tokenUrl: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const plat = t(`pat.platform.${provider}`);
  const scopes = asLines(t(`pat.guide.${provider}.scopes`, { returnObjects: true }));
  const extra = asLines(t(`pat.guide.${provider}.extra`, { returnObjects: true }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="wizard-overlay" role="dialog" aria-modal="true" aria-labelledby="pat-guide-title" onClick={onClose}>
      <div className="card dialog-card pat-guide-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <div id="pat-guide-title" className="card-title">
            {t("pat.guideTitle", { platform: plat })}
          </div>
        </div>
        <div className="card-body stack pat-guide-body">
          <p className="pat-guide-intro">{t(`pat.guide.${provider}.intro`)}</p>
          <div className="muted" style={{ fontWeight: 600 }}>
            {t(`pat.guide.${provider}.must`)}
          </div>
          <ul className="pat-guide-list">
            {scopes.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {extra.length > 0 && (
            <>
              <div className="muted" style={{ fontWeight: 600 }}>
                {t(`pat.guide.${provider}.optional`)}
              </div>
              <ul className="pat-guide-list">
                {extra.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </>
          )}
          <p className="muted" style={{ fontSize: 12, margin: 0 }}>
            {t("pat.guideNote")}
          </p>
        </div>
        <div className="card-foot">
          <button type="button" className="btn ghost sm" onClick={() => void api.openUrl(tokenUrl)}>
            <ExternalLink size={12} style={{ marginRight: 3 }} />
            {t("pat.openTokenPage", { platform: plat })}
          </button>
          <button type="button" className="btn primary sm" onClick={onClose} autoFocus>
            {t("common.gotIt")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
