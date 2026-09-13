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
  type CloudSnapshot,
} from "../lib/ipc";
import { PageHead, Card, Badge, FieldLabel, ConfirmDialog, ErrorDialog } from "../ui/common";
import { S3SetupGuide, S3GuideButton, type S3GuideProvider } from "../ui/S3SetupGuide";
import { encodeS3ConfigPayload, importS3ConfigFromPicker } from "../lib/s3ConfigPick";
import { firstS3ConfigJson, scanQrWithCamera } from "../lib/qrCapture";
import { useApp } from "../store";

const AUTO_PRESETS: { label: string; minutes: number }[] = [
  { label: "关闭", minutes: 0 },
  { label: "15 分钟", minutes: 15 },
  { label: "30 分钟 (推荐)", minutes: 30 },
  { label: "1 小时", minutes: 60 },
  { label: "2 小时", minutes: 120 },
];

export function SyncView({ variant }: { variant: "desktop" | "mobile" }) {
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
    listen<{ ok: boolean; message: string; syncedAt?: string }>("cloud-auto-sync", (ev) => {
      const p = ev.payload;
      setSyncNotice(`${p.ok ? "✅" : "❌"} ${p.message}`);
      void loadInitial();
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {
        /* 非 Tauri */
      });
    return () => {
      unlisten?.();
    };
  }, []);

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
      setErr("保存失败: " + errMessage(e));
    }
  }

  async function exportS3File() {
    try {
      const selected = await save({
        defaultPath: `gam-s3-${s3Config.bucket || "config"}.json`,
        filters: [{ name: "GAM S3/R2 配置", extensions: ["json"] }],
      });
      if (!selected) return;
      await api.exportS3Config(selected, s3Config);
      setSyncNotice("✅ 已导出 S3/R2 配置文件");
    } catch (e) {
      setSyncNotice(`❌ 导出配置失败: ${errMessage(e)}`);
    }
  }

  async function importS3File() {
    try {
      const cfg = await importS3ConfigFromPicker();
      if (!cfg) return;
      setS3Config(cfg);
      setSyncNotice("✅ 已导入 S3/R2 配置，请确认后保存");
    } catch (e) {
      setSyncNotice(`❌ 导入配置失败: ${errMessage(e)}`);
    }
  }

  function s3Filled(): boolean {
    return !!(s3Config.endpoint && s3Config.bucket && s3Config.accessKeyId && s3Config.secretAccessKey);
  }

  async function shareConfigQr() {
    if (!s3Filled()) {
      setShareQr(null);
      setSyncNotice("❌ 请先填写云存储配置，再分享二维码");
      return;
    }
    setSharing(true);
    setShareQr(null);
    setSyncNotice(null);
    try {
      const png = await api.renderQrPng(encodeS3ConfigPayload(s3Config));
      setShareQr(png);
      setSyncNotice("✅ 已生成配置二维码。只含云存储连接信息，不含恢复密钥；不会自动推送数据。");
    } catch (e) {
      setShareQr(null);
      setSyncNotice(`❌ 生成二维码失败：${errMessage(e)}`);
    } finally {
      setSharing(false);
    }
  }

  async function scanS3Qr() {
    setSyncNotice(null);
    try {
      const texts = await scanQrWithCamera({
        title: "扫描云存储配置二维码",
        hint: "对准其他设备【分享配置】生成的二维码",
      });
      if (!texts) return;
      const raw = firstS3ConfigJson(texts);
      if (!raw) {
        setSyncNotice("❌ 未识别到云存储配置二维码");
        return;
      }
      const cfg = await api.importS3ConfigText(raw);
      setS3Config(cfg);
      await api.saveCloudSyncConfig(cfg);
      setSyncNotice("✅ 已写入云存储配置。二维码不含恢复密钥；换机恢复仍需在初始化时输入恢复密钥。");
    } catch (e) {
      setSyncNotice(`❌ 扫码写入失败: ${errMessage(e)}`);
    }
  }

  // 测试云端连通性
  async function testConnection() {
    if (!s3Config.endpoint || !s3Config.bucket || !s3Config.accessKeyId || !s3Config.secretAccessKey) {
      setTestResult({ ok: false, msg: "请先填写完整的 Endpoint、Bucket、AK 与 SK" });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const ms = await api.testCloudSyncConfig(s3Config);
      setTestResult({ ok: true, msg: `连接正常，读写探测延迟 ${ms} ms` });
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
      setErr("请先填写并保存云存储配置");
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
      setSyncNotice(`✅ ${res.message}`);
      await refreshStatus();
      await loadSnapshots();
    } catch (e) {
      setSyncNotice(`❌ 推送失败: ${errMessage(e)}`);
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
      setSyncNotice(`✅ ${res.message}（${res.identityCount} 个身份，${res.keyCount} 把密钥）`);
      await refreshStatus();
    } catch (e) {
      setSyncNotice(`❌ 拉取失败: ${errMessage(e)}`);
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
      setSyncNotice(`✅ ${res.message}`);
      await refreshStatus();
    } catch (e) {
      setSyncNotice(`❌ 恢复失败: ${errMessage(e)}`);
    } finally {
      setRestoringId(null);
    }
  }

  // 触发离线备份导出
  async function handleExportBackup() {
    setExportErr(null);
    setExportResult(null);
    if (!exportPw || exportPw.length < 6) {
      setExportErr("备份加密密码不能少于 6 位");
      return;
    }
    if (exportPw !== exportPw2) {
      setExportErr("两次输入的备份密码不一致");
      return;
    }

    const defaultName = `gam-backup-${new Date().toISOString().slice(0, 10)}.gambackup`;
    const selected = await save({
      defaultPath: defaultName,
      filters: [{ name: "GAM 加密备份包", extensions: ["gambackup"] }],
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
      filters: [{ name: "GAM 加密备份包", extensions: ["gambackup"] }],
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
      setImportErr("请先选择备份文件");
      return;
    }
    if (!importPw) {
      setImportErr("请输入备份加密密码");
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
    if (!cloudStatus) return { text: "检测中", cls: "muted" };
    switch (cloudStatus.status) {
      case "synced":
        return { text: "已同步", cls: "ok" };
      case "local_ahead":
        return { text: "本地有待推送变更", cls: "warn" };
      case "remote_ahead":
        return { text: "云端有待拉取更新", cls: "info" };
      case "different_workspace":
        return { text: "与当前空间不一致", cls: "danger" };
      case "not_synced":
        return { text: "云端暂无备份", cls: "warn" };
      case "checking":
        return { text: writesLocked ? "启动同步中" : "等待下次同步", cls: "muted" };
      default:
        return { text: "未配置云存储", cls: "muted" };
    }
  })();

  return (
    <div className="stack-lg">
      <ErrorDialog message={err} onClose={() => setErr("")} />
      {pendingConfirm?.kind === "push" && (
        <ConfirmDialog
          title="确认推送到云端"
          message="将把当前本机工作空间加密后上传到云存储。"
          detail="云端已有内容会被这次快照覆盖为最新版本，其他设备下次拉取会收到本次数据。"
          confirmLabel="确认推送"
          busy={syncing === "push"}
          busyLabel="正在推送…"
          onCancel={() => setPendingConfirm(null)}
          onConfirm={() => void runPush()}
        />
      )}
      {pendingConfirm?.kind === "pull" && (
        <ConfirmDialog
          title="确认从云端拉取"
          message="将从云端读取最新加密数据，并合并到本机。"
          detail="本机现有身份、密钥与配置可能被云端版本覆盖，请确认这是你要同步的设备。"
          confirmLabel="确认拉取"
          busy={syncing === "pull"}
          busyLabel="正在拉取…"
          onCancel={() => setPendingConfirm(null)}
          onConfirm={() => void runPull()}
        />
      )}
      {pendingConfirm?.kind === "restore" && (
        <ConfirmDialog
          title="确认恢复历史快照"
          message={
            <>
              确定恢复到 <strong>{pendingConfirm.at}</strong> 的快照吗？
            </>
          }
          detail="将覆盖当前身份、密钥与配置，此操作不可撤销。"
          confirmLabel="恢复此版本"
          tone="danger"
          busy={restoringId !== null}
          busyLabel="正在恢复…"
          onCancel={() => setPendingConfirm(null)}
          onConfirm={() => void runRestore(pendingConfirm.id)}
        />
      )}
      <PageHead
        title="云端同步与备份"
        desc="启动时自动拉取并检查一次；之后按定时规则与本地编辑推送。进入本页不会重复探测云端。"
        actions={
          compact ? (
            <div className="m-seg">
              <button
                type="button"
                className={"m-seg-btn" + (activeTab === "cloud" ? " on" : "")}
                onClick={() => setActiveTab("cloud")}
              >
                <Cloud size={14} />
                云端
              </button>
              <button
                type="button"
                className={"m-seg-btn" + (activeTab === "backup" ? " on" : "")}
                onClick={() => setActiveTab("backup")}
              >
                <FileArchive size={14} />
                离线备份
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
                云端同步 (E2EE)
              </button>
              <button
                type="button"
                className={`btn sm ${activeTab === "backup" ? "primary" : "ghost"}`}
                onClick={() => setActiveTab("backup")}
              >
                <FileArchive size={13} style={{ marginRight: 4 }} />
                离线备份包
              </button>
            </div>
          )
        }
      />

      {activeTab === "cloud" && (
        <>
          {/* 板块 1: 云同步状态与快速操作 */}
          <Card
            title="云端同步状态"
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
                  刷新
                </button>
              </div>
            }
          >
            <div className="stat-card-row mb-3">
              <div className="stat-card">
                <div className="stat-card-title">本地资产</div>
                <div className="stat-card-body">
                  <div className="stat-card-val" style={{ fontSize: 18 }}>
                    {cloudStatus?.localIdentityCount ?? 0}
                  </div>
                  <div className="stat-card-sub">
                    {cloudStatus?.localKeyCount ?? 0} 密钥 · {cloudStatus?.localRepoCount ?? 0} 仓库
                  </div>
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-card-title">云端状态</div>
                <div className="stat-card-body">
                  <div
                    className="stat-card-val"
                    style={{
                      fontSize: 16,
                      color: cloudStatus?.remoteExists ? "var(--green)" : "var(--text-soft)",
                    }}
                  >
                    {cloudStatus?.status === "checking" || (loadingStatus && !cloudStatus?.remoteExists)
                      ? "检测中…"
                      : cloudStatus?.remoteExists
                        ? "已就绪"
                        : "待初次推送"}
                  </div>
                  <div className="stat-card-sub">
                    {cloudStatus?.status === "checking"
                      ? "正在读取云端清单"
                      : cloudStatus?.headerReady
                        ? "换机恢复头部正常"
                        : "无云端快照"}
                  </div>
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-card-title">最近同步</div>
                <div className="stat-card-body">
                  <div className="stat-card-val" style={{ fontSize: 13, lineHeight: 1.4 }}>
                    {cloudStatus?.remoteUpdatedAt ? new Date(cloudStatus.remoteUpdatedAt).toLocaleTimeString() : "—"}
                  </div>
                  <div className="stat-card-sub">
                    {cloudStatus?.remoteUpdatedAt ? new Date(cloudStatus.remoteUpdatedAt).toLocaleDateString() : "尚未同步"}
                  </div>
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-card-title">安全算法</div>
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
                以上为最近一次启动或自动同步的结果。需要立刻核对云端时再点「刷新」。数据出机前全量加密。
              </div>
              <div className="sync-action-btns">
                <button
                  type="button"
                  className="btn primary"
                  disabled={writesLocked || syncing !== null || cloudStatus?.status === "unconfigured"}
                  onClick={handlePush}
                >
                  <CloudUpload size={14} />
                  {syncing === "push" ? "正在加密推送…" : "推送到云端 (Push)"}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={syncing !== null || cloudStatus?.status === "unconfigured" || !cloudStatus?.remoteExists}
                  onClick={handlePull}
                >
                  <CloudDownload size={14} />
                  {syncing === "pull" ? "正在同步…" : "从云端拉取 (Pull)"}
                </button>
              </div>
            </div>
          </Card>

          {/* 板块 2: 精简后的定时同步 */}
          <Card
            title="定时自动同步"
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
                    setSyncNotice(res ? `✅ ${res.message}` : "当前已是最新状态");
                    await refreshStatus();
                    await loadSnapshots();
                  } catch (e) {
                    setSyncNotice(`❌ ${errMessage(e)}`);
                  } finally {
                    setSyncing(null);
                  }
                }}
                style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
              >
                <RefreshCw size={12} className={syncing === "pull" ? "animate-spin" : ""} />
                立即同步一次
              </button>
            }
          >
            <div className="stack">
              <div className="between" style={{ flexWrap: "wrap", gap: 8 }}>
                <div>
                  <div style={{ fontSize: 11.5, fontWeight: 600 }}>同步周期</div>
                  <div className="muted" style={{ fontSize: 11, marginTop: 1 }}>
                    启动时自动拉取并检查一次。之后按周期先拉后推；编辑身份或密钥后会立即推送。
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
                              prev ? { ...prev, minutes } : { minutes, defaultMinutes: 30, lastAutoSyncAt: null, lastAutoSyncMessage: null },
                            );
                          } catch (e) {
                            setSyncNotice(`❌ ${errMessage(e)}`);
                          } finally {
                            setSavingAuto(false);
                          }
                        }}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              {autoSync?.lastAutoSyncAt && (
                <div className="muted sm" style={{ borderTop: "1px dashed var(--border)", paddingTop: 5, marginTop: 2 }}>
                  最近自动同步：{new Date(autoSync.lastAutoSyncAt).toLocaleString()}
                  {autoSync.lastAutoSyncMessage ? ` · ${autoSync.lastAutoSyncMessage}` : ""}
                </div>
              )}
            </div>
          </Card>

          {/* 板块 3: S3 / Cloudflare R2 存储配置 (上移到历史快照之前) */}
          <Card
            title="S3 / Cloudflare R2 存储配置"
            actions={
              compact ? undefined : (
                <div className="flex gap-1">
                  <span className="muted" style={{ fontSize: 11, alignSelf: "center", marginRight: 4 }}>快速预设:</span>
                  <button type="button" className="btn ghost sm" onClick={() => applyPreset("r2")}>Cloudflare R2</button>
                  <button type="button" className="btn ghost sm" onClick={() => applyPreset("s3")}>AWS S3</button>
                  <button type="button" className="btn ghost sm" onClick={() => applyPreset("minio")}>MinIO</button>
                </div>
              )
            }
          >
            <div className="callout info sm" style={{ marginBottom: 10, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <span>还没有云存储账号？按「小白引导」一步步建桶、拿两把钥匙，再填回本页。新手推荐 Cloudflare R2。</span>
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
                  name="存储端点 (Endpoint)"
                  tip="云厂商给你的 S3 接口地址，必须带 https:// 或 http://。R2 形如 https://账户ID.r2.cloudflarestorage.com；AWS 形如 https://s3.ap-southeast-1.amazonaws.com。不要填控制台网页地址。"
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
                  name="存储桶名称 (Bucket)"
                  tip="就是你在云控制台创建的那个储物柜名字，必须完全一致。只能用小写字母、数字和连字符。不要把桶设成公开。"
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
                  name="区域 (Region)"
                  tip="R2 填 auto。AWS 必须和创建桶时选的区域一致，例如 ap-southeast-1。MinIO 一般填 us-east-1。"
                />
                <input
                  className="input mono"
                  placeholder="auto 或 us-east-1"
                  value={s3Config.region}
                  onChange={(e) => setS3Config({ ...s3Config, region: e.target.value })}
                />
              </div>
              <div>
                <FieldLabel
                  name="路径前缀 (Prefix)"
                  tip="桶里面的文件夹名，用来和其他文件分开。默认 gam-sync/ 即可。换电脑恢复时必须和旧设备填得一模一样。"
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
                  tip="云厂商发给你的访问钥匙，不是登录邮箱。R2 在「管理 API 令牌」创建后可见；AWS 在 IAM 用户的访问密钥里，多半以 AKIA 开头。"
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
                  tip="和 Access Key 成对的密码。创建时只显示一次，关掉页面就再也看不到，请先复制保存。不要发到聊天或邮件。"
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
                {testResult.ok ? `✅ ${testResult.msg}` : `❌ ${testResult.msg}`}
              </div>
            )}

            <div className={compact ? "m-s3-actions" : "flex gap-2 items-center"}>
              <button
                type="button"
                className="btn primary sm"
                onClick={saveConfig}
              >
                {configSaved ? "已保存配置 ✓" : "保存配置"}
              </button>
              <button
                type="button"
                className="btn ghost sm"
                disabled={testing}
                onClick={testConnection}
                style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
              >
                <Zap size={13} />
                {testing ? "正在测试…" : "测试连通性"}
              </button>
              <button type="button" className="btn ghost sm" onClick={exportS3File}>
                <Download size={13} />
                导出配置
              </button>
              <button type="button" className="btn ghost sm" onClick={importS3File}>
                <Upload size={13} />
                导入配置
              </button>
              {!compact && (
                <button type="button" className="btn ghost sm" disabled={sharing} onClick={shareConfigQr}>
                  <QrCode size={13} />
                  {sharing ? "正在生成…" : "分享配置"}
                </button>
              )}
              {compact && (
                <button type="button" className="btn ghost sm" onClick={scanS3Qr}>
                  <Camera size={13} />
                  扫码导入
                </button>
              )}
            </div>
          </Card>

          {/* 板块 4: 云端历史快照 (下移一个板块至存储配置下方) */}
          <Card
            title="云端历史快照"
            actions={
              <button
                type="button"
                className="btn ghost sm"
                disabled={loadingSnaps || cloudStatus?.status === "unconfigured"}
                onClick={loadSnapshots}
                style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
              >
                <History size={12} />
                {loadingSnaps ? "读取中…" : "刷新快照"}
              </button>
            }
          >
            <div className="muted" style={{ fontSize: 11.5, marginBottom: 8 }}>
              自动保留最近 10 份快照与近 14 天每日版本，支持一键按需回滚。
            </div>
            {snapshots.length === 0 ? (
              <div className="muted sm">
                {loadingSnaps ? "正在读取云端快照…" : "暂无历史快照，完成初次推送后将在此显示。"}
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
                            {s.isRecent && <Badge kind="ok">最近</Badge>}
                            {s.isDailyFirst && !s.isRecent && <Badge kind="info">首份</Badge>}
                          </div>
                          <div className="m-snapshot-meta">
                            {s.identityCount}身份 · {s.keyCount}密钥 · {s.repoCount}仓库
                            {host ? ` · ${host}` : ""}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="m-snapshot-restore"
                          disabled={writesLocked || restoringId !== null}
                          onClick={() => askRestore(s)}
                        >
                          {restoringId === s.id ? "…" : "恢复"}
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
                            {s.isDailyFirst && <Badge kind="info">当日首份</Badge>}
                            {s.isRecent && <Badge kind="ok">最近</Badge>}
                          </div>
                          <div className="muted sm" style={{ marginTop: 2 }}>
                            {s.identityCount} 个身份 · {s.keyCount} 把密钥 · {s.repoCount} 个仓库
                            {s.clientName ? ` · ${s.clientName}` : ""}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="btn ghost sm"
                          disabled={writesLocked || restoringId !== null}
                          onClick={() => askRestore(s)}
                        >
                          {restoringId === s.id ? "恢复中…" : "恢复此版本"}
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
            <div>
              <strong>零知识端到端加密：</strong>所有资产均在本地通过 XChaCha20-Poly1305 加密后上传，云端文件名经 HMAC 散列混淆，服务商及任何第三方均无法解密。
            </div>
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
          <Card title="导出离线加密备份 (.gambackup)">
            <p className="muted" style={{ fontSize: 11.5, marginBottom: 10 }}>
              将工作空间身份、密钥与仓库私钥打包为单一离线加密文件，适合本地冷备份或换机导入。
            </p>

            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="field-label">设置备份加密密码 (至少 6 位)</label>
                <input
                  type="password"
                  className="input"
                  placeholder="输入密码"
                  value={exportPw}
                  onChange={(e) => setExportPw(e.target.value)}
                />
              </div>
              <div>
                <label className="field-label">再次确认密码</label>
                <input
                  type="password"
                  className="input"
                  placeholder="重复输入密码"
                  value={exportPw2}
                  onChange={(e) => setExportPw2(e.target.value)}
                />
              </div>
            </div>

            {exportErr && (
              <div className="err-text mb-3">❌ {exportErr}</div>
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
                ✅ 备份导出成功：包含 {exportResult.identityCount} 个身份，{exportResult.keyCount} 把密钥，{exportResult.repoCount} 个仓库。
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
              {exporting ? "正在打包并加密…" : "导出离线备份"}
            </button>
          </Card>

          {/* M6 本地离线备份导入 */}
          <Card title="导入与还原离线备份">
            <p className="muted" style={{ fontSize: 11.5, marginBottom: 10 }}>
              从已导出的 <code>.gambackup</code> 文件中恢复数据，可先解密预览清单后再确认合并。
            </p>

            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="field-label">选择备份文件 (.gambackup)</label>
                <div className="flex gap-2">
                  <input
                    className="input grow"
                    readOnly
                    placeholder="未选择备份文件"
                    value={importPath}
                  />
                  <button type="button" className="btn ghost sm" onClick={pickImportFile}>
                    浏览…
                  </button>
                </div>
              </div>
              <div>
                <label className="field-label">备份加密密码</label>
                <input
                  type="password"
                  className="input"
                  placeholder="输入导出时的密码"
                  value={importPw}
                  onChange={(e) => setImportPw(e.target.value)}
                />
              </div>
            </div>

            {importErr && (
              <div className="err-text mb-3">❌ {importErr}</div>
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
                ✅ 备份导入成功：当前工作空间已合并更新（{importSuccess.identityCount} 个身份，{importSuccess.keyCount} 把密钥）。
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
                  📦 备份包解密成功，资产清单：
                </div>
                <div style={{ color: "var(--text)" }}>
                  • 备份时间：{new Date(importSummary.createdAt).toLocaleString()} · 身份：<b>{importSummary.identityCount}</b> 个 · 密钥：<b>{importSummary.keyCount}</b> 把 · 仓库：<b>{importSummary.repoCount}</b> 个
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
                {inspecting ? "正在验证解密…" : "解密并预览"}
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
                  {importing ? "正在导入合并…" : "确认合并到当前空间"}
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
              <div className="card-title">分享云配置</div>
            </div>
            <div className="card-body stack" style={{ alignItems: "center", textAlign: "center" }}>
              <img
                alt="云存储配置二维码"
                src={`data:image/png;base64,${shareQr}`}
                style={{ width: 240, height: 240 }}
              />
              <div className="muted sm">
                二维码只含云存储连接信息，不含恢复密钥，也不会推送数据。需要手机拉到最新保险库时，请先自行推送到云端。换机恢复仍需输入恢复密钥。
              </div>
            </div>
            <div className="card-foot">
              <span />
              <button type="button" className="btn sm" onClick={() => setShareQr(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
