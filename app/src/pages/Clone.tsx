import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderGit2, X, AlertTriangle } from "lucide-react";
import {
  api,
  errMessage,
  type Inference,
  type ClonePlan,
  type CloneResult,
  type Candidate,
} from "../lib/ipc";
import { PageHead, Card, Badge } from "../ui/common";
import { writeClipboard } from "../lib/clipboard";
import { useApp } from "../store";

const CONF_KEYS: Record<string, string> = {
  certain: "clone.certain",
  veryHigh: "clone.veryHigh",
  mediumHigh: "clone.mediumHigh",
  low: "clone.low",
};

function guessRepoName(url: string): string {
  const cleaned = url.trim().replace(/\.git$/i, "").replace(/[\\/]+$/, "");
  const parts = cleaned.split(/[/:]/).filter(Boolean);
  return parts[parts.length - 1] || "repo";
}

function candidateBasis(c: Candidate, t: (key: string) => string): string {
  if (c.probeKind) {
    const key = `clone.probeKind.${c.probeKind}`;
    const translated = t(key);
    if (translated !== key) return translated;
  }
  return c.basis;
}

function modeLabel(mode: string, t: (key: string) => string): string {
  if (mode === "clone") return "git clone";
  if (mode === "init") return t("clone.modeInit");
  if (mode === "addRemote") return t("clone.modeAddRemote");
  return mode;
}

