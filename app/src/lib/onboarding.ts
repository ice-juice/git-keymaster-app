import { invoke } from "@tauri-apps/api/core";
import type {
  OnboardingPreferences,
  OnboardingView,
} from "../shared/onboarding";
import { useApp } from "../store";
import {
  getMaskAccountMiddle,
  setMaskAccountMiddleStored,
  getStartupAnimEnabled,
  setStartupAnimEnabledStored,
} from "./prefs";
import { recommendedPreferences } from "../shared/onboarding";

export const onboardingApi = {
  get: () => invoke<OnboardingView>("onboarding_get"),
  draft: (preferences: OnboardingPreferences, step: number, revision: number) =>
    invoke<OnboardingView>("onboarding_save_draft", {
      preferences,
      step,
      revision,
    }),
  commit: (requestId: string, revision: number) =>
    invoke<OnboardingView>("onboarding_commit", { requestId, revision }),
  ackUi: (requestId: string) =>
    invoke<OnboardingView>("onboarding_ack_ui", { requestId }),
  skip: (revision: number) =>
    invoke<OnboardingView>("onboarding_skip", { revision }),
  reopen: (preferences: OnboardingPreferences, revision: number) =>
    invoke<OnboardingView>("onboarding_reopen", { preferences, revision }),
  dismissBiometrics: () => invoke<void>("onboarding_dismiss_biometrics"),
};

export async function finishOnboardingUi(
  view: OnboardingView,
): Promise<OnboardingView> {
  const { record } = view;
  if (!record.uiPending) return view;
  if (!record.lastRequestId || !record.draft)
    throw new Error("Missing onboarding save receipt");
  const p = record.draft;
  const store = useApp.getState();
  // ACK only after every local preference is stored. A failed write is recoverable
  // from the backend receipt without replaying OS settings.
  store.setTheme(p.theme);
  store.setUnlockAnimEnabled(p.unlockAnimation);
  store.setUnlockAnimStyle(p.unlockStyle);
  setMaskAccountMiddleStored(p.maskAccounts);
  setStartupAnimEnabledStored(p.startupAnimation);
  return onboardingApi.ackUi(record.lastRequestId);
}

export function currentUiPreferences(): OnboardingPreferences {
  const app = useApp.getState();
  return {
    ...recommendedPreferences,
    theme: app.theme,
    unlockAnimation: app.unlockAnimEnabled,
    unlockStyle: app.unlockAnimStyle,
    maskAccounts: getMaskAccountMiddle(),
    startupAnimation: getStartupAnimEnabled(),
  };
}

export const ONBOARDING_OPEN_EVENT = "gkm-onboarding-open";
