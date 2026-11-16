import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Fingerprint,
  KeyRound,
  Monitor,
  Play,
  ShieldCheck,
} from "lucide-react";
import { onboardingApi, finishOnboardingUi } from "../lib/onboarding";
import { errMessage, api } from "../lib/ipc";
import {
  draftFor,
  type OnboardingPreferences,
  type OnboardingView,
} from "../shared/onboarding";
import { prefersReducedMotion } from "../lib/prefs";
import { isAndroid } from "../lib/platform";
import UnlockAnimation from "../ui/UnlockAnimation";
import { StartupAnimation } from "../ui/StartupAnimation";
import "./Onboarding.css";

export function Onboarding({
  initial,
  onFinish,
  onThemePreview,
}: {
  initial: OnboardingView;
  onFinish: (view: OnboardingView) => void;
  onThemePreview: (theme: OnboardingPreferences["theme"]) => void;
}) {
  const { t } = useTranslation();
  const tr = (key: string) => t(`onboarding.${key}`);
  const [server, setServer] = useState(initial);
  const [draft, setDraft] = useState(() => draftFor(initial));
  const [step, setStep] = useState(
    initial.record.pending || initial.record.uiPending
      ? 2
      : initial.record.step,
  );
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [unknown, setUnknown] = useState(false);
  const [preview, setPreview] = useState<"startup" | "unlock" | null>(null);
  const closePreview = useCallback(() => setPreview(null), []);
  const current = useRef(initial);
  const preferences = useRef(draft);
  const currentStep = useRef(step);
  const surface = useRef<HTMLDivElement>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const count = useRef(0);
  const failed = useRef(false);
  const mutation = useRef(false);
  const mounted = useRef(true);
  useLayoutEffect(() => {
    surface.current?.scrollTo({ top: 0 });
  }, [step]);
  useEffect(() => {
    onThemePreview(draft.theme);
  }, [draft.theme, onThemePreview]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function accept(view: OnboardingView) {
    current.current = view;
    if (mounted.current) setServer(view);
  }
  function persist(p: OnboardingPreferences, nextStep: number) {
    count.current++;
    setSaving(true);
    const job = queue.current
      .then(async () => {
        if (failed.current) return;
        try {
          accept(
            await onboardingApi.draft(
              p,
              nextStep,
              current.current.record.revision,
            ),
          );
        } catch (e) {
          failed.current = true;
          if (mounted.current) setError(errMessage(e));
        }
      })
      .finally(() => {
        count.current--;
        if (mounted.current) setSaving(count.current > 0);
      });
    queue.current = job;
  }
  function change<K extends keyof OnboardingPreferences>(
    key: K,
    value: OnboardingPreferences[K],
  ) {
    if (
      mutation.current ||
      current.current.record.pending ||
      current.current.record.uiPending
    )
      return;
    const p = { ...preferences.current, [key]: value };
    preferences.current = p;
    setDraft(p);
    persist(p, currentStep.current);
  }
  function navigate(next: number) {
    if (
      mutation.current ||
      current.current.record.pending ||
      current.current.record.uiPending
    )
      return;
    currentStep.current = next;
    setStep(next);
    surface.current?.scrollTo({ top: 0 });
    persist(preferences.current, next);
  }
  useEffect(() => {
    if (!isAndroid()) return;
    const back = () => {
      if (mutation.current) return "stay" as const;
      if (currentStep.current > 0) {
        navigate(currentStep.current - 1);
        return "stay" as const;
      }
      void api.mobileLeaveApp(true).catch(() => {});
      return "home" as const;
    };
    window.__kmAndroidBack = back;
    return () => {
      if (window.__kmAndroidBack === back) delete window.__kmAndroidBack;
    };
    // Navigation uses refs to keep the native callback current without replacing it each edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function readStatus() {
    if (mutation.current) return;
    mutation.current = true;
    setBusy(true);
    await queue.current;
    try {
      const view = await onboardingApi.get();
      accept(view);
      setUnknown(false);
      setError("");
      if (view.configError) {
        onFinish(view);
        return;
      }
      if (view.record.uiPending) {
        onFinish(await finishOnboardingUi(view));
        return;
      }
      if (
        view.record.status === "completed" ||
        view.record.status === "skipped"
      ) {
        onFinish(view);
        return;
      }
      failed.current = false;
      if (view.record.pending) {
        preferences.current = draftFor(view);
        setDraft(preferences.current);
        currentStep.current = 2;
        setStep(2);
      } else {
        persist(preferences.current, currentStep.current);
      }
    } catch (e) {
      setError(errMessage(e));
      setUnknown(true);
    } finally {
      mutation.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function finish(skip: boolean) {
    if (mutation.current || unknown) return;
    mutation.current = true;
    setBusy(true);
    setError("");
    await queue.current;
    try {
      if (failed.current) {
        setError(tr("retryDraft"));
        return;
      }
      let view = current.current;
      if (view.record.uiPending) {
        onFinish(await finishOnboardingUi(view));
        return;
      }
      if (skip) {
        view = await onboardingApi.skip(view.record.revision);
      } else {
        const id = view.record.pending?.requestId ?? crypto.randomUUID();
        view = await onboardingApi.commit(id, view.record.revision);
      }
      accept(view);
      onFinish(await finishOnboardingUi(view));
    } catch (e) {
      setError(errMessage(e));
      // A transport error is not proof of failure. Read the durable original
      // operation before making any subsequent write; never auto-replay it.
      try {
        const observed = await onboardingApi.get();
        accept(observed);
        if (
          !observed.record.pending &&
          !observed.record.uiPending &&
          (observed.record.status === "completed" ||
            observed.record.status === "skipped")
        ) {
          onFinish(observed);
          return;
        }
        if (observed.record.uiPending) {
          currentStep.current = 2;
          setStep(2);
        }
      } catch {
        setUnknown(true);
      }
    } finally {
      mutation.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const pending = !!server.record.pending || server.record.uiPending;
  const disabled = busy || pending || unknown;
  const captureName = server.capability === "overlay" ? "overlay" : "capture";
  const captureHint =
    server.capability === "unsupported"
      ? "unsupported"
      : server.capability === "overlay"
        ? "overlayHint"
        : server.captureLimited
          ? "macLimit"
          : "captureHint";
  const toggle = (
    key: keyof OnboardingPreferences,
    title: string,
    hint?: string,
    extraDisabled = false,
  ) => (
    <label className="ob-toggle">
      <input
        type="checkbox"
        checked={!!draft[key]}
        disabled={disabled || extraDisabled}
        onChange={(e) => change(key, e.target.checked as never)}
      />
      <span>
        <strong>{tr(title)}</strong>
        {hint && <small>{tr(hint)}</small>}
      </span>
    </label>
  );
  const select = (
    key: "autoLockMinutes" | "clipboardClearSeconds" | "revealGraceMinutes",
    title: string,
    values: number[],
    zero: string,
    hint: string,
  ) => (
    <label className="ob-setting">
      <span>
        <strong>{tr(title)}</strong>
        <small>{tr(hint)}</small>
      </span>
      <select
        aria-label={tr(title)}
        value={draft[key]}
        disabled={disabled}
        onChange={(e) => change(key, Number(e.target.value))}
      >
        {[...new Set([...values, draft[key]])].map((value) => (
          <option key={value} value={value}>
            {value === 0
              ? tr(zero)
              : t(
                  `onboarding.${key === "clipboardClearSeconds" ? "seconds" : "minutes"}`,
                  { count: value },
                )}
          </option>
        ))}
      </select>
    </label>
  );
  const summary: [string, ReactNode][] = [
    ["theme", tr(draft.theme)],
    ["startup", tr(draft.startupAnimation ? "on" : "off")],
    ["unlock", draft.unlockAnimation ? tr(draft.unlockStyle) : tr("off")],
    [captureName, tr(draft.screenProtection ? "on" : "off")],
    [
      "idle",
      draft.autoLockMinutes
        ? t("onboarding.minutes", { count: draft.autoLockMinutes })
        : tr("neverLock"),
    ],
    [
      server.screenLockDetectable ? "sleep" : "sleepOnly",
      tr(draft.lockOnSleep ? "on" : "off"),
    ],
    [
      "clipboard",
      draft.clipboardClearSeconds
        ? t("onboarding.seconds", { count: draft.clipboardClearSeconds })
        : tr("neverClear"),
    ],
    [
      "reveal",
      draft.revealGraceMinutes
        ? t("onboarding.minutes", { count: draft.revealGraceMinutes })
        : tr("everyTime"),
    ],
    ["mask", tr(draft.maskAccounts ? "on" : "off")],
    ["watch", tr(draft.clipboardWatch ? "on" : "off")],
    ...(server.launchAtLoginSupported
      ? [
          ["autostart", tr(draft.launchAtLogin ? "on" : "off")] as [
            string,
            ReactNode,
          ],
        ]
      : []),
  ];
  return (
    <div className="onboarding" data-theme={draft.theme}>
      <aside className="ob-sidebar">
        <h2>
          <KeyRound size={20} /> {tr("title")}
        </h2>
        <nav aria-label={tr("firstRun")}>
          {["experience", "security", "confirm"].map((label, index) => (
            <button
              key={label}
              type="button"
              aria-current={step === index ? "step" : undefined}
              disabled={disabled}
              onClick={() => navigate(index)}
            >
              <span>{index + 1}</span>
              {tr(label === "security" ? "securityStep" : label)}
            </button>
          ))}
        </nav>
        <p>
          <Monitor size={16} />
          {tr("device")}
        </p>
      </aside>
      <div className="ob-main">
        <header>
          <p className="ob-eyebrow">
            {tr("firstRun")} · {step + 1} / 3
          </p>
          <h1>
            {tr(["experienceTitle", "securityTitle", "confirmTitle"][step])}
          </h1>
          <p>{tr(["experienceHint", "securityHint", "confirmHint"][step])}</p>
        </header>
        <div
          className="ob-content"
          ref={surface}
          role="region"
          aria-label={tr(["experience", "security", "confirm"][step])}
        >
          {error && (
            <div className="callout danger" role="alert">
              {error}
              <button
                className="btn sm"
                type="button"
                disabled={busy}
                onClick={() => void readStatus()}
              >
                {tr(failed.current ? "retryDraft" : "retry")}
              </button>
            </div>
          )}
          {unknown && (
            <div className="callout warning" role="alert">
              {tr("unknown")}
            </div>
          )}
          {pending && (
            <div className="callout warning" role="status">
              {tr(server.record.uiPending ? "uiPending" : "pending")}
              <button
                className="btn sm"
                type="button"
                disabled={busy}
                onClick={() => void readStatus()}
              >
                {tr("retry")}
              </button>
            </div>
          )}
          {step === 0 && (
            <section>
              <h2>{tr("theme")}</h2>
              <div className="ob-themes">
                {(["light", "dark", "navy"] as const).map((theme) => (
                  <button
                    type="button"
                    key={theme}
                    aria-pressed={draft.theme === theme}
                    className={`ob-theme ob-theme-${theme}`}
                    disabled={disabled}
                    onClick={() => change("theme", theme)}
                  >
                    <span aria-hidden="true" />
                    <strong>{tr(theme)}</strong>
                  </button>
                ))}
              </div>
              <div className="ob-card ob-animation-card">
                <div
                  className="ob-animation"
                  data-enabled={draft.startupAnimation}
                >
                  <div className="ob-animation-heading">
                    {toggle("startupAnimation", "startup", "startupHint")}
                    <button
                      className="btn ob-preview"
                      type="button"
                      disabled={
                        disabled ||
                        !draft.startupAnimation ||
                        prefersReducedMotion()
                      }
                      onClick={() => setPreview("startup")}
                    >
                      <Play size={14} />
                      {tr("previewStartup")}
                    </button>
                  </div>
                </div>
                <div
                  className="ob-animation"
                  data-enabled={draft.unlockAnimation}
                >
                  <div className="ob-animation-heading">
                    {toggle("unlockAnimation", "unlock", "unlockHint")}
                    <button
                      className="btn ob-preview"
                      type="button"
                      disabled={
                        disabled ||
                        !draft.unlockAnimation ||
                        prefersReducedMotion()
                      }
                      onClick={() => setPreview("unlock")}
                    >
                      <Play size={14} />
                      {tr("preview")}
                    </button>
                  </div>
                  <div
                    className="ob-styles"
                    role="group"
                    aria-label={tr("unlockStyle")}
                  >
                    {(["minimal", "classic", "cyber"] as const).map((style) => (
                      <button
                        className="btn sm"
                        type="button"
                        key={style}
                        aria-pressed={draft.unlockStyle === style}
                        disabled={disabled || !draft.unlockAnimation}
                        onClick={() => change("unlockStyle", style)}
                      >
                        {tr(style)}
                      </button>
                    ))}
                  </div>
                </div>
                <p className="ob-hint">{tr("motionHint")}</p>
              </div>
              {server.launchAtLoginSupported && (
                <details>
                  <summary>{tr("moreStartup")}</summary>
                  <div className="ob-card">
                    {toggle("launchAtLogin", "autostart", "autostartHint")}
                  </div>
                </details>
              )}
            </section>
          )}
          {step === 1 && (
            <section>
              <div className="ob-highlight">
                {toggle(
                  "screenProtection",
                  captureName,
                  captureHint,
                  server.capability === "unsupported",
                )}
                <span className="ob-recommend">
                  {server.capability === "unsupported"
                    ? tr("unsupported")
                    : tr("recommended")}
                </span>
                {!pending && (
                  <p className="ob-capture-state">
                    {tr(
                      `capture${server.allowScreenshots ? "Off" : "On"}${draft.screenProtection ? "On" : "Off"}`,
                    )}
                  </p>
                )}
                {server.capability === "exclude" && (
                  <p className="ob-hint">{tr("captureLimit")}</p>
                )}
              </div>
              <div className="ob-card">
                {select(
                  "autoLockMinutes",
                  "idle",
                  [1, 5, 15, 30, 0],
                  "neverLock",
                  "idleHint",
                )}
                {toggle(
                  "lockOnSleep",
                  server.screenLockDetectable ? "sleep" : "sleepOnly",
                  "sleepHint",
                )}
                {select(
                  "clipboardClearSeconds",
                  "clipboard",
                  [10, 20, 60, 0],
                  "neverClear",
                  "clipboardHint",
                )}
                {draft.autoLockMinutes === 0 && (
                  <p className="ob-hint">{tr("idleWarning")}</p>
                )}
              </div>
              <details>
                <summary>{tr("moreSecurity")}</summary>
                <div className="ob-card">
                  {select(
                    "revealGraceMinutes",
                    "reveal",
                    [0, 1, 5],
                    "everyTime",
                    "revealHint",
                  )}
                  {toggle("maskAccounts", "mask")}
                  {toggle("clipboardWatch", "watch", "watchHint")}
                </div>
              </details>
              <p className="ob-defer">
                <Fingerprint size={18} />
                {tr("laterBio")}
              </p>
            </section>
          )}
          {step === 2 && (
            <section>
              <dl className="ob-summary">
                {summary.map(([label, value]) => (
                  <div key={label}>
                    <dt>{tr(label)}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              <p className="ob-highlight ob-hint">
                <ShieldCheck size={16} /> {tr("confirmNotice")}
              </p>
            </section>
          )}
        </div>
        <footer className="ob-footer">
          <div className="ob-footer-meta">
            <div className="ob-save-state" aria-live="polite">
              {saving
                ? tr("savingDraft")
                : error || server.record.status === "notStarted"
                  ? tr("notApplied")
                  : tr("savedDraft")}
            </div>
            <small>{tr("skipHint")}</small>
          </div>
          <div className="ob-footer-actions">
            {step > 0 && (
              <button
                className="btn"
                type="button"
                disabled={disabled}
                onClick={() => navigate(step - 1)}
              >
                {tr("back")}
              </button>
            )}
            <button
              className="btn ghost"
              type="button"
              disabled={busy || pending || unknown}
              onClick={() => void finish(true)}
            >
              {tr("skip")}
            </button>
            <button
              className="btn primary"
              type="button"
              disabled={busy || unknown || (saving && step === 2)}
              onClick={() =>
                step < 2 ? navigate(step + 1) : void finish(false)
              }
            >
              {busy
                ? tr("saving")
                : server.record.uiPending
                  ? tr("finishUi")
                  : server.record.pending
                    ? tr("resume")
                    : step < 2
                      ? tr("next")
                      : tr("save")}
            </button>
          </div>
        </footer>
      </div>
      {preview === "unlock" && (
        <UnlockAnimation style={draft.unlockStyle} onDone={closePreview} />
      )}
      {preview === "startup" && <StartupAnimation onDone={closePreview} />}
    </div>
  );
}
