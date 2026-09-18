import { useState } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "../../lib/i18n";
import { open } from "@tauri-apps/plugin-dialog";
import { api, errCode, errMessage, type CloudRestorePreview, type S3Config } from "../../lib/ipc";
import { readClipboard } from "../../lib/clipboard";
import { importS3ConfigFromPicker } from "../../lib/s3ConfigPick";
import { firstS3ConfigJson, pickQrFromGallery, scanQrWithCamera } from "../../lib/qrCapture";
import { useApp } from "../../store";
import type { S3GuideProvider } from "../../ui/S3SetupGuide";

type Translate = (key: string, options?: Record<string, unknown>) => string;

export function createSteps(t: Translate) {
  return [
    t("init.steps.selectWs"),
    t("init.steps.setPassword"),
    t("init.steps.saveRecovery"),
    t("init.steps.verifyRecovery"),
    t("init.steps.done"),
  ];
}
export function restoreSteps(t: Translate) {
  return [
    t("init.steps.selectWs"),
    t("init.steps.cloud"),
    t("init.steps.recovery"),
    t("init.steps.newPassword"),
    t("init.steps.done"),
  ];
}
export function createStepsMobile(t: Translate) {
  return [
    t("init.steps.setPassword"),
    t("init.steps.saveRecovery"),
    t("init.steps.verifyRecovery"),
    t("init.steps.done"),
  ];
}
export function restoreStepsMobile(t: Translate) {
  return [t("init.steps.cloud"), t("init.steps.recovery"), t("init.steps.newPassword"), t("init.steps.done")];
}

export type Mode = "create" | "restore";

export function samePath(a: string, b: string): boolean {
  return a.trim().replace(/[\\/]+$/, "").toLowerCase() === b.trim().replace(/[\\/]+$/, "").toLowerCase();
}

export function emptyS3(): S3Config {
  return {
    endpoint: "",
    bucket: "",
    region: "auto",
    accessKeyId: "",
    secretAccessKey: "",
    prefix: "gam-sync/",
  };
}

export function pwStrengthKey(pw: string): "weak" | "medium" | "strong" {
  if (pw.length < 8) return "weak";
  let score = 0;
  if (/[a-z]/.test(pw)) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^a-zA-Z0-9]/.test(pw)) score++;
  if (pw.length >= 12) score++;
  return score >= 4 ? "strong" : score >= 3 ? "medium" : "weak";
}

export function pwStrength(pw: string): string {
  return i18n.t(`init.${pwStrengthKey(pw)}`);
}

