import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { writeClipboard } from "../lib/clipboard";
import type { ClipboardCloneHint as Hint } from "../shared/hooks/useClipboardCloneHint";

export function ClipboardCloneHint({
  hint,
  onDismiss,
}: {
  hint: Hint | null;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const nav = useNavigate();
  if (!hint) return null;

  return (
    <div className="clipboard-clone-hint" role="status">
      <div className="clipboard-clone-hint-text">
        {hint.identityName
          ? t("clipboardHint.detected", { repo: hint.repo, name: hint.identityName })
          : t("clipboardHint.detectedNoId", { repo: hint.repo })}
      </div>
      <div className="clipboard-clone-hint-actions">
        <button
          type="button"
          className="btn primary sm"
          onClick={() => {
            nav(`/repos?tab=clone&url=${encodeURIComponent(hint.url)}`);
            onDismiss();
          }}
        >
          {t("clipboardHint.clone")}
        </button>
        {hint.rewrittenUrl && (
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              void writeClipboard(hint.rewrittenUrl!);
              onDismiss();
            }}
          >
            {t("clipboardHint.copyAlias")}
          </button>
        )}
        <button type="button" className="btn ghost sm" onClick={onDismiss}>
          {t("clipboardHint.dismiss")}
        </button>
      </div>
    </div>
  );
}
