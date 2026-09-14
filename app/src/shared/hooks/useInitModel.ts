import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, errCode, errMessage, type CloudRestorePreview, type S3Config } from "../../lib/ipc";
import { importS3ConfigFromPicker } from "../../lib/s3ConfigPick";
import { firstS3ConfigJson, scanQrWithCamera } from "../../lib/qrCapture";
import { useApp } from "../../store";
import type { S3GuideProvider } from "../../ui/S3SetupGuide";

export const CREATE_STEPS = ["选择工作空间", "设置访问密码", "保存恢复密钥", "回填校验", "完成"];
export const RESTORE_STEPS = ["选择工作空间", "云存储", "恢复密钥", "新访问密码", "完成"];
export const CREATE_STEPS_MOBILE = ["设置访问密码", "保存恢复密钥", "回填校验", "完成"];
export const RESTORE_STEPS_MOBILE = ["云存储", "恢复密钥", "新访问密码", "完成"];

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

export function pwStrength(pw: string): string {
  if (pw.length < 8) return "弱";
  let score = 0;
  if (/[a-z]/.test(pw)) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^a-zA-Z0-9]/.test(pw)) score++;
  if (pw.length >= 12) score++;
  return score >= 4 ? "强" : score >= 3 ? "中" : "弱";
}

export function useInitModel(variant: "desktop" | "mobile") {
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
    ? (compact ? RESTORE_STEPS_MOBILE : RESTORE_STEPS)
    : (compact ? CREATE_STEPS_MOBILE : CREATE_STEPS);
  const strength = pwStrength(pw);
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
      setErr("请选择或填写工作空间目录");
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
        title: "选择工作空间目录",
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
    if (!path.trim()) return setErr("请选择或填写工作空间目录");
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
    if (pw.length < 8) return setErr("访问密码至少 8 位");
    if (pw !== pw2) return setErr("两次输入的密码不一致");
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
    if (norm(confirm) !== norm(recovery)) return setErr("恢复密钥不一致，请仔细核对（大小写与连字符可忽略）");
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
    if (!s3Ready()) return setErr("请先填写 Endpoint、Bucket、Access Key 与 Secret Key");
    setBusy(true);
    setTestResult(null);
    try {
      const ms = await api.testCloudSyncConfig(s3);
      setTestResult({ ok: true, msg: `连接成功，探测耗时 ${ms} ms` });
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
      setTestResult({ ok: true, msg: "已导入配置文件，可先测试连通性再继续" });
    } catch (e) {
      setErr(errMessage(e));
    }
  }

  async function scanS3Qr() {
    resetErr();
    setBusy(true);
    setTestResult(null);
    try {
      const texts = await scanQrWithCamera({
        title: "扫描电脑上的云配置二维码",
        hint: "对准电脑端【设置 → 云同步 → 分享配置】生成的二维码",
      });
      if (!texts) return;
      const raw = firstS3ConfigJson(texts);
      if (!raw) {
        setErr("未识别到云存储配置二维码。电脑须先在同步页「分享配置」生成二维码。");
        return;
      }
      const cfg = await api.importS3ConfigText(raw);
      setS3(cfg);
      setTestResult({ ok: true, msg: "已自动写入云配置。下一步请输入旧设备恢复密钥以解开保险库。" });
      setStep(2);
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function goRestoreCloud() {
    resetErr();
    if (!s3Ready()) return setErr("请先填写完整的云存储连接信息，或扫描电脑上的二维码");
    setStep(2);
  }

  async function doPreview() {
    resetErr();
    if (!restoreKey.trim()) return setErr("请输入旧设备的恢复密钥");
    setBusy(true);
    setPreview(null);
    try {
      const r = await api.previewCloudRestore(s3, restoreKey);
      setPreview(r);
      if (!r.hasManifest) {
        setErr("已解开云端头部，但还没有加密清单。请先在旧设备上打开本应用并执行一次「推送到云端」。");
      }
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function doRestore() {
    resetErr();
    if (pw.length < 8) return setErr("访问密码至少 8 位");
    if (pw !== pw2) return setErr("两次输入的密码不一致");
    if (!preview?.hasManifest) return setErr("请先验证恢复密钥并确认云端有可还原的数据");
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
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) {
        setRestoreKey(text.trim());
        setPreview(null);
      }
    } catch {
      // 剪贴板不可用或权限限制
    }
  }

  async function pasteConfirm() {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) {
        setConfirm(text.trim());
      }
    } catch {
      // 剪贴板不可用或权限限制
    }
  }

  const title =
    !mode ? "选择初始化方式"
    : mode === "restore"
      ? ["选择加密工作空间目录", "填写云存储连接", "输入旧设备恢复密钥", "设置本机访问密码", "已从云端恢复"][step]
      : [
          "选择加密工作空间目录",
          "设置日常访问密码",
          "妥善保存恢复密钥",
          "回填校验恢复密钥",
          "工作空间已就绪",
        ][step];

  const desc =
    !mode ? "全新使用请创建工作空间；另一台设备已有数据时，用那台设备的恢复密钥从云端还原。"
    : mode === "restore"
      ? [
          "还原后的身份与密钥会加密写入这个本地目录。请选择尚未初始化的空目录。",
          "填写与旧设备完全相同的 R2 / S3 连接信息（含路径前缀）。",
          "输入旧设备初始化时保存的恢复密钥，用于解开云端数据。",
          "为本机设置日常访问密码，可以与旧设备不同。旧恢复密钥仍然有效。",
          "已用同一把主密钥重建工作空间，之后两台设备可以继续云同步。",
        ][step]
      : [
          "所有密钥和配置文件均加密存储在你的本地目录中，绝不明文上传。",
          "密码用于本机日常解锁；请牢记，一旦遗忘只能使用恢复密钥重置。",
          "恢复密钥仅显示一次，是换机或忘记密码时唯一的救命稻草，请离线保存。",
          "请把刚才保存的恢复密钥完整填入下方，确认你已真正抄录备份。",
          "加密工作空间已初始化完成，你可以直接进入应用。",
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
