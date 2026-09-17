import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { RefreshCw } from "lucide-react";
import {
  api,
  errMessage,
  type UpdateCheckResult,
  type UpdateSource,
} from "../lib/ipc";
import { isAndroid, isIOS } from "../lib/platform";
import { Card, ErrorDialog, FieldLabel } from "../ui/common";
import { NetworkProxyCard } from "./Settings.shared";

const DEFAULT_UPDATE_REPO = "ice-juice/git-keymaster-app";

function formatWhen(iso: string | null | undefined, neverLabel: string): string {
  if (!iso) return neverLabel;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

/** 移动端「关于与更新」：安卓侧载检查/下载/安装；iOS 只提示商店。 */
export function MobileAboutUpdateCard() {
  const { t } = useTranslation();
  const android = isAndroid();
  const ios = isIOS();
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
      .catch(() => setVersion("1.8.1"));
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
    if (ios) return;
    setErr("");
    setMsg("");
    setInstalling(true);
    try {
      await api.downloadAndInstallUpdate();
      setMsg(t("update.installerOpened"));
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

  const canSideload = !!result?.available && !!result.sideloadUpdateSupported && android && !ios;

  return (
    <div className="stack-lg">
      <Card title={t("update.appInfo")}>
        <div className="stack">
          <ErrorDialog message={err} onClose={() => setErr("")} />
          {msg && <div className="callout info">{msg}</div>}
          {ios && <div className="callout info">{t("update.iosStoreOnly")}</div>}
          {android && <div className="hint">{t("update.sideloadHint")}</div>}
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
              {result.notes && (
                <div className="muted" style={{ marginTop: 8, fontSize: 12, whiteSpace: "pre-wrap" }}>
                  {result.notes}
                </div>
              )}
              {ios && <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>{t("update.iosStoreSoon")}</div>}
              <div className="row" style={{ flexWrap: "wrap", marginTop: 8 }}>
                {canSideload && (
                  <button type="button" className="btn primary sm" disabled={installing} onClick={install}>
                    {installing ? t("update.installing") : t("update.install")}
                  </button>
                )}
                <button type="button" className="btn sm" disabled={busy} onClick={skip}>
                  {t("update.skip")}
                </button>
                {result.downloadUrl && !ios && (
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
