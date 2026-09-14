import { Camera, Cloud, Eye, EyeOff, FolderPlus, Moon, Palette, Sun } from "lucide-react";
import { writeClipboard } from "../lib/clipboard";
import { APP_LANG, APP_NAME } from "../lib/config";
import { AppLogo } from "../ui/AppLogo";
import { S3SetupGuide, S3GuideButton } from "../ui/S3SetupGuide";
import { useInitModel } from "../shared/hooks/useInitModel";

export function InitView({ variant }: { variant: "desktop" | "mobile" }) {
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
              {mode === "restore"
                ? APP_LANG === "en"
                  ? "Cloud Restore"
                  : "从云端恢复"
                : APP_LANG === "en"
                  ? "Workspace Init"
                  : "工作空间初始化"}
            </div>
          )}
          {mode && (
            <>
              <div className="nav-group">向导步骤</div>
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
              title="点击切换界面皮肤风格"
            >
              <span className="ic">
                {theme === "light" ? <Sun size={14} /> : theme === "dark" ? <Moon size={14} /> : <Palette size={14} />}
              </span>
              <span style={{ fontSize: 11.5, color: "var(--text-soft)" }}>
                皮肤：{theme === "light" ? "浅色" : theme === "dark" ? "深色" : "黛蓝"}
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
                  {mode ? (mode === "restore" ? "从云端恢复" : "创建保险库") : "开始使用"}
                </div>
              </div>
              <button
                type="button"
                className="m-icon-btn"
                aria-label="切换主题"
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
                      <strong>创建新工作空间</strong>
                      <small>首次使用。生成本机访问密码与恢复密钥。</small>
                    </span>
                  </button>
                  <button type="button" className="mode-pick" onClick={() => chooseMode("restore")}>
                    <Cloud size={18} />
                    <span>
                      <strong>从云端恢复</strong>
                      <small>
                        {compact
                          ? "电脑须已接入云并成功推送。手机扫码写入云配置后，还要输入恢复密钥才能解开。"
                          : "已有另一台设备。填写云存储并导入那台设备的恢复密钥。"}
                      </small>
                    </span>
                  </button>
                </div>
              )}

              {mode && step === 0 && !compact && (
                <div className="stack" style={{ gap: 10 }}>
                  {mode === "create" && alreadyCreated && (
                    <div className="callout warn">
                      已在「{createdPath}」创建过工作空间。更换目录会创建新空间，原目录不会自动删除。
                    </div>
                  )}
                  {mode === "restore" && (
                    <div className="callout info">请选择一个尚未初始化的空目录作为本机工作空间。</div>
                  )}
                  <div className="field">
                    <label className="field-label">工作空间目录</label>
                    <div className="path-pick">
                      <input
                        className="input mono"
                        placeholder="点击「浏览」选择，或直接粘贴路径"
                        value={path}
                        onChange={(e) => setPath(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && checkPath()}
                      />
                      <button type="button" className="btn" onClick={pickDir}>
                        浏览…
                      </button>
                    </div>
                    <div className="hint">请用本地独立目录，尽量只含英文、数字和连字符，例如 D:\git-keymaster-ws。不要放进 OneDrive / 坚果云，也不要用空格或中文路径（Git / OpenSSH 容易出错）。</div>
                  </div>
                  {warning && <div className="callout warn">⚠️ {warning}</div>}
                </div>
              )}

              {mode === "create" && step === 1 && (
                <div className="stack" style={{ gap: 10 }}>
                  {warning && <div className="callout warn">⚠️ {warning}</div>}
                  {alreadyCreated && !switchingPath && (
                    <div className="callout info">
                      工作空间已创建。在此修改密码只会更新访问密码，恢复密钥不变。
                    </div>
                  )}
                  {switchingPath && (
                    <div className="callout warn">
                      ⚠️ 将在新目录创建另一个工作空间，并生成新的恢复密钥。
                    </div>
                  )}
                  <PasswordFields pw={pw} pw2={pw2} setPw={setPw} setPw2={setPw2} strength={strength} onEnter={doInit} />
                  <div className="callout info">🔑 访问密码仅保存在本地进行加密校验，请牢记。</div>
                </div>
              )}

              {mode === "create" && step === 2 && (
                <div className="stack" style={{ gap: 10 }}>
                  <div className="callout danger">
                    ⚠️ 这是唯一一次完整显示恢复密钥。请立刻复制并妥善离线保存！
                  </div>
                  <div className="reckey">{recovery}</div>
                  <div className="row">
                    <button type="button" className="btn primary sm" onClick={() => writeClipboard(recovery, true)}>
                      复制恢复密钥
                    </button>
                  </div>
                </div>
              )}

              {mode === "create" && step === 3 && (
                <div className="stack" style={{ gap: 10 }}>
                  <div className="muted">请把刚才保存的恢复密钥完整填入下方（支持粘贴）：</div>
                  <textarea
                    className="input mono"
                    placeholder="粘贴或输入恢复密钥（如 GAM1-...）"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    style={{ minHeight: 76 }}
                  />
                </div>
              )}

              {mode === "create" && step === 4 && (
                <div className="stack" style={{ textAlign: "center", padding: "16px 0", gap: 6 }}>
                  <div style={{ fontSize: 36, marginBottom: 2 }}>🎉</div>
                  <div className="title-lg" style={{ fontSize: 16 }}>加密工作空间已就绪</div>
                  <div className="muted">你可以开始导入现有 SSH 密钥，或者新建多平台 Git 身份。</div>
                </div>
              )}

              {mode === "restore" && step === 1 && (
                <div className="stack" style={{ gap: 10 }}>
                  <div className="callout info sm">
                    {compact
                      ? "电脑须已接入云并成功推送。扫码只带入云存储配置，不含恢复密钥；扫完后仍要输入恢复密钥才能解开保险库。"
                      : "填写必须和旧设备完全一样。还没有这些信息？点「小白引导」按步骤到云控制台建桶、拿密钥。"}
                  </div>
                  {compact && (
                    <button type="button" className="btn primary" disabled={busy} onClick={scanS3Qr}>
                      <Camera size={16} />
                      {busy ? "正在识别…" : "扫描电脑上的二维码"}
                    </button>
                  )}
                  <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    <S3GuideButton onClick={() => setGuideOpen(true)} />
                    <span className="muted" style={{ fontSize: 11, alignSelf: "center" }}>快速预设</span>
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
                      <label className="field-label">存储端点</label>
                      <input className="input" placeholder="https://<account_id>.r2.cloudflarestorage.com" value={s3.endpoint} onChange={(e) => setS3({ ...s3, endpoint: e.target.value })} />
                    </div>
                    <div className="field">
                      <label className="field-label">存储桶</label>
                      <input className="input" placeholder="my-git-vault-backup" value={s3.bucket} onChange={(e) => setS3({ ...s3, bucket: e.target.value })} />
                    </div>
                    <div className="field">
                      <label className="field-label">区域</label>
                      <input className="input" placeholder="auto 或 us-east-1" value={s3.region} onChange={(e) => setS3({ ...s3, region: e.target.value })} />
                    </div>
                    <div className="field">
                      <label className="field-label">路径前缀</label>
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
                    {compact && (
                      <button type="button" className="btn ghost sm" disabled={busy} onClick={scanS3Qr}>
                        <Camera size={13} /> 扫码
                      </button>
                    )}
                    <button type="button" className="btn ghost sm" disabled={busy} onClick={importS3File}>
                      导入配置文件
                    </button>
                    <button type="button" className="btn ghost sm" disabled={busy} onClick={testS3}>
                      {busy ? "正在探测…" : "测试连通性"}
                    </button>
                  </div>
                </div>
              )}

              {mode === "restore" && step === 2 && (
                <div className="stack" style={{ gap: 10 }}>
                  <div className="callout warn">
                    {compact
                      ? "扫码只写入了云配置。请输入旧设备的恢复密钥才能解开保险库；二维码里没有恢复密钥。"
                      : "请输入旧设备初始化时保存的恢复密钥（GAM1-…）。填错无法解密云端数据。"}
                  </div>
                  <textarea
                    className="input mono"
                    placeholder="粘贴恢复密钥（如 GAM1-...）"
                    value={restoreKey}
                    onChange={(e) => {
                      setRestoreKey(e.target.value);
                      setPreview(null);
                    }}
                    style={{ minHeight: 76 }}
                  />
                  <div>
                    <button type="button" className="btn ghost sm" disabled={busy} onClick={doPreview}>
                      {busy ? "正在验证…" : "验证恢复密钥并预览"}
                    </button>
                  </div>
                  {preview && preview.hasManifest && (
                    <div className="stack" style={{ gap: 10 }}>
                      <div className="callout good">
                        已解开工作空间 {preview.workspaceId.slice(0, 8)}…
                        {preview.updatedAt ? ` · 云端更新于 ${new Date(preview.updatedAt).toLocaleString()}` : ""}
                        <br />
                        {preview.identityCount} 个身份 · {preview.keyCount} 把密钥
                        {preview.repoCount > 0 ? ` · 云端另有 ${preview.repoCount} 条其他机器的仓库登记` : ""}
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
                        即将还原 {preview.identityCount} 个身份、{preview.keyCount} 把密钥到「{path}」。
                        {includeRepos
                          ? ` 并导入 ${preview.repoCount} 条仓库登记（路径按本机重写归属）。`
                          : " 不会导入其他机器上的仓库登记。"}
                      </div>
                      <RestoreScope includeRepos={includeRepos} setIncludeRepos={setIncludeRepos} repoCount={preview.repoCount} />
                    </div>
                  )}
                  <PasswordFields pw={pw} pw2={pw2} setPw={setPw} setPw2={setPw2} strength={strength} onEnter={doRestore} />
                  <div className="callout info">本机访问密码可以重新设置；旧恢复密钥保持有效，请继续妥善保存。</div>
                </div>
              )}

              {mode === "restore" && step === 4 && (
                <div className="stack" style={{ textAlign: "center", padding: "16px 0", gap: 6 }}>
                  <div style={{ fontSize: 36, marginBottom: 2 }}>🎉</div>
                  <div className="title-lg" style={{ fontSize: 16 }}>已从云端恢复</div>
                  <div className="muted">{restoreResult || "工作空间已用同一把主密钥重建。"}</div>
                  {preview && (
                    <div className="muted">
                      {preview.identityCount} 个身份 · {preview.keyCount} 把密钥
                      {includeRepos ? ` · ${preview.repoCount} 个仓库` : " · 未导入仓库登记"}
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
                {mode && step === 0 ? "返回" : "上一步"}
              </button>

              <div>
                {mode && step === 0 && !compact && (
                  <button type="button" className="btn primary" onClick={checkPath}>
                    下一步
                  </button>
                )}
                {mode === "create" && step === 1 && (
                  <button type="button" className="btn primary" disabled={busy} onClick={doInit}>
                    {busy
                      ? "处理中…"
                      : switchingPath
                        ? "在新目录创建工作空间"
                        : alreadyCreated
                          ? "保存并继续"
                          : "创建工作空间"}
                  </button>
                )}
                {mode === "create" && step === 2 && (
                  <button type="button" className="btn primary" onClick={() => setStep(3)}>
                    我已安全保存，继续
                  </button>
                )}
                {mode === "create" && step === 3 && (
                  <button type="button" className="btn primary" onClick={verifyConfirm}>
                    校验并完成
                  </button>
                )}
                {mode === "create" && step === 4 && (
                  <button type="button" className="btn primary" onClick={() => refresh()}>
                    进入主界面
                  </button>
                )}
                {mode === "restore" && step === 1 && (
                  <button type="button" className="btn primary" onClick={goRestoreCloud}>
                    下一步
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
                    确认预览，继续
                  </button>
                )}
                {mode === "restore" && step === 3 && (
                  <button type="button" className="btn primary" disabled={busy} onClick={doRestore}>
                    {busy ? "正在解密并还原…" : "恢复到本机"}
                  </button>
                )}
                {mode === "restore" && step === 4 && (
                  <button type="button" className="btn primary" onClick={() => refresh()}>
                    进入主界面
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
  return (
    <>
      <div className="field">
        <label className="field-label">访问密码</label>
        <input className="input" type="password" value={pw} autoFocus onChange={(e) => setPw(e.target.value)} />
        <div className="hint">密码强度：{strength}（至少 8 位，包含字母、数字或符号更佳）</div>
      </div>
      <div className="field">
        <label className="field-label">确认访问密码</label>
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
  return (
    <div className="card" style={{ padding: "12px 14px" }}>
      <div className="field-label" style={{ marginBottom: 10, fontWeight: 600 }}>
        自定义恢复范围
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
              <span>身份、密钥、SSH 配置</span>
              <span className="badge muted sm">必须恢复</span>
            </div>
            <div className="muted sm" style={{ marginTop: 3, fontSize: 12 }}>
              包含全局身份信息、私钥加密副本以及本地 SSH Bridge 引导配置。
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
              <span>仓库登记</span>
              {repoCount > 0 && <span className="badge sm">云端 {repoCount} 条</span>}
              <span className="muted sm" style={{ fontWeight: 400 }}>（默认不恢复）</span>
            </div>
            <div className="muted sm" style={{ marginTop: 3, fontSize: 12, lineHeight: 1.4 }}>
              其他机器上的本地目录路径在本机通常无效。不勾选可保持本机仓库列表干净；恢复后也可随时通过「扫描入库」重新识别本机代码库。
            </div>
          </div>
        </label>
      </div>
    </div>
  );
}