export function useInitModel(variant: "desktop" | "mobile") {
  const { t } = useTranslation();
  const { refresh, theme, toggleTheme } = useApp();
  const [mode, setMode] = useState<Mode | null>(null);
  const [step, setStep] = useState(0);
  const [path, setPath] = useState("");
  const [warning, setWarning] = useState<string | null>(null);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [recovery, setRecovery] = useState("");
  const [confirm, setConfirm] = useState("");
  const [createdPath, setCreatedPath] = useState<string | null>(null);
  const [createdPw, setCreatedPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [s3, setS3] = useState<S3Config>(emptyS3);
  const [showSecret, setShowSecret] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [restoreKey, setRestoreKey] = useState("");
  const [preview, setPreview] = useState<CloudRestorePreview | null>(null);
  const [restoreResult, setRestoreResult] = useState<string | null>(null);
  const [includeRepos, setIncludeRepos] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [guideTab, setGuideTab] = useState<S3GuideProvider>("r2");

  const compact = variant === "mobile";
  const steps = mode === "restore"
    ? (compact ? restoreStepsMobile(t as Translate) : restoreSteps(t as Translate))
    : (compact ? createStepsMobile(t as Translate) : createSteps(t as Translate));
  const strength = t(`init.${pwStrengthKey(pw)}`);
  const alreadyCreated = !!createdPath;
  const switchingPath = alreadyCreated && !samePath(path, createdPath);

  function resetErr() {
    setErr("");
  }

  async function chooseMode(next: Mode) {
    resetErr();
    setMode(next);
    if (compact) {
      try {
        const ws = await api.defaultWorkspacePath();
        setPath(ws);
        const status = await api.vaultStatus();
        if (status.initialized) {
          await refresh();
          return;
        }
      } catch (e) {
        setErr(errMessage(e));
      }
      setStep(1);
      return;
    }
    setStep(0);
  }

  function backToMode() {
    resetErr();
    setMode(null);
    setStep(0);
  }

  async function ensureWorkspacePath(): Promise<string | null> {
    const current = path.trim();
    if (current) return current;
    if (!compact) {
      setErr(t("init.needPath"));
      return null;
    }
    try {
      const ws = await api.defaultWorkspacePath();
      setPath(ws);
      return ws;
    } catch (e) {
      setErr(errMessage(e));
      return null;
    }
  }

  async function pickDir() {
    resetErr();
    // 手机没有系统文件夹选择器；保险库固定在应用沙箱，不能走桌面 dialog。
    if (compact) return;
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t("init.pickDir"),
        defaultPath: path.trim() || undefined,
      });
      if (typeof selected !== "string" || !selected) return;
      setPath(selected);
      const r = await api.checkWorkspacePath(selected);
      setWarning(r.warning);
      if (r.error) setErr(r.error);
    } catch (e) {
      setErr(errMessage(e));
    }
  }

  async function checkPath() {
    resetErr();
    if (!path.trim()) return setErr(t("init.needPath"));
    try {
      const r = await api.checkWorkspacePath(path);
      setWarning(r.warning);
      if (r.error) return setErr(r.error);
      setStep(1);
    } catch (e) {
      setErr(errMessage(e));
    }
  }

  async function doInit() {
    resetErr();
    if (pw.length < 8) return setErr(t("init.pwMin"));
    if (pw !== pw2) return setErr(t("init.pwMismatch"));
    setBusy(true);
    try {
      if (createdPath && samePath(path, createdPath)) {
        if (pw !== createdPw) {
          await api.changePassword(createdPw, pw);
          setCreatedPw(pw);
        }
        setStep(2);
        return;
      }
      const ws = await ensureWorkspacePath();
      if (!ws) return;
      const r = await api.vaultInit(ws, pw);
      setRecovery(r.recoveryKey);
      setCreatedPath(ws);
      setCreatedPw(pw);
      setConfirm("");
      setStep(2);
    } catch (e) {
      const already = errCode(e) === "ALREADY_INITIALIZED" || errMessage(e).includes("工作空间已存在");
      if (compact && already) {
        await refresh();
        return;
      }
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function verifyConfirm() {
    resetErr();
    const norm = (s: string) => s.replace(/[\s-]/g, "").toUpperCase();
    if (norm(confirm) !== norm(recovery)) return setErr(t("init.recoveryMismatch"));
    setStep(4);
  }

  function s3Ready(): boolean {
    return !!(s3.endpoint.trim() && s3.bucket.trim() && s3.accessKeyId.trim() && s3.secretAccessKey.trim());
  }

  function applyGuidePreset(type: "r2" | "s3" | "minio") {
    setGuideTab(type);
    if (type === "r2") {
      setS3((p) => ({ ...p, endpoint: "https://<account_id>.r2.cloudflarestorage.com", region: "auto", prefix: p.prefix || "gam-sync/" }));
    } else if (type === "s3") {
      setS3((p) => ({ ...p, endpoint: "https://s3.us-east-1.amazonaws.com", region: "us-east-1", prefix: p.prefix || "gam-sync/" }));
    } else {
      setS3((p) => ({ ...p, endpoint: "http://127.0.0.1:9000", region: "us-east-1", prefix: p.prefix || "gam-sync/" }));
    }
  }

  async function testS3() {
    resetErr();
    if (!s3Ready()) return setErr(t("init.testNeed"));
    setBusy(true);
    setTestResult(null);
    try {
      const ms = await api.testCloudSyncConfig(s3);
      setTestResult({ ok: true, msg: t("init.testOk", { ms }) });
    } catch (e) {
      setTestResult({ ok: false, msg: errMessage(e) });
    } finally {
      setBusy(false);
    }
  }

  async function importS3File() {
    resetErr();
    try {
      const cfg = await importS3ConfigFromPicker();
      if (!cfg) return;
      setS3(cfg);
      setTestResult({ ok: true, msg: t("init.importOk") });
    } catch (e) {
      setErr(errMessage(e));
    }
  }

  async function applyS3QrTexts(texts: string[] | null) {
    if (!texts) return;
    const raw = firstS3ConfigJson(texts);
    if (!raw) {
      setErr(t("init.scanNone"));
      return;
    }
    const cfg = await api.importS3ConfigText(raw);
    setS3(cfg);
    setTestResult({ ok: true, msg: t("init.scanOk") });
    setStep(2);
  }

  async function scanS3Qr() {
    resetErr();
    setBusy(true);
    setTestResult(null);
    try {
      const texts = await scanQrWithCamera({
        title: t("init.scanQrTitle"),
        hint: t("init.scanHintComputer"),
      });
      await applyS3QrTexts(texts);
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  /** iOS 引导「从相册识别配置码」：不依赖实时相机。 */
  async function importS3QrFromGallery() {
    resetErr();
    setBusy(true);
    setTestResult(null);
    try {
      const texts = await pickQrFromGallery();
      await applyS3QrTexts(texts);
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function goRestoreCloud() {
    resetErr();
    if (!s3Ready()) return setErr(t("init.needCloud"));
    setStep(2);
  }

  async function doPreview() {
    resetErr();
    if (!restoreKey.trim()) return setErr(t("init.needRestoreKey"));
    setBusy(true);
    setPreview(null);
    try {
      const r = await api.previewCloudRestore(s3, restoreKey);
      setPreview(r);
      if (!r.hasManifest) {
        setErr(t("init.noManifest"));
      }
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function doRestore() {
    resetErr();
    if (pw.length < 8) return setErr(t("init.pwMin"));
    if (pw !== pw2) return setErr(t("init.pwMismatch"));
    if (!preview?.hasManifest) return setErr(t("init.needPreview"));
    setBusy(true);
    try {
      const ws = await ensureWorkspacePath();
      if (!ws) return;
      const r = await api.restoreFromCloud({
        path: ws,
        password: pw,
        recoveryKey: restoreKey,
        syncConfig: s3,
        includeRepos,
      });
      setRestoreResult(r.message);
      setStep(4);
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function goBack() {
    if (!mode) return;
    resetErr();
    if (step <= 0 || (compact && step <= 1)) {
      backToMode();
      return;
    }
    if (mode === "create" && step >= 4) return;
    if (mode === "restore" && step >= 4) return;
    setStep((s) => s - 1);
  }

  function jumpTo(i: number) {
    if (!mode || i >= step || i >= 4) return;
    resetErr();
    setStep(i);
  }

  async function pasteRestoreKey() {
    resetErr();
    try {
      const text = await readClipboard();
      setRestoreKey(text);
      setPreview(null);
    } catch (e) {
      setErr(errMessage(e));
    }
  }

  async function pasteConfirm() {
    resetErr();
    try {
      setConfirm(await readClipboard());
    } catch (e) {
      setErr(errMessage(e));
    }
  }

  const title =
    !mode ? t("init.chooseTitle")
    : mode === "restore"
      ? [
          t("init.titles.selectDir"),
          t("init.titles.fillCloud"),
          t("init.titles.oldRecovery"),
          t("init.titles.setLocalPassword"),
          t("init.titles.restored"),
        ][step]
      : [
          t("init.titles.selectDir"),
          t("init.titles.setDailyPassword"),
          t("init.titles.saveKey"),
          t("init.titles.verifyKey"),
          t("init.titles.ready"),
        ][step];

  const desc =
    !mode ? t("init.chooseDesc")
    : mode === "restore"
      ? [
          t("init.descs.restore0"),
          t("init.descs.restore1"),
          t("init.descs.restore2"),
          t("init.descs.restore3"),
          t("init.descs.restore4"),
        ][step]
      : [
          t("init.descs.create0"),
          t("init.descs.create1"),
          t("init.descs.create2"),
          t("init.descs.create3"),
          t("init.descs.create4"),
        ][step];

  return {
    mode,
    step,
    path,
    warning,
    pw,
    pw2,
    recovery,
    confirm,
    createdPath,
    createdPw,
    err,
    busy,
    s3,
    showSecret,
    testResult,
    restoreKey,
    preview,
    restoreResult,
    includeRepos,
    guideOpen,
    guideTab,
    theme,
    toggleTheme,
    refresh,
    compact,
    steps,
    title,
    desc,
    strength,
    alreadyCreated,
    switchingPath,
    setMode,
    setStep,
    setPath,
    setPw,
    setPw2,
    setConfirm,
    setS3,
    setShowSecret,
    setRestoreKey,
    setPreview,
    setIncludeRepos,
    setGuideOpen,
    setGuideTab,
    resetErr,
    chooseMode,
    backToMode,
    pickDir,
    checkPath,
    doInit,
    verifyConfirm,
    s3Ready,
    applyGuidePreset,
    testS3,
    importS3File,
    scanS3Qr,
    importS3QrFromGallery,
    goRestoreCloud,
    doPreview,
    doRestore,
    goBack,
    jumpTo,
    pasteRestoreKey,
    pasteConfirm,
  };
}

export type InitModel = ReturnType<typeof useInitModel>;
