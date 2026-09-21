import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, errMessage, type AgentStatus, type AgentUnifyReport } from "../lib/ipc";
import { loadAgentStatus, peekAgentStatus } from "../lib/agentCache";
import { PageHead, Card, Empty, Badge } from "../ui/common";
import { EnvUnifyDialog } from "../ui/EnvUnifyDialog";

function guessHostOs(): string {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("windows")) return "windows";
  if (ua.includes("mac")) return "macos";
  return "linux";
}

export function AgentPage() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<AgentStatus | null>(() => peekAgentStatus());
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(() => !peekAgentStatus());
  const [report, setReport] = useState<AgentUnifyReport | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function detect(force = true) {
    setErr("");
    if (force || !peekAgentStatus()) setScanning(true);
    try {
      setStatus(await loadAgentStatus(force));
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setScanning(false);
    }
  }

  useEffect(() => {
    if (peekAgentStatus()) return;
    void detect(false);
  }, []);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setErr("");
    setMsg("");
    setBusy(true);
    try {
      await fn();
      if (ok) setMsg(ok);
      await detect();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const unify = status?.unify;
  const os = unify?.os || guessHostOs();
  const needsApply = unify && !unify.aligned;
  const checks = unify?.checks ?? [];
  const failCount = checks.filter((c) => !c.ok).length;
  const isWindows = os === "windows";

  return (
    <div className="stack-lg">
      <PageHead
        title={t("agent.title")}
        desc={isWindows ? t("agent.descWin") : t("agent.descUnix")}
        actions={
          <>
            <button className="btn" disabled={busy || scanning} onClick={() => detect(true)}>
              {scanning ? t("agent.scanning") : t("agent.rescan")}
            </button>
            <button className="btn" disabled={busy} onClick={() => run(() => api.agentEnsure(), t("agent.ensured"))}>
              {t("agent.ensure")}
            </button>
            <button className="btn" disabled={busy} onClick={() => setConfirmOpen(true)}>
              {t("agent.applyEnv")}
            </button>
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const n = await api.agentLoadAll();
                  setMsg(t("agent.loadedN", { n }));
                }, "")
              }
            >
              {t("agent.loadAll")}
            </button>
            <button className="btn danger" disabled={busy} onClick={() => run(() => api.agentClear(), t("agent.cleared"))}>
              {t("agent.clear")}
            </button>
          </>
        }
      />
      {err && !confirmOpen && <div className="err-text">{err}</div>}
      {msg && <div className="callout info">{msg}</div>}

      <Card
        title={t("agent.envTitle")}
        actions={
          unify ? (
            <Badge kind={unify.aligned ? "good" : "warn"}>
              {scanning
                ? t("agent.scanningShort")
                : unify.aligned
                  ? isWindows
                    ? t("agent.usingGitAgent")
                    : t("agent.localReady")
                  : t("agent.nNotReady", { n: failCount })}
            </Badge>
          ) : null
        }
      >
        {scanning && !status ? (
          <div className="muted sm">{isWindows ? t("agent.scanningWin") : t("agent.scanningUnix")}</div>
        ) : (
          <>
            <div className="row" style={{ marginBottom: 12, gap: 8 }}>
              <Badge kind={status?.running ? "good" : "danger"}>{status?.running ? t("agent.running") : t("agent.stopped")}</Badge>
              {status?.usingFallback && (
                <Badge kind="good">{isWindows ? t("agent.procGit") : t("agent.procLocal")}</Badge>
              )}
            </div>

            {needsApply && (
              <div className="callout warn" style={{ marginBottom: 12 }}>
                <div>
                  {isWindows ? (
                    <>
                      {t("agent.misalignWin1")} {t("agent.misalignWin2")}
                    </>
                  ) : (
                    <>
                      {t("agent.misalignUnix1")} {t("agent.misalignUnix2")}
                    </>
                  )}
                </div>
                <button type="button" className="btn sm" disabled={busy} onClick={() => setConfirmOpen(true)}>
                  {t("agent.applyEnv")}
                </button>
              </div>
            )}

            {unify?.aligned && (
              <div className="callout good" style={{ marginBottom: 12 }}>
                {isWindows ? t("agent.passWin") : t("agent.passUnix")}
              </div>
            )}

            {checks.length > 0 ? (
              <div className="list env-check-list">
                <div className="env-check-head">
                  <span>{t("agent.colCheck")}</span>
                  <span>{t("agent.colResult")}</span>
                  <span>{t("agent.colValue")}</span>
                </div>
                {checks.map((c) => (
                  <div key={c.key}>
                    <div className="list-row env-check-row">
                      <div className="env-check-label">{c.label}</div>
                      <Badge kind={c.ok ? "good" : "warn"}>{c.ok ? t("agent.pass") : t("agent.notSet")}</Badge>
                      <div className="mono muted sm env-check-value">{c.current || t("agent.emptyValue")}</div>
                    </div>
                    {!c.ok && c.hint && <div className="env-check-hint">{c.hint}</div>}
                  </div>
                ))}
              </div>
            ) : (
              <Empty icon="🔍" text={t("agent.noResult")} />
            )}

            {report && report.steps.length > 0 && (
              <div className="callout info" style={{ marginTop: 12 }}>
                {report.steps.map((s, i) => (
                  <div key={i} className="mono sm">
                    {s}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </Card>

      <Card title={t("agent.loadedKeys")}>
        {!status || status.keys.length === 0 ? (
          <Empty icon="🧩" text={t("agent.noLoaded")} />
        ) : (
          <div className="list">
            {status.keys.map((k, i) => (
              <div className="list-row" key={i}>
                <div className="grow">
                  <div className="row" style={{ gap: 8 }}>
                    <strong>{k.identityName ?? k.keyName ?? t("agent.unknownKey")}</strong>
                    <Badge kind="info">{k.agent.algo}</Badge>
                    {!k.identityName && !k.keyName && <Badge kind="warn">{t("agent.outside")}</Badge>}
                  </div>
                  <div className="mono muted sm">
                    {k.agent.fingerprint} {k.agent.comment && `· ${k.agent.comment}`}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <EnvUnifyDialog
        open={confirmOpen}
        busy={busy}
        error={confirmOpen ? err : undefined}
        os={os}
        ssh={status?.ssh || unify?.gitSsh}
        sock={status?.authSock || unify?.authSock}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() =>
          run(async () => {
            const r = await api.agentUnifyEnv(true);
            setReport(r);
            setMsg(r.hint);
            setConfirmOpen(false);
          }, "")
        }
      />
    </div>
  );
}
