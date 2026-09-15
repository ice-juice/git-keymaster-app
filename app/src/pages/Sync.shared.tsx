import { useEffect, useState } from "react";
import {
  Cloud,
  CloudUpload,
  CloudDownload,
  RefreshCw,
  Shield,
  FileArchive,
  Download,
  Upload,
  Eye,
  EyeOff,
  Zap,
  History,
  QrCode,
  Camera,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  api,
  errMessage,
  type S3Config,
  type CloudSyncStatus,
  type SyncResult,
  type BackupSummary,
  type AutoSyncSettings,
  type BlobSyncProgress,
  type CloudSnapshot,
} from "../lib/ipc";
import { PageHead, Card, Badge, FieldLabel, ConfirmDialog, ErrorDialog } from "../ui/common";
import { S3SetupGuide, S3GuideButton, type S3GuideProvider } from "../ui/S3SetupGuide";
import { encodeS3ConfigPayload, importS3ConfigFromPicker } from "../lib/s3ConfigPick";
import { firstS3ConfigJson, scanQrWithCamera } from "../lib/qrCapture";
import { useApp } from "../store";
import { useOverlayBack } from "../shared/mobileBack";

const AUTO_PRESETS: { labelKey: string; minutes: number }[] = [
  { labelKey: "syncPage.intervalOff", minutes: 0 },
  { labelKey: "syncPage.interval15", minutes: 15 },
  { labelKey: "syncPage.interval30", minutes: 30 },
  { labelKey: "syncPage.interval60", minutes: 60 },
  { labelKey: "syncPage.interval120", minutes: 120 },
];

