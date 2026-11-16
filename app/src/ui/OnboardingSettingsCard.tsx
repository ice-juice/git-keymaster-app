import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  currentUiPreferences,
  ONBOARDING_OPEN_EVENT,
  onboardingApi,
} from "../lib/onboarding";
import {
  getStartupAnimEnabled,
  setStartupAnimEnabledStored,
} from "../lib/prefs";
import { errMessage } from "../lib/ipc";
import { Card } from "./common";

export function OnboardingSettingsCard() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(getStartupAnimEnabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  async function reopen() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const current = await onboardingApi.get();
      const next =
        current.record.pending || current.record.uiPending
          ? current
          : await onboardingApi.reopen(
              currentUiPreferences(),
              current.record.revision,
            );
      window.dispatchEvent(
        new CustomEvent(ONBOARDING_OPEN_EVENT, { detail: next }),
      );
    } catch (e) {
      setError(errMessage(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <Card title={t("onboarding.preferences")}>
      <div className="stack">
        <div className="field">
          <div className="between">
            <div>
              <div className="field-label">{t("onboarding.startup")}</div>
              <div className="hint">{t("onboarding.startupSettingHint")}</div>
            </div>
            <button
              type="button"
              role="switch"
              aria-label={t("onboarding.startup")}
              aria-checked={enabled}
              className={"switch" + (enabled ? "" : " off")}
              onClick={() => {
                try {
                  setStartupAnimEnabledStored(!enabled);
                  setEnabled(!enabled);
                  setError("");
                } catch (err) {
                  setError(errMessage(err));
                }
              }}
            />
          </div>
        </div>
        <div>
          <button
            className="btn sm"
            type="button"
            disabled={busy}
            onClick={() => void reopen()}
          >
            {t("onboarding.reopen")}
          </button>
        </div>
        <div className="hint">{t("onboarding.reopenHint")}</div>
        {error && (
          <div role="alert" className="callout danger">
            {error}
          </div>
        )}
      </div>
    </Card>
  );
}
