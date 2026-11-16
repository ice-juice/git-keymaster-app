import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Fingerprint } from "lucide-react";
import {
  onboardingApi,
  finishOnboardingUi,
  ONBOARDING_OPEN_EVENT,
} from "../lib/onboarding";
import { api, errMessage } from "../lib/ipc";
import { getStartupAnimEnabled, prefersReducedMotion } from "../lib/prefs";
import { useApp } from "../store";
import { needsOnboarding, type OnboardingView } from "../shared/onboarding";
import { Onboarding } from "../pages/Onboarding";
import { StartupAnimation } from "./StartupAnimation";
import { TitleBar } from "./TitleBar";
import { CloseConfirmHost } from "./CloseConfirm";
import { resolvePlatform } from "../platform/resolve";
import { useScreenCaptureGuard } from "../shared/hooks/useScreenCaptureGuard";
import { startActivityHeartbeat } from "../shared/activityHeartbeat";
import { useImeInset } from "../shared/hooks/useImeInset";
import { useSafeAreaInset } from "../shared/hooks/useSafeAreaInset";
import type { ThemeMode } from "../lib/theme";

function BiometricWelcome({ onDismiss }: { onDismiss: () => void }) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  async function dismiss() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await onboardingApi.dismissBiometrics();
      setPassword("");
      onDismiss();
    } catch (e) {
      setError(errMessage(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function enable() {
    if (inFlight.current || !password.trim()) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await api.biometricEnable(password);
      setPassword("");
      await onboardingApi.dismissBiometrics();
      onDismiss();
    } catch (e) {
      setPassword("");
      setError(errMessage(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <div
      className="wizard-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ob-bio-title"
    >
      <div className="card ob-bio">
        <Fingerprint size={30} />
        <h2 id="ob-bio-title">{t("onboarding.bioTitle")}</h2>
        <p>{t("onboarding.bioHint")}</p>
        <p>{t("onboarding.bioDisclosure")}</p>
        {confirm && (
          <label className="field">
            <span>{t("onboarding.bioPassword")}</span>
            <input
              autoFocus
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              disabled={busy}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void enable();
              }}
            />
          </label>
        )}
        {error && (
          <div className="callout danger" role="alert">
            {error}
          </div>
        )}
        <div className="ob-actions">
          <button
            className="btn"
            type="button"
            disabled={busy}
            onClick={() => void dismiss()}
          >
            {t("onboarding.bioLater")}
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={busy || (confirm && !password.trim())}
            onClick={() => (confirm ? void enable() : setConfirm(true))}
          >
            {t("onboarding.bioEnable")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function OnboardingBoundary({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const mobile = resolvePlatform() === "mobile";
  const notesPreview =
    import.meta.env.DEV &&
    new URLSearchParams(window.location.search).get("preview") === "notes";
  useImeInset(mobile);
  useSafeAreaInset(mobile);
  const [view, setView] = useState<OnboardingView | null>(null);
  const [previewTheme, setPreviewTheme] = useState<ThemeMode>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [epoch, setEpoch] = useState(0);
  const [bio, setBio] = useState(false);
  const [startupPreference] = useState(
    () => getStartupAnimEnabled() && !prefersReducedMotion(),
  );
  const [startup, setStartup] = useState(false);
  const startupConsidered = useRef(false);
  const request = useRef(0);
  const status = useApp((s) => s.status);
  const unlockAnimation = useApp((s) => s.playUnlockAnim);
  const guard = useScreenCaptureGuard();
  const endStartup = useCallback(() => setStartup(false), []);
  const load = useCallback(
    async (alive: () => boolean = () => true) => {
      const id = ++request.current;
      try {
        await useApp.getState().refresh();
        const next = await onboardingApi.get();
        if (!alive() || id !== request.current) return;
        const ready = next.configError ? next : await finishOnboardingUi(next);
        if (alive() && id === request.current) {
          if (!startupConsidered.current) {
            startupConsidered.current = true;
            setStartup(startupPreference && !needsOnboarding(ready));
          }
          setView(ready);
          setEpoch((e) => e + 1);
        }
      } catch (e) {
        if (alive() && id === request.current) setError(errMessage(e));
      } finally {
        if (alive() && id === request.current) setLoading(false);
      }
    },
    [startupPreference],
  );
  useEffect(() => {
    if (notesPreview) return;
    let alive = true;
    // oxlint-disable-next-line react/set-state-in-effect -- Initial native IPC synchronization; state changes follow asynchronous replies.
    void load(() => alive);
    return () => {
      alive = false;
    };
  }, [load, notesPreview]);
  useEffect(() => {
    const open = (event: Event) => {
      request.current++;
      setView((event as CustomEvent<OnboardingView>).detail);
      setEpoch((e) => e + 1);
      setError("");
      setLoading(false);
    };
    window.addEventListener(ONBOARDING_OPEN_EVENT, open);
    return () => window.removeEventListener(ONBOARDING_OPEN_EVENT, open);
  }, []);
  const active = !!view && needsOnboarding(view);
  useEffect(() => (active ? startActivityHeartbeat() : undefined), [active]);
  useEffect(() => {
    let cancelled = false;
    if (
      loading ||
      error ||
      active ||
      !view?.record.offerBiometrics ||
      !status?.unlocked ||
      unlockAnimation
    ) {
      return;
    }
    void api
      .biometricStatus()
      .then((result) => {
        if (!cancelled) setBio(result.available && !result.enabled);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [
    active,
    loading,
    error,
    view?.record.offerBiometrics,
    status?.unlocked,
    status?.workspaceId,
    unlockAnimation,
  ]);
  const finish = (next: OnboardingView) => {
    // Do not remount secret-bearing pages with a stale pre-lock vault status.
    setLoading(true);
    void useApp
      .getState()
      .refresh()
      .then(() => {
        setView(next);
        setLoading(false);
      });
  };
  const blocking =
    loading ||
    !!error ||
    !view ||
    view.configError ||
    view.record.version !== 1;
  if (notesPreview) return <>{children}</>;
  return (
    <>
      {blocking || active ? (
        <div className="app-shell" data-theme={previewTheme}>
          {resolvePlatform() === "desktop" && (
            <TitleBar preferencesLocked previewTheme={previewTheme} />
          )}
          <CloseConfirmHost />
          {blocking ? (
            <div className="ob-loading" role="status">
              <p>
                {loading
                  ? t("common.loading")
                  : view?.configError
                    ? t("onboarding.configDamaged")
                    : view && view.record.version !== 1
                      ? t("onboarding.newVersion")
                      : t("onboarding.readFailed")}
              </p>
              {error && <p role="alert">{error}</p>}
              {!loading && (
                <button
                  className="btn primary"
                  type="button"
                  onClick={() => {
                    setLoading(true);
                    setError("");
                    void load();
                  }}
                >
                  {t("onboarding.retry")}
                </button>
              )}
            </div>
          ) : (
            <div className="app-view">
              <Onboarding
                key={epoch}
                initial={view!}
                onFinish={finish}
                onThemePreview={setPreviewTheme}
              />
            </div>
          )}
          {guard.cover && <div className="privacy-cover" aria-hidden="true" />}
          {guard.shotNotice && (
            <div className="wizard-overlay" role="alertdialog">
              <div className="card ob-bio">
                <p>{guard.shotNotice}</p>
                <button
                  className="btn"
                  type="button"
                  onClick={guard.dismissShotNotice}
                >
                  {t("common.gotIt")}
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        children
      )}
      {startup && <StartupAnimation onDone={endStartup} />}
      {!blocking &&
        !active &&
        bio &&
        view?.record.offerBiometrics &&
        !unlockAnimation &&
        status?.unlocked && (
          <BiometricWelcome
            key={status.workspaceId}
            onDismiss={() => {
              setBio(false);
              if (view)
                setView({
                  ...view,
                  record: { ...view.record, offerBiometrics: false },
                });
            }}
          />
        )}
    </>
  );
}