export function ClonePage({
  embedded = false,
  onGoRepos,
}: {
  embedded?: boolean;
  onGoRepos?: () => void;
} = {}) {
  const { t } = useTranslation();
  const { writesLocked } = useApp();
  const nav = useNavigate();
  const [searchParams] = useSearchParams();
  const [url, setUrl] = useState("");
  const [inf, setInf] = useState<Inference | null>(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [cloneBusy, setCloneBusy] = useState(false);
  const [probeBusy, setProbeBusy] = useState(false);
  const [pickedIdentityId, setPickedIdentityId] = useState("");
  const [pending, setPending] = useState<{
    destDir: string;
    plan: ClonePlan;
    identity: Candidate;
    cloneUrl: string;
  } | null>(null);
  const [lastClone, setLastClone] = useState<CloneResult | null>(null);

  const identityOptions = useMemo(() => {
    if (!inf) return [];
    if (inf.candidates.length > 0) return inf.candidates;
    return inf.recommended ? [inf.recommended] : [];
  }, [inf]);

  const activeIdentity =
    identityOptions.find((c) => c.identityId === pickedIdentityId) ?? inf?.recommended ?? identityOptions[0] ?? null;

  async function resolve(nextUrl = url) {
    setErr("");
    setMsg("");
    setInf(null);
    setLastClone(null);
    setPending(null);
    const raw = nextUrl.trim();
    if (!raw) return;
    try {
      const result = await api.resolveUrl(raw);
      setInf(result);
      setPickedIdentityId(result.recommended?.identityId ?? result.candidates[0]?.identityId ?? "");
    } catch (e) {
      setErr(errMessage(e));
    }
  }

  async function probe() {
    setErr("");
    setMsg("");
    if (!url.trim()) return;
    setProbeBusy(true);
    try {
      const result = await api.probeUrlIdentity(url);
      setInf(result);
      setPickedIdentityId(result.recommended?.identityId ?? result.candidates[0]?.identityId ?? "");
      if (!result.recommended) {
        setMsg(t("clone.probeNone"));
      }
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setProbeBusy(false);
    }
  }

  useEffect(() => {
    const q = searchParams.get("url")?.trim();
    if (!q) return;
    setUrl(q);
    void resolve(q);
    // 只在进入页时吃一次查询参数。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  async function startClone() {
    setErr("");
    setMsg("");
    if (!inf) return setErr(t("clone.needParse"));
    if (!activeIdentity) return setErr(t("clone.needIdentity"));

    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t("clone.pickDest"),
      });
      if (typeof selected !== "string" || !selected) return;

      const repoName = guessRepoName(inf.rewrittenUrl || url);
      const plan = await api.inspectCloneTarget(selected, repoName);
      setPending({
        destDir: selected,
        plan,
        identity: activeIdentity,
        cloneUrl: inf.rewrittenUrl || url.trim(),
      });
    } catch (e) {
      setErr(errMessage(e));
    }
  }

  async function confirmClone() {
    if (!pending) return;
    if (!pending.plan.canProceed) {
      setPending(null);
      return;
    }
    setCloneBusy(true);
    setErr("");
    try {
      const result = await api.cloneRepo({
        url: pending.cloneUrl,
        destDir: pending.destDir,
        identityId: pending.identity.identityId,
        mode: pending.plan.suggestedMode,
      });
      setLastClone(result);
      setMsg(t("clone.done", { dest: result.dest }));
      setPending(null);
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setCloneBusy(false);
    }
  }

  return (
    <div className="stack-lg">
      {!embedded && <PageHead title={t("clone.title")} desc={t("clone.desc")} />}
      {err && <div className="err-text">{err}</div>}
      {msg && <div className="callout good">{msg}</div>}

      <Card title={t("clone.parseTitle")}>
        <div className="stack">
          <div className="path-pick">
            <input
              className="input mono"
              placeholder={t("clone.urlPh")}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && resolve()}
            />
            <button type="button" className="btn primary" onClick={() => void resolve()}>
              {t("clone.parse")}
            </button>
          </div>

          {inf && (
            <div className="stack">
              {inf.rewrittenUrl && (
                <div className="callout good between">
                  <span className="mono grow">{inf.rewrittenUrl}</span>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => writeClipboard(inf.rewrittenUrl!)}
                  >
                    {t("common.copy")}
                  </button>
                </div>
              )}
              {inf.recommended && (
                <div className="callout info">
                  <span>
                    {t("clone.recommend")}
                    <strong>{inf.recommended.identityName}</strong>
                    {t("clone.alias", { alias: inf.recommended.hostAlias })}
                  </span>
                  <Badge kind="good">{CONF_KEYS[inf.recommended.confidence] ? t(CONF_KEYS[inf.recommended.confidence]) : inf.recommended.confidence}</Badge>
                  <div className="muted sm" style={{ flexBasis: "100%" }}>
                    {t("clone.basis", { basis: candidateBasis(inf.recommended, t) })}
                  </div>
                </div>
              )}
              {inf.candidates.length > 1 && (
                <div className="list">
                  {inf.candidates.map((c) => (
                    <div className="list-row" key={c.identityId}>
                      <div className="grow">
                        <strong>{c.identityName}</strong>
                        <span className="mono muted sm"> · {c.hostAlias}</span>
                      </div>
                      <Badge>{CONF_KEYS[c.confidence] ? t(CONF_KEYS[c.confidence]) : c.confidence}</Badge>
                      <span className="muted sm">{candidateBasis(c, t)}</span>
                    </div>
                  ))}
                </div>
              )}
              {inf.needsProbe && <div className="callout warn">{t("clone.needProbe")}</div>}
              {!inf.recommended && !inf.needsProbe && <div className="muted">{t("clone.noMatch")}</div>}
              <div className="row" style={{ flexWrap: "wrap" }}>
                <button type="button" className="btn" disabled={probeBusy || cloneBusy} onClick={() => void probe()}>
                  {probeBusy ? t("clone.probing") : t("clone.probe")}
                </button>
              </div>

              {identityOptions.length > 1 && (
                <div className="field">
                  <label className="field-label">{t("clone.useIdentity")}</label>
                  <select
                    className="input"
                    value={activeIdentity?.identityId ?? ""}
                    onChange={(e) => setPickedIdentityId(e.target.value)}
                  >
                    {identityOptions.map((c) => (
                      <option key={c.identityId} value={c.identityId}>
                        {t("clone.identityOption", { name: c.identityName, alias: c.hostAlias })}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="row" style={{ justifyContent: "flex-end" }}>
                <button
                  type="button"
                  className="btn primary"
                  disabled={!activeIdentity || cloneBusy || writesLocked}
                  onClick={startClone}
                >
                  <FolderGit2 size={14} />
                  <span>{cloneBusy ? t("common.busy") : t("clone.cloneLocal")}</span>
                </button>
              </div>

              {lastClone && (
                <div className="callout info sm">
                  {t("clone.added", { name: lastClone.identityName, mode: modeLabel(lastClone.mode, t) })}{" "}
                  <span className="mono">{lastClone.usedUrl}</span>
                  <button
                    type="button"
                    className="btn sm"
                    style={{ marginLeft: 8 }}
                    onClick={() => {
                      if (onGoRepos) onGoRepos();
                      else nav("/repos");
                    }}
                  >
                    {t("clone.goRepos")}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </Card>

      {pending && (
        <CloneConfirmModal
          pending={pending}
          busy={cloneBusy}
          onCancel={() => setPending(null)}
          onConfirm={confirmClone}
        />
      )}
    </div>
  );
}

function CloneConfirmModal({
  pending,
  busy,
  onCancel,
  onConfirm,
}: {
  pending: { destDir: string; plan: ClonePlan; identity: Candidate; cloneUrl: string };
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const blocked = !pending.plan.canProceed;
  return (
    <div className="wizard-overlay" style={{ zIndex: 60 }}>
      <div
        className="card"
        style={{
          width: 460,
          maxWidth: "95%",
          border: blocked ? "1px solid var(--amber)" : "1px solid var(--border)",
        }}
      >
        <div className="card-head" style={blocked ? { background: "var(--amber-soft)" } : undefined}>
          <div className="row" style={{ gap: 6 }}>
            {blocked ? <AlertTriangle size={15} style={{ color: "var(--amber)" }} /> : <FolderGit2 size={15} />}
            <div className="card-title">{blocked ? t("clone.blocked") : t("clone.confirmMode")}</div>
          </div>
          <button type="button" className="btn ghost sm" onClick={onCancel} disabled={busy}>
            <X size={15} />
          </button>
        </div>

        <div className="card-body stack" style={{ gap: 8, padding: "12px 14px" }}>
          <div className={blocked ? "callout warn sm" : "callout info sm"}>{pending.plan.message}</div>
          <div className="muted sm">{t("clone.autoAdd")}</div>
          <div className="grid-sum">
            <div>
              <div className="muted">{t("clone.folder")}</div>
              <div className="mono">{pending.destDir}</div>
            </div>
            <div>
              <div className="muted">{t("clone.target")}</div>
              <div className="mono">{pending.plan.targetPath}</div>
            </div>
            <div>
              <div className="muted">{t("clone.willRun")}</div>
              <div>{modeLabel(pending.plan.suggestedMode, t)}</div>
            </div>
            <div>
              <div className="muted">{t("clone.identity")}</div>
              <div>
                {pending.identity.identityName}
                <span className="mono muted sm"> · {pending.identity.hostAlias}</span>
              </div>
            </div>
          </div>
          <div>
            <div className="muted">{t("clone.remote")}</div>
            <div className="mono">{pending.cloneUrl}</div>
          </div>
        </div>

        <div
          className="card-head"
          style={{ justifyContent: "flex-end", gap: 8, borderTop: "1px solid var(--border)", borderBottom: "none" }}
        >
          <button type="button" className="btn ghost sm" onClick={onCancel} disabled={busy}>
            {blocked ? t("common.close") : t("clone.otherDir")}
          </button>
          {!blocked && (
            <button type="button" className="btn primary sm" disabled={busy} onClick={onConfirm}>
              {busy ? t("clone.running") : pending.plan.suggestedMode === "init" ? t("clone.confirmInit") : t("clone.confirmClone")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
