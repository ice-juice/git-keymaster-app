import { Camera, Cloud, Eye, EyeOff, FolderPlus, Moon, Palette, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";
import { writeClipboard } from "../lib/clipboard";
import { useAppName } from "../lib/config";
import { AppLogo } from "../ui/AppLogo";
import { S3SetupGuide, S3GuideButton } from "../ui/S3SetupGuide";
import { useInitModel } from "../shared/hooks/useInitModel";
import { can } from "../platform/capabilities";

export function InitView({ variant }: { variant: "desktop" | "mobile" }) {
  const { t } = useTranslation();
  const APP_NAME = useAppName();
  const m = useInitModel(variant);
  const {
    mode,
    step,
    path,
    warning,
    pw,
    pw2,
    recovery,
    confirm,
    createdPath,
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
    pickDir,
    checkPath,
    doInit,
    verifyConfirm,
    applyGuidePreset,
    testS3,
    importS3File,
    scanS3Qr,
    goRestoreCloud,
    doPreview,
    doRestore,
    goBack,
    jumpTo,
  } = m;

  return (
    <div className={"window" + (compact ? " init-wizard-mobile" : "")}>
      <div className="body">
        <aside className="sidebar" style={{ width: 176, flex: "0 0 176px", padding: "10px 8px" }}>
          {mode && (
            <div
              className="muted"
              style={{ padding: "6px 8px 10px", fontSize: 12, fontWeight: 600, color: "var(--sidebar-text)" }}
            >
              {mode === "restore" ? t("init.sidebarRestore") : t("init.sidebarCreate")}
            </div>
          )}
          {mode && (
            <>
              <div className="nav-group">{t("init.wizardSteps")}</div>
              <div className="stack" style={{ gap: 3 }}>
                {steps.map((s, i) => (
                  <div
                    key={s}
                    className={"nav-item" + (i === step ? " active" : "")}
                    style={{
                      cursor: i < step ? "pointer" : "default",
                      color: i === step ? "var(--accent)" : i < step ? "var(--text)" : "var(--text-soft)",
                      fontWeight: i === step ? 600 : 500,
                    }}
                    onClick={() => jumpTo(i)}
                  >
                    <span
                      className="ic"
                      style={{
                        fontSize: 10.5,
                        fontWeight: 700,
                        color: i < step ? "var(--green)" : i === step ? "var(--accent)" : "var(--text-mute)",
                      }}
                    >
                      {i < step ? "✓" : i + 1}
                    </span>
                    <span style={{ fontSize: 12 }}>{s}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="grow" />

          <div className="side-foot">
            <button
              type="button"
              className="nav-item"
              onClick={toggleTheme}
              title={t("theme.toggle")}
            >
              <span className="ic">
                {theme === "light" ? <Sun size={14} /> : theme === "dark" ? <Moon size={14} /> : <Palette size={14} />}
              </span>
              <span style={{ fontSize: 11.5, color: "var(--text-soft)" }}>
                {t("theme.skin", {
                  name: theme === "light" ? t("theme.light") : theme === "dark" ? t("theme.dark") : t("theme.navy"),
                })}
              </span>
            </button>
          </div>
        </aside>

        <main
          className={"main" + (compact ? " init-main-mobile" : "")}
          style={
            compact
              ? undefined
              : {
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "20px",
                  background: "var(--bg)",
                }
          }
        >
          {compact && (
            <header className="init-mobile-head">
              <AppLogo size={22} />
              <div className="init-mobile-copy">
                <div className="init-mobile-brand">{APP_NAME}</div>
                <div className="init-mobile-page">
                  {mode ? (mode === "restore" ? t("init.pageRestore") : t("init.pageCreate")) : t("init.pageStart")}
                </div>
              </div>
              <button
                type="button"
                className="m-icon-btn"
                aria-label={t("theme.toggle")}
                onClick={toggleTheme}
              >
                {theme === "light" ? <Sun size={18} /> : theme === "dark" ? <Moon size={18} /> : <Palette size={18} />}
              </button>
            </header>
          )}
          {compact && mode && (
            <ol className="init-stepper">
              {steps.map((s, i) => {
                const actual = compact ? i + 1 : i;
                return (
                  <li
                    key={s}
                    className={actual === step ? "on" : actual < step ? "done" : ""}
                    onClick={() => jumpTo(actual)}
                  >
                    <span className="n">{actual < step ? "✓" : i + 1}</span>
                    <span className="l">{s}</span>
                  </li>
                );
              })}
            </ol>
          )}
          <div
            className={"card" + (compact ? " init-card" : "")}
            style={{
              width: mode === "restore" ? 560 : 520,
              maxWidth: "100%",
              padding: "20px 22px",
              boxShadow: "var(--shadow-lg)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
              <div>
                <div className="title-lg" style={{ fontSize: 15, fontWeight: 700 }}>{title}</div>
                <div className="muted" style={{ marginTop: 4, lineHeight: 1.45 }}>{desc}</div>
              </div>
              {mode && (
                <span className="badge info" style={{ flexShrink: 0, marginLeft: 12 }}>
                  {(compact ? step : step + 1)} / {steps.length}
                </span>
              )}
            </div>

            <div>
              {!mode && (
                <div className="stack" style={{ gap: 10 }}>
                  <button type="button" className="mode-pick" onClick={() => chooseMode("create")}>
                    <FolderPlus size={18} />
                    <span>
                      <strong>{t("init.createTitle")}</strong>
                      <small>{t("init.createDesc")}</small>
                    </span>
                  </button>
                  <button type="button" className="mode-pick" onClick={() => chooseMode("restore")}>
                    <Cloud size={18} />
                    <span>
                      <strong>{t("init.restoreTitle")}</strong>
                      <small>{compact ? t("init.restoreDescMobile") : t("init.restoreDesc")}</small>
                    </span>
                  </button>
                </div>
              )}

              {mode && step === 0 && !compact && (
                <div className="stack" style={{ gap: 10 }}>
                  {mode === "create" && alreadyCreated && (
                    <div className="callout warn">
                      {t("init.alreadyCreated", { path: createdPath })}
                    </div>
                  )}
                  {mode === "restore" && (
                    <div className="callout info">{t("init.pickEmpty")}</div>
                  )}
                  <div className="field">
                    <label className="field-label">{t("init.wsDir")}</label>
                    <div className="path-pick">
                      <input
                        className="input mono"
                        placeholder={t("init.wsDirPh")}
                        value={path}
                        onChange={(e) => setPath(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && checkPath()}
                      />
                      <button type="button" className="btn" onClick={pickDir}>
                        {t("init.browse")}
                      </button>
                    </div>
                    <div className="hint">{t("init.pathHint")}</div>
                  </div>
                  {warning && <div className="callout warn">⚠️ {warning}</div>}
                </div>
              )}

              {mode === "create" && step === 1 && (
                <div className="stack" style={{ gap: 10 }}>
                  {warning && <div className="callout warn">⚠️ {warning}</div>}
                  {alreadyCreated && !switchingPath && (
                    <div className="callout info">
                      {t("init.createdKeepKey")}
                    </div>
                  )}
                  {switchingPath && (
                    <div className="callout warn">
                      ⚠️ {t("init.newDirWarn")}
                    </div>
                  )}
                  <PasswordFields pw={pw} pw2={pw2} setPw={setPw} setPw2={setPw2} strength={strength} onEnter={doInit} />
                  <div className="callout info">🔑 {t("init.passwordLocal")}</div>
                </div>
              )}

              {mode === "create" && step === 2 && (
                <div className="stack" style={{ gap: 10 }}>
                  <div className="callout danger">
                    ⚠️ {t("init.recoveryOnce")}
                  </div>
                  <div className="reckey">{recovery}</div>
                  <div className="row">
                    <button type="button" className="btn primary sm" onClick={() => writeClipboard(recovery, true)}>
                      {t("init.copyRecovery")}
                    </button>
                  </div>
                </div>
              )}

              {mode === "create" && step === 3 && (
                <div className="stack" style={{ gap: 10 }}>
                  <div className="muted">{t("init.pasteRecovery")}</div>
                  <textarea
                    className="input mono"
                    placeholder={t("init.recoveryPh")}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    style={{ minHeight: 76 }}
                  />
                </div>
              )}

              {mode === "create" && step === 4 && (
                <div className="stack" style={{ textAlign: "center", padding: "16px 0", gap: 6 }}>
                  <div style={{ fontSize: 36, marginBottom: 2 }}>🎉</div>
                  <div className="title-lg" style={{ fontSize: 16 }}>{t("init.readyTitle")}</div>
                  <div className="muted">{t("init.readyDesc")}</div>
                </div>
              )}

              {mode === "restore" && step === 1 && (
                <div className="stack" style={{ gap: 10 }}>
                  <div className="callout info sm">
                    {compact ? t("init.restoreCloudHintMobile") : t("init.restoreCloudHint")}
                  </div>
                  {compact && can("cameraQrScan") && (
                    <button type="button" className="btn primary" disabled={busy} onClick={scanS3Qr}>
                      <Camera size={16} />
                      {busy ? t("init.scanning") : t("init.scanComputerQr")}
                    </button>
                  )}
                  <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    <S3GuideButton onClick={() => setGuideOpen(true)} />
                    <span className="muted" style={{ fontSize: 11, alignSelf: "center" }}>{t("init.quickPreset")}</span>
                    <button type="button" className="btn ghost sm" onClick={() => { setGuideTab("r2"); setS3((p) => ({ ...p, endpoint: "https://<account_id>.r2.cloudflarestorage.com", region: "auto", prefix: p.prefix || "gam-sync/" })); }}>
                      Cloudflare R2
                    </button>
                    <button type="button" className="btn ghost sm" onClick={() => { setGuideTab("s3"); setS3((p) => ({ ...p, endpoint: "https://s3.us-east-1.amazonaws.com", region: "us-east-1", prefix: p.prefix || "gam-sync/" })); }}>
                      AWS S3
                    </button>
                    <button type="button" className="btn ghost sm" onClick={() => { setGuideTab("minio"); setS3((p) => ({ ...p, endpoint: "http://127.0.0.1:9000", region: "us-east-1", prefix: p.prefix || "gam-sync/" })); }}>
                      MinIO
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="field">
                      <label className="field-label">{t("init.endpoint")}</label>
                      <input className="input" placeholder="https://<account_id>.r2.cloudflarestorage.com" value={s3.endpoint} onChange={(e) => setS3({ ...s3, endpoint: e.target.value })} />
                    </div>
                    <div className="field">
                      <label className="field-label">{t("init.bucket")}</label>
                      <input className="input" placeholder="my-git-vault-backup" value={s3.bucket} onChange={(e) => setS3({ ...s3, bucket: e.target.value })} />
                    </div>
                    <div className="field">
                      <label className="field-label">{t("init.region")}</label>
                      <input className="input" placeholder={t("init.regionPh")} value={s3.region} onChange={(e) => setS3({ ...s3, region: e.target.value })} />
                    </div>
                    <div className="field">
                      <label className="field-label">{t("init.prefix")}</label>
                      <input className="input" placeholder="gam-sync/" value={s3.prefix} onChange={(e) => setS3({ ...s3, prefix: e.target.value })} />
                    </div>
                    <div className="field">
                      <label className="field-label">Access Key ID</label>
                      <input className="input" placeholder="AKIA..." value={s3.accessKeyId} onChange={(e) => setS3({ ...s3, accessKeyId: e.target.value })} />
                    </div>
                    <div className="field">
                      <label className="field-label">Secret Access Key</label>
                      <div style={{ position: "relative" }}>
                        <input
                          type={showSecret ? "text" : "password"}
                          className="input"
                          placeholder="Secret Key"
                          value={s3.secretAccessKey}
                          onChange={(e) => setS3({ ...s3, secretAccessKey: e.target.value })}
                          style={{ paddingRight: 32 }}
                        />
                        <button type="button" className="btn ghost sm" onClick={() => setShowSecret((v) => !v)} style={{ position: "absolute", right: 4, top: 4, padding: "2px 6px" }}>
                          {showSecret ? <EyeOff size={13} /> : <Eye size={13} />}
                        </button>
                      </div>
                    </div>
                  </div>
                  {testResult && (
                    <div className={testResult.ok ? "callout good" : "callout danger"}>
                      {testResult.ok ? `✅ ${testResult.msg}` : `❌ ${testResult.msg}`}
                    </div>
                  )}
                  <div className="row">
                    {compact && can("cameraQrScan") && (
                      <button type="button" className="btn ghost sm" disabled={busy} onClick={scanS3Qr}>
                        <Camera size={13} /> {t("init.scan")}
                      </button>
                    )}
                      <button type="button" className="btn ghost sm" disabled={busy} onClick={importS3File}>
                      {t("init.importFile")}
                    </button>
                    <button type="button" className="btn ghost sm" disabled={busy} onClick={testS3}>
                      {busy ? t("init.testing") : t("init.testConn")}
                    </button>
                  </div>
                </div>
              )}

              {mode === "restore" && step === 2 && (
                <div className="stack" style={{ gap: 10 }}>
                  <div className="callout warn">
                    {compact ? t("init.restoreKeyWarnMobile") : t("init.restoreKeyWarn")}
                  </div>
                  <textarea
                    className="input mono"
                    placeholder={t("init.restoreKeyPh")}
                    value={restoreKey}
                    onChange={(e) => {
                      setRestoreKey(e.target.value);
                      setPreview(null);
                    }}
                    style={{ minHeight: 76 }}
                  />
                  <div>
                    <button type="button" className="btn ghost sm" disabled={busy} onClick={doPreview}>
                      {busy ? t("init.verifying") : t("init.verifyPreview")}
                    </button>
                  </div>
                  {preview && preview.hasManifest && (
                    <div className="stack" style={{ gap: 10 }}>
                      <div className="callout good">
                        {t("init.unlockedWs", { id: preview.workspaceId.slice(0, 8) })}
                        {preview.updatedAt ? t("init.cloudUpdated", { when: new Date(preview.updatedAt).toLocaleString() }) : ""}
                        <br />
                        {t("init.previewCounts", { identities: preview.identityCount, keys: preview.keyCount })}
                        {preview.repoCount > 0 ? t("init.previewRepos", { count: preview.repoCount }) : ""}
                      </div>
                      <RestoreScope includeRepos={includeRepos} setIncludeRepos={setIncludeRepos} repoCount={preview.repoCount} />
                    </div>
                  )}
                </div>
              )}

              {mode === "restore" && step === 3 && (
                <div className="stack" style={{ gap: 10 }}>
                  {preview && (
                    <div className="stack" style={{ gap: 10 }}>
                      <div className="callout info">
                        {t("init.willRestore", { identities: preview.identityCount, keys: preview.keyCount, path })}
                        {includeRepos
                          ? t("init.willImportRepos", { count: preview.repoCount })
                          : t("init.noImportRepos")}
                      </div>
                      <RestoreScope includeRepos={includeRepos} setIncludeRepos={setIncludeRepos} repoCount={preview.repoCount} />
                    </div>
                  )}
                  <PasswordFields pw={pw} pw2={pw2} setPw={setPw} setPw2={setPw2} strength={strength} onEnter={doRestore} />
                  <div className="callout info">{t("init.localPwHint")}</div>
                </div>
              )}

              {mode === "restore" && step === 4 && (
                <div className="stack" style={{ textAlign: "center", padding: "16px 0", gap: 6 }}>
                  <div style={{ fontSize: 36, marginBottom: 2 }}>🎉</div>
                  <div className="title-lg" style={{ fontSize: 16 }}>{t("init.restoredTitle")}</div>
                  <div className="muted">{restoreResult || t("init.restoredFallback")}</div>
                  {preview && (
                    <div className="muted">
                      {t("init.restoredCounts", { identities: preview.identityCount, keys: preview.keyCount })}
                      {includeRepos ? t("init.restoredRepos", { count: preview.repoCount }) : t("init.restoredNoRepos")}
                    </div>
                  )}
                </div>
              )}

              {err && <div className="err-text" style={{ marginTop: 8 }}>{err}</div>}
            </div>

            <div
              className="between"
              style={{
                marginTop: 20,
                paddingTop: 12,
                borderTop: "1px solid var(--border)",
              }}
            >
              <button
                type="button"
                className="btn ghost sm"
                disabled={!mode || (mode === "create" && step >= 4) || (mode === "restore" && step >= 4)}
                onClick={goBack}
              >
                {mode && step === 0 ? t("common.back") : t("init.prev")}
              </button>

              <div>
                {mode && step === 0 && !compact && (
                  <button type="button" className="btn primary" onClick={checkPath}>
                    {t("common.next")}
                  </button>
                )}
                {mode === "create" && step === 1 && (
                  <button type="button" className="btn primary" disabled={busy} onClick={doInit}>
                    {busy
                      ? t("common.busy")
                      : switchingPath
                        ? t("init.createInNewDir")
                        : alreadyCreated
                          ? t("init.saveContinue")
                          : t("init.createWs")}
                  </button>
                )}
                {mode === "create" && step === 2 && (
                  <button type="button" className="btn primary" onClick={() => setStep(3)}>
                    {t("init.savedContinue")}
                  </button>
                )}
                {mode === "create" && step === 3 && (
                  <button type="button" className="btn primary" onClick={verifyConfirm}>
                    {t("init.verifyFinish")}
                  </button>
                )}
                {mode === "create" && step === 4 && (
                  <button type="button" className="btn primary" onClick={() => refresh()}>
                    {t("init.enterApp")}
                  </button>
                )}
                {mode === "restore" && step === 1 && (
                  <button type="button" className="btn primary" onClick={goRestoreCloud}>
                    {t("common.next")}
                  </button>
                )}
                {mode === "restore" && step === 2 && (
                  <button
                    type="button"
                    className="btn primary"
                    disabled={!preview?.hasManifest}
                    onClick={() => {
                      resetErr();
                      setStep(3);
                    }}
                  >
                    {t("init.confirmPreview")}
                  </button>
                )}
                {mode === "restore" && step === 3 && (
                  <button type="button" className="btn primary" disabled={busy} onClick={doRestore}>
                    {busy ? t("init.restoring") : t("init.restoreLocal")}
                  </button>
                )}
                {mode === "restore" && step === 4 && (
                  <button type="button" className="btn primary" onClick={() => refresh()}>
                    {t("init.enterApp")}
                  </button>
                )}
              </div>
            </div>
          </div>
        </main>
      </div>
      <S3SetupGuide
        open={guideOpen}
        initial={guideTab}
        onClose={() => setGuideOpen(false)}
        onApplyPreset={applyGuidePreset}
      />
    </div>
  );
}

export function PasswordFields({
  pw,
  pw2,
  setPw,
  setPw2,
  strength,
  onEnter,
}: {
  pw: string;
  pw2: string;
  setPw: (v: string) => void;
  setPw2: (v: string) => void;
  strength: string;
  onEnter: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div className="field">
        <label className="field-label">{t("init.password")}</label>
        <input className="input" type="password" value={pw} autoFocus onChange={(e) => setPw(e.target.value)} />
        <div className="hint">{t("init.strength", { level: strength })}</div>
      </div>
      <div className="field">
        <label className="field-label">{t("init.passwordConfirm")}</label>
        <input
          className="input"
          type="password"
          value={pw2}
          onChange={(e) => setPw2(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onEnter()}
        />
      </div>
    </>
  );
}

export function RestoreScope({
  includeRepos,
  setIncludeRepos,
  repoCount,
}: {
  includeRepos: boolean;
  setIncludeRepos: (v: boolean) => void;
  repoCount: number;
}) {
  const { t } = useTranslation();
  return (
    <div className="card" style={{ padding: "12px 14px" }}>
      <div className="field-label" style={{ marginBottom: 10, fontWeight: 600 }}>
        {t("init.scopeTitle")}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <label
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            padding: "10px 12px",
            borderRadius: 6,
            border: "1px solid var(--border)",
            backgroundColor: "rgba(0, 0, 0, 0.02)",
            cursor: "not-allowed",
            opacity: 0.85,
          }}
        >
          <input
            type="checkbox"
            checked
            disabled
            readOnly
            style={{ marginTop: 2, flexShrink: 0, cursor: "not-allowed" }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 500, fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
              <span>{t("init.scopeCore")}</span>
              <span className="badge muted sm">{t("init.scopeMust")}</span>
            </div>
            <div className="muted sm" style={{ marginTop: 3, fontSize: 12 }}>
              {t("init.scopeCoreHint")}
            </div>
          </div>
        </label>

        <label
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            padding: "10px 12px",
            borderRadius: 6,
            border: includeRepos ? "1px solid var(--accent, #4f46e5)" : "1px solid var(--border)",
            backgroundColor: includeRepos ? "rgba(99, 102, 241, 0.05)" : "transparent",
            cursor: "pointer",
            transition: "all 0.15s ease",
          }}
        >
          <input
            type="checkbox"
            checked={includeRepos}
            onChange={(e) => setIncludeRepos(e.target.checked)}
            style={{ marginTop: 2, flexShrink: 0, cursor: "pointer" }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 500, fontSize: 13, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span>{t("init.scopeRepos")}</span>
              {repoCount > 0 && <span className="badge sm">{t("init.scopeRepoCount", { count: repoCount })}</span>}
              <span className="muted sm" style={{ fontWeight: 400 }}>{t("init.scopeReposOptional")}</span>
            </div>
            <div className="muted sm" style={{ marginTop: 3, fontSize: 12, lineHeight: 1.4 }}>
              {t("init.scopeReposHint")}
            </div>
          </div>
        </label>
      </div>
    </div>
  );
}
