import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import {
  Palette,
  ShieldCheck,
  FolderKanban,
  Rocket,
  AlertTriangle,
  ExternalLink,
  Globe,
  RefreshCw,
  Cloud,
  FileCog,
  Play,
  Fingerprint,
} from "lucide-react";
import {
  api,
  errMessage,
  type BiometricStatus,
  type NetworkProxy,
  type ProxyTestResult,
  type SecurityChecklist,
  type SecurityFinding,
  type ScreenCaptureCapability,
  type SecurityLevel,
  type UpdateCheckResult,
  type UpdateSource,
} from "../lib/ipc";
import { writeClipboard } from "../lib/clipboard";
import { useApp } from "../store";
import { THEME_OPTIONS } from "../lib/theme";
import { getNotesAutoSave, setNotesAutoSaveStored, UNLOCK_ANIM_STYLES } from "../lib/prefs";
import { PageHead, Card, FieldLabel, Badge, ErrorDialog } from "../ui/common";
import { LanguageCard } from "../ui/LanguageCard";

function closeActionLabel(action: "tray" | "quit" | null | undefined, t: (key: string) => string): string {
  if (action === "tray") return t("settings.closeTray");
  if (action === "quit") return t("settings.closeQuit");
  return t("settings.closeAsk");
}

export function GithubPatSettings({ writesLocked }: { writesLocked: boolean }) {
  const { t } = useTranslation();
  const [configured, setConfigured] = useState(false);
  const [login, setLogin] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  async function refresh() {
    const s = await api.githubPatStatus();
    setConfigured(s.configured);
    if (s.configured) {
      try {
        setLogin(await api.testGithubPat());
      } catch {
        setLogin("");
      }
    } else {
      setLogin("");
    }
  }

  useEffect(() => {
    refresh().catch((e) => setErr(errMessage(e)));
  }, []);

  async function save() {
    if (!token.trim()) return setErr(t("pat.needToken"));
    setErr("");
    setMsg("");
    setBusy(true);
    try {
      await api.setGithubPat(token.trim());
      const name = await api.testGithubPat();
      setLogin(name);
      setConfigured(true);
      setToken("");
      setMsg(t("pat.saved", { name }));
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setErr("");
    setMsg("");
    setBusy(true);
    try {
      const name = await api.testGithubPat();
      setLogin(name);
      setMsg(t("pat.tested", { name }));
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setErr("");
    setMsg("");
    setBusy(true);
    try {
      await api.clearGithubPat();
      setConfigured(false);
      setLogin("");
      setMsg(t("pat.cleared"));
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <ErrorDialog message={err} onClose={() => setErr("")} />
      {msg && <div className="callout info">{msg}</div>}
      <div className="muted" style={{ fontSize: 12 }}>
        {t("pat.hint")}
      </div>
      <div className="kv">
        <span className="muted">{t("pat.status")}</span>
        <span>
          {configured ? (
            <Badge kind="good">{t("pat.configured")} {login ? `· ${login}` : ""}</Badge>
          ) : (
            <Badge kind="warn">{t("pat.unconfigured")}</Badge>
          )}
        </span>
      </div>
      <div className="field">
        <FieldLabel name={t("pat.newToken")} tip={t("pat.tokenTip")} />
        <input
          className="input mono"
          type="password"
          autoComplete="off"
          placeholder={t("settings.patTokenPh")}
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </div>
      <div className="row" style={{ flexWrap: "wrap", marginTop: 4 }}>
        <button type="button" className="btn primary sm" disabled={busy || writesLocked || !token.trim()} onClick={save}>
          {t("pat.saveTest")}
        </button>
        <button type="button" className="btn sm" disabled={busy || !configured} onClick={test}>
          {t("pat.test")}
        </button>
        <button type="button" className="btn ghost sm" disabled={busy || writesLocked || !configured} onClick={clear}>
          {t("pat.clear")}
        </button>
        <button type="button" className="btn ghost sm" onClick={() => api.openUrl("https://github.com/settings/tokens")}>
          <ExternalLink size={12} style={{ marginRight: 3 }} />
          {t("pat.openGithub")}
        </button>
      </div>
    </div>
  );
}

export function FactoryResetPanel({ onDone }: { onDone: () => Promise<void> }) {
  const { t } = useTranslation();
  const [stage, setStage] = useState<"idle" | "confirm">("idle");
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [steps, setSteps] = useState<string[]>([]);

  async function run() {
    setErr("");
    setBusy(true);
    try {
      const r = await api.factoryReset(true, phrase);
      setSteps(r.steps);
      try {
        localStorage.removeItem("gam.theme");
      } catch {
        /* ignore */
      }
      await onDone();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <ErrorDialog message={err} onClose={() => setErr("")} />
      <div className="callout danger">
        ⚠️ {t("factory.warn")}
      </div>
      {stage === "idle" ? (
        <div>
          <button type="button" className="btn danger sm" disabled={busy} onClick={() => setStage("confirm")}>
            {t("factory.prepare")}
          </button>
        </div>
      ) : (
        <div className="stack" style={{ maxWidth: 360, marginTop: 4 }}>
          <div className="muted" style={{ fontSize: 12 }}>
            {t("factory.reconfirm")}
          </div>
          <input
            className="input"
            placeholder={t("factory.phrasePh")}
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
          />
          <div className="row">
            <button
              type="button"
              className="btn danger sm"
              disabled={busy || phrase.trim() !== t("factory.phrase")}
              onClick={run}
            >
              {busy ? t("factory.running") : t("factory.confirm")}
            </button>
            <button
              type="button"
              className="btn ghost sm"
              disabled={busy}
              onClick={() => {
                setStage("idle");
                setPhrase("");
                setErr("");
              }}
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}
      {steps.length > 0 && (
        <div className="callout info">
          {steps.map((s) => (
            <div key={s}>{s}</div>
          ))}
        </div>
      )}
    </div>
  );
}

const DEFAULT_UPDATE_REPO = "ice-juice/git-keymaster-app";

function formatWhen(iso: string | null | undefined, neverLabel: string): string {
  if (!iso) return neverLabel;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function UpdateNotes({ notes }: { notes: string }) {
  const blocks = notes
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line, i, arr) => line.trim() !== "" || (i > 0 && arr[i - 1].trim() !== ""));

  return (
    <div className="update-notes">
      {blocks.map((line, i) => {
        const heading = line.match(/^#{2,3}\s+(.+)/);
        if (heading) {
          return (
            <div key={i} className="update-notes-h">
              {heading[1]}
            </div>
          );
        }
        const item = line.match(/^[-*]\s+(.+)/);
        if (item) {
          return (
            <div key={i} className="update-notes-li">
              {renderInline(item[1])}
            </div>
          );
        }
        return (
          <div key={i} className="update-notes-p">
            {renderInline(line)}
          </div>
        );
      })}
    </div>
  );
}

function renderInline(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    const bold = part.match(/^\*\*([^*]+)\*\*$/);
    if (bold) return <strong key={i}>{bold[1]}</strong>;
    return <span key={i}>{part}</span>;
  });
}

const EMPTY_PROXY: NetworkProxy = {
  enabled: false,
  scheme: "http",
  host: "127.0.0.1",
  port: 7890,
  username: "",
  password: "",
  applyToGitHttps: true,
  applyToSsh: true,
  applyToCloudSync: true,
};

export function NetworkProxyCard() {
  const { t } = useTranslation();
  const [form, setForm] = useState<NetworkProxy>(EMPTY_PROXY);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [test, setTest] = useState<ProxyTestResult | null>(null);

  useEffect(() => {
    api
      .getNetworkProxy()
      .then((p) => {
        if (p) {
          setForm({
            ...EMPTY_PROXY,
            ...p,
            username: p.username ?? "",
            password: p.password ?? "",
          });
        }
      })
      .catch((e) => setErr(errMessage(e)));
  }, []);

  function patch(partial: Partial<NetworkProxy>) {
    setForm((prev) => ({ ...prev, ...partial }));
  }

  function payload(): NetworkProxy {
    const port = Number(form.port);
    return {
      ...form,
      scheme: form.scheme || "http",
      host: form.host.trim(),
      port: Number.isFinite(port) ? port : 0,
      username: form.username?.trim() || null,
      password: form.password || null,
    };
  }

  async function save() {
    setErr("");
    setMsg("");
    setBusy(true);
    try {
      await api.saveNetworkProxy(payload());
      setMsg(payload().enabled ? t("proxy.savedOn") : t("proxy.savedOff"));
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function clearProxy() {
    setErr("");
    setMsg("");
    setBusy(true);
    try {
      await api.saveNetworkProxy(null);
      setForm(EMPTY_PROXY);
      setTest(null);
      setMsg(t("proxy.cleared"));
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function testNow() {
    setErr("");
    setMsg("");
    setTesting(true);
    try {
      const r = await api.testNetworkProxy({ ...payload(), enabled: true });
      setTest(r);
      setMsg(r.httpsOk ? t("proxy.httpsPass", { ms: r.httpsMs }) : t("proxy.httpsFail"));
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card title={t("proxy.title")}>
      <div className="stack">
        <ErrorDialog message={err} onClose={() => setErr("")} />
        {msg && <div className="callout info">{msg}</div>}
        <div className="field">
          <div className="between">
            <div>
              <FieldLabel
                name={t("proxy.enable")}
                tip={t("proxy.enableTip")}
              />
              <div className="hint">{t("proxy.hint")}</div>
            </div>
            <button
              type="button"
              className={"switch" + (form.enabled ? "" : " off")}
              disabled={busy}
              onClick={() => patch({ enabled: !form.enabled })}
            />
          </div>
        </div>

        <div className="field">
            <label className="field-label">{t("proxy.scheme")}</label>
          <div className="choice-row">
            {(["http", "https", "socks5"] as const).map((s) => (
              <button
                key={s}
                type="button"
                className={"choice" + (form.scheme === s ? " on" : "")}
                onClick={() => patch({ scheme: s })}
              >
                {s.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        <div className="row" style={{ flexWrap: "wrap" }}>
          <div className="field grow">
            <label className="field-label">{t("proxy.host")}</label>
            <input
              className="input mono"
              value={form.host}
              onChange={(e) => patch({ host: e.target.value })}
              placeholder="127.0.0.1"
            />
          </div>
          <div className="field" style={{ width: 110 }}>
            <label className="field-label">{t("proxy.port")}</label>
            <input
              className="input mono"
              type="number"
              min={1}
              max={65535}
              value={form.port}
              onChange={(e) => patch({ port: Number(e.target.value) })}
            />
          </div>
        </div>

        <div className="row" style={{ flexWrap: "wrap" }}>
          <div className="field grow">
            <label className="field-label">{t("proxy.user")}</label>
            <input className="input" value={form.username ?? ""} onChange={(e) => patch({ username: e.target.value })} />
          </div>
          <div className="field grow">
            <label className="field-label">{t("proxy.password")}</label>
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={form.password ?? ""}
              onChange={(e) => patch({ password: e.target.value })}
            />
          </div>
        </div>

        <div className="field">
          <div className="between">
            <FieldLabel name={t("proxy.gitHttps")} tip={t("proxy.gitHttpsTip")} />
            <button
              type="button"
              className={"switch" + (form.applyToGitHttps ? "" : " off")}
              disabled={busy}
              onClick={() => patch({ applyToGitHttps: !form.applyToGitHttps })}
            />
          </div>
        </div>
        <div className="field">
          <div className="between">
            <FieldLabel
              name={t("proxy.ssh")}
              tip={t("proxy.sshTip")}
            />
            <button
              type="button"
              className={"switch" + (form.applyToSsh ? "" : " off")}
              disabled={busy}
              onClick={() => patch({ applyToSsh: !form.applyToSsh })}
            />
          </div>
        </div>
        <div className="field">
          <div className="between">
            <FieldLabel name={t("proxy.cloud")} tip={t("proxy.cloudTip")} />
            <button
              type="button"
              className={"switch" + (form.applyToCloudSync ? "" : " off")}
              disabled={busy}
              onClick={() => patch({ applyToCloudSync: !form.applyToCloudSync })}
            />
          </div>
        </div>

        {test && (
          <div className={"callout " + (test.httpsOk ? "good" : "warn")}>
            <div>{test.httpsOk ? t("proxy.httpsOk", { ms: test.httpsMs }) : test.httpsError}</div>
            {test.sshNote && <div>{test.sshNote}</div>}
          </div>
        )}

        <div className="row" style={{ flexWrap: "wrap", marginTop: 4 }}>
          <button type="button" className="btn primary sm" disabled={busy || testing} onClick={testNow}>
            <Globe size={13} style={{ marginRight: 3 }} />
            {testing ? t("proxy.testing") : t("proxy.test")}
          </button>
          <button type="button" className="btn sm" disabled={busy} onClick={save}>
            {t("common.save")}
          </button>
          <button type="button" className="btn ghost sm" disabled={busy} onClick={clearProxy}>
            {t("proxy.clear")}
          </button>
        </div>
      </div>
    </Card>
  );
}

export function AboutUpdateCard() {
  const { t } = useTranslation();
  const [version, setVersion] = useState("");
  const [lastCheck, setLastCheck] = useState<string | null>(null);
  const [kind, setKind] = useState<UpdateSource["kind"]>("github");
  const [repo, setRepo] = useState("");
  const [manifestUrl, setManifestUrl] = useState("");
  const [includePrerelease, setIncludePrerelease] = useState(false);
  const [autoCheck, setAutoCheck] = useState(true);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [result, setResult] = useState<UpdateCheckResult | null>(null);

  async function loadPrefs() {
    const [src, last, auto] = await Promise.all([
      api.getUpdateSource(),
      api.getLastUpdateCheck(),
      api.getAutoCheckUpdate(),
    ]);
    setKind(src.kind === "manifest" ? "manifest" : "github");
    setRepo(src.repo ?? "");
    setManifestUrl(src.manifestUrl ?? "");
    setIncludePrerelease(!!src.includePrerelease);
    setLastCheck(last);
    setAutoCheck(auto);
  }

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion("1.8.0"));
    loadPrefs().catch((e) => setErr(errMessage(e)));
  }, []);

  function currentSource(): UpdateSource {
    if (kind === "manifest") {
      return { kind: "manifest", manifestUrl: manifestUrl.trim(), includePrerelease: false };
    }
    return {
      kind: "github",
      repo: repo.trim() || undefined,
      includePrerelease,
    };
  }

  async function saveSource() {
    setErr("");
    setMsg("");
    setBusy(true);
    try {
      await api.saveUpdateSource(currentSource());
      await loadPrefs();
      setMsg(t("update.sourceSaved"));
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function restoreDefault() {
    setErr("");
    setMsg("");
    setBusy(true);
    try {
      await api.saveUpdateSource(null);
      await loadPrefs();
      setKind("github");
      setRepo("");
      setManifestUrl("");
      setIncludePrerelease(false);
      setMsg(t("update.sourceDefault"));
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleAuto(enabled: boolean) {
    setErr("");
    setBusy(true);
    try {
      await api.setAutoCheckUpdate(enabled);
      setAutoCheck(enabled);
      setMsg(enabled ? t("update.autoOn") : t("update.autoOff"));
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function checkNow() {
    setErr("");
    setMsg("");
    setChecking(true);
    try {
      const r = await api.checkUpdate();
      setResult(r);
      setVersion(r.currentVersion);
      setLastCheck(await api.getLastUpdateCheck());
      setMsg(r.available ? t("update.found", { version: r.latestVersion }) : t("update.latest"));
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setChecking(false);
    }
  }

  async function install() {
    setErr("");
    setMsg("");
    setInstalling(true);
    try {
      await api.downloadAndInstallUpdate();
      setMsg(t("update.installedRestart"));
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setInstalling(false);
    }
  }

  async function skip() {
    const ver = result?.latestVersion;
    if (!ver) return;
    setErr("");
    setBusy(true);
    try {
      await api.skipUpdateVersion(ver);
      setMsg(t("update.skipped", { version: ver }));
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const showInstall = !!result?.available && result.selfUpdateSupported;
  const showManualOnly = !!result?.available && !result.selfUpdateSupported;

  return (
    <div className="stack-lg">
      <Card title={t("update.appInfo")}>
        <div className="stack">
          <ErrorDialog message={err} onClose={() => setErr("")} />
          {msg && <div className="callout info">{msg}</div>}
          <div className="kv">
            <span className="muted">{t("update.version")}</span>
            <span className="mono">{version || "—"}</span>
          </div>
          <div className="kv">
            <span className="muted">{t("update.lastCheck")}</span>
            <span>{formatWhen(lastCheck, t("update.never"))}</span>
          </div>
          <div className="kv">
            <span className="muted">{t("update.platform")}</span>
            <span className="mono">{result?.platform ?? t("update.platformAfter")}</span>
          </div>
          <div style={{ marginTop: 4 }}>
            <button type="button" className="btn primary sm" disabled={checking || busy} onClick={checkNow}>
              <RefreshCw size={13} className={checking ? "animate-spin" : ""} style={{ marginRight: 3 }} />
              {checking ? t("update.checking") : t("update.checkNow")}
            </button>
          </div>

          {result?.available && (
            <div className="callout info update-result">
              <div>
                <strong>{t("update.newVersion", { version: result.latestVersion })}</strong>
                {result.pubDate ? ` · ${formatWhen(result.pubDate, t("update.never"))}` : ""}
              </div>
              {result.notes && <UpdateNotes notes={result.notes} />}
              {showManualOnly && (
                <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                  {t("update.manualOnly")}
                </div>
              )}
              <div className="row" style={{ flexWrap: "wrap", marginTop: 8 }}>
                {showInstall && (
                  <button type="button" className="btn primary sm" disabled={installing} onClick={install}>
                    {installing ? t("update.installing") : t("update.install")}
                  </button>
                )}
                <button type="button" className="btn sm" disabled={busy} onClick={skip}>
                  {t("update.skip")}
                </button>
                {result.downloadUrl && (
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => api.openUrl(result.downloadUrl!)}
                  >
                    {t("update.manual")}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </Card>

      <Card title={t("update.prefs")}>
        <div className="stack">
          <div className="field">
            <div className="between">
              <div>
                <FieldLabel name={t("update.autoCheck")} tip={t("update.autoTip")} />
                <div className="hint">{t("update.autoHint")}</div>
              </div>
              <button
                type="button"
                className={"switch" + (autoCheck ? "" : " off")}
                disabled={busy}
                onClick={() => toggleAuto(!autoCheck)}
              />
            </div>
          </div>

          <div className="field" style={{ marginTop: 4 }}>
            <FieldLabel name={t("update.sourceLabel")} tip={t("update.sourceTip")} />
            <div className="choice-row">
              <button
                type="button"
                className={"choice" + (kind === "github" ? " on" : "")}
                onClick={() => setKind("github")}
              >
                {t("update.githubOfficial")}
              </button>
              <button
                type="button"
                className={"choice" + (kind === "manifest" ? " on" : "")}
                onClick={() => setKind("manifest")}
              >
                {t("update.customManifest")}
              </button>
            </div>
          </div>

          {kind === "github" ? (
            <>
              <div className="field">
                <label className="field-label">{t("update.repo")}</label>
                <input
                  className="input mono"
                  placeholder={DEFAULT_UPDATE_REPO}
                  value={repo}
                  onChange={(e) => setRepo(e.target.value)}
                />
                <div className="hint">{t("update.repoHint", { repo: DEFAULT_UPDATE_REPO })}</div>
              </div>
              <div className="field">
                <div className="between">
                  <FieldLabel name={t("update.prerelease")} tip={t("update.prereleaseTip")} />
                  <button
                    type="button"
                    className={"switch" + (includePrerelease ? "" : " off")}
                    disabled={busy}
                    onClick={() => setIncludePrerelease(!includePrerelease)}
                  />
                </div>
              </div>
            </>
          ) : (
            <div className="field">
              <label className="field-label">{t("update.manifestUrl")}</label>
              <input
                className="input mono"
                placeholder="https://mirror.example.com/latest.json"
                value={manifestUrl}
                onChange={(e) => setManifestUrl(e.target.value)}
              />
              <div className="hint">{t("update.manifestHint")}</div>
            </div>
          )}

          <div className="row" style={{ flexWrap: "wrap", marginTop: 4 }}>
            <button type="button" className="btn primary sm" disabled={busy} onClick={saveSource}>
              {t("update.saveSource")}
            </button>
            <button type="button" className="btn ghost sm" disabled={busy} onClick={restoreDefault}>
              {t("update.restoreDefault")}
            </button>
          </div>
        </div>
      </Card>

      <NetworkProxyCard />
    </div>
  );
}

function formatExpiry(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

type SettingsTab = "general" | "security" | "workspace" | "about" | "danger";

const SETTING_ANCHOR_TAB: Record<string, SettingsTab> = {
  "workspace-path": "workspace",
  "auto-lock": "workspace",
  "lock-on-sleep": "workspace",
  "reveal-grace": "security",
  "clipboard-clear": "security",
  "allow-screenshots": "security",
};

function screenshotHintKey(capability: ScreenCaptureCapability): string {
  if (capability === "overlay") return "settings.screenshotHintOverlay";
  if (capability === "unsupported") return "settings.screenshotHintUnsupported";
  return "settings.screenshotHintExclude";
}

export function ScreenshotSetting({
  allow,
  capability,
  busy,
  onToggle,
}: {
  allow: boolean;
  capability: ScreenCaptureCapability;
  busy?: boolean;
  onToggle: (next: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="stack" id="setting-allow-screenshots">
      <div className="muted">{t(screenshotHintKey(capability))}</div>
      <div className="field">
        <FieldLabel name={t("settings.screenshotAllow")} tip={t("settings.screenshotAllowTip")} />
        <label className="row" style={{ marginTop: 4, gap: 8 }}>
          <input
            type="checkbox"
            disabled={busy}
            checked={allow}
            onChange={(e) => onToggle(e.target.checked)}
          />
          <span className="hint">{t("settings.screenshotAllowHint")}</span>
        </label>
      </div>
    </div>
  );
}

function scrollToSettingAnchor(anchor: string) {
  const el = document.getElementById(`setting-${anchor}`);
  el?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function levelBadge(level: SecurityLevel, t: (key: string) => string): { kind: string; label: string } {
  if (level === "risk") return { kind: "danger", label: t("security.risk") };
  if (level === "caution") return { kind: "warn", label: t("security.caution") };
  return { kind: "good", label: t("security.safe") };
}

function findingCallout(severity: SecurityFinding["severity"]): string {
  if (severity === "warn") return "warn";
  if (severity === "info") return "info";
  return "good";
}

export function SecurityChecklistCard({
  refreshNonce,
  onJump,
}: {
  refreshNonce: number;
  onJump: (anchor: string) => void;
}) {
  const { t } = useTranslation();
  const [list, setList] = useState<SecurityChecklist | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [showOk, setShowOk] = useState(false);

  async function load() {
    setErr("");
    setBusy(true);
    try {
      setList(await api.securityChecklist());
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    load().catch((e) => setErr(errMessage(e)));
  }, [refreshNonce]);

  const todos = list?.items.filter((i) => i.severity !== "ok") ?? [];
  const oks = list?.items.filter((i) => i.severity === "ok") ?? [];
  const badge = list ? levelBadge(list.level, t) : null;

  return (
    <Card
      title={t("security.checklist")}
      actions={
        <button type="button" className="btn ghost sm" disabled={busy} onClick={load}>
          <RefreshCw size={13} className={busy ? "animate-spin" : ""} style={{ marginRight: 3 }} />
                          {busy ? t("security.refreshing") : t("common.refresh")}
        </button>
      }
    >
      <div className="stack">
        <ErrorDialog message={err} onClose={() => setErr("")} />
        {badge && (
          <div className="kv">
            <span className="muted">{t("security.status")}</span>
            <span>
              <Badge kind={badge.kind}>{badge.label}</Badge>
              {list?.checkedAt && (
                <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
                  {formatWhen(list.checkedAt, t("update.never"))}
                </span>
              )}
            </span>
          </div>
        )}

        <div className="callout info" style={{ fontSize: 12 }}>
          <div>{t("security.intro1")}</div>
          <div style={{ marginTop: 6 }}>{t("security.intro2")}</div>
          <div style={{ marginTop: 6 }}>{t("security.intro3")}</div>
        </div>

        {todos.length === 0 && list && (
          <div className="muted" style={{ fontSize: 12 }}>
            {t("security.noTodos")}
          </div>
        )}

        {todos.map((item) => (
          <div key={item.id} className={"callout " + findingCallout(item.severity)}>
            <div className="between" style={{ alignItems: "flex-start", gap: 8 }}>
              <strong>{item.title}</strong>
              <Badge kind={item.severity === "warn" ? "danger" : "warn"}>
                {item.severity === "warn" ? t("security.handle") : t("security.watch")}
              </Badge>
            </div>
            <div style={{ marginTop: 6 }}>{item.detail}</div>
            <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
              {item.advice}
            </div>
            {item.limitation && (
              <div className="hint" style={{ marginTop: 6 }}>
                {item.limitation}
              </div>
            )}
            {item.settingsAnchor && (
              <div style={{ marginTop: 8 }}>
                <button type="button" className="btn sm" onClick={() => onJump(item.settingsAnchor!)}>
                  {t("security.goto")}
                </button>
              </div>
            )}
          </div>
        ))}

        {oks.length > 0 && (
          <div>
            <button type="button" className="btn ghost sm" onClick={() => setShowOk((v) => !v)}>
              {showOk ? t("security.hideOk") : t("security.showOk", { count: oks.length })}
            </button>
            {showOk && (
              <div className="stack" style={{ marginTop: 8 }}>
                {oks.map((item) => (
                  <div key={item.id} className="callout good">
                    <div className="between">
                      <strong>{item.title}</strong>
                      <Badge kind="good">{t("security.passed")}</Badge>
                    </div>
                    <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                      {item.detail}
                    </div>
                    {item.limitation && (
                      <div className="hint" style={{ marginTop: 6 }}>
                        {item.limitation}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

export function SettingsView() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const {
    status,
    refresh,
    theme,
    setTheme,
    unlockAnimEnabled,
    setUnlockAnimEnabled,
    unlockAnimStyle,
    setUnlockAnimStyle,
    startUnlockAnim,
  } = useApp();
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [checklistNonce, setChecklistNonce] = useState(0);
  const pendingAnchor = useRef<string | null>(null);

  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [newPw2, setNewPw2] = useState("");
  const [graceDays, setGraceDays] = useState(String(status?.graceDays ?? 0));
  const [revealGrace, setRevealGrace] = useState("5");
  const [clipSec, setClipSec] = useState("20");
  const [histLimit, setHistLimit] = useState("10");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [newRecovery, setNewRecovery] = useState("");
  const [bio, setBio] = useState<BiometricStatus | null>(null);
  const [bioPw, setBioPw] = useState("");
  const [notesAutoSave, setNotesAutoSave] = useState(getNotesAutoSave);
  const [allowScreenshots, setAllowScreenshots] = useState(false);
  const [screenshotCapability, setScreenshotCapability] = useState<ScreenCaptureCapability>("exclude");

  useEffect(() => {
    setGraceDays(String(status?.graceDays ?? 0));
  }, [status?.graceDays]);

  useEffect(() => {
    api.getRevealSettings().then((s) => {
      setRevealGrace(String(s.revealGraceMinutes));
      setClipSec(String(s.clipboardClearSeconds));
      setHistLimit(String(s.accountHistoryLimit));
    }).catch(() => {});
    api.getScreenCaptureSettings().then((s) => {
      setAllowScreenshots(!!s.allowScreenshots);
      setScreenshotCapability(s.capability);
    }).catch(() => {});
    api.biometricStatus().then(setBio).catch(() => setBio(null));
  }, []);

  useEffect(() => {
    const anchor = pendingAnchor.current;
    if (!anchor) return;
    pendingAnchor.current = null;
    const id = window.setTimeout(() => scrollToSettingAnchor(anchor), 0);
    return () => window.clearTimeout(id);
  }, [activeTab]);

  function jumpToSetting(anchor: string) {
    const tab = SETTING_ANCHOR_TAB[anchor] ?? "security";
    pendingAnchor.current = anchor;
    if (tab !== activeTab) {
      setActiveTab(tab);
    } else {
      scrollToSettingAnchor(anchor);
      pendingAnchor.current = null;
    }
  }

  async function changePassword() {
    setErr("");
    setMsg("");
    if (newPw.length < 8) return setErr(t("settings.pwMin"));
    if (newPw !== newPw2) return setErr(t("settings.pwMismatch"));
    setBusy(true);
    try {
      await api.changePassword(oldPw, newPw);
      setMsg(t("settings.pwUpdated"));
      setOldPw("");
      setNewPw("");
      setNewPw2("");
      await refresh();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function rotate() {
    setErr("");
    setMsg("");
    setBusy(true);
    try {
      const r = await api.rotateRecoveryKey();
      setNewRecovery(r.recoveryKey);
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleLaunch(enabled: boolean) {
    setErr("");
    setBusy(true);
    try {
      await api.setLaunchAtLogin(enabled);
      setMsg(enabled ? t("settings.launchOn") : t("settings.launchOff"));
      await refresh();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveGrace() {
    setErr("");
    const n = Number(graceDays);
    if (!Number.isFinite(n) || n < 0 || n > 30) return setErr(t("settings.graceRange"));
    setBusy(true);
    try {
      await api.setGraceDays(Math.floor(n));
      setMsg(n === 0 ? t("settings.graceOff") : t("settings.graceOn", { days: Math.floor(n) }));
      await refresh();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const NAV_ITEMS: { id: SettingsTab; label: string; icon: typeof Palette; danger?: boolean }[] = [
    { id: "general", label: t("settings.nav.general"), icon: Palette },
    { id: "security", label: t("settings.nav.security"), icon: ShieldCheck },
    { id: "workspace", label: t("settings.nav.workspace"), icon: FolderKanban },
    { id: "about", label: t("settings.nav.about"), icon: Rocket },
    { id: "danger", label: t("settings.nav.danger"), icon: AlertTriangle, danger: true },
  ];

  return (
    <div className="stack-lg">
      <PageHead title={t("settings.title")} desc={t("settings.desc")} />

      <ErrorDialog message={err} onClose={() => setErr("")} />
      {msg && <div className="callout info">{msg}</div>}

      <div className="settings-layout">
        {/* 左侧/顶部 分栏导航Tab */}
        <nav className="settings-nav" aria-label={t("settings.navAria")}>
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={
                  "settings-nav-item" +
                  (isActive ? " active" : "") +
                  (item.danger ? " danger-nav" : "")
                }
                onClick={() => {
                  setErr("");
                  setMsg("");
                  setActiveTab(item.id);
                }}
              >
                <Icon size={15} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* 右侧主设置面板内容 */}
        <div className="settings-content">
          {/* TAB 1: 通用与外观 */}
          {activeTab === "general" && (
            <>
              <LanguageCard />

              <Card title={t("settings.themeCard")}>
                <div className="stack">
                  <div className="choice-row">
                    {THEME_OPTIONS.map((opt) => {
                      const active = theme === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          className={"choice" + (active ? " on" : "")}
                          style={{ flex: "1 1 180px", padding: "8px 10px" }}
                          onClick={() => setTheme(opt.id)}
                        >
                          <div className="row" style={{ justifyContent: "space-between", marginBottom: 3 }}>
                            <strong>{t(`theme.options.${opt.id}.name`)}</strong>
                            <span
                              style={{
                                display: "inline-block",
                                width: 12,
                                height: 12,
                                borderRadius: "50%",
                                backgroundColor: opt.previewAccent,
                                boxShadow: "0 0 0 1px var(--border-strong)",
                              }}
                            />
                          </div>
                          <div className="muted sm">{t(`theme.options.${opt.id}.desc`)}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </Card>

              <Card title={t("settings.notesCard")}>
                <div className="field">
                  <div className="between">
                    <div>
                      <FieldLabel name={t("settings.notesAutoSave")} tip={t("settings.notesAutoSaveTip")} />
                      <div className="hint">{t("settings.notesAutoSaveHint")}</div>
                    </div>
                    <button
                      type="button"
                      className={"switch" + (notesAutoSave ? "" : " off")}
                      onClick={() => {
                        const next = !notesAutoSave;
                        setNotesAutoSave(next);
                        setNotesAutoSaveStored(next);
                      }}
                    />
                  </div>
                </div>
              </Card>

              <Card title={t("settings.animCard")}>
                <div className="field">
                  <div className="between">
                    <div>
                      <FieldLabel
                        name={t("settings.unlockAnim")}
                        tip={t("settings.unlockAnimTip")}
                      />
                      <div className="hint">
                        {t("settings.unlockAnimHintDesktop")}
                      </div>
                    </div>
                    <button
                      type="button"
                      className={"switch" + (unlockAnimEnabled ? "" : " off")}
                      onClick={() => setUnlockAnimEnabled(!unlockAnimEnabled)}
                    />
                  </div>

                  {unlockAnimEnabled && (
                    <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <span className="hint" style={{ fontWeight: 600, color: "var(--text-1)" }}>
                          {t("settings.pickAnimStyle")}
                        </span>
                        <button
                          type="button"
                          className="btn ghost sm"
                          onClick={() => startUnlockAnim(unlockAnimStyle)}
                          title={t("settings.previewStyle")}
                          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                        >
                          <Play size={13} /> {t("settings.previewCurrent")}
                        </button>
                      </div>

                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
                          gap: 10,
                        }}
                      >
                        {UNLOCK_ANIM_STYLES.map((st) => {
                          const active = unlockAnimStyle === st.id;
                          return (
                            <div
                              key={st.id}
                              role="button"
                              tabIndex={0}
                              onClick={() => setUnlockAnimStyle(st.id)}
                              style={{
                                padding: "12px 14px",
                                borderRadius: "var(--radius, 10px)",
                                border: active
                                  ? "1.5px solid var(--accent, #6366f1)"
                                  : "1px solid var(--border, rgba(255, 255, 255, 0.08))",
                                background: active
                                  ? "var(--accent-dim, rgba(99, 102, 241, 0.08))"
                                  : "var(--bg-card, rgba(255, 255, 255, 0.02))",
                                cursor: "pointer",
                                display: "flex",
                                flexDirection: "column",
                                gap: 6,
                                transition: "all 0.15s ease",
                              }}
                            >
                              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                  <span style={{ fontSize: 18 }}>{st.icon}</span>
                                  <span style={{ fontWeight: 600, fontSize: 13, color: active ? "var(--accent)" : "var(--text-1)" }}>
                                    {t(`anim.${st.id}.label`)}
                                  </span>
                                </div>
                                <button
                                  type="button"
                                  className="btn ghost sm"
                                  style={{ padding: "2px 8px", fontSize: 11, height: 24 }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setUnlockAnimStyle(st.id);
                                    startUnlockAnim(st.id);
                                  }}
                                  title={t("settings.tryLookNamed", { name: t(`anim.${st.id}.label`) })}
                                >
                                  {t("settings.tryLook")}
                                </button>
                              </div>
                              <div style={{ fontSize: 11, color: "var(--text-3)", lineHeight: 1.4 }}>
                                {t(`anim.${st.id}.desc`)}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </Card>

              <Card title={t("settings.windowCard")}>
                <div className="stack">
                  <div className="field">
                    <div className="between">
                      <div>
                        <FieldLabel
                          name={t("settings.launchAtLogin")}
                          tip={t("settings.launchTip")}
                        />
                        <div className="hint">
                          {status?.launchAtLoginSupported === false
                            ? t("settings.launchUnsupported")
                            : t("settings.launchHint")}
                        </div>
                      </div>
                      <button
                        type="button"
                        className={"switch" + (status?.launchAtLogin ? "" : " off")}
                        disabled={busy || status?.launchAtLoginSupported === false}
                        onClick={() => toggleLaunch(!status?.launchAtLogin)}
                      />
                    </div>
                  </div>

                  <hr className="sep" style={{ margin: "4px 0" }} />

                  <div className="field">
                    <FieldLabel name={t("settings.closeAction")} tip={t("settings.closeActionTip")} />
                    <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                      {t("settings.closeCurrent", { action: closeActionLabel(status?.closeAction, t) })}
                    </div>
                    {status?.closeAction && (
                      <div>
                        <button
                          type="button"
                          className="btn ghost sm"
                          disabled={busy}
                          onClick={async () => {
                            setErr("");
                            setBusy(true);
                            try {
                              await api.clearClosePreference();
                              setMsg(t("settings.closeReset"));
                              await refresh();
                            } catch (e) {
                              setErr(errMessage(e));
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          {t("settings.restoreAsk")}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </Card>
            </>
          )}

          {/* TAB 2: 安全与凭据 */}
          {activeTab === "security" && (
            <>
              <SecurityChecklistCard refreshNonce={checklistNonce} onJump={jumpToSetting} />

              <Card title={t("settings.graceTitle")}>
                <div className="stack">
                  <div className="field">
                    <FieldLabel
                      name={t("settings.graceDays")}
                      tip={t("settings.graceTip")}
                    />
                    <div className="row" style={{ marginTop: 4 }}>
                      <input
                        className="input"
                        type="number"
                        min={0}
                        max={30}
                        style={{ width: 88, minWidth: 88, flex: "0 0 88px" }}
                        value={graceDays}
                        onChange={(e) => setGraceDays(e.target.value)}
                      />
                      <button type="button" className="btn primary sm" disabled={busy} onClick={saveGrace}>
                        {t("settings.saveSetting")}
                      </button>
                    </div>
                    <div className="hint" style={{ marginTop: 4 }}>
                      {t("settings.graceHint")}
                    </div>
                  </div>
                  {status?.graceActive && status.graceExpiresAt && (
                    <div className="callout info" style={{ marginTop: 4 }}>
                      {t("settings.graceValidUntil", { when: formatExpiry(status.graceExpiresAt) })}
                    </div>
                  )}
                  {!status?.graceActive && (status?.graceDays ?? 0) > 0 && (
                    <div className="callout warn" style={{ marginTop: 4 }}>
                      {t("settings.gracePending")}
                    </div>
                  )}
                </div>
              </Card>

              <Card title={t("settings.bioTitle")}>
                <div className="stack">
                  <div className="muted">
                    {t("settings.bioIntro")}
                  </div>
                  {!bio?.available && (
                    <div className="callout warn" style={{ marginTop: 4 }}>
                      {t("settings.bioUnavailable")}
                    </div>
                  )}
                  {bio?.stale && (
                    <div className="callout warn" style={{ marginTop: 4 }}>
                      {t("settings.bioStale")}
                    </div>
                  )}
                  <div className="field">
                    <FieldLabel name={t("settings.bioEnable")} tip={t("settings.bioEnableTip")} />
                    {bio?.available && !bio.enabled && (
                      <div className="row" style={{ marginTop: 4 }}>
                        <input
                          className="input"
                          type="password"
                          placeholder={t("settings.bioPasswordPh")}
                          value={bioPw}
                          onChange={(e) => setBioPw(e.target.value)}
                          style={{ flex: 1 }}
                        />
                        <button
                          type="button"
                          className="btn primary sm"
                          disabled={busy || !bioPw.trim()}
                          onClick={async () => {
                            setBusy(true);
                            setErr("");
                            try {
                              await api.biometricEnable(bioPw);
                              setBioPw("");
                              setBio(await api.biometricStatus());
                              setMsg(t("settings.bioOn"));
                            } catch (e) {
                              setErr(errMessage(e));
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          <Fingerprint size={14} /> {t("settings.bioEnableBtn")}
                        </button>
                      </div>
                    )}
                    {bio?.enabled && (
                      <div className="row" style={{ marginTop: 4 }}>
                        <span className="hint">{t("settings.bioEnabledHint")}</span>
                        <button
                          type="button"
                          className="btn ghost sm"
                          disabled={busy}
                          onClick={async () => {
                            setBusy(true);
                            setErr("");
                            try {
                              await api.biometricDisable();
                              setBio(await api.biometricStatus());
                              setMsg(t("settings.bioOff"));
                            } catch (e) {
                              setErr(errMessage(e));
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          {t("common.close")}
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="field">
                    <FieldLabel name={t("settings.bioReveal")} tip={t("settings.bioRevealTip")} />
                    <label className="row" style={{ marginTop: 4, gap: 8 }}>
                      <input
                        type="checkbox"
                        disabled={!bio?.enabled || busy}
                        checked={!!bio?.revealEnabled}
                        onChange={async (e) => {
                          setBusy(true);
                          try {
                            await api.setBiometricRevealEnabled(e.target.checked);
                            setBio(await api.biometricStatus());
                          } catch (err) {
                            setErr(errMessage(err));
                          } finally {
                            setBusy(false);
                          }
                        }}
                      />
                      <span className="hint">{t("settings.bioRevealDefault")}</span>
                    </label>
                  </div>
                  <div className="field">
                    <FieldLabel name={t("settings.bioExport")} tip={t("settings.bioExportTip")} />
                    <label className="row" style={{ marginTop: 4, gap: 8 }}>
                      <input
                        type="checkbox"
                        disabled={!bio?.enabled || busy}
                        checked={!!bio?.revealSecret}
                        onChange={async (e) => {
                          setBusy(true);
                          try {
                            await api.setBiometricRevealSecret(e.target.checked);
                            setBio(await api.biometricStatus());
                          } catch (err) {
                            setErr(errMessage(err));
                          } finally {
                            setBusy(false);
                          }
                        }}
                      />
                      <span className="hint">{t("settings.bioExportRisk")}</span>
                    </label>
                  </div>
                </div>
              </Card>

              <Card title={t("settings.screenshotTitle")}>
                <ScreenshotSetting
                  allow={allowScreenshots}
                  capability={screenshotCapability}
                  busy={busy}
                  onToggle={async (next) => {
                    setBusy(true);
                    setErr("");
                    try {
                      const s = await api.setAllowScreenshots(next);
                      setAllowScreenshots(!!s.allowScreenshots);
                      setScreenshotCapability(s.capability);
                      setMsg(next ? t("settings.screenshotOn") : t("settings.screenshotOff"));
                      setChecklistNonce((n) => n + 1);
                    } catch (e) {
                      setErr(errMessage(e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                />
              </Card>

              <Card title={t("settings.revealTitle")}>
                <div className="stack">
                  <div className="muted">{t("settings.revealIntro")}</div>
                  <div className="field" id="setting-reveal-grace">
                    <FieldLabel name={t("settings.revealGrace")} tip={t("settings.revealGraceTip")} />
                    <div className="row" style={{ marginTop: 4 }}>
                      <select className="input" style={{ width: 160 }} value={revealGrace} onChange={(e) => setRevealGrace(e.target.value)}>
                        <option value="0">{t("settings.everyTime")}</option>
                        <option value="1">{t("settings.min1")}</option>
                        <option value="5">{t("settings.min5")}</option>
                        <option value="15">{t("settings.min15")}</option>
                        <option value="30">{t("settings.min30")}</option>
                      </select>
                      <button
                        type="button"
                        className="btn primary sm"
                        disabled={busy}
                        onClick={async () => {
                          setBusy(true);
                          try {
                            await api.setRevealGraceMinutes(Number(revealGrace));
                            setMsg(t("settings.revealSaved"));
                            setChecklistNonce((n) => n + 1);
                          } catch (e) {
                            setErr(errMessage(e));
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        {t("common.save")}
                      </button>
                    </div>
                  </div>
                  <div className="field" id="setting-clipboard-clear">
                    <label className="field-label">{t("settings.clipClear")}</label>
                    <div className="row">
                      <select className="input" style={{ width: 140 }} value={clipSec} onChange={(e) => setClipSec(e.target.value)}>
                        <option value="0">{t("settings.clipNever")}</option>
                        <option value="10">{t("settings.sec10")}</option>
                        <option value="20">{t("settings.sec20")}</option>
                        <option value="60">{t("settings.sec60")}</option>
                      </select>
                      <button
                        type="button"
                        className="btn sm"
                        disabled={busy}
                        onClick={async () => {
                          await api.setClipboardClearSeconds(Number(clipSec));
                          setMsg(t("settings.clipSaved"));
                          setChecklistNonce((n) => n + 1);
                        }}
                      >
                        {t("common.save")}
                      </button>
                    </div>
                  </div>
                  <div className="field">
                    <label className="field-label">{t("settings.histLimit")}</label>
                    <div className="row">
                      <select className="input" style={{ width: 120 }} value={histLimit} onChange={(e) => setHistLimit(e.target.value)}>
                        <option value="5">{t("settings.histN", { n: 5 })}</option>
                        <option value="10">{t("settings.histN", { n: 10 })}</option>
                        <option value="20">{t("settings.histN", { n: 20 })}</option>
                      </select>
                      <button
                        type="button"
                        className="btn sm"
                        disabled={busy}
                        onClick={async () => {
                          await api.setAccountHistoryLimit(Number(histLimit));
                          setMsg(t("settings.histSaved"));
                        }}
                      >
                        {t("common.save")}
                      </button>
                    </div>
                  </div>
                </div>
              </Card>

              <Card title={t("settings.changePwTitle")}>
                <div className="stack" style={{ maxWidth: 420 }}>
                  <div className="field">
                    <label className="field-label">{t("settings.currentPw")}</label>
                    <input className="input" type="password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} />
                  </div>
                  <div className="field">
                    <label className="field-label">{t("settings.newPw")}</label>
                    <input className="input" type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
                  </div>
                  <div className="field">
                    <label className="field-label">{t("settings.confirmPw")}</label>
                    <input className="input" type="password" value={newPw2} onChange={(e) => setNewPw2(e.target.value)} />
                  </div>
                  <div style={{ marginTop: 4 }}>
                    <button className="btn primary sm" disabled={busy} onClick={changePassword}>
                      {t("settings.updatePw")}
                    </button>
                  </div>
                </div>
              </Card>

              <Card title={t("settings.rotateTitle")}>
                <div className="stack">
                  <div className="muted">{t("settings.rotateIntro")}</div>
                  {newRecovery ? (
                    <>
                      <div className="callout danger">{t("settings.rotateOnce")}</div>
                      <div className="reckey">{newRecovery}</div>
                      <div className="row">
                        <button className="btn sm" onClick={() => writeClipboard(newRecovery, true)}>
                          {t("common.copy")}
                        </button>
                        <button className="btn ghost sm" onClick={() => setNewRecovery("")}>
                          {t("settings.rotateSaved")}
                        </button>
                      </div>
                    </>
                  ) : (
                    <div>
                      <button className="btn danger sm" disabled={busy} onClick={rotate}>
                        {t("settings.rotateBtn")}
                      </button>
                    </div>
                  )}
                </div>
              </Card>
            </>
          )}

          {/* TAB 3: 工作空间与服务 */}
          {activeTab === "workspace" && (
            <>
              <Card title={t("settings.wsTitle")}>
                <div className="stack">
                  <div className="kv" id="setting-workspace-path">
                    <span className="muted">{t("settings.wsPath")}</span>
                    <span className="mono">{status?.workspacePath ?? t("common.emDash")}</span>
                  </div>
                  <div className="kv">
                    <span className="muted">{t("settings.wsSsh")}</span>
                    <span>
                      <button type="button" className="btn ghost sm" onClick={() => navigate("/config")}>
                        <FileCog size={13} style={{ marginRight: 3 }} />
                        {t("settings.wsEditSsh")}
                      </button>
                    </span>
                  </div>
                  <div className="kv">
                    <span className="muted">{t("settings.wsId")}</span>
                    <span className="mono">{status?.workspaceId ?? t("common.emDash")}</span>
                  </div>
                  <div className="kv" id="setting-auto-lock">
                    <span className="muted">{t("settings.wsAutoLock")}</span>
                    <span>{t("settings.wsMinutes", { n: status?.autoLockMinutes ?? 0 })}</span>
                  </div>
                  <div className="kv" id="setting-lock-on-sleep">
                    <span className="muted">{t("settings.wsSleepLock")}</span>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {t("settings.wsSleepLockHint")}
                    </span>
                  </div>
                </div>
              </Card>

              <Card title={t("settings.patTitle")}>
                <GithubPatSettings writesLocked={!!status?.writesLocked} />
              </Card>

              <Card title={t("settings.backupTitle")}>
                <div className="stack">
                  <div className="muted" style={{ fontSize: 12 }}>
                    {t("settings.backupIntro")}
                  </div>
                  <div>
                    <button
                      type="button"
                      className="btn primary sm"
                      onClick={() => navigate("/sync")}
                    >
                      <Cloud size={13} style={{ marginRight: 3 }} />
                      {t("settings.gotoSync")}
                    </button>
                  </div>
                </div>
              </Card>
            </>
          )}

          {/* TAB 4: 关于与更新 */}
          {activeTab === "about" && <AboutUpdateCard />}

          {/* TAB 5: 高危区与还原 */}
          {activeTab === "danger" && (
            <div className="danger-card card">
              <div className="card-head">
                <div className="card-title" style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <AlertTriangle size={14} />
                  {t("settings.dangerTitle")}
                </div>
              </div>
              <div className="card-body">
                <FactoryResetPanel onDone={refresh} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
