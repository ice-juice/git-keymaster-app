import { useState } from "react";
import {
  Camera,
  Cloud,
  Eye,
  EyeOff,
  FolderPlus,
  Moon,
  Palette,
  Sun,
  ClipboardPaste,
  Image as ImageIcon,
  BookOpen,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  AlertCircle,
  Copy,
} from "lucide-react";
import { useInitModel } from "../shared/hooks/useInitModel";
import { PasswordFields, RestoreScope } from "./Init.shared";
import { useTranslation } from "react-i18next";
import { AppLogo } from "../ui/AppLogo";
import { useAppName } from "../lib/config";
import { S3SetupGuide } from "../ui/S3SetupGuide";
import { writeClipboard } from "../lib/clipboard";
import { can } from "../platform/capabilities";

export function InitMobile() {
  const { t } = useTranslation();
  const APP_NAME = useAppName();
  const m = useInitModel("mobile");
  const [manualOpen, setManualOpen] = useState(false);
  const [activePreset, setActivePreset] = useState<"r2" | "s3" | "minio" | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  function handlePreset(p: "r2" | "s3" | "minio") {
    setActivePreset(p);
    m.applyGuidePreset(p);
  }

  async function handleCopyRecovery() {
    await writeClipboard(m.recovery, true);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2000);
  }

  // 计算当前向导标题
  const topTitle = !m.mode
    ? t("init.pageStart")
    : m.mode === "restore"
      ? t("init.pageRestore")
      : t("init.mobileCreate");

  return (
    <div className="m-init-shell" aria-busy={m.transition ? true : undefined}>
      {/* 顶部精简导航栏 */}
      <header className="m-init-topbar">
        <AppLogo size={24} />
        <div className="m-init-topbar-copy">
          <div className="m-init-topbar-brand">{APP_NAME}</div>
          <div className="m-init-topbar-title">{topTitle}</div>
        </div>
        <button
          type="button"
          className="m-icon-btn"
          aria-label={t("theme.toggle")}
          onClick={m.toggleTheme}
        >
          {m.theme === "light" ? <Sun size={18} /> : m.theme === "dark" ? <Moon size={18} /> : <Palette size={18} />}
        </button>
      </header>

      {/* 现代分段步骤条 */}
      {m.mode && (
        <div className="m-init-progress">
          <div className="m-init-progress-header">
            <span className="m-init-progress-stepname">
              {m.title}
            </span>
            <span className="m-init-progress-count">
              {m.step} / {m.steps.length}
            </span>
          </div>
          <div className="m-init-progress-bar">
            {m.steps.map((_, i) => {
              const currentStep = i + 1;
              const isDone = currentStep < m.step;
              const isOn = currentStep === m.step;
              return (
                <div
                  key={i}
                  className={
                    "m-init-progress-segment" +
                    (isDone ? " done" : "") +
                    (isOn ? " on" : "")
                  }
                  onClick={() => isDone && m.jumpTo(currentStep)}
                  style={{ cursor: isDone ? "pointer" : "default" }}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* 内容滚动区域 */}
      <main className="m-init-body">
        {/* 全局错误提示 */}
        {m.err && (
          <div className="callout danger sm" style={{ marginBottom: 2 }}>
            <AlertCircle size={15} style={{ flexShrink: 0 }} />
            <span>{m.err}</span>
          </div>
        )}

        {/* 模式选择阶段 */}
        {!m.mode && (
          <div className="stack" style={{ gap: 12, paddingTop: 10 }}>
            <div style={{ padding: "0 4px 6px" }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)" }}>{t("init.welcome", { name: APP_NAME })}</div>
              <div className="muted" style={{ fontSize: 13, marginTop: 4, lineHeight: 1.5 }}>
                {t("init.welcomeDesc")}
              </div>
            </div>

            <button
              type="button"
              className="mode-pick"
              onClick={() => m.chooseMode("restore")}
              style={{ padding: "16px 14px", border: "1.5px solid var(--accent)", background: "var(--accent-soft)" }}
            >
              <Cloud size={24} style={{ color: "var(--accent)", flexShrink: 0 }} />
              <div style={{ textAlign: "left", flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <strong style={{ fontSize: 15, color: "var(--text)" }}>{t("init.restoreTitle")}</strong>
                  <span className="badge sm" style={{ background: "var(--accent)", color: "#fff" }}>{t("init.recommended")}</span>
                </div>
                <small style={{ fontSize: 12.5, color: "var(--text-soft)", marginTop: 4, display: "block" }}>
                  {t("init.restoreDescMobilePick")}
                </small>
              </div>
            </button>

            <button
              type="button"
              className="mode-pick"
              onClick={() => m.chooseMode("create")}
              style={{ padding: "16px 14px" }}
            >
              <FolderPlus size={24} style={{ color: "var(--text-mute)", flexShrink: 0 }} />
              <div style={{ textAlign: "left", flex: 1 }}>
                <strong style={{ fontSize: 15, color: "var(--text)" }}>{t("init.createTitle")}</strong>
                <small style={{ fontSize: 12.5, color: "var(--text-soft)", marginTop: 4, display: "block" }}>
                  {t("init.createDescMobile")}
                </small>
              </div>
            </button>
          </div>
        )}

        {/* 云端恢复 Step 1：填写云存储连接 */}
        {m.mode === "restore" && m.step === 1 && (
          <div className="stack" style={{ gap: 12 }}>
            {/* 顶栏说明 */}
            <div className="callout info sm">
              {t("init.restoreCloudHintMobile")}
            </div>

            {/* 推荐大卡片：扫码或从相册识别。相册入口不因实时相机能力关闭而整卡隐藏。 */}
            <div className="m-init-qr-card">
              <div className="m-init-qr-badge">{t("init.mobileQrBadge")}</div>
              <div className="m-init-qr-title">{t("init.mobileQrTitle")}</div>
              <div className="m-init-qr-desc">
                {t("init.mobileQrDesc")}
              </div>

              <div className="m-init-qr-actions">
                {can("cameraQrScan") && (
                  <button
                    type="button"
                    className="btn primary m-init-qr-btn"
                    disabled={m.busy}
                    onClick={m.scanS3Qr}
                  >
                    <Camera size={18} />
                    <span>{m.busy ? t("init.scanningQr") : t("init.scanComputerQr")}</span>
                  </button>
                )}
                <button
                  type="button"
                  className={"btn m-init-qr-btn" + (can("cameraQrScan") ? " ghost" : " primary")}
                  disabled={m.busy}
                  onClick={m.importS3QrFromGallery}
                >
                  <ImageIcon size={18} />
                  <span>{m.busy ? t("init.scanningGalleryQr") : t("init.scanGalleryQr")}</span>
                </button>
              </div>

              {m.s3Ready() && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--green)", fontWeight: 600, marginTop: 2 }}>
                  <CheckCircle2 size={14} />
                  <span>{t("init.s3Filled", { bucket: m.s3.bucket })}</span>
                </div>
              )}
            </div>

            {/* 手动填写与预设配置卡片 */}
            <div className="m-init-card">
              <div
                className="m-init-card-head"
                onClick={() => setManualOpen((v) => !v)}
              >
                <span className="m-init-card-title">
                  {manualOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                  <span>{t("init.manualParams")}</span>
                </span>
                <span className="badge sm muted">
                  {m.s3Ready() ? t("init.configured") : t("init.backup")}
                </span>
              </div>

              {(manualOpen || !m.s3Ready()) && (
                <div className="stack" style={{ gap: 12, paddingTop: 4 }}>
                  {/* 快速预设胶囊栏 */}
                  <div>
                    <div style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text-mute)", marginBottom: 6 }}>
                      {t("init.quickProviders")}
                    </div>
                    <div className="m-preset-chips">
                      <button
                        type="button"
                        className={"m-preset-chip" + (activePreset === "r2" ? " active" : "")}
                        onClick={() => handlePreset("r2")}
                      >
                        Cloudflare R2
                      </button>
                      <button
                        type="button"
                        className={"m-preset-chip" + (activePreset === "s3" ? " active" : "")}
                        onClick={() => handlePreset("s3")}
                      >
                        AWS S3
                      </button>
                      <button
                        type="button"
                        className={"m-preset-chip" + (activePreset === "minio" ? " active" : "")}
                        onClick={() => handlePreset("minio")}
                      >
                        MinIO
                      </button>
                      <button
                        type="button"
                        className="m-preset-chip"
                        onClick={() => m.setGuideOpen(true)}
                        style={{ color: "var(--accent)" }}
                      >
                        <BookOpen size={13} />
                        <span>{t("init.guide")}</span>
                      </button>
                    </div>
                  </div>

                  {/* 存储字段排布 */}
                  <div className="field">
                    <label className="field-label">{t("init.endpointFull")}</label>
                    <input
                      className="input"
                      placeholder="https://<account_id>.r2.cloudflarestorage.com"
                      value={m.s3.endpoint}
                      onChange={(e) => m.setS3({ ...m.s3, endpoint: e.target.value })}
                    />
                  </div>

                  <div className="field">
                    <label className="field-label">{t("init.bucketFull")}</label>
                    <input
                      className="input"
                      placeholder="my-git-vault-backup"
                      value={m.s3.bucket}
                      onChange={(e) => m.setS3({ ...m.s3, bucket: e.target.value })}
                    />
                  </div>

                  <div className="m-grid-2">
                    <div className="field">
                      <label className="field-label">{t("init.regionFull")}</label>
                      <input
                        className="input"
                        placeholder={t("init.regionPh")}
                        value={m.s3.region}
                        onChange={(e) => m.setS3({ ...m.s3, region: e.target.value })}
                      />
                    </div>
                    <div className="field">
                      <label className="field-label">{t("init.prefixFull")}</label>
                      <input
                        className="input"
                        placeholder="gam-sync/"
                        value={m.s3.prefix}
                        onChange={(e) => m.setS3({ ...m.s3, prefix: e.target.value })}
                      />
                    </div>
                  </div>

                  <div className="field">
                    <label className="field-label">Access Key ID</label>
                    <input
                      className="input"
                      placeholder="AKIA... / R2 Access Key"
                      value={m.s3.accessKeyId}
                      onChange={(e) => m.setS3({ ...m.s3, accessKeyId: e.target.value })}
                    />
                  </div>

                  <div className="field">
                    <label className="field-label">Secret Access Key</label>
                    <div style={{ position: "relative" }}>
                      <input
                        type={m.showSecret ? "text" : "password"}
                        className="input"
                        placeholder="Secret Access Key"
                        value={m.s3.secretAccessKey}
                        onChange={(e) => m.setS3({ ...m.s3, secretAccessKey: e.target.value })}
                        style={{ paddingRight: 36 }}
                      />
                      <button
                        type="button"
                        className="btn ghost sm"
                        onClick={() => m.setShowSecret((v) => !v)}
                        style={{ position: "absolute", right: 4, top: 4, padding: "4px 8px" }}
                        aria-label={t("init.toggleSecret")}
                      >
                        {m.showSecret ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                  </div>

                  {/* 测试结果 */}
                  {m.testResult && (
                    <div className={m.testResult.ok ? "callout good sm" : "callout danger sm"}>
                      {m.testResult.ok ? `✅ ${m.testResult.msg}` : `❌ ${m.testResult.msg}`}
                    </div>
                  )}

                  {/* 辅助操作栏 */}
                  <div className="m-actions-row">
                    <button
                      type="button"
                      className="btn ghost sm"
                      disabled={m.busy}
                      onClick={m.importS3File}
                    >
                      {t("init.importFile")}
                    </button>
                    <button
                      type="button"
                      className="btn ghost sm"
                      disabled={m.busy}
                      onClick={m.testS3}
                    >
                      {m.busy ? t("init.testing") : t("init.testConn")}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 云端恢复 Step 2：输入旧设备恢复密钥 */}
        {m.mode === "restore" && m.step === 2 && (
          <div className="stack" style={{ gap: 12 }}>
            <div className="callout warn sm">
              {t("init.restoreKeyWarnMobile")}
            </div>

            <div className="m-init-card">
              <div className="m-input-header-action">
                <label className="field-label" style={{ margin: 0 }}>{t("init.titles.oldRecovery")}</label>
                <button
                  type="button"
                  className="m-paste-btn"
                  onClick={m.pasteRestoreKey}
                >
                  <ClipboardPaste size={13} />
                  <span>{t("init.pasteClipboard")}</span>
                </button>
              </div>

              <textarea
                className="input mono"
                placeholder={t("init.restoreKeyPh")}
                value={m.restoreKey}
                onChange={(e) => {
                  m.setRestoreKey(e.target.value);
                  m.setPreview(null);
                }}
                style={{ minHeight: 88, fontSize: 13, lineHeight: 1.5 }}
              />

              <button
                type="button"
                className="btn ghost sm"
                disabled={m.busy || !m.restoreKey.trim()}
                onClick={m.doPreview}
                style={{ alignSelf: "flex-start" }}
              >
                {m.busy ? t("init.verifyingDecrypt") : t("init.verifyPreview")}
              </button>
            </div>

            {/* 解密成功预览信息 */}
            {m.preview && m.preview.hasManifest && (
              <div className="stack" style={{ gap: 10 }}>
                <div className="callout good">
                  <strong>✓ {t("init.unlockedOk")}</strong>（{m.preview.workspaceId.slice(0, 8)}…）
                  <div style={{ marginTop: 4, fontSize: 12 }}>
                    {t("init.previewInclude", { identities: m.preview.identityCount, keys: m.preview.keyCount })}
                    {m.preview.updatedAt ? t("init.cloudUpdated", { when: new Date(m.preview.updatedAt).toLocaleDateString() }) : ""}
                  </div>
                </div>
                <RestoreScope
                  includeRepos={m.includeRepos}
                  setIncludeRepos={m.setIncludeRepos}
                  repoCount={m.preview.repoCount}
                />
              </div>
            )}
          </div>
        )}

        {/* 云端恢复 Step 3：设置本机访问密码 */}
        {m.mode === "restore" && m.step === 3 && (
          <div className="stack" style={{ gap: 12 }}>
            {m.preview && (
              <div className="callout info sm">
                {t("init.willRestoreMobile", { identities: m.preview.identityCount, keys: m.preview.keyCount })}
              </div>
            )}

            <div className="m-init-card">
              <div style={{ fontSize: 14, fontWeight: 650, color: "var(--text)", marginBottom: 4 }}>
                {t("init.titles.setLocalPassword")}
              </div>
              <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.45, marginBottom: 8 }}>
                {t("init.localPwHintMobile")}
              </div>

              <PasswordFields
                pw={m.pw}
                pw2={m.pw2}
                setPw={m.setPw}
                setPw2={m.setPw2}
                strength={m.strength}
                onEnter={m.doRestore}
              />
            </div>
          </div>
        )}

        {/* 云端恢复 Step 4：完成 */}
        {m.mode === "restore" && m.step === 4 && (
          <div className="stack" style={{ textAlign: "center", padding: "30px 10px", gap: 12 }}>
            <div style={{ fontSize: 44 }}>🎉</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text)" }}>{t("init.restoredTitleMobile")}</div>
            <div className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
              {m.restoreResult || t("init.restoredFallbackMobile")}
            </div>
            {m.preview && (
              <div className="badge good" style={{ alignSelf: "center", padding: "6px 14px", fontSize: 13 }}>
                {t("init.restoredBadge", { identities: m.preview.identityCount, keys: m.preview.keyCount })}
              </div>
            )}
            <div style={{ marginTop: 20 }}>
              <button
                type="button"
                className="btn primary"
                disabled={m.busy}
                onClick={() => m.enterApp()}
                style={{ width: "100%", minHeight: 46, fontSize: 15 }}
              >
                {t("init.enterApp")}
              </button>
            </div>
          </div>
        )}

        {/* 创建工作空间各步骤 */}
        {m.mode === "create" && m.step === 1 && (
          <div className="stack" style={{ gap: 12 }}>
            <div className="callout info sm">
              🔑 {t("init.createPwHintMobile")}
            </div>
            <div className="m-init-card">
              <PasswordFields
                pw={m.pw}
                pw2={m.pw2}
                setPw={m.setPw}
                setPw2={m.setPw2}
                strength={m.strength}
                onEnter={m.doInit}
              />
            </div>
          </div>
        )}

        {m.mode === "create" && m.step === 2 && (
          <div className="stack" style={{ gap: 12 }}>
            <div className="callout danger sm">
              ⚠️ {t("init.recoveryOnceMobile")}
            </div>
            <div className="m-init-card">
              <div className="reckey" style={{ fontSize: 12.5, wordBreak: "break-all", padding: "12px 10px" }}>
                {m.recovery}
              </div>
              <button
                type="button"
                className="btn primary sm"
                onClick={handleCopyRecovery}
                style={{ alignSelf: "center", minWidth: 140 }}
              >
                <Copy size={14} />
                <span>{copiedKey ? t("init.copiedClipboard") : t("init.copyRecovery")}</span>
              </button>
            </div>
          </div>
        )}

        {m.mode === "create" && m.step === 3 && (
          <div className="stack" style={{ gap: 12 }}>
            <div className="muted" style={{ fontSize: 13 }}>{t("init.pasteRecoveryShort")}</div>
            <div className="m-init-card">
              <div className="m-input-header-action">
                <label className="field-label" style={{ margin: 0 }}>{t("init.steps.recovery")}</label>
                <button
                  type="button"
                  className="m-paste-btn"
                  onClick={m.pasteConfirm}
                >
                  <ClipboardPaste size={13} />
                  <span>{t("init.pasteOnce")}</span>
                </button>
              </div>
              <textarea
                className="input mono"
                placeholder={t("init.recoveryPh")}
                value={m.confirm}
                onChange={(e) => m.setConfirm(e.target.value)}
                style={{ minHeight: 88, fontSize: 13, lineHeight: 1.5 }}
              />
            </div>
          </div>
        )}

        {m.mode === "create" && m.step === 4 && (
          <div className="stack" style={{ textAlign: "center", padding: "30px 10px", gap: 12 }}>
            <div style={{ fontSize: 44 }}>🎉</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text)" }}>{t("init.readyTitle")}</div>
            <div className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
              {t("init.readyDescMobile")}
            </div>
            <div style={{ marginTop: 20 }}>
              <button
                type="button"
                className="btn primary"
                disabled={m.busy}
                onClick={() => m.enterApp()}
                style={{ width: "100%", minHeight: 46, fontSize: 15 }}
              >
                {t("init.pageStart")}
              </button>
            </div>
          </div>
        )}
      </main>

      {/* 固定底部操作栏 */}
      {m.mode && m.step < 4 && (
        <footer className="m-init-foot">
          <button
            type="button"
            className="btn ghost sm"
            disabled={m.busy}
            onClick={m.goBack}
            style={{ minWidth: 80 }}
          >
            {m.step <= 1 ? t("common.back") : t("init.prev")}
          </button>

          <div style={{ flex: 1, display: "flex", justifyContent: "flex-end" }}>
            {m.mode === "create" && m.step === 1 && (
              <button
                type="button"
                className="btn primary"
                disabled={m.busy}
                onClick={m.doInit}
              >
                {m.busy ? t("init.creating") : t("common.next")}
              </button>
            )}

            {m.mode === "create" && m.step === 2 && (
              <button
                type="button"
                className="btn primary"
                onClick={() => m.setStep(3)}
              >
                {t("init.savedContinue")}
              </button>
            )}

            {m.mode === "create" && m.step === 3 && (
              <button
                type="button"
                className="btn primary"
                onClick={m.verifyConfirm}
              >
                {t("init.verifyFinish")}
              </button>
            )}

            {m.mode === "restore" && m.step === 1 && (
              <button
                type="button"
                className="btn primary"
                onClick={m.goRestoreCloud}
              >
                {t("common.next")}
              </button>
            )}

            {m.mode === "restore" && m.step === 2 && (
              <button
                type="button"
                className="btn primary"
                disabled={!m.preview?.hasManifest}
                onClick={() => {
                  m.resetErr();
                  m.setStep(3);
                }}
              >
                {t("init.confirmPreview")}
              </button>
            )}

            {m.mode === "restore" && m.step === 3 && (
              <button
                type="button"
                className="btn primary"
                disabled={m.busy}
                onClick={m.doRestore}
              >
                {m.busy ? t("init.restoring") : t("init.restoreLocal")}
              </button>
            )}
          </div>
        </footer>
      )}

      {m.transition && (
        <div className="m-init-transition" role="status" aria-live="polite">
          <div className="m-init-transition-card">
            <div className="m-init-transition-title">{m.transition}</div>
            <div className="m-init-transition-bar" aria-hidden="true">
              <span />
            </div>
            <div className="m-init-transition-hint">{t("init.transitionHint")}</div>
          </div>
        </div>
      )}

      {/* S3 小白引导弹窗 */}
      <S3SetupGuide
        open={m.guideOpen}
        initial={m.guideTab}
        onClose={() => m.setGuideOpen(false)}
        onApplyPreset={m.applyGuidePreset}
      />
    </div>
  );
}
