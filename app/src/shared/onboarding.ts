export interface OnboardingPreferences {
  theme: "light" | "dark" | "navy";
  startupAnimation: boolean;
  unlockAnimation: boolean;
  unlockStyle: "minimal" | "classic" | "cyber";
  screenProtection: boolean;
  autoLockMinutes: number;
  lockOnSleep: boolean;
  clipboardClearSeconds: number;
  revealGraceMinutes: number;
  maskAccounts: boolean;
  clipboardWatch: boolean;
  launchAtLogin: boolean;
}
export interface OnboardingRecord {
  version: number;
  status: "notStarted" | "inProgress" | "completed" | "skipped" | "legacy";
  revision: number;
  step: number;
  draft: OnboardingPreferences | null;
  pending: { requestId: string; preferences: OnboardingPreferences } | null;
  lastRequestId: string | null;
  lastError: string | null;
  uiPending: boolean;
  offerBiometrics: boolean;
}
export interface OnboardingView {
  record: OnboardingRecord;
  allowScreenshots: boolean;
  capability: "exclude" | "overlay" | "unsupported";
  captureLimited: boolean;
  launchAtLoginSupported: boolean;
  screenLockDetectable: boolean;
  configError: boolean;
}
export const recommendedPreferences: OnboardingPreferences = {
  theme: "light",
  startupAnimation: true,
  unlockAnimation: true,
  unlockStyle: "minimal",
  screenProtection: true,
  autoLockMinutes: 5,
  lockOnSleep: true,
  clipboardClearSeconds: 20,
  revealGraceMinutes: 1,
  maskAccounts: true,
  clipboardWatch: false,
  launchAtLogin: false,
};
export function needsOnboarding(view: OnboardingView): boolean {
  return (
    view.configError ||
    view.record.version !== 1 ||
    !!view.record.pending ||
    view.record.uiPending ||
    view.record.status === "notStarted" ||
    view.record.status === "inProgress"
  );
}
export function draftFor(view: OnboardingView): OnboardingPreferences {
  const draft = {
    ...(view.record.pending?.preferences ??
      view.record.draft ??
      recommendedPreferences),
  };
  if (view.capability === "unsupported") draft.screenProtection = false;
  if (!view.launchAtLoginSupported) draft.launchAtLogin = false;
  return draft;
}
