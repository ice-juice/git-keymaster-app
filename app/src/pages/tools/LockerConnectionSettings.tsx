import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import {
  api,
  errMessage,
  LOCKER_DEPLOY_PROGRESS_EVENT,
  type LockerDeployMethod,
  type LockerDeployProgress,
  type LockerDeployStep,
  type LockerProbeResult,
  type LockerWorkerConfig,
} from "../../lib/ipc";
import { useOverlayBack } from "../../shared/mobileBack";

type ConfigView = "form" | "methods" | "guide" | "progress";
const CF_TOKEN_URL = "https://dash.cloudflare.com/profile/api-tokens";

const EMPTY_WORKER: LockerWorkerConfig = {
  baseUrl: "",
  workersDevUrl: "",
  hasSecret: false,
  hasApiToken: false,
  tokenLast4: "",
  lastMethod: "",
};

function isDeployMethod(
  value: string | null | undefined,
): value is LockerDeployMethod {
  return value === "apiToken" || value === "wrangler";
}

function hasViewableProgress(p: LockerDeployProgress | null): boolean {
  if (!p) return false;
  return (
    p.running ||
    p.finished ||
    Boolean(p.error) ||
    p.waitingForAccount ||
    p.steps.some((step) => step.status !== "pending")
  );
}

function idleSteps(): LockerDeployStep[] {
  return Array.from({ length: 12 }, (_, i) => ({
    index: i + 1,
    name: "",
    status: "pending",
    detail: "",
  }));
}

function redactSecrets(text: string, secrets: string[]) {
  return secrets.reduce((out, secret) => {
    const value = secret.trim();
    if (value.length < 8) return out;
    return out.split(value).join("••••");
  }, text);
}

