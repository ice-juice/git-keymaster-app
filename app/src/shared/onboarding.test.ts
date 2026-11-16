import { test } from "node:test";
import assert from "node:assert/strict";
import {
  draftFor,
  needsOnboarding,
  recommendedPreferences,
  type OnboardingView,
} from "./onboarding.ts";

function view(): OnboardingView {
  return {
    record: {
      version: 1,
      status: "notStarted",
      revision: 0,
      step: 0,
      draft: { ...recommendedPreferences },
      pending: null,
      lastRequestId: null,
      lastError: null,
      uiPending: false,
      offerBiometrics: true,
    },
    allowScreenshots: true,
    capability: "exclude",
    captureLimited: false,
    launchAtLoginSupported: true,
    screenLockDetectable: true,
    configError: false,
  };
}
test("old users and explicit skips bypass the guide; incomplete saves do not", () => {
  const v = view();
  for (const status of ["legacy", "skipped", "completed"] as const) {
    v.record.status = status;
    assert.equal(needsOnboarding(v), false);
  }
  v.record.uiPending = true;
  assert.equal(needsOnboarding(v), true);
  v.record.uiPending = false;
  v.configError = true;
  assert.equal(needsOnboarding(v), true);
  v.configError = false;
  v.record.version = 2;
  assert.equal(needsOnboarding(v), true);
});
test("recommendation never implies capture protection is already active", () => {
  const v = view();
  assert.equal(draftFor(v).screenProtection, true);
  assert.equal(v.allowScreenshots, true);
  const draft = draftFor(v);
  draft.screenProtection = false;
  assert.equal(v.record.draft?.screenProtection, true);
});
test("unsupported choices are disabled without mutating the persisted draft", () => {
  const v = view();
  v.capability = "unsupported";
  v.launchAtLoginSupported = false;
  v.record.draft!.launchAtLogin = true;
  assert.equal(draftFor(v).screenProtection, false);
  assert.equal(draftFor(v).launchAtLogin, false);
  assert.equal(v.record.draft!.screenProtection, true);
});
test("recovery uses immutable pending intent, not a different draft", () => {
  const v = view();
  v.record.pending = {
    requestId: "saved-operation",
    preferences: {
      ...recommendedPreferences,
      screenProtection: false,
      autoLockMinutes: 30,
    },
  };
  assert.equal(needsOnboarding(v), true);
  assert.equal(draftFor(v).screenProtection, false);
  assert.equal(draftFor(v).autoLockMinutes, 30);
});
