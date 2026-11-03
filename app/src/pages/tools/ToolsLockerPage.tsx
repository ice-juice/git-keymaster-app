import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { PackageOpen, Settings } from "lucide-react";
import { useOverlayBack } from "../../shared/mobileBack";
import {
  api,
  entryAttachments,
  errMessage,
  LOCKER_DEPLOY_PROGRESS_EVENT,
  type FileEntry,
  type LockerDeployMethod,
  type LockerDeployProgress,
  type LockerDeployStep,
  type LockerEntry,
  type LockerProbeResult,
  type LockerPutOpts,
  type LockerWorkerConfig,
} from "../../lib/ipc";
import { copyWithClear, isNeedReauth, tryBiometricReauth } from "../../lib/secretsUi";
import { encodeQrSvg } from "../../shared/qrEncode";
import { formatBytes } from "../../shared/hooks/useFilesModel";
import { isMobilePlatform } from "../../platform/resolve";
import { ReauthDialog } from "../../ui/ReauthDialog";
import { ToolSubPage } from "./ToolsShared";

type Panel = "put" | "take" | "config" | "door";
type ConfigView = "form" | "methods" | "guide" | "progress";
type TtlChoice = "1h" | "24h" | "7d" | "30d" | "forever" | "custom";
type PullChoice = "1" | "3" | "custom" | "unlimited";

const CF_TOKEN_URL = "https://dash.cloudflare.com/profile/api-tokens";

const EMPTY_WORKER: LockerWorkerConfig = {
  baseUrl: "",
  workersDevUrl: "",
  hasSecret: false,
  hasApiToken: false,
  tokenLast4: "",
  lastMethod: "",
};