export function SyncView({ variant }: { variant: "desktop" | "mobile" }) {
  const { t } = useTranslation();
  const { writesLocked } = useApp();
  const compact = variant === "mobile";
  const [activeTab, setActiveTab] = useState<"cloud" | "backup">("cloud");

  // 云端同步配置与状态
  const [s3Config, setS3Config] = useState<S3Config>({
    endpoint: "",
    bucket: "",
    region: "auto",
    accessKeyId: "",
    secretAccessKey: "",
    prefix: "gam-sync/",
  });
  const [showSecret, setShowSecret] = useState(false);
  const [cloudStatus, setCloudStatus] = useState<CloudSyncStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [syncing, setSyncing] = useState<"push" | "pull" | null>(null);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [configSaved, setConfigSaved] = useState(false);
  const [autoSync, setAutoSync] = useState<AutoSyncSettings | null>(null);
  const [savingAuto, setSavingAuto] = useState(false);
  const [blobProgress, setBlobProgress] = useState<BlobSyncProgress | null>(null);
  const [snapshots, setSnapshots] = useState<CloudSnapshot[]>([]);
  const [loadingSnaps, setLoadingSnaps] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [guideTab, setGuideTab] = useState<S3GuideProvider>("r2");
  const [shareQr, setShareQr] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [err, setErr] = useState("");
  const [pendingConfirm, setPendingConfirm] = useState<
    | { kind: "push" }
    | { kind: "pull" }
    | { kind: "restore"; id: string; at: string }
    | null
  >(null);
  useOverlayBack(!!pendingConfirm, () => setPendingConfirm(null));
  useOverlayBack(!!shareQr, () => setShareQr(null));
  useOverlayBack(guideOpen, () => setGuideOpen(false));

  // 本地离线备份导出
  const [exportPw, setExportPw] = useState("");
  const [exportPw2, setExportPw2] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<BackupSummary | null>(null);
  const [exportErr, setExportErr] = useState<string | null>(null);

  // 本地离线备份导入
  const [importPath, setImportPath] = useState("");
  const [importPw, setImportPw] = useState("");
  const [inspecting, setInspecting] = useState(false);
  const [importSummary, setImportSummary] = useState<BackupSummary | null>(null);
  const [importing, setImporting] = useState(false);
  const [importSuccess, setImportSuccess] = useState<BackupSummary | null>(null);
  const [importErr, setImportErr] = useState<string | null>(null);

  // 只读启动/自动同步留下的本地缓存，进页不探测、不同步。
  async function loadInitial() {
    try {
      const page = await api.getCloudSyncPage();
      if (page.config) {
        setS3Config(page.config);
      }
      setCloudStatus(page.status);
      setAutoSync(page.autoSync);
      setSnapshots(page.snapshots);
    } catch (e) {
      console.error(e);
    }
  }

  async function refreshRemote(lite: boolean) {
    setLoadingStatus(true);
    setLoadingSnaps(true);
    try {
      const [st, snaps] = await Promise.all([
        api.getCloudSyncStatus(lite),
        api.listCloudSnapshots(!lite).catch(() => []),
      ]);
      setCloudStatus(st);
      setSnapshots(snaps);
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingStatus(false);
      setLoadingSnaps(false);
    }
  }

  async function loadSnapshots() {
    setLoadingSnaps(true);
    try {
      setSnapshots(await api.listCloudSnapshots(true));
    } catch {
      setSnapshots([]);
    } finally {
      setLoadingSnaps(false);
    }
  }

  useEffect(() => {
    loadInitial();
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let unlistenBlob: (() => void) | undefined;
    listen<{ ok: boolean; message: string; syncedAt?: string }>("cloud-auto-sync", (ev) => {
      const p = ev.payload;
      setSyncNotice(p.ok ? t("syncPage.okMsg", { message: p.message }) : t("syncPage.failErr", { error: p.message }));
      setBlobProgress(null);
      void loadInitial();
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {
        /* 非 Tauri */
      });
    listen<BlobSyncProgress>("blob-sync-progress", (ev) => {
      setBlobProgress(ev.payload.total > 0 ? ev.payload : null);
    })
      .then((fn) => {
        unlistenBlob = fn;
      })
      .catch(() => {
        /* 非 Tauri */
      });
    return () => {
      unlisten?.();
      unlistenBlob?.();
    };
  }, [t]);

  // 快捷预设
  function applyPreset(type: "r2" | "s3" | "minio") {
    setGuideTab(type);
    if (type === "r2") {
      setS3Config((prev) => ({
        ...prev,
        endpoint: "https://<account_id>.r2.cloudflarestorage.com",
        region: "auto",
        prefix: "gam-sync/",
      }));
    } else if (type === "s3") {
      setS3Config((prev) => ({
        ...prev,
        endpoint: "https://s3.us-east-1.amazonaws.com",
        region: "us-east-1",
        prefix: "gam-sync/",
      }));
    } else {
      setS3Config((prev) => ({
        ...prev,
        endpoint: "http://127.0.0.1:9000",
        region: "us-east-1",
        prefix: "gam-sync/",
      }));
    }
  }

  // 保存云存储配置
  async function saveConfig() {
    try {
      await api.saveCloudSyncConfig(s3Config);
      setConfigSaved(true);
      setTimeout(() => setConfigSaved(false), 3000);
      refreshStatus();
    } catch (e) {
      setErr(t("syncPage.saveFail", { error: errMessage(e) }));
    }
  }

  async function exportS3File() {
    try {
      const selected = await save({
        defaultPath: `gam-s3-${s3Config.bucket || "config"}.json`,
        filters: [{ name: t("syncPage.cfgFilter"), extensions: ["json"] }],
      });
      if (!selected) return;
      await api.exportS3Config(selected, s3Config);
      setSyncNotice(t("syncPage.exportCfgOk"));
    } catch (e) {
      setSyncNotice(t("syncPage.exportCfgFail", { error: errMessage(e) }));
    }
  }

  async function importS3File() {
    try {
      const cfg = await importS3ConfigFromPicker();
      if (!cfg) return;
      setS3Config(cfg);
      setSyncNotice(t("syncPage.importCfgOk"));
    } catch (e) {
      setSyncNotice(t("syncPage.importCfgFail", { error: errMessage(e) }));
    }
  }

  function s3Filled(): boolean {
    return !!(s3Config.endpoint && s3Config.bucket && s3Config.accessKeyId && s3Config.secretAccessKey);
  }

  async function shareConfigQr() {
    if (!s3Filled()) {
      setShareQr(null);
      setSyncNotice(t("syncPage.shareNeedCfg"));
      return;
    }
    setSharing(true);
    setShareQr(null);
    setSyncNotice(null);
    try {
      const png = await api.renderQrPng(encodeS3ConfigPayload(s3Config));
      setShareQr(png);
      setSyncNotice(t("syncPage.shareOk"));
    } catch (e) {
      setShareQr(null);
      setSyncNotice(t("syncPage.shareFail", { error: errMessage(e) }));
    } finally {
      setSharing(false);
    }
  }

  async function scanS3Qr() {
    setSyncNotice(null);
    try {
      const texts = await scanQrWithCamera({
        title: t("syncPage.scanTitle"),
        hint: t("syncPage.scanHint"),
      });
      if (!texts) return;
      const raw = firstS3ConfigJson(texts);
      if (!raw) {
        setSyncNotice(t("syncPage.scanNone"));
        return;
      }
      const cfg = await api.importS3ConfigText(raw);
      setS3Config(cfg);
      await api.saveCloudSyncConfig(cfg);
      setSyncNotice(t("syncPage.scanOk"));
    } catch (e) {
      setSyncNotice(t("syncPage.scanFail", { error: errMessage(e) }));
    }
  }

  // 测试云端连通性
  async function testConnection() {
    if (!s3Config.endpoint || !s3Config.bucket || !s3Config.accessKeyId || !s3Config.secretAccessKey) {
      setTestResult({ ok: false, msg: t("syncPage.testNeed") });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const ms = await api.testCloudSyncConfig(s3Config);
      setTestResult({ ok: true, msg: t("syncPage.testOk", { ms }) });
    } catch (e) {
      setTestResult({ ok: false, msg: errMessage(e) });
    } finally {
      setTesting(false);
    }
  }

  // 刷新云同步状态（完整探测，并同步刷新快照）
  async function refreshStatus() {
    await refreshRemote(false);
  }

  function ensureConfigured(): boolean {
    if (!cloudStatus || cloudStatus.status === "unconfigured") {
      setErr(t("syncPage.needSavedCfg"));
      return false;
    }
    return true;
  }

  function handlePush() {
    if (!ensureConfigured()) return;
    setPendingConfirm({ kind: "push" });
  }

  function handlePull() {
    if (!ensureConfigured()) return;
    setPendingConfirm({ kind: "pull" });
  }

  async function runPush() {
    setSyncing("push");
    setSyncNotice(null);
    setPendingConfirm(null);
    try {
      const res: SyncResult = await api.cloudSyncPush();
      setSyncNotice(t("syncPage.okMsg", { message: res.message }));
      await refreshStatus();
      await loadSnapshots();
    } catch (e) {
      setSyncNotice(t("syncPage.pushFail", { error: errMessage(e) }));
    } finally {
      setSyncing(null);
    }
  }

  async function runPull() {
    setSyncing("pull");
    setSyncNotice(null);
    setPendingConfirm(null);
    try {
      const res: SyncResult = await api.cloudSyncPull();
      setSyncNotice(t("syncPage.pullOk", { message: res.message, identities: res.identityCount, keys: res.keyCount }));
      await refreshStatus();
    } catch (e) {
      setSyncNotice(t("syncPage.pullFail", { error: errMessage(e) }));
    } finally {
      setSyncing(null);
    }
  }

  function askRestore(snapshot: CloudSnapshot) {
    setPendingConfirm({
      kind: "restore",
      id: snapshot.id,
      at: new Date(snapshot.createdAt).toLocaleString(),
    });
  }

  async function runRestore(id: string) {
    setRestoringId(id);
    setPendingConfirm(null);
    try {
      const res = await api.restoreCloudSnapshot(id);
      setSyncNotice(t("syncPage.okMsg", { message: res.message }));
      await refreshStatus();
    } catch (e) {
      setSyncNotice(t("syncPage.restoreFail", { error: errMessage(e) }));
    } finally {
      setRestoringId(null);
    }
  }

  // 触发离线备份导出
  async function handleExportBackup() {
    setExportErr(null);
    setExportResult(null);
    if (!exportPw || exportPw.length < 6) {
      setExportErr(t("syncPage.backupPwShort"));
      return;
    }
    if (exportPw !== exportPw2) {
      setExportErr(t("syncPage.backupPwMismatch"));
      return;
    }

    const defaultName = `gam-backup-${new Date().toISOString().slice(0, 10)}.gambackup`;
    const selected = await save({
      defaultPath: defaultName,
      filters: [{ name: t("syncPage.backupFilter"), extensions: ["gambackup"] }],
    });

    if (!selected) return;

    setExporting(true);
    try {
      const res = await api.exportVaultBackup(selected, exportPw);
      setExportResult(res);
      setExportPw("");
      setExportPw2("");
    } catch (e) {
      setExportErr(errMessage(e));
    } finally {
      setExporting(false);
    }
  }

  // 选择待导入备份文件
  async function pickImportFile() {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: t("syncPage.backupFilter"), extensions: ["gambackup"] }],
    });
    if (selected && typeof selected === "string") {
      setImportPath(selected);
      setImportSummary(null);
      setImportErr(null);
      setImportSuccess(null);
    }
  }

  // 查看备份包内容
  async function handleInspectBackup() {
    if (!importPath) {
      setImportErr(t("syncPage.needBackupFile"));
      return;
    }
    if (!importPw) {
      setImportErr(t("syncPage.needBackupPw"));
      return;
    }
    setInspecting(true);
    setImportErr(null);
    try {
      const res = await api.inspectVaultBackup(importPath, importPw);
      setImportSummary(res);
    } catch (e) {
      setImportErr(errMessage(e));
    } finally {
      setInspecting(false);
    }
  }

  // 确认导入合并
  async function handleConfirmImport() {
    if (!importPath || !importPw) return;
    setImporting(true);
    setImportErr(null);
    try {
      const res = await api.importVaultBackup(importPath, importPw, true);
      setImportSuccess(res);
      setImportSummary(null);
      setImportPath("");
      setImportPw("");
    } catch (e) {
      setImportErr(errMessage(e));
    } finally {
      setImporting(false);
    }
  }

  const statusLabel = (() => {
    if (!cloudStatus) return { text: t("syncPage.stChecking"), cls: "muted" };
    switch (cloudStatus.status) {
      case "synced":
        return { text: t("syncPage.stSynced"), cls: "ok" };
      case "local_ahead":
        return { text: t("syncPage.stLocalDirty"), cls: "warn" };
      case "remote_ahead":
        return { text: t("syncPage.stRemoteNewer"), cls: "info" };
      case "different_workspace":
        return { text: t("syncPage.stMismatch"), cls: "danger" };
      case "not_synced":
        return { text: t("syncPage.stEmpty"), cls: "warn" };
      case "checking":
        return { text: writesLocked ? t("syncPage.stStartup") : t("syncPage.stWait"), cls: "muted" };
      default:
        return { text: t("syncPage.stNone"), cls: "muted" };
    }
  })();

  return (
    <div className="stack-lg">
      <ErrorDialog message={err} onClose={() => setErr("")} />
      {pendingConfirm?.kind === "push" && (
        <ConfirmDialog
          title={t("syncPage.confirmPushTitle")}
          message={t("syncPage.confirmPushMsg")}
          detail={t("syncPage.confirmPushDetail")}
          confirmLabel={t("syncPage.confirmPush")}
          busy={syncing === "push"}
          busyLabel={t("syncPage.pushing")}
          onCancel={() => setPendingConfirm(null)}
          onConfirm={() => void runPush()}
        />
      )}
      {pendingConfirm?.kind === "pull" && (
        <ConfirmDialog
          title={t("syncPage.confirmPullTitle")}
          message={t("syncPage.confirmPullMsg")}
          detail={t("syncPage.confirmPullDetail")}
          confirmLabel={t("syncPage.confirmPull")}
          busy={syncing === "pull"}
          busyLabel={t("syncPage.pulling")}
          onCancel={() => setPendingConfirm(null)}
          onConfirm={() => void runPull()}
        />
      )}
      {pendingConfirm?.kind === "restore" && (
        <ConfirmDialog
          title={t("syncPage.confirmRestoreTitle")}
          message={t("syncPage.confirmRestoreMsg", { at: pendingConfirm.at })}
          detail={t("syncPage.confirmRestoreDetail")}
          confirmLabel={t("syncPage.confirmRestore")}
          tone="danger"
          busy={restoringId !== null}
          busyLabel={t("syncPage.restoring")}
          onCancel={() => setPendingConfirm(null)}
          onConfirm={() => void runRestore(pendingConfirm.id)}
        />
      )}
      <PageHead
        title={t("pages.syncTitle")}
        desc={t("pages.syncDesc")}
        actions={
          compact ? (
            <div className="m-seg">
              <button
                type="button"
                className={"m-seg-btn" + (activeTab === "cloud" ? " on" : "")}
                onClick={() => setActiveTab("cloud")}
              >
                <Cloud size={14} />
                {t("pages.cloud")}
              </button>
              <button
                type="button"
                className={"m-seg-btn" + (activeTab === "backup" ? " on" : "")}
                onClick={() => setActiveTab("backup")}
              >
                <FileArchive size={14} />
                {t("syncPage.offlineTab")}
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <button
                type="button"
                className={`btn sm ${activeTab === "cloud" ? "primary" : "ghost"}`}
                onClick={() => setActiveTab("cloud")}
              >
                <Cloud size={13} style={{ marginRight: 4 }} />
                {t("syncPage.cloudTab")}
              </button>
              <button
                type="button"
                className={`btn sm ${activeTab === "backup" ? "primary" : "ghost"}`}
                onClick={() => setActiveTab("backup")}
              >
                <FileArchive size={13} style={{ marginRight: 4 }} />
                {t("syncPage.offlinePack")}
              </button>
            </div>
          )
        }
      />

      {activeTab === "cloud" && (
        <>
          {/* 板块 1: 云同步状态与快速操作 */}
          <Card
            title={t("syncPage.statusTitle")}
            actions={
              <div className="flex items-center gap-2">
                <Badge kind={statusLabel.cls}>{statusLabel.text}</Badge>
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={loadingStatus}
                  onClick={refreshStatus}
                  style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
                >
                  <RefreshCw size={12} className={loadingStatus ? "animate-spin" : ""} />
                  {t("common.refresh")}
                </button>
              </div>
            }
          >
            <div className="stat-card-row mb-3">
              <div className="stat-card">
                <div className="stat-card-title">{t("syncPage.localAssets")}</div>
                <div className="stat-card-body">
                  <div className="stat-card-val" style={{ fontSize: 18 }}>
                    {cloudStatus?.localIdentityCount ?? 0}
                  </div>
                  <div className="stat-card-sub">
                    {t("syncPage.keysRepos", {
                      keys: cloudStatus?.localKeyCount ?? 0,
                      repos: cloudStatus?.localRepoCount ?? 0,
                    })}
                  </div>
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-card-title">{t("syncPage.cloudStatus")}</div>
                <div className="stat-card-body">
                  <div
                    className="stat-card-val"
                    style={{
                      fontSize: 16,
                      color: cloudStatus?.remoteExists ? "var(--green)" : "var(--text-soft)",
                    }}
                  >
                    {cloudStatus?.status === "checking" || (loadingStatus && !cloudStatus?.remoteExists)
                      ? t("syncPage.checkingEllipsis")
                      : cloudStatus?.remoteExists
                        ? t("syncPage.ready")
                        : t("syncPage.needFirstPush")}
                  </div>
                  <div className="stat-card-sub">
                    {cloudStatus?.status === "checking"
                      ? t("syncPage.readingManifest")
                      : cloudStatus?.headerReady
                        ? t("syncPage.headerOk")
                        : t("syncPage.noSnapshot")}
                  </div>
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-card-title">{t("syncPage.lastSync")}</div>
                <div className="stat-card-body">
                  <div className="stat-card-val" style={{ fontSize: 13, lineHeight: 1.4 }}>
                    {cloudStatus?.remoteUpdatedAt ? new Date(cloudStatus.remoteUpdatedAt).toLocaleTimeString() : t("common.emDash")}
                  </div>
                  <div className="stat-card-sub">
                    {cloudStatus?.remoteUpdatedAt ? new Date(cloudStatus.remoteUpdatedAt).toLocaleDateString() : t("syncPage.neverSync")}
                  </div>
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-card-title">{t("syncPage.algo")}</div>
                <div className="stat-card-body">
                  <div className="stat-card-val" style={{ fontSize: 15, color: "var(--accent)" }}>
                    E2EE
                  </div>
                  <div className="stat-card-sub">
                    XChaCha20-Poly1305
                  </div>
                </div>
              </div>
            </div>

            {syncNotice && (
              <div
                style={{
                  padding: "7px 10px",
                  borderRadius: 6,
                  fontSize: 11.5,
                  marginBottom: 10,
                  background: syncNotice.startsWith("✅") ? "rgba(16, 185, 129, 0.1)" : "rgba(239, 68, 68, 0.1)",
                  color: syncNotice.startsWith("✅") ? "var(--green)" : "var(--red)",
                  border: "1px solid",
                  borderColor: syncNotice.startsWith("✅") ? "rgba(16, 185, 129, 0.3)" : "rgba(239, 68, 68, 0.3)",
                }}
              >
                {syncNotice}
              </div>
            )}

            <div className="sync-action-bar">
              <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.5, flex: 1, minWidth: 180 }}>
                {t("syncPage.statusHint")}
              </div>
              <div className="sync-action-btns">
                <button
                  type="button"
                  className="btn primary"
                  disabled={writesLocked || syncing !== null || cloudStatus?.status === "unconfigured"}
                  onClick={handlePush}
                >
                  <CloudUpload size={14} />
                  {syncing === "push" ? t("syncPage.pushingEnc") : t("syncPage.pushBtn")}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={syncing !== null || cloudStatus?.status === "unconfigured" || !cloudStatus?.remoteExists}
                  onClick={handlePull}
                >
                  <CloudDownload size={14} />
                  {syncing === "pull" ? t("syncPage.pullingSync") : t("syncPage.pullBtn")}
                </button>
              </div>
            </div>
          </Card>

          {/* 板块 2: 精简后的定时同步 */}
          <Card
            title={t("syncPage.autoTitle")}
            actions={
              <button
                type="button"
                className="btn ghost sm"
                disabled={syncing !== null || cloudStatus?.status === "unconfigured"}
                onClick={async () => {
                  setSyncing("pull");
                  setSyncNotice(null);
                  try {
                    const res = await api.runAutoSyncNow();
                    setSyncNotice(
                      res
                        ? t("syncPage.okMsg", { message: res.message })
                        : t("syncPage.okMsg", { message: t("syncPage.alreadyLatest") }),
                    );
                    await refreshStatus();
                    await loadSnapshots();
                  } catch (e) {
                    setSyncNotice(t("syncPage.failErr", { error: errMessage(e) }));
                  } finally {
                    setSyncing(null);
                  }
                }}
                style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
              >
                <RefreshCw size={12} className={syncing === "pull" ? "animate-spin" : ""} />
                {t("syncPage.syncNow")}
              </button>
            }
          >
            <div className="stack">
              <div className="between" style={{ flexWrap: "wrap", gap: 8 }}>
                <div>
                  <div style={{ fontSize: 11.5, fontWeight: 600 }}>{t("syncPage.period")}</div>
                  <div className="muted" style={{ fontSize: 11, marginTop: 1 }}>
                    {t("syncPage.periodHint")}
                  </div>
                </div>
                <div className="choice-row" style={{ margin: 0 }}>
                  {AUTO_PRESETS.map((p) => {
                    const on = (autoSync?.minutes ?? 30) === p.minutes;
                    return (
                      <button
                        key={p.minutes}
                        type="button"
                        className={"choice" + (on ? " on" : "")}
                        disabled={savingAuto}
                        style={{ padding: "4px 9px", fontSize: 11 }}
                        onClick={async () => {
                          setSavingAuto(true);
                          try {
                            const minutes = await api.setAutoSyncMinutes(p.minutes);
                            setAutoSync((prev) =>
                              prev
                                ? { ...prev, minutes }
                                : {
                                    minutes,
                                    defaultMinutes: 30,
                                    lastAutoSyncAt: null,
                                    lastAutoSyncMessage: null,
                                    syncAttachmentsWifiOnly: true,
                                    syncAttachmentsManualOnly: false,
                                  },
                            );
                          } catch (e) {
                            setSyncNotice(t("syncPage.failErr", { error: errMessage(e) }));
                          } finally {
                            setSavingAuto(false);
                          }
                        }}
                      >
                        {t(p.labelKey)}
                      </button>
                    );
                  })}
                </div>
              </div>
              {autoSync?.lastAutoSyncAt && (
                <div className="muted sm" style={{ borderTop: "1px dashed var(--border)", paddingTop: 5, marginTop: 2 }}>
                  {t("syncPage.lastAuto", { at: new Date(autoSync.lastAutoSyncAt).toLocaleString() })}
                  {autoSync.lastAutoSyncMessage ? ` · ${autoSync.lastAutoSyncMessage}` : ""}
                </div>
              )}
              {blobProgress && (
                <div className="muted sm">
                  {t("syncPage.blobProgress", {
                    current: blobProgress.current,
                    total: blobProgress.total,
                    phase: blobProgress.phase === "download" ? t("syncPage.blobDownload") : t("syncPage.blobUpload"),
                  })}
                </div>
              )}
              <div className="between" style={{ flexWrap: "wrap", gap: 8, borderTop: "1px dashed var(--border)", paddingTop: 8 }}>
                <div>
                  <div style={{ fontSize: 11.5, fontWeight: 600 }}>{t("syncPage.wifiOnly")}</div>
                  <div className="muted" style={{ fontSize: 11, marginTop: 1 }}>{t("syncPage.wifiOnlyHint")}</div>
                </div>
                <button
                  type="button"
                  className={"switch" + (autoSync?.syncAttachmentsWifiOnly === false ? " off" : "")}
                  disabled={savingAuto}
                  onClick={async () => {
                    setSavingAuto(true);
                    try {
                      const next = await api.setAttachmentSyncGuards(!(autoSync?.syncAttachmentsWifiOnly !== false), !!autoSync?.syncAttachmentsManualOnly);
                      setAutoSync(next);
                    } catch (e) {
                      setSyncNotice(t("syncPage.failErr", { error: errMessage(e) }));
                    } finally {
                      setSavingAuto(false);
                    }
                  }}
                />
              </div>
              <div className="between" style={{ flexWrap: "wrap", gap: 8 }}>
                <div>
                  <div style={{ fontSize: 11.5, fontWeight: 600 }}>{t("syncPage.attachmentsManual")}</div>
                  <div className="muted" style={{ fontSize: 11, marginTop: 1 }}>{t("syncPage.attachmentsManualHint")}</div>
                </div>
                <button
                  type="button"
                  className={"switch" + (autoSync?.syncAttachmentsManualOnly ? "" : " off")}
                  disabled={savingAuto}
                  onClick={async () => {
                    setSavingAuto(true);
                    try {
                      const next = await api.setAttachmentSyncGuards(autoSync?.syncAttachmentsWifiOnly !== false, !autoSync?.syncAttachmentsManualOnly);
                      setAutoSync(next);
                    } catch (e) {
                      setSyncNotice(t("syncPage.failErr", { error: errMessage(e) }));
                    } finally {
                      setSavingAuto(false);
                    }
                  }}
                />
              </div>
            </div>
          </Card>

          {/* 板块 3: S3 / Cloudflare R2 存储配置 (上移到历史快照之前) */}
          <Card
            title={t("syncPage.s3Title")}
            actions={
              compact ? (
                <button type="button" className="m-s3-head-scan" onClick={scanS3Qr}>
                  <Camera size={14} />
                  {t("syncPage.scanImport")}
                </button>
              ) : (
                <div className="flex gap-1">
                  <span className="muted" style={{ fontSize: 11, alignSelf: "center", marginRight: 4 }}>{t("syncPage.presets")}</span>
                  <button type="button" className="btn ghost sm" onClick={() => applyPreset("r2")}>Cloudflare R2</button>
                  <button type="button" className="btn ghost sm" onClick={() => applyPreset("s3")}>AWS S3</button>
                  <button type="button" className="btn ghost sm" onClick={() => applyPreset("minio")}>MinIO</button>
                </div>
              )
            }
          >
            <div className="callout info sm" style={{ marginBottom: 10, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <span>{t("syncPage.guideHint")}</span>
              <S3GuideButton onClick={() => setGuideOpen(true)} />
            </div>
            {compact && (
              <div className="choice-row" style={{ marginBottom: 10 }}>
                <button type="button" className="choice" onClick={() => applyPreset("r2")}>R2</button>
                <button type="button" className="choice" onClick={() => applyPreset("s3")}>S3</button>
                <button type="button" className="choice" onClick={() => applyPreset("minio")}>MinIO</button>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <FieldLabel
                  name={t("syncPage.endpoint")}
                  tip={t("syncPage.endpointTip")}
                />
                <input
                  className="input mono"
                  placeholder="https://<account_id>.r2.cloudflarestorage.com"
                  value={s3Config.endpoint}
                  onChange={(e) => setS3Config({ ...s3Config, endpoint: e.target.value })}
                />
              </div>
              <div>
                <FieldLabel
                  name={t("syncPage.bucket")}
                  tip={t("syncPage.bucketTip")}
                />
                <input
                  className="input mono"
                  placeholder="my-git-vault-backup"
                  value={s3Config.bucket}
                  onChange={(e) => setS3Config({ ...s3Config, bucket: e.target.value })}
                />
              </div>
              <div>
                <FieldLabel
                  name={t("syncPage.region")}
                  tip={t("syncPage.regionTip")}
                />
                <input
                  className="input mono"
                  placeholder={t("syncPage.regionPh")}
                  value={s3Config.region}
                  onChange={(e) => setS3Config({ ...s3Config, region: e.target.value })}
                />
              </div>
              <div>
                <FieldLabel
                  name={t("syncPage.prefix")}
                  tip={t("syncPage.prefixTip")}
                />
                <input
                  className="input mono"
                  placeholder="gam-sync/"
                  value={s3Config.prefix}
                  onChange={(e) => setS3Config({ ...s3Config, prefix: e.target.value })}
                />
              </div>
              <div>
                <FieldLabel
                  name="Access Key ID"
                  tip={t("syncPage.akTip")}
                />
                <input
                  className="input mono"
                  placeholder="AKIA..."
                  value={s3Config.accessKeyId}
                  onChange={(e) => setS3Config({ ...s3Config, accessKeyId: e.target.value })}
                />
              </div>
              <div>
                <FieldLabel
                  name="Secret Access Key"
                  tip={t("syncPage.skTip")}
                />
                <div style={{ position: "relative" }}>
                  <input
                    type={showSecret ? "text" : "password"}
                    className="input mono"
                    placeholder="Secret Key"
                    value={s3Config.secretAccessKey}
                    onChange={(e) => setS3Config({ ...s3Config, secretAccessKey: e.target.value })}
                    style={{ paddingRight: 32 }}
                  />
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => setShowSecret(!showSecret)}
                    style={{ position: "absolute", right: 4, top: 4, padding: "2px 6px" }}
                  >
                    {showSecret ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                </div>
              </div>
            </div>

            {testResult && (
              <div
                style={{
                  padding: "7px 10px",
                  borderRadius: 6,
                  fontSize: 11.5,
                  marginBottom: 10,
                  background: testResult.ok ? "rgba(16, 185, 129, 0.1)" : "rgba(239, 68, 68, 0.1)",
                  color: testResult.ok ? "var(--green)" : "var(--red)",
                  border: "1px solid",
                  borderColor: testResult.ok ? "rgba(16, 185, 129, 0.3)" : "rgba(239, 68, 68, 0.3)",
                }}
              >
                {testResult.ok ? t("syncPage.okMsg", { message: testResult.msg }) : t("syncPage.failErr", { error: testResult.msg })}
              </div>
            )}

            {compact ? (
              <div className="m-s3-actions">
                <div className="m-s3-actions-main">
                  <button type="button" className="btn primary" onClick={saveConfig}>
                    {configSaved ? t("syncPage.savedCfg") : t("syncPage.saveCfg")}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={testing}
                    onClick={testConnection}
                  >
                    <Zap size={14} />
                    {testing ? t("syncPage.testing") : t("syncPage.testConn")}
                  </button>
                </div>
                <div className="m-s3-tools">
                  <button type="button" className="m-s3-tool" onClick={exportS3File}>
                    <Download size={16} />
                    <span>{t("syncPage.exportCfg")}</span>
                  </button>
                  <button type="button" className="m-s3-tool" onClick={importS3File}>
                    <Upload size={16} />
                    <span>{t("syncPage.importCfg")}</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2 items-center">
                <button type="button" className="btn primary sm" onClick={saveConfig}>
                  {configSaved ? t("syncPage.savedCfg") : t("syncPage.saveCfg")}
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={testing}
                  onClick={testConnection}
                  style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
                >
                  <Zap size={13} />
                  {testing ? t("syncPage.testing") : t("syncPage.testConn")}
                </button>
                <button type="button" className="btn ghost sm" onClick={exportS3File}>
                  <Download size={13} />
                  {t("syncPage.exportCfg")}
                </button>
                <button type="button" className="btn ghost sm" onClick={importS3File}>
                  <Upload size={13} />
                  {t("syncPage.importCfg")}
                </button>
                <button type="button" className="btn ghost sm" disabled={sharing} onClick={shareConfigQr}>
                  <QrCode size={13} />
                  {sharing ? t("syncPage.sharing") : t("syncPage.shareCfg")}
                </button>
              </div>
            )}
          </Card>

          {/* 板块 4: 云端历史快照 (下移一个板块至存储配置下方) */}
          <Card
            title={t("syncPage.snapsTitle")}
            actions={
              <button
                type="button"
                className="btn ghost sm"
                disabled={loadingSnaps || cloudStatus?.status === "unconfigured"}
                onClick={loadSnapshots}
                style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
              >
                <History size={12} />
                {loadingSnaps ? t("syncPage.reading") : t("syncPage.refreshSnaps")}
              </button>
            }
          >
            <div className="muted" style={{ fontSize: 11.5, marginBottom: 8 }}>
              {t("syncPage.snapsHint")}
            </div>
            {snapshots.length === 0 ? (
              <div className="muted sm">
                {loadingSnaps ? t("syncPage.readingSnaps") : t("syncPage.noSnaps")}
              </div>
            ) : compact ? (
              <div className="m-snapshot-list">
                {snapshots.map((s, i) => {
                  const day = new Date(s.createdAt).toLocaleDateString();
                  const prevDay = i > 0 ? new Date(snapshots[i - 1].createdAt).toLocaleDateString() : "";
                  const showDay = day !== prevDay;
                  const timeStr = new Date(s.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
                  const host = s.clientName ? s.clientName.replace(/^.*@/, "") : "";
                  return (
                    <div key={s.id}>
                      {showDay && <div className="m-snapshot-day">{day}</div>}
                      <div className="m-snapshot-row">
                        <div className="m-snapshot-main">
                          <div className="m-snapshot-time">
                            <span>{timeStr}</span>
                            {s.isRecent && <Badge kind="ok">{t("syncPage.recent")}</Badge>}
                            {s.isDailyFirst && !s.isRecent && <Badge kind="info">{t("syncPage.first")}</Badge>}
                          </div>
                          <div className="m-snapshot-meta">
                            {t("syncPage.snapMeta", {
                              identities: s.identityCount,
                              keys: s.keyCount,
                              repos: s.repoCount,
                            })}
                            {host ? ` · ${host}` : ""}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="m-snapshot-restore"
                          disabled={writesLocked || restoringId !== null}
                          onClick={() => askRestore(s)}
                        >
                          {restoringId === s.id ? t("syncPage.restoringNow") : t("syncPage.restore")}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="list">
                {snapshots.map((s, i) => {
                  const day = new Date(s.createdAt).toLocaleDateString();
                  const prevDay = i > 0 ? new Date(snapshots[i - 1].createdAt).toLocaleDateString() : "";
                  const showDay = day !== prevDay;
                  return (
                    <div className="list-row" key={s.id} style={{ flexDirection: "column", alignItems: "stretch", gap: 5 }}>
                      {showDay && (
                        <div className="muted sm" style={{ fontWeight: 600 }}>{day}</div>
                      )}
                      <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
                        <div className="grow">
                          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                            <span>{new Date(s.createdAt).toLocaleString()}</span>
                            {s.isDailyFirst && <Badge kind="info">{t("syncPage.dailyFirst")}</Badge>}
                            {s.isRecent && <Badge kind="ok">{t("syncPage.recent")}</Badge>}
                          </div>
                          <div className="muted sm" style={{ marginTop: 2 }}>
                            {t("syncPage.snapMetaLong", {
                              identities: s.identityCount,
                              keys: s.keyCount,
                              repos: s.repoCount,
                            })}
                            {s.clientName ? ` · ${s.clientName}` : ""}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="btn ghost sm"
                          disabled={writesLocked || restoringId !== null}
                          onClick={() => askRestore(s)}
                        >
                          {restoringId === s.id ? t("syncPage.restoringNow") : t("syncPage.restoreThis")}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          {/* 底部轻量安全提示 */}
          <div
            style={{
              padding: "9px 12px",
              borderRadius: "var(--radius)",
              background: "rgba(99, 102, 241, 0.05)",
              border: "1px solid rgba(99, 102, 241, 0.18)",
              fontSize: 11.5,
              lineHeight: 1.5,
              color: "var(--text-soft)",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <Shield size={15} style={{ color: "var(--accent)", flexShrink: 0 }} />
            <div>{t("syncPage.e2eeNote")}</div>
          </div>
          <S3SetupGuide
            open={guideOpen}
            initial={guideTab}
            onClose={() => setGuideOpen(false)}
            onApplyPreset={applyPreset}
          />
        </>
      )}

      {activeTab === "backup" && (
        <div className="stack-lg">
          {/* M6 本地离线加密导出 */}
          <Card title={t("syncPage.exportTitle")}>
            <p className="muted" style={{ fontSize: 11.5, marginBottom: 10 }}>
              {t("syncPage.exportHint")}
            </p>

            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="field-label">{t("syncPage.exportPw")}</label>
                <input
                  type="password"
                  className="input"
                  placeholder={t("syncPage.pwPh")}
                  value={exportPw}
                  onChange={(e) => setExportPw(e.target.value)}
                />
              </div>
              <div>
                <label className="field-label">{t("syncPage.exportPw2")}</label>
                <input
                  type="password"
                  className="input"
                  placeholder={t("syncPage.pw2Ph")}
                  value={exportPw2}
                  onChange={(e) => setExportPw2(e.target.value)}
                />
              </div>
            </div>

            {exportErr && (
              <div className="err-text mb-3">{t("syncPage.failErr", { error: exportErr })}</div>
            )}

            {exportResult && (
              <div
                style={{
                  padding: "7px 10px",
                  borderRadius: 6,
                  fontSize: 11.5,
                  marginBottom: 10,
                  background: "rgba(16, 185, 129, 0.1)",
                  color: "var(--green)",
                  border: "1px solid rgba(16, 185, 129, 0.3)",
                }}
              >
                {t("syncPage.exportOk", {
                  identities: exportResult.identityCount,
                  keys: exportResult.keyCount,
                  repos: exportResult.repoCount,
                })}
              </div>
            )}

            <button
              type="button"
              className="btn primary sm"
              disabled={exporting}
              onClick={handleExportBackup}
              style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
            >
              <Download size={13} />
              {exporting ? t("syncPage.exporting") : t("syncPage.exportBtn")}
            </button>
          </Card>

          {/* M6 本地离线备份导入 */}
          <Card title={t("syncPage.importTitle")}>
            <p className="muted" style={{ fontSize: 11.5, marginBottom: 10 }}>
              {t("syncPage.importHint")}
            </p>

            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="field-label">{t("syncPage.pickBackup")}</label>
                <div className="flex gap-2">
                  <input
                    className="input grow"
                    readOnly
                    placeholder={t("syncPage.noFile")}
                    value={importPath}
                  />
                  <button type="button" className="btn ghost sm" onClick={pickImportFile}>
                    {t("syncPage.browse")}
                  </button>
                </div>
              </div>
              <div>
                <label className="field-label">{t("syncPage.backupPw")}</label>
                <input
                  type="password"
                  className="input"
                  placeholder={t("syncPage.backupPwPh")}
                  value={importPw}
                  onChange={(e) => setImportPw(e.target.value)}
                />
              </div>
            </div>

            {importErr && (
              <div className="err-text mb-3">{t("syncPage.failErr", { error: importErr })}</div>
            )}

            {importSuccess && (
              <div
                style={{
                  padding: "7px 10px",
                  borderRadius: 6,
                  fontSize: 11.5,
                  marginBottom: 10,
                  background: "rgba(16, 185, 129, 0.1)",
                  color: "var(--green)",
                  border: "1px solid rgba(16, 185, 129, 0.3)",
                }}
              >
                {t("syncPage.importOk", {
                  identities: importSuccess.identityCount,
                  keys: importSuccess.keyCount,
                })}
              </div>
            )}

            {importSummary && (
              <div
                style={{
                  padding: "9px 12px",
                  borderRadius: 6,
                  fontSize: 11.5,
                  background: "rgba(99, 102, 241, 0.08)",
                  border: "1px solid rgba(99, 102, 241, 0.25)",
                  marginBottom: 10,
                }}
              >
                <div style={{ fontWeight: 600, color: "var(--accent)", marginBottom: 3 }}>
                  {t("syncPage.inspectOk")}
                </div>
                <div style={{ color: "var(--text)" }}>
                  {t("syncPage.inspectMeta", {
                    at: new Date(importSummary.createdAt).toLocaleString(),
                    identities: importSummary.identityCount,
                    keys: importSummary.keyCount,
                    repos: importSummary.repoCount,
                  })}
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <button
                type="button"
                className="btn ghost sm"
                disabled={inspecting || !importPath}
                onClick={handleInspectBackup}
                style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
              >
                <Eye size={13} />
                {inspecting ? t("syncPage.inspecting") : t("syncPage.inspectBtn")}
              </button>
              {importSummary && (
                <button
                  type="button"
                  className="btn primary sm"
                  disabled={importing}
                  onClick={handleConfirmImport}
                  style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
                >
                  <Upload size={13} />
                  {importing ? t("syncPage.importing") : t("syncPage.importBtn")}
                </button>
              )}
            </div>
          </Card>
        </div>
      )}

      {shareQr && (
        <div className="wizard-overlay" onClick={() => setShareQr(null)}>
          <div className="card dialog-card" style={{ width: 360 }} onClick={(e) => e.stopPropagation()}>
            <div className="card-head">
              <div className="card-title">{t("syncPage.shareTitle")}</div>
            </div>
            <div className="card-body stack" style={{ alignItems: "center", textAlign: "center" }}>
              <img
                alt={t("syncPage.qrAlt")}
                src={`data:image/png;base64,${shareQr}`}
                style={{ width: 240, height: 240 }}
              />
              <div className="muted sm">
                {t("syncPage.shareNote")}
              </div>
            </div>
            <div className="card-foot">
              <span />
              <button type="button" className="btn sm" onClick={() => setShareQr(null)}>
                {t("common.close")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