export function LockerConnectionSettings({
  onClose,
  onChanged,
  disabled,
}: {
  onClose: () => void;
  onChanged: () => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const [worker, setWorker] = useState<LockerWorkerConfig>(EMPTY_WORKER);
  const [workerUrl, setWorkerUrl] = useState("");
  const [workerSecret, setWorkerSecret] = useState("");
  const [pasteToken, setPasteToken] = useState("");
  const [configView, setConfigView] = useState<ConfigView>("form");
  const [guideErr, setGuideErr] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [probeBusy, setProbeBusy] = useState(false);
  const [probe, setProbe] = useState<LockerProbeResult | null>(null);
  const [progress, setProgress] = useState<LockerDeployProgress | null>(null);
  const [deployRun, setDeployRun] = useState<
    "idle" | "running" | "failed" | "done"
  >("idle");
  const dirty = useRef(false);
  const sensitiveInputs = useRef<string[]>([]);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      sensitiveInputs.current = [];
    };
  }, []);
  const shareReady = !!worker.baseUrl.trim() && worker.hasSecret;
  const stepName = useCallback(
    (index: number) => t(`tools.lockerStep${index}`),
    [t],
  );
  const applyDeployRun = useCallback(
    (next: LockerDeployProgress, follow = false) => {
      setDeployRun(
        next.finished
          ? "done"
          : next.error
            ? "failed"
            : next.running || next.waitingForAccount
              ? "running"
              : "idle",
      );
      if (follow) setConfigView("progress");
    },
    [],
  );
  const reload = useCallback(async () => {
    const cfg = await api.lockerGetWorkerConfig();
    if (!alive.current) return;
    setWorker(cfg);
    if (!dirty.current) setWorkerUrl(cfg.baseUrl);
    onChanged();
  }, [onChanged]);
  useEffect(() => {
    void reload().catch((e) => setErr(errMessage(e)));
    void api
      .lockerDeployStatus()
      .then((next) => {
        if (alive.current) {
          setProgress(next);
          applyDeployRun(next);
        }
      })
      .catch(() => {});
  }, [reload, applyDeployRun]);
  useEffect(() => {
    let stop: (() => void) | undefined;
    let disposed = false;
    void listen<LockerDeployProgress>(LOCKER_DEPLOY_PROGRESS_EVENT, (ev) => {
      if (!alive.current) return;
      setProgress(ev.payload);
      applyDeployRun(ev.payload);
      if (ev.payload.finished)
        void reload().catch((e) => setErr(errMessage(e)));
    })
      .then((fn) => {
        if (disposed) fn();
        else stop = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      stop?.();
    };
  }, [applyDeployRun, reload]);
  const closeConfigView = useCallback(
    () => setConfigView((view) => (view === "guide" ? "methods" : "form")),
    [],
  );
  useOverlayBack(configView !== "form", closeConfigView);
  async function saveWorker() {
    setBusy(true);
    setErr("");
    try {
      await api.lockerSaveWorkerConfig(
        workerUrl.trim(),
        workerSecret.trim() || null,
        false,
      );
      setWorkerSecret("");
      dirty.current = false;
      await reload();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const deploying = deployRun === "running";
  const deployedOnce = Boolean(
    worker.workersDevUrl ||
    worker.lastMethod ||
    worker.hasApiToken ||
    shareReady,
  );
  const workersDevUrl = (worker.workersDevUrl || "").replace(/\/$/, "");
  const canRestoreWorkersDev = Boolean(
    workersDevUrl && workerUrl.trim().replace(/\/$/, "") !== workersDevUrl,
  );

  async function startDeploy(method: LockerDeployMethod, token?: string) {
    if (token) sensitiveInputs.current.push(token);
    setGuideErr("");
    setErr("");
    setDeployRun("running");
    try {
      const next = await api.lockerDeployStart(method, token || null);
      setProgress(next);
      applyDeployRun(next, true);
      setConfigView("progress");
    } catch (e) {
      const message = redactSecrets(errMessage(e), sensitiveInputs.current);
      setDeployRun("idle");
      if (method === "apiToken") {
        setGuideErr(message);
        setConfigView("guide");
        return;
      }
      setErr(message);
    }
  }

  async function probeWorker() {
    setProbeBusy(true);
    setErr("");
    setProbe(null);
    try {
      setProbe(await api.lockerProbeWorker(workerUrl.trim()));
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setProbeBusy(false);
    }
  }

  async function clearDeployToken() {
    setBusy(true);
    setErr("");
    try {
      const cfg = await api.lockerClearApiToken();
      setWorker(cfg);
      if (!dirty.current) setWorkerUrl(cfg.baseUrl);
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function cancelDeploy() {
    if (!progress?.cancelable) return;
    try {
      const next = await api.lockerDeployCancel();
      setProgress(next);
      applyDeployRun(next);
    } catch (e) {
      setErr(errMessage(e));
      return;
    }
    setConfigView("methods");
  }

  async function retryDeploy() {
    const fromProgress = progress?.method;
    const method = isDeployMethod(fromProgress)
      ? fromProgress
      : isDeployMethod(worker.lastMethod)
        ? worker.lastMethod
        : null;
    if (!method) {
      setConfigView("methods");
      return;
    }
    await startDeploy(method);
  }

  async function selectDeployAccount(accountId: string) {
    setErr("");
    try {
      const next = await api.lockerDeploySelectAccount(accountId);
      setProgress(next);
      applyDeployRun(next, true);
    } catch (e) {
      setErr(errMessage(e));
    }
  }

  function openDeployMethods() {
    if (deploying) return;
    setGuideErr("");
    setPasteToken("");
    setConfigView("methods");
  }

  async function openProgress() {
    setErr("");
    try {
      const status = await api.lockerDeployStatus();
      setProgress(status);
      applyDeployRun(status);
      setConfigView("progress");
    } catch (e) {
      setErr(errMessage(e));
    }
  }

  async function restoreWorkersDev() {
    if (!workersDevUrl) return;
    setBusy(true);
    setErr("");
    try {
      const cfg = await api.lockerSaveWorkerConfig(workersDevUrl);
      setWorker(cfg);
      setWorkerUrl(cfg.baseUrl);
      setWorkerSecret("");
      setProbe(null);
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function safeDetail(text?: string) {
    if (!text) return "";
    return redactSecrets(text, [
      workerSecret,
      pasteToken,
      ...sensitiveInputs.current,
    ]);
  }

  return (
    <section className="locker-v2-config">
      <div className="locker-v2-taskbar">
        <button
          type="button"
          className="btn ghost sm"
          onClick={() =>
            configView === "form" ? onClose() : closeConfigView()
          }
        >
          {t("common.back")}
        </button>
        <h2>{t("locker.connectionSettings")}</h2>
      </div>
      <fieldset disabled={disabled} className="locker-v2-config-fields">
        {configView === "form" && (
          <div className="card-body stack">
            {err && <div className="callout danger sm">{err}</div>}
            <div className="muted">
              {shareReady
                ? t("locker.serviceConfiguredHint")
                : t("tools.lockerShareDisabled")}
            </div>
            <label className="field">
              <span>{t("tools.lockerWorkerUrl")}</span>
              <input
                className="input"
                value={workerUrl}
                disabled={busy || deploying}
                onChange={(e) => {
                  dirty.current = true;
                  setWorkerUrl(e.target.value);
                  setProbe(null);
                }}
                placeholder="https://locker.example.com"
              />
            </label>
            <label className="field">
              <span>{t("tools.lockerWorkerSecret")}</span>
              <input
                className="input"
                type="password"
                disabled={busy || deploying}
                value={workerSecret}
                onChange={(e) => {
                  dirty.current = true;
                  setWorkerSecret(e.target.value);
                }}
                placeholder={
                  worker.hasSecret ? t("tools.lockerSecretKeep") : ""
                }
              />
            </label>
            {worker.hasApiToken && (
              <div className="locker-token-row">
                <span>
                  {t("tools.lockerTokenSaved", {
                    last4: worker.tokenLast4 || "••••",
                  })}
                </span>
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={busy || deploying}
                  onClick={() => void clearDeployToken()}
                >
                  {t("tools.lockerTokenClear")}
                </button>
              </div>
            )}
            <button
              type="button"
              className="btn primary"
              disabled={busy || deploying}
              onClick={() => void saveWorker()}
            >
              {t("common.save")}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || deploying}
              onClick={openDeployMethods}
            >
              {deployedOnce
                ? t("tools.lockerRedeploy")
                : t("tools.lockerDeploy")}
            </button>
            {hasViewableProgress(progress) && (
              <button
                type="button"
                className="btn"
                onClick={() => void openProgress()}
              >
                {t("tools.lockerViewProgress")}
              </button>
            )}
            <button
              type="button"
              className="btn"
              disabled={probeBusy || !workerUrl.trim()}
              onClick={() => void probeWorker()}
            >
              {probeBusy ? t("common.busy") : t("tools.lockerProbe")}
            </button>
            {canRestoreWorkersDev && (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void restoreWorkersDev()}
              >
                {t("tools.lockerRestoreWorkersDev")}
              </button>
            )}
            {probe && (
              <div
                className={"locker-probe" + (probe.ok ? " is-ok" : " is-bad")}
              >
                {probe.checks.map((check) => (
                  <div
                    key={check.id}
                    className={
                      "locker-probe-item" + (check.ok ? " is-ok" : " is-bad")
                    }
                  >
                    <span className="locker-probe-led" aria-hidden="true" />
                    <div>
                      <strong>
                        {check.id === "download"
                          ? t("tools.lockerProbeDownload")
                          : check.id === "gate"
                            ? t("tools.lockerProbeGate")
                            : t("tools.lockerProbeService")}
                      </strong>
                      {check.detail && <p>{safeDetail(check.detail)}</p>}
                    </div>
                  </div>
                ))}
                <div className="locker-probe-sum">
                  {probe.ok
                    ? t("tools.lockerProbeOk")
                    : t("tools.lockerProbeFail")}
                </div>
                {probe.hint && (
                  <p className="muted">{safeDetail(probe.hint)}</p>
                )}
              </div>
            )}
          </div>
        )}
        {configView === "methods" && (
          <div className="card-body stack">
            {err && <div className="callout danger sm">{err}</div>}
            <p className="muted">{t("tools.lockerDeployMethodsHint")}</p>
            <div className="locker-methods">
              <button
                type="button"
                className={
                  "locker-method" +
                  (worker.lastMethod === "apiToken" ? " is-last" : "")
                }
                disabled={deploying}
                onClick={() => {
                  setGuideErr("");
                  setConfigView("guide");
                }}
              >
                {worker.lastMethod === "apiToken" && (
                  <span className="locker-slot">
                    {t("tools.lockerMethodLast")}
                  </span>
                )}
                <strong>{t("tools.lockerMethodApiTitle")}</strong>
                <span>{t("tools.lockerMethodApiDesc")}</span>
              </button>
              <button
                type="button"
                className={
                  "locker-method" +
                  (worker.lastMethod === "wrangler" ? " is-last" : "")
                }
                disabled={deploying}
                onClick={() => void startDeploy("wrangler")}
              >
                {worker.lastMethod === "wrangler" && (
                  <span className="locker-slot">
                    {t("tools.lockerMethodLast")}
                  </span>
                )}
                <strong>{t("tools.lockerMethodWranglerTitle")}</strong>
                <span>{t("tools.lockerMethodWranglerDesc")}</span>
              </button>
            </div>
          </div>
        )}
        {configView === "guide" && (
          <div className="card-body stack">
            {guideErr && <div className="callout danger sm">{guideErr}</div>}
            <p className="muted">{t("tools.lockerGuideIntro")}</p>
            <ol className="locker-guide-list">
              <li>{t("tools.lockerGuideStep1")}</li>
              <li>
                {t("tools.lockerGuidePermsTitle")}
                <ul>
                  <li>{t("tools.lockerGuidePermScripts")}</li>
                  <li>{t("tools.lockerGuidePermR2")}</li>
                  <li>{t("tools.lockerGuidePermD1")}</li>
                  <li>{t("tools.lockerGuidePermAccount")}</li>
                </ul>
              </li>
              <li>{t("tools.lockerGuideUserPerms")}</li>
            </ol>
            <p className="muted">{t("tools.lockerGuideCopyHint")}</p>
            <button
              type="button"
              className="btn"
              onClick={() => void api.openUrl(CF_TOKEN_URL)}
            >
              {t("tools.lockerGuideOpenDash")}
            </button>
            {worker.hasApiToken && (
              <div className="locker-token-row">
                <span>
                  {t("tools.lockerTokenSaved", {
                    last4: worker.tokenLast4 || "••••",
                  })}
                </span>
                <button
                  type="button"
                  className="btn primary"
                  disabled={deploying}
                  onClick={() => void startDeploy("apiToken")}
                >
                  {t("tools.lockerGuideUseSaved")}
                </button>
              </div>
            )}
            <label className="field">
              <span>{t("tools.lockerGuideToken")}</span>
              <textarea
                className="input locker-token-input"
                rows={3}
                value={pasteToken}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setPasteToken(e.target.value)}
                placeholder={t("tools.lockerGuideTokenPh")}
              />
            </label>
            <button
              type="button"
              className="btn primary"
              disabled={deploying || !pasteToken.trim()}
              onClick={() => {
                const token = pasteToken.trim();
                if (!token) {
                  setGuideErr(t("tools.lockerGuideNeedToken"));
                  return;
                }
                setPasteToken("");
                void startDeploy("apiToken", token);
              }}
            >
              {t("tools.lockerGuideStart")}
            </button>
          </div>
        )}
        {configView === "progress" && (
          <div className="card-body stack locker-deploy-body">
            <ol className="locker-v2-deploy-phases">
              {[
                { key: "deployAuthorize", end: 3 },
                { key: "deployResources", end: 6 },
                { key: "deployPublish", end: 10 },
                { key: "deployVerify", end: 12 },
              ].map((stage, index, all) => {
                const done =
                  progress?.finished ||
                  (progress?.currentStep || 1) > stage.end;
                const current =
                  !done &&
                  (progress?.currentStep || 1) > (all[index - 1]?.end || 0);
                return (
                  <li
                    key={stage.key}
                    className={done ? "done" : current ? "current" : ""}
                  >
                    <span>
                      {index + 1}. {t(`locker.${stage.key}`)}
                    </span>
                    <small>
                      {t(
                        done
                          ? "tools.lockerStepDone"
                          : current
                            ? "tools.lockerStepRunning"
                            : "tools.lockerStepPending",
                      )}
                    </small>
                  </li>
                );
              })}
            </ol>
            {err && <div className="callout danger sm">{err}</div>}
            <div
              className={
                "locker-deploy-now" +
                (progress?.error
                  ? " is-failed"
                  : progress?.finished
                    ? " is-done"
                    : "")
              }
            >
              {progress?.finished
                ? t("tools.lockerProgressDone")
                : progress?.error
                  ? t("tools.lockerProgressFailed", {
                      current: progress.currentStep,
                      name:
                        progress.steps.find(
                          (step) => step.index === progress.currentStep,
                        )?.name || stepName(progress.currentStep),
                    })
                  : t("tools.lockerProgressNow", {
                      current: progress?.currentStep || 1,
                      name:
                        progress?.steps.find(
                          (step) => step.index === progress.currentStep,
                        )?.name || stepName(progress?.currentStep || 1),
                    })}
            </div>
            <details
              className="locker-v2-deploy-details"
              open={!!progress?.waitingForAccount || !!progress?.error}
            >
              <summary>{t("locker.deployDetails")}</summary>
              <ol className="locker-deploy-steps">
                {(progress?.steps?.length ? progress.steps : idleSteps()).map(
                  (step) => {
                    const showAccounts =
                      Boolean(progress?.waitingForAccount) &&
                      step.index === (progress?.currentStep || 3);
                    return (
                      <li
                        key={step.index}
                        className={
                          "locker-deploy-step is-" +
                          step.status +
                          (progress?.currentStep === step.index
                            ? " is-current"
                            : "")
                        }
                      >
                        <span className="locker-deploy-index">
                          {step.index}
                        </span>
                        <div className="locker-deploy-copy">
                          <strong>{step.name || stepName(step.index)}</strong>
                          <span className="locker-deploy-state">
                            {step.status === "running"
                              ? t("tools.lockerStepRunning")
                              : step.status === "waiting"
                                ? t("tools.lockerStepWaiting")
                                : step.status === "done"
                                  ? t("tools.lockerStepDone")
                                  : step.status === "failed"
                                    ? t("tools.lockerStepFailed")
                                    : t("tools.lockerStepPending")}
                          </span>
                          {progress?.currentStep === step.index &&
                            safeDetail(step.detail) && (
                              <p>{safeDetail(step.detail)}</p>
                            )}
                          {step.status === "failed" &&
                            safeDetail(step.detail) &&
                            progress?.currentStep !== step.index && (
                              <p>{safeDetail(step.detail)}</p>
                            )}
                          {showAccounts && (
                            <div className="locker-accounts">
                              <div className="muted">
                                {t("tools.lockerPickAccount")}
                              </div>
                              {progress?.accounts.map((account) => (
                                <button
                                  key={account.id}
                                  type="button"
                                  className="btn"
                                  onClick={() =>
                                    void selectDeployAccount(account.id)
                                  }
                                >
                                  {account.name}
                                </button>
                              ))}
                            </div>
                          )}
                          {step.status === "failed" && (
                            <button
                              type="button"
                              className="btn primary"
                              disabled={deploying}
                              onClick={() => void retryDeploy()}
                            >
                              {t("tools.lockerRetryStep")}
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  },
                )}
              </ol>
            </details>
            {progress?.cancelable === true && (
              <button
                type="button"
                className="btn"
                onClick={() => void cancelDeploy()}
              >
                {t("common.cancel")}
              </button>
            )}
            {progress?.finished && (
              <div className="locker-deploy-success">
                <div>
                  {t("tools.lockerSuccessUrl", {
                    url:
                      progress.currentUrl || workerUrl || workersDevUrl || "—",
                  })}
                </div>
                <div className="muted">
                  {progress.hasSecret || worker.hasSecret
                    ? t("tools.lockerSuccessSecret")
                    : t("tools.lockerSuccessNoSecret")}
                </div>
                {progress.keptCustomAddress && (
                  <div className="muted">{t("tools.lockerKeptCustomUrl")}</div>
                )}
                {progress.keptCustomAddress &&
                  progress.currentUrl &&
                  progress.workersDevUrl &&
                  progress.currentUrl.replace(/\/$/, "") !==
                    progress.workersDevUrl.replace(/\/$/, "") && (
                    <div className="muted">
                      {t("tools.lockerCustomDomainPending")}
                    </div>
                  )}
                <p className="muted">{t("tools.lockerSuccessHint")}</p>
              </div>
            )}
          </div>
        )}
      </fieldset>
    </section>
  );
}