function isDeployMethod(value: string | null | undefined): value is LockerDeployMethod {
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

function groupCode(code: string) {
  const digits = code.replace(/\D/g, "");
  if (digits.length !== 6) return code;
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

function countdownClock(totalSeconds: number) {
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  const clock = [hours, mins, secs].map((n) => String(n).padStart(2, "0")).join(":");
  return { days, clock };
}

function remainSeconds(expireAt?: string | null, now = Date.now()) {
  if (!expireAt) return null;
  const end = Date.parse(expireAt);
  if (Number.isNaN(end)) return null;
  return Math.max(0, Math.floor((end - now) / 1000));
}

export function ToolsLockerPage({
  initialVault,
}: {
  initialVault?: { entryId: string; attId?: string } | null;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [doorId, setDoorId] = useState<string | null>(null);
  const [ttl, setTtl] = useState<TtlChoice>("24h");
  const [customHours, setCustomHours] = useState("6");
  const [pulls, setPulls] = useState<PullChoice>("1");
  const [alsoShare, setAlsoShare] = useState(true);
  const [customPulls, setCustomPulls] = useState("5");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [entries, setEntries] = useState<LockerEntry[]>([]);
  const [worker, setWorker] = useState<LockerWorkerConfig>(EMPTY_WORKER);
  const [workerUrl, setWorkerUrl] = useState("");
  const [workerSecret, setWorkerSecret] = useState("");
  const [configView, setConfigView] = useState<ConfigView>("form");
  const [pasteToken, setPasteToken] = useState("");
  const [guideErr, setGuideErr] = useState("");
  const [deployRun, setDeployRun] = useState<"idle" | "running" | "failed" | "done">("idle");
  const [progress, setProgress] = useState<LockerDeployProgress | null>(null);
  const [probe, setProbe] = useState<LockerProbeResult | null>(null);
  const [probeBusy, setProbeBusy] = useState(false);
  const [putCode, setPutCode] = useState("");
  const [putId, setPutId] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [takeDigits, setTakeDigits] = useState<string[]>([]);
  const [revealedCode, setRevealedCode] = useState("");
  const [savedPath, setSavedPath] = useState("");
  const [vaultOpen, setVaultOpen] = useState(false);
  const [vaultEntries, setVaultEntries] = useState<FileEntry[]>([]);
  const [vaultId, setVaultId] = useState("");
  const [attId, setAttId] = useState("");
  const [tick, setTick] = useState(Date.now());
  const [reauth, setReauth] = useState<null | ((pw: string) => Promise<void>)>(null);
  const reauthCancel = useRef<(() => void) | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const mobile = isMobilePlatform();

  const withAuth = useCallback(async function withAuth<T>(fn: (pw?: string) => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (e) {
      if (!isNeedReauth(e)) throw e;
      if (await tryBiometricReauth()) {
        try {
          return await fn();
        } catch (err) {
          if (!isNeedReauth(err)) throw err;
        }
      }
      return await new Promise<T | undefined>((resolve, reject) => {
        reauthCancel.current = () => {
          reauthCancel.current = null;
          setReauth(null);
          resolve(undefined);
        };
        setReauth(() => async (pw: string) => {
          try {
            const r = await fn(pw);
            reauthCancel.current = null;
            setReauth(null);
            resolve(r);
          } catch (err) {
            reject(err);
            throw new Error(errMessage(err));
          }
        });
      });
    }
  }, []);

  const stepName = useCallback((index: number) => t(`tools.lockerStep${index}`), [t]);

  const applyDeployRun = useCallback((next: LockerDeployProgress, follow = false) => {
    if (next.finished) {
      setDeployRun("done");
      return;
    }
    if (next.error) {
      setDeployRun("failed");
      return;
    }
    if (next.running || next.waitingForAccount) {
      setDeployRun("running");
      if (follow) {
        setConfigView((view) => (view === "guide" || view === "methods" ? "progress" : view));
      }
      return;
    }
    setDeployRun("idle");
  }, []);

  const reload = useCallback(async () => {
    const [list, cfg, status] = await Promise.all([
      api.lockerList(),
      api.lockerGetWorkerConfig(),
      api.lockerDeployStatus().catch(() => null),
    ]);
    setEntries(list.entries);
    setWorker(cfg);
    setWorkerUrl(cfg.baseUrl);
    if (status) {
      setProgress(status);
      applyDeployRun(status);
    }
  }, [applyDeployRun]);

  useEffect(() => {
    void reload().catch((e) => setErr(errMessage(e)));
  }, [reload]);

  useEffect(() => {
    if (!entries.some((entry) => entry.share)) return;
    const refresh = () => {
      if (busy) return;
      void reload().catch(() => {});
    };
    const id = window.setInterval(refresh, 15000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", refresh);
    };
  }, [entries, reload, busy]);

  useEffect(() => {
    if (panel === "door" && doorId && !entries.some((entry) => entry.id === doorId)) {
      setPanel(null);
      setDoorId(null);
    }
  }, [entries, panel, doorId]);

  useEffect(() => {
    const id = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<LockerDeployProgress>(LOCKER_DEPLOY_PROGRESS_EVENT, (ev) => {
      const next = ev.payload;
      if (!next) return;
      setProgress(next);
      applyDeployRun(next, true);
      if (next.finished) void reload().catch(() => {});
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {
        /* 非 Tauri */
      });
    return () => unlisten?.();
  }, [applyDeployRun, reload]);

  useEffect(() => {
    const entryId = initialVault?.entryId || params.get("vault") || "";
    const attachmentId = initialVault?.attId || params.get("att") || "";
    if (!entryId) return;
    setPanel("put");
    setVaultId(entryId);
    setAttId(attachmentId);
    void api
      .fileList()
      .then((list) => setVaultEntries(list.entries))
      .catch((e) => setErr(errMessage(e)));
  }, [initialVault, params]);

  const shareReady = worker.baseUrl.trim().length > 0 && worker.hasSecret;
  const shareSvg = useMemo(() => {
    if (!shareUrl) return "";
    try {
      return encodeQrSvg(shareUrl);
    } catch {
      return "";
    }
  }, [shareUrl]);

  function buildOpts(): LockerPutOpts {
    const opts: LockerPutOpts = {};
    if (name.trim()) opts.name = name.trim();
    if (ttl === "forever") opts.permanent = true;
    else if (ttl === "custom") opts.ttlSecs = Math.max(1, Math.round(Number(customHours) || 1)) * 3600;
    else if (ttl === "1h") opts.ttlSecs = 3600;
    else if (ttl === "7d") opts.ttlSecs = 7 * 86400;
    else if (ttl === "30d") opts.ttlSecs = 30 * 86400;
    else opts.ttlSecs = 86400;
    if (pulls === "unlimited") opts.unlimitedPulls = true;
    else if (pulls === "custom") opts.maxPulls = Math.max(1, Math.round(Number(customPulls) || 1));
    else if (pulls === "3") opts.maxPulls = 3;
    else opts.maxPulls = 1;
    return opts;
  }

  function showPut(result: { id: string; code: string }) {
    setPutId(result.id);
    setPutCode(result.code);
    setShareUrl("");
    setErr("");
  }

  async function finishPut(result: { id: string; code: string }) {
    showPut(result);
    await reload();
    if (!alsoShare || !shareReady) return;
    const shared = await withAuth((pw) => api.lockerShare(result.id, pw));
    if (!shared) return;
    setShareUrl(shared.url);
    await reload();
  }

  async function putFromPath() {
    setErr("");
    const selected = await open({ multiple: false, directory: false });
    if (typeof selected !== "string" || !selected) return;
    setBusy(true);
    try {
      await finishPut(await api.lockerPutFromPath(selected, buildOpts()));
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function putFromFile(file: File) {
    setErr("");
    if (file.size > 100 * 1024 * 1024) {
      setErr(t("tools.lockerTooBig"));
      return;
    }
    setBusy(true);
    try {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      await finishPut(await api.lockerPutBytes(file.name, bytes, buildOpts()));
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function putFromVault() {
    if (!vaultId) {
      setErr(t("tools.lockerPickVault"));
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const result = await withAuth((pw) => api.lockerPutFromVault(vaultId, attId || null, pw, buildOpts()));
      if (!result) return;
      await finishPut(result);
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function openVault() {
    setVaultOpen(true);
    setErr("");
    try {
      const list = await api.fileList();
      setVaultEntries(list.entries);
    } catch (e) {
      setErr(errMessage(e));
    }
  }

  async function makeShare(id: string) {
    setBusy(true);
    setErr("");
    try {
      const result = await withAuth((pw) => api.lockerShare(id, pw));
      if (!result) return;
      setShareUrl(result.url);
      setPutId(id);
      await reload();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    setErr("");
    try {
      await api.lockerRevokeShare(id);
      if (putId === id) setShareUrl("");
      await reload();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function burn(id: string) {
    if (!window.confirm(t("tools.lockerBurnConfirm"))) return;
    setBusy(true);
    setErr("");
    try {
      await api.lockerDelete(id);
      if (putId === id) {
        setPutCode("");
        setShareUrl("");
      }
      if (doorId === id) {
        setPanel(null);
        setDoorId(null);
      }
      await reload();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function pullToDisk(target: { code?: string; id?: string; defaultName?: string }) {
    const digits = target.code?.replace(/\D/g, "") ?? "";
    if (!target.id && digits.length !== 6) {
      setErr(t("tools.lockerCodeRule"));
      return;
    }
    const dest = await save({ defaultPath: target.defaultName || "file" });
    if (typeof dest !== "string" || !dest) return;
    setBusy(true);
    setErr("");
    try {
      const result = await withAuth((pw) =>
        target.id ? api.lockerPullById(target.id, dest, pw) : api.lockerPull(digits, dest, pw),
      );
      if (!result) return;
      setSavedPath(result.destPath);
      await reload();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function pullToVault(target: { code?: string; id?: string }) {
    const digits = target.code?.replace(/\D/g, "") ?? "";
    if (!target.id && digits.length !== 6) {
      setErr(t("tools.lockerCodeRule"));
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const got = await withAuth((pw) =>
        target.id ? api.lockerPullBytesById(target.id, pw) : api.lockerPullBytes(digits, pw),
      );
      if (!got) return;
      const saved = await api.fileAddBytes(got.originalName || got.name || "file", got.bytes, {
        name: got.name || got.originalName,
      });
      await reload();
      navigate(`/files?focus=${encodeURIComponent(saved.id)}`);
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveWorker() {
    setBusy(true);
    setErr("");
    try {
      await api.lockerSaveWorkerConfig(workerUrl.trim(), workerSecret.trim() || null, false);
      setWorkerSecret("");
      await reload();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const deploying = deployRun === "running";
  const deployedOnce = Boolean(worker.workersDevUrl || worker.lastMethod || worker.hasApiToken || shareReady);
  const workersDevUrl = (worker.workersDevUrl || "").replace(/\/$/, "");
  const canRestoreWorkersDev = Boolean(
    workersDevUrl && workerUrl.trim().replace(/\/$/, "") !== workersDevUrl,
  );

  async function startDeploy(method: LockerDeployMethod, token?: string) {
    setGuideErr("");
    setErr("");
    setDeployRun("running");
    try {
      const next = await api.lockerDeployStart(method, token || null);
      setProgress(next);
      applyDeployRun(next, true);
      setConfigView("progress");
    } catch (e) {
      const message = errMessage(e);
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
      setWorkerUrl(cfg.baseUrl);
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
    return redactSecrets(text, [workerSecret, pasteToken]);
  }

  const selectedVault = vaultEntries.find((e) => e.id === vaultId);
  const atts = selectedVault ? entryAttachments(selectedVault) : [];

  const closePanel = useCallback(() => {
    setPanel(null);
    setDoorId(null);
    setShareUrl("");
    setPutCode("");
    setPutId("");
    setRevealedCode("");
    setTakeDigits([]);
    setConfigView("form");
    setGuideErr("");
    setPasteToken("");
  }, []);
  const closeConfigView = useCallback(() => {
    setConfigView((view) => (view === "guide" ? "methods" : "form"));
  }, []);
  const closeVault = useCallback(() => setVaultOpen(false), []);
  useOverlayBack(panel === "config" && configView !== "form", closeConfigView);
  useOverlayBack(panel != null && !(panel === "config" && configView !== "form"), closePanel);
  useOverlayBack(vaultOpen, closeVault);

  function openPut() {
    setPutCode("");
    setPutId("");
    setShareUrl("");
    setErr("");
    setSavedPath("");
    setPanel("put");
  }

  function openDoor(id: string) {
    setShareUrl("");
    setErr("");
    setSavedPath("");
    setRevealedCode("");
    setDoorId(id);
    setPanel("door");
  }

  async function revealCode(id: string) {
    setErr("");
    try {
      const result = await withAuth((pw) => api.lockerRevealCode(id, pw));
      if (result) setRevealedCode(result.code);
    } catch (e) {
      setErr(errMessage(e));
    }
  }

  function fileKind(entry: LockerEntry): "pdf" | "img" | "key" | "doc" {
    const hint = `${entry.mime || ""} ${entry.originalName}`.toLowerCase();
    if (hint.includes("pdf")) return "pdf";
    if (/(png|jpe?g|gif|webp|image)/.test(hint)) return "img";
    if (/(pem|key|ppk)/.test(hint)) return "key";
    return "doc";
  }

  function slotLabel(index: number) {
    const row = String.fromCharCode(65 + Math.floor(index / 2));
    return `${row}-${String((index % 2) + 1).padStart(2, "0")}`;
  }

  function remainLabel(entry: LockerEntry) {
    const sec = remainSeconds(entry.expireAt, tick);
    if (sec == null) return t("tools.lockerForever");
    if (sec <= 0) return t("tools.lockerExpired");
    const days = Math.floor(sec / 86400);
    const hours = Math.floor((sec % 86400) / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    if (days > 0) return t("tools.lockerRemainDay", { d: days, h: hours });
    if (hours > 0) return t("tools.lockerRemainHour", { h: hours, m: mins });
    return t("tools.lockerRemainMin", { m: mins, s: sec % 60 });
  }

  const doorEntry = entries.find((entry) => entry.id === doorId) ?? null;

  function countdownLabel(entry: LockerEntry) {
    const sec = remainSeconds(entry.expireAt, tick);
    if (sec == null) return t("tools.lockerForever");
    if (sec <= 0) return t("tools.lockerExpired");
    const { days, clock } = countdownClock(sec);
    if (days > 0) return t("tools.lockerCountdownDay", { d: days, clock });
    return clock;
  }

  function pullsLabel(entry: LockerEntry) {
    if (entry.pullsLeft == null) return t("tools.lockerPullUnlimited");
    return t("tools.lockerPullsLeft", { n: entry.pullsLeft });
  }

  function shareBlock(id: string, already = false) {
    return (
      <>
        <button type="button" className="btn primary" disabled={busy || !shareReady} onClick={() => void makeShare(id)}>
          {already && !shareUrl ? t("tools.lockerShowLink") : t("tools.lockerShare")}
        </button>
        {!shareReady && <div className="muted">{t("tools.lockerShareDisabled")}</div>}
        {shareUrl && (
          <>
            <button type="button" className="btn" onClick={() => void copyWithClear(shareUrl, undefined, true)}>
              {t("tools.lockerCopyLink")}
            </button>
            {shareSvg && <div className="tools-qr" dangerouslySetInnerHTML={{ __html: shareSvg }} />}
            <div className="muted">{t("tools.lockerQrHint")}</div>
          </>
        )}
      </>
    );
  }

  return (
    <ToolSubPage title={t("tools.lockerTitle")} desc={t("tools.lockerDesc")}>
      <div className="locker-home">
        <div className="locker-kiosk">
          <div className="locker-kiosk-head">
            <span />
            <div className="locker-prompt">{t("tools.lockerChoose")}</div>
            <button type="button" className="locker-gear" onClick={() => { setErr(""); setPanel("config"); setConfigView(deployRun === "running" ? "progress" : "form"); }}>
              <Settings size={16} aria-hidden="true" />
              {t("tools.lockerConfig")}
            </button>
          </div>
          <div className="locker-ops">
            <button type="button" className="locker-op store" onClick={openPut}>
              <span className="locker-medallion" aria-hidden="true">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V7"/><path d="m8.5 10.5 3.5-3.5 3.5 3.5"/><path d="M20 16.5A4.5 4.5 0 0 0 17.5 8h-1.1A7 7 0 1 0 4 14.9"/></svg>
              </span>
              <strong>{t("tools.lockerVerbStore")}</strong>
              <span>{t("tools.lockerStoreHint")}</span>
            </button>
            <button
              type="button"
              className="locker-op take"
              onClick={() => {
                setErr("");
                setSavedPath("");
                setTakeDigits([]);
                setPanel("take");
              }}
            >
              <span className="locker-medallion" aria-hidden="true">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="8.5" cy="14.5" r="3.5"/><path d="m11 12 8-8"/><path d="M16 4h3v3"/><path d="m15 8 2 2"/></svg>
              </span>
              <strong>{t("tools.lockerVerbTake")}</strong>
              <span>{t("tools.lockerTakeHint")}</span>
            </button>
          </div>
          {err && panel == null && <div className="callout danger sm">{err}</div>}
          {entries.length > 0 && (
            <div className="locker-chassis">
              <div className="locker-chassis-head">
                <span>{t("tools.lockerBay")}</span>
                <span>{t("tools.lockerBayHint")}</span>
              </div>
              <div className="locker-bay">
                <div className="locker-doors">
                  {entries.map((entry, index) => {
                    const sec = remainSeconds(entry.expireAt, tick);
                    const kind = fileKind(entry);
                    return (
                      <button
                        key={entry.id}
                        type="button"
                        className={"locker-door" + (sec === 0 ? " is-expired" : "")}
                        onClick={() => openDoor(entry.id)}
                      >
                        <span className="locker-slot">{slotLabel(index)}</span>
                        <span className="locker-led" aria-hidden="true" />
                        <span className="locker-handle" aria-hidden="true" />
                        <span className="locker-niche"><span className={"locker-totem " + kind}>{kind.toUpperCase()}</span></span>
                        <span className="locker-door-meta">
                          <span className="locker-door-name">{entry.name}</span>
                          <span className="locker-lcd">{countdownLabel(entry)}</span>
                          <span className="locker-pulls">{pullsLabel(entry)}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
          {entries.length === 0 && <div className="muted">{t("tools.lockerEmpty")}</div>}
        </div>
      </div>

      {panel === "put" && (
        <div className="wizard-overlay" role="presentation" onClick={closePanel}>
          <div
            className="locker-sheet"
            role="dialog"
            aria-labelledby="locker-put-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="card-head">
              <div className="card-title locker-panel-title" id="locker-put-title">
                {putCode ? t("tools.lockerCodeReady") : t("tools.lockerNewTitle")}
              </div>
              <button type="button" className="btn ghost sm" onClick={closePanel}>
                {t("common.close")}
              </button>
            </div>
            <div className="card-body stack">
              {err && <div className="callout danger sm">{err}</div>}
              {putCode ? (
                <>
                  <div className="locker-code">{groupCode(putCode)}</div>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void copyWithClear(putCode.replace(/\D/g, ""), undefined, true)}
                  >
                    {t("tools.lockerCopyCode")}
                  </button>
                  {shareBlock(putId)}
                </>
              ) : (
                <>
          <label className="field">
            <span>{t("tools.lockerName")}</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("tools.lockerNamePh")} />
          </label>
          <label className="field">
            <span>{t("tools.lockerTtl")}</span>
            <select className="input" value={ttl} onChange={(e) => setTtl(e.target.value as TtlChoice)}>
              <option value="1h">{t("tools.lockerTtlHour")}</option>
              <option value="24h">{t("tools.lockerTtlDay")}</option>
              <option value="7d">{t("tools.lockerTtlWeek")}</option>
              <option value="30d">{t("tools.lockerTtlMonth")}</option>
              <option value="forever">{t("tools.lockerForever")}</option>
              <option value="custom">{t("tools.lockerTtlCustom")}</option>
            </select>
          </label>
          {ttl === "custom" && (
            <label className="field">
              <span>{t("tools.lockerCustomHours")}</span>
              <input className="input" inputMode="numeric" value={customHours} onChange={(e) => setCustomHours(e.target.value)} />
            </label>
          )}
          <label className="field">
            <span>{t("tools.lockerPulls")}</span>
            <select className="input" value={pulls} onChange={(e) => setPulls(e.target.value as PullChoice)}>
              <option value="1">{t("tools.lockerPullOnce")}</option>
              <option value="3">{t("tools.lockerPullThrice")}</option>
              <option value="custom">{t("tools.lockerPullCustom")}</option>
              <option value="unlimited">{t("tools.lockerPullUnlimited")}</option>
            </select>
          </label>
          {pulls === "custom" && (
            <label className="field">
              <span>{t("tools.lockerCustomPulls")}</span>
              <input className="input" inputMode="numeric" value={customPulls} onChange={(e) => setCustomPulls(e.target.value)} />
            </label>
          )}
          <label className="locker-share-opt">
            <input type="checkbox" checked={alsoShare} onChange={(e) => setAlsoShare(e.target.checked)} />
            <span>{t("tools.lockerAlsoShare")}</span>
          </label>
          {alsoShare && !shareReady && <div className="muted">{t("tools.lockerShareDisabled")}</div>}
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            {mobile ? (
              <>
                <button type="button" className="btn primary" disabled={busy} onClick={() => fileRef.current?.click()}>
                  {t("tools.lockerPickLocal")}
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  hidden
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) void putFromFile(file);
                  }}
                />
              </>
            ) : (
              <button type="button" className="btn primary" disabled={busy} onClick={() => void putFromPath()}>
                {t("tools.lockerPickLocal")}
              </button>
            )}
            <button type="button" className="btn" disabled={busy} onClick={() => void openVault()}>
              {t("tools.lockerFromVault")}
            </button>
          </div>
          {vaultId && (
            <div className="card">
              <div className="card-body stack">
                <div>{selectedVault?.name || vaultId}</div>
                {atts.length > 1 && (
                  <select className="input" value={attId} onChange={(e) => setAttId(e.target.value)}>
                    <option value="">{t("tools.lockerChooseAtt")}</option>
                    {atts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.originalName}
                      </option>
                    ))}
                  </select>
                )}
                <button type="button" className="btn primary" disabled={busy} onClick={() => void putFromVault()}>
                  {t("tools.lockerSendVault")}
                </button>
              </div>
            </div>
          )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {panel === "take" && (
        <div className="wizard-overlay" role="presentation" onClick={closePanel}>
          <div className="locker-sheet" role="dialog" aria-labelledby="locker-take-title" onClick={(e) => e.stopPropagation()}>
            <div className="card-head">
              <div className="card-title locker-panel-title" id="locker-take-title">
                {t("tools.lockerTabTake")}
              </div>
              <button type="button" className="btn ghost sm" onClick={closePanel}>
                {t("common.close")}
              </button>
            </div>
            <div className="card-body stack" onKeyDown={(e) => {
              if (/\d/.test(e.key) && takeDigits.length < 6) setTakeDigits((d) => [...d, e.key]);
              if (e.key === "Backspace") setTakeDigits((d) => d.slice(0, -1));
              if (e.key === "Escape") setTakeDigits([]);
            }}>
              {err && <div className="callout danger sm">{err}</div>}
              <p className="muted">{t("tools.lockerCodeHint")}</p>
              <div className="locker-cells">
                {Array.from({ length: 6 }, (_, i) => (
                  <span key={i} className={"locker-cell" + (takeDigits[i] ? " fill" : "")}>{takeDigits[i] || ""}</span>
                ))}
              </div>
              <div className="locker-pad">
                {["1","2","3","4","5","6","7","8","9","del","0","clear"].map((key) => (
                  <button
                    key={key}
                    type="button"
                    className="locker-key"
                    onClick={() => {
                      if (key === "del") setTakeDigits((d) => d.slice(0, -1));
                      else if (key === "clear") setTakeDigits([]);
                      else setTakeDigits((d) => (d.length < 6 ? [...d, key] : d));
                    }}
                  >
                    {key === "del" ? t("tools.lockerKeyDelete") : key === "clear" ? t("tools.lockerKeyClear") : key}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="btn primary"
                disabled={busy || takeDigits.length !== 6}
                onClick={() => void pullToDisk({ code: takeDigits.join("") })}
              >
                {t("tools.lockerConfirmTake")}
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy || takeDigits.length !== 6}
                onClick={() => void pullToVault({ code: takeDigits.join("") })}
              >
                {t("tools.lockerSaveVault")}
              </button>
              {savedPath && <div className="muted">{t("tools.lockerSavedPath", { path: savedPath })}</div>}
            </div>
          </div>
        </div>
      )}

      {panel === "door" && doorEntry && (
        <div className="wizard-overlay" role="presentation" onClick={closePanel}>
          <div className="locker-sheet" role="dialog" aria-labelledby="locker-door-title" onClick={(e) => e.stopPropagation()}>
            <div className="card-head">
              <div className="card-title locker-panel-title" id="locker-door-title">
                {doorEntry.name}
              </div>
              <button type="button" className="btn ghost sm" onClick={closePanel}>
                {t("common.close")}
              </button>
            </div>
            <div className="card-body stack">
              {err && <div className="callout danger sm">{err}</div>}
              <div className="muted">
                {formatBytes(doorEntry.size)} · {remainLabel(doorEntry)} ·{" "}
                {doorEntry.pullsLeft == null
                  ? t("tools.lockerPullUnlimited")
                  : t("tools.lockerPullsLeft", { n: doorEntry.pullsLeft })}
                {doorEntry.share ? ` · ${t("tools.lockerShared")}` : ""}
              </div>
              {revealedCode ? (
                <>
                  <div className="locker-code">{groupCode(revealedCode)}</div>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void copyWithClear(revealedCode.replace(/\D/g, ""), undefined, true)}
                  >
                    {t("tools.lockerCopyCode")}
                  </button>
                </>
              ) : (
                <button type="button" className="btn" disabled={busy} onClick={() => void revealCode(doorEntry.id)}>
                  {t("tools.lockerRevealCode")}
                </button>
              )}
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy}
                  onClick={() => void pullToDisk({ id: doorEntry.id, defaultName: doorEntry.originalName || doorEntry.name })}
                >
                  {t("tools.lockerTakeBack")}
                </button>
                {doorEntry.share && (
                  <button type="button" className="btn" disabled={busy || !shareReady} onClick={() => void revoke(doorEntry.id)}>
                    {t("tools.lockerRevoke")}
                  </button>
                )}
                <button type="button" className="btn danger" disabled={busy} onClick={() => void burn(doorEntry.id)}>
                  {t("tools.lockerBurn")}
                </button>
              </div>
              {shareBlock(doorEntry.id, !!doorEntry.share)}
              {savedPath && <div className="muted">{t("tools.lockerSavedPath", { path: savedPath })}</div>}
            </div>
          </div>
        </div>
      )}

      {panel === "config" && (
        <div
          className="wizard-overlay"
          role="presentation"
          onClick={() => {
            if (configView !== "form") closeConfigView();
            else closePanel();
          }}
        >
          <div
            className={"locker-sheet" + (configView === "progress" || configView === "guide" ? " locker-deploy-sheet" : "")}
            role="dialog"
            aria-labelledby="locker-config-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="card-head">
              <div className="card-title locker-panel-title" id="locker-config-title">
                {configView === "methods"
                  ? t("tools.lockerDeployMethodsTitle")
                  : configView === "guide"
                    ? t("tools.lockerGuideTitle")
                    : configView === "progress"
                      ? t("tools.lockerProgressTitle")
                      : t("tools.lockerConfig")}
              </div>
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => {
                  if (configView !== "form") closeConfigView();
                  else closePanel();
                }}
              >
                {configView === "form" ? t("common.close") : t("common.back")}
              </button>
            </div>
            {configView === "form" && (
              <div className="card-body stack">
                {err && <div className="callout danger sm">{err}</div>}
                <div className="muted">{shareReady ? t("tools.lockerWorkerReady") : t("tools.lockerShareDisabled")}</div>
                <label className="field">
                  <span>{t("tools.lockerWorkerUrl")}</span>
                  <input
                    className="input"
                    value={workerUrl}
                    onChange={(e) => {
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
                    value={workerSecret}
                    onChange={(e) => setWorkerSecret(e.target.value)}
                    placeholder={worker.hasSecret ? t("tools.lockerSecretKeep") : ""}
                  />
                </label>
                {worker.hasApiToken && (
                  <div className="locker-token-row">
                    <span>{t("tools.lockerTokenSaved", { last4: worker.tokenLast4 || "••••" })}</span>
                    <button type="button" className="btn ghost sm" disabled={busy || deploying} onClick={() => void clearDeployToken()}>
                      {t("tools.lockerTokenClear")}
                    </button>
                  </div>
                )}
                <button type="button" className="btn primary" disabled={busy} onClick={() => void saveWorker()}>
                  {t("common.save")}
                </button>
                <button type="button" className="btn" disabled={busy || deploying} onClick={openDeployMethods}>
                  {deployedOnce ? t("tools.lockerRedeploy") : t("tools.lockerDeploy")}
                </button>
                {hasViewableProgress(progress) && (
                  <button type="button" className="btn" onClick={() => void openProgress()}>
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
                  <button type="button" className="btn" disabled={busy} onClick={() => void restoreWorkersDev()}>
                    {t("tools.lockerRestoreWorkersDev")}
                  </button>
                )}
                {probe && (
                  <div className={"locker-probe" + (probe.ok ? " is-ok" : " is-bad")}>
                    {probe.checks.map((check) => (
                      <div key={check.id} className={"locker-probe-item" + (check.ok ? " is-ok" : " is-bad")}>
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
                      {probe.ok ? t("tools.lockerProbeOk") : t("tools.lockerProbeFail")}
                    </div>
                    {probe.hint && <p className="muted">{safeDetail(probe.hint)}</p>}
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
                    className={"locker-method" + (worker.lastMethod === "apiToken" ? " is-last" : "")}
                    disabled={deploying}
                    onClick={() => {
                      setGuideErr("");
                      setConfigView("guide");
                    }}
                  >
                    {worker.lastMethod === "apiToken" && <span className="locker-slot">{t("tools.lockerMethodLast")}</span>}
                    <strong>{t("tools.lockerMethodApiTitle")}</strong>
                    <span>{t("tools.lockerMethodApiDesc")}</span>
                  </button>
                  <button
                    type="button"
                    className={"locker-method" + (worker.lastMethod === "wrangler" ? " is-last" : "")}
                    disabled={deploying}
                    onClick={() => void startDeploy("wrangler")}
                  >
                    {worker.lastMethod === "wrangler" && <span className="locker-slot">{t("tools.lockerMethodLast")}</span>}
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
                <button type="button" className="btn" onClick={() => void api.openUrl(CF_TOKEN_URL)}>
                  {t("tools.lockerGuideOpenDash")}
                </button>
                {worker.hasApiToken && (
                  <div className="locker-token-row">
                    <span>{t("tools.lockerTokenSaved", { last4: worker.tokenLast4 || "••••" })}</span>
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
                {err && <div className="callout danger sm">{err}</div>}
                <div className={"locker-deploy-now" + (progress?.error ? " is-failed" : progress?.finished ? " is-done" : "")}>
                  {progress?.finished
                    ? t("tools.lockerProgressDone")
                    : progress?.error
                      ? t("tools.lockerProgressFailed", {
                          current: progress.currentStep,
                          name: progress.steps.find((step) => step.index === progress.currentStep)?.name || stepName(progress.currentStep),
                        })
                      : t("tools.lockerProgressNow", {
                          current: progress?.currentStep || 1,
                          name:
                            progress?.steps.find((step) => step.index === progress.currentStep)?.name ||
                            stepName(progress?.currentStep || 1),
                        })}
                </div>
                <ol className="locker-deploy-steps">
                  {(progress?.steps?.length ? progress.steps : idleSteps()).map((step) => {
                    const showAccounts =
                      Boolean(progress?.waitingForAccount) &&
                      step.index === (progress?.currentStep || 3);
                    return (
                      <li
                        key={step.index}
                        className={"locker-deploy-step is-" + step.status + (progress?.currentStep === step.index ? " is-current" : "")}
                      >
                        <span className="locker-deploy-index">{step.index}</span>
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
                          {progress?.currentStep === step.index && safeDetail(step.detail) && (
                            <p>{safeDetail(step.detail)}</p>
                          )}
                          {step.status === "failed" && safeDetail(step.detail) && progress?.currentStep !== step.index && (
                            <p>{safeDetail(step.detail)}</p>
                          )}
                          {showAccounts && (
                            <div className="locker-accounts">
                              <div className="muted">{t("tools.lockerPickAccount")}</div>
                              {progress?.accounts.map((account) => (
                                <button
                                  key={account.id}
                                  type="button"
                                  className="btn"
                                  onClick={() => void selectDeployAccount(account.id)}
                                >
                                  {account.name}
                                </button>
                              ))}
                            </div>
                          )}
                          {step.status === "failed" && (
                            <button type="button" className="btn primary" disabled={deploying} onClick={() => void retryDeploy()}>
                              {t("tools.lockerRetryStep")}
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>
                {progress?.cancelable === true && (
                  <button type="button" className="btn" onClick={() => void cancelDeploy()}>
                    {t("common.cancel")}
                  </button>
                )}
                {progress?.finished && (
                  <div className="locker-deploy-success">
                    <div>{t("tools.lockerSuccessUrl", { url: progress.currentUrl || workerUrl || workersDevUrl || "—" })}</div>
                    <div className="muted">
                      {progress.hasSecret || worker.hasSecret ? t("tools.lockerSuccessSecret") : t("tools.lockerSuccessNoSecret")}
                    </div>
                    {progress.keptCustomAddress && <div className="muted">{t("tools.lockerKeptCustomUrl")}</div>}
                    {progress.keptCustomAddress &&
                      progress.currentUrl &&
                      progress.workersDevUrl &&
                      progress.currentUrl.replace(/\/$/, "") !== progress.workersDevUrl.replace(/\/$/, "") && (
                        <div className="muted">{t("tools.lockerCustomDomainPending")}</div>
                      )}
                    <p className="muted">{t("tools.lockerSuccessHint")}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {vaultOpen && (
        <div className="wizard-overlay" role="presentation" onClick={() => setVaultOpen(false)}>
          <div className="locker-sheet" role="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="card-body stack">
              <div className="card-title">{t("tools.lockerFromVault")}</div>
              {vaultEntries.length === 0 && <div className="muted">{t("tools.lockerVaultEmpty")}</div>}
              {vaultEntries.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="btn"
                  onClick={() => {
                    const files = entryAttachments(entry);
                    setVaultId(entry.id);
                    setAttId(files.length === 1 ? files[0].id : "");
                    setVaultOpen(false);
                  }}
                >
                  <PackageOpen size={14} /> {entry.name}
                </button>
              ))}
              <button type="button" className="btn ghost" onClick={() => setVaultOpen(false)}>
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {reauth && (
        <ReauthDialog
          hint={t("tools.lockerReauthHint")}
          onCancel={() => reauthCancel.current?.()}
          onConfirm={(pw) => reauth(pw)}
        />
      )}
    </ToolSubPage>
  );
}
