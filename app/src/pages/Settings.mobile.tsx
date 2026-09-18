import { useEffect, useState } from "react";
import { pushMobileBack } from "../shared/mobileBack";
import { useTranslation } from "react-i18next";
import {
  Languages,
  Palette,
  ShieldCheck,
  FolderKanban,
  Rocket,
  AlertTriangle,
  ChevronRight,
  ChevronLeft,
  KeyRound,
  Fingerprint,
  Timer,
  MonitorOff,
  RefreshCw,
  Sparkles,
  Info,
  Play,
  Cloud,
  NotebookPen,
} from "lucide-react";
import { useSettingsModel } from "../shared/hooks/useSettingsModel";
import { THEME_OPTIONS } from "../lib/theme";
import { getNotesAutoSave, setNotesAutoSaveStored, UNLOCK_ANIM_STYLES } from "../lib/prefs";
import { writeClipboard } from "../lib/clipboard";
import { Badge, Card, ErrorDialog, FieldLabel } from "../ui/common";
import {
  FactoryResetPanel,
  ClipboardWatchField,
  GithubPatSettings,
  ScreenshotSetting,
  SecurityChecklistCard,
} from "./Settings.shared";
import { LanguageChoiceRow } from "../ui/LanguageCard";
import { MobileAboutUpdateCard } from "./MobileAboutUpdateCard";
import { useAppName } from "../lib/config";
import { useLocale } from "../lib/locale";

type SubSection =
  | "theme"
  | "language"
  | "animation"
  | "checklist"
  | "password"
  | "biometric"
  | "screenshot"
  | "timeout"
  | "recovery"
  | "workspace"
  | "pat"
  | "about"
  | "danger"
  | null;

export function SettingsMobile() {
  const { t } = useTranslation();
  const APP_NAME = useAppName();
  const { uiLocale } = useLocale();
  const m = useSettingsModel();
  const [subSection, setSubSection] = useState<SubSection>(null);
  const [notesAutoSave, setNotesAutoSave] = useState(getNotesAutoSave);

  useEffect(() => {
    if (subSection === null) return;
    return pushMobileBack(() => {
      m.setErr("");
      m.setMsg("");
      setSubSection(null);
      return true;
    });
  }, [subSection]);

  const currentThemeName = t(`theme.options.${m.theme}.name`);
  const localeLabel = t(`settings.language.${uiLocale}`);

  // 渲染二级子页面
  if (subSection !== null) {
    return (
      <div className="m-settings-wrap">
        <ErrorDialog message={m.err} onClose={() => m.setErr("")} />
        {m.msg && <div className="callout info">{m.msg}</div>}

        <div className="m-subpage-topbar">
          <button
            type="button"
            className="m-subpage-back-btn"
            onClick={() => {
              m.setErr("");
              m.setMsg("");
              setSubSection(null);
            }}
          >
            <ChevronLeft size={16} />
            <span>{t("settings.title")}</span>
          </button>
          <div className="m-subpage-title">
            {subSection && t(`settings.sub.${subSection}`)}
          </div>
        </div>

        {/* 1. 主题与外观 */}
        {subSection === "language" && (
          <Card title={t("settings.language.title")}>
            <LanguageChoiceRow />
          </Card>
        )}

        {subSection === "theme" && (
          <Card title={t("settings.pickTheme")}>
            <div className="stack">
              <div className="choice-row">
                {THEME_OPTIONS.map((opt) => {
                  const active = m.theme === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      className={"choice" + (active ? " on" : "")}
                      style={{ flex: "1 1 100%", padding: "12px 14px" }}
                      onClick={() => m.setTheme(opt.id)}
                    >
                      <div className="row" style={{ justifyContent: "space-between", marginBottom: 4 }}>
                        <strong style={{ fontSize: 14 }}>{t(`theme.options.${opt.id}.name`)}</strong>
                        <span
                          style={{
                            display: "inline-block",
                            width: 14,
                            height: 14,
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
        )}

        {/* 2. 解锁动画 */}
        {subSection === "animation" && (
          <Card title={t("settings.doorAnim")}>
            <div className="stack">
              <div className="row between">
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{t("settings.unlockAnim")}</div>
                  <div className="hint" style={{ marginTop: 2 }}>
                    {t("settings.unlockAnimHint")}
                  </div>
                </div>
                <button
                  type="button"
                  className={"switch" + (m.unlockAnimEnabled ? "" : " off")}
                  onClick={() => m.setUnlockAnimEnabled(!m.unlockAnimEnabled)}
                />
              </div>

              {m.unlockAnimEnabled && (
                <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 12 }}>
                  <div className="row between">
                    <span className="hint" style={{ fontWeight: 600, color: "var(--text)" }}>
                      {t("settings.animStyle")}
                    </span>
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => m.startUnlockAnim(m.unlockAnimStyle)}
                      style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
                    >
                      <Play size={13} /> {t("settings.previewAnim")}
                    </button>
                  </div>

                  <div className="stack">
                    {UNLOCK_ANIM_STYLES.map((st) => {
                      const active = m.unlockAnimStyle === st.id;
                      return (
                        <div
                          key={st.id}
                          role="button"
                          tabIndex={0}
                          onClick={() => m.setUnlockAnimStyle(st.id)}
                          style={{
                            padding: "12px 14px",
                            borderRadius: "10px",
                            border: active ? "2px solid var(--accent)" : "1px solid var(--border)",
                            background: active ? "var(--accent-soft)" : "var(--panel-2)",
                            cursor: "pointer",
                          }}
                        >
                          <div className="row between" style={{ marginBottom: 3 }}>
                            <span style={{ fontWeight: 650, fontSize: 13.5 }}>{t(`anim.${st.id}.label`)}</span>
                            {active && <Badge kind="info">{t("settings.selected")}</Badge>}
                          </div>
                          <div className="muted sm">{t(`anim.${st.id}.desc`)}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </Card>
        )}

        {/* 3. 安全检查 */}
        {subSection === "checklist" && (
          <SecurityChecklistCard
            refreshNonce={m.checklistNonce}
            onJump={(anchor) => {
              if (anchor === "reveal-grace" || anchor === "clipboard-clear") {
                setSubSection("timeout");
              } else if (anchor === "allow-screenshots") {
                setSubSection("screenshot");
              } else if (anchor === "workspace-path" || anchor === "auto-lock") {
                setSubSection("workspace");
              }
            }}
          />
        )}

        {/* 4. 修改密码 */}
        {subSection === "password" && (
          <Card title={t("settings.changePwTitle")}>
            <div className="stack">
              <div className="field">
                <label className="field-label">{t("settings.currentPw")}</label>
                <input
                  className="input"
                  type="password"
                  placeholder={t("settings.currentPwPh")}
                  value={m.oldPw}
                  onChange={(e) => m.setOldPw(e.target.value)}
                />
              </div>
              <div className="field">
                <label className="field-label">{t("settings.newPw")}</label>
                <input
                  className="input"
                  type="password"
                  placeholder={t("settings.newPwPh")}
                  value={m.newPw}
                  onChange={(e) => m.setNewPw(e.target.value)}
                />
              </div>
              <div className="field">
                <label className="field-label">{t("settings.confirmPw")}</label>
                <input
                  className="input"
                  type="password"
                  placeholder={t("settings.confirmPwPh")}
                  value={m.newPw2}
                  onChange={(e) => m.setNewPw2(e.target.value)}
                />
              </div>
              <div style={{ marginTop: 6 }}>
                <button
                  type="button"
                  className="btn primary"
                  style={{ width: "100%" }}
                  disabled={m.busy || !m.oldPw || !m.newPw}
                  onClick={m.changePassword}
                >
                  {m.busy ? t("settings.updatingPw") : t("settings.updatePw")}
                </button>
              </div>
            </div>
          </Card>
        )}

        {/* 5. 生物识别解锁 */}
        {subSection === "biometric" && (
          <Card title={t("settings.bioCell")}>
            <div className="stack">
              <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                {t("settings.bioIntroMobile")}
              </div>

              {m.bio?.stale && (
                <div className="callout warn">
                  {t("settings.bioStale")}
                </div>
              )}

              <div className="field">
                <FieldLabel name={t("settings.bioCell")} tip={t("settings.bioMethodTip")} />
                <div className="m-bio-methods">
                  <button
                    type="button"
                    className={"choice" + (m.bio?.enabled ? " on" : "")}
                    disabled={m.busy || m.bio?.available === false}
                    onClick={() => void m.setBioMethod("fingerprint")}
                  >
                    <Fingerprint size={18} />
                    <span>{t("settings.fingerprint")}</span>
                  </button>
                  <button
                    type="button"
                    className={"choice" + (!m.bio?.enabled ? " on" : "")}
                    disabled={m.busy}
                    onClick={() => void m.setBioMethod("password")}
                  >
                    <KeyRound size={18} />
                    <span>{t("settings.password")}</span>
                  </button>
                </div>
                {m.bio?.available === false && (
                  <div className="hint" style={{ marginTop: 6 }}>
                    {t("settings.bioUnavailableMobile")}
                  </div>
                )}
              </div>

              {m.bio?.available && !m.bio.enabled && (
                <div className="stack" style={{ marginTop: 8 }}>
                  <label className="field-label">{t("settings.bioPasswordPh")}</label>
                  <input
                    className="input"
                    type="password"
                    placeholder={t("reauth.password")}
                    value={m.bioPw}
                    onChange={(e) => m.setBioPw(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn primary"
                    disabled={m.busy || !m.bioPw.trim()}
                    onClick={() => m.enableBio(m.bioPw)}
                  >
                    <Fingerprint size={15} />
                    {t("settings.bioEnable")}
                  </button>
                </div>
              )}

              {m.bio?.enabled && (
                <div className="stack" style={{ marginTop: 6 }}>
                  <div className="callout good">{t("settings.bioEnabledHint")}</div>

                  <div className="field">
                    <FieldLabel name={t("settings.bioReveal")} tip={t("settings.bioRevealTip")} />
                    <label className="row" style={{ marginTop: 6, gap: 8 }}>
                      <input
                        type="checkbox"
                        checked={!!m.bio.revealEnabled}
                        disabled={m.busy}
                        onChange={(e) => m.toggleBioReveal(e.target.checked)}
                      />
                      <span className="hint">{t("settings.bioRevealDefault")}</span>
                    </label>
                  </div>

                  <div className="field">
                    <FieldLabel name={t("settings.bioExport")} tip={t("settings.bioExportTip")} />
                    <label className="row" style={{ marginTop: 6, gap: 8 }}>
                      <input
                        type="checkbox"
                        checked={!!m.bio.revealSecret}
                        disabled={m.busy}
                        onChange={(e) => m.toggleBioSecret(e.target.checked)}
                      />
                      <span className="hint">{t("settings.bioExportRisk")}</span>
                    </label>
                  </div>
                </div>
              )}
            </div>
          </Card>
        )}

        {subSection === "screenshot" && (
          <Card title={t("settings.screenshotTitle")}>
            <ScreenshotSetting
              allow={m.allowScreenshots}
              capability={m.screenshotCapability}
              busy={m.busy}
              onToggle={(next) => void m.toggleAllowScreenshots(next)}
            />
          </Card>
        )}

        {/* 6. 时效与剪贴板 */}
        {subSection === "timeout" && (
          <Card title={t("settings.timeoutCell")}>
            <div className="stack">
              <div className="field">
                <FieldLabel name={t("settings.revealGrace")} tip={t("settings.revealGraceTip")} />
                <div className="row" style={{ marginTop: 6 }}>
                  <select
                    className="input"
                    style={{ flex: 1 }}
                    value={m.revealGrace}
                    onChange={(e) => m.setRevealGrace(e.target.value)}
                  >
                    <option value="0">{t("settings.everyTime")}</option>
                    <option value="1">{t("settings.min1")}</option>
                    <option value="5">{t("settings.min5")}</option>
                    <option value="15">{t("settings.min15")}</option>
                    <option value="30">{t("settings.min30")}</option>
                  </select>
                  <button
                    type="button"
                    className="btn primary sm"
                    disabled={m.busy}
                    onClick={() => m.saveRevealGrace()}
                  >
                    {t("common.save")}
                  </button>
                </div>
              </div>

              <hr className="sep" />

              <div className="field">
                <FieldLabel name={t("settings.clipClear")} tip={t("settings.clipClearTip")} />
                <div className="row" style={{ marginTop: 6 }}>
                  <select
                    className="input"
                    style={{ flex: 1 }}
                    value={m.clipSec}
                    onChange={(e) => m.setClipSec(e.target.value)}
                  >
                    <option value="0">{t("settings.clipNever")}</option>
                    <option value="10">{t("settings.sec10")}</option>
                    <option value="20">{t("settings.sec20")}</option>
                    <option value="60">{t("settings.sec60")}</option>
                  </select>
                  <button
                    type="button"
                    className="btn primary sm"
                    disabled={m.busy}
                    onClick={() => m.saveClipSec()}
                  >
                    {t("common.save")}
                  </button>
                </div>
              </div>

              <hr className="sep" />
              <ClipboardWatchField />
              <hr className="sep" />

              <div className="field">
                <FieldLabel name={t("settings.histLimit")} tip={t("settings.histLimitTip")} />
                <div className="row" style={{ marginTop: 6 }}>
                  <select
                    className="input"
                    style={{ flex: 1 }}
                    value={m.histLimit}
                    onChange={(e) => m.setHistLimit(e.target.value)}
                  >
                    <option value="5">{t("settings.histN", { n: 5 })}</option>
                    <option value="10">{t("settings.histN", { n: 10 })}</option>
                    <option value="20">{t("settings.histN", { n: 20 })}</option>
                  </select>
                  <button
                    type="button"
                    className="btn primary sm"
                    disabled={m.busy}
                    onClick={() => m.saveHistLimit()}
                  >
                    {t("common.save")}
                  </button>
                </div>
              </div>
            </div>
          </Card>
        )}

        {/* 7. 恢复密钥 */}
        {subSection === "recovery" && (
          <Card title={t("settings.rotateTitle")}>
            <div className="stack">
              <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                {t("settings.rotateIntro")}
              </div>

              {m.newRecovery ? (
                <div className="stack" style={{ marginTop: 6 }}>
                  <div className="callout danger">
                    {t("settings.rotateOnce")}
                  </div>
                  <div className="reckey" style={{ fontSize: 13, wordBreak: "break-all" }}>
                    {m.newRecovery}
                  </div>
                  <div className="row" style={{ marginTop: 4 }}>
                    <button
                      type="button"
                      className="btn primary sm"
                      style={{ flex: 1 }}
                      onClick={() => writeClipboard(m.newRecovery, true)}
                    >
                      {t("common.copy")}
                    </button>
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => m.setNewRecovery("")}
                    >
                      {t("settings.rotateSaved")}
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ marginTop: 10 }}>
                  <button
                    type="button"
                    className="btn danger"
                    style={{ width: "100%" }}
                    disabled={m.busy}
                    onClick={m.rotate}
                  >
                    <RefreshCw size={14} /> {t("settings.rotateBtn")}
                  </button>
                </div>
              )}
            </div>
          </Card>
        )}

        {/* 8. 工作空间信息 */}
        {subSection === "workspace" && (
          <Card title={t("settings.wsTitle")}>
            <div className="stack">
              <div className="kv">
                <span className="muted">{t("settings.wsPath")}</span>
                <span className="mono" style={{ wordBreak: "break-all", fontSize: 12 }}>
                  {m.status?.workspacePath ?? t("common.emDash")}
                </span>
              </div>
              <div className="kv">
                <span className="muted">{t("settings.wsId")}</span>
                <span className="mono" style={{ fontSize: 12 }}>
                  {m.status?.workspaceId ?? t("common.emDash")}
                </span>
              </div>
              <div className="kv">
                <span className="muted">{t("settings.wsAutoLock")}</span>
                <span>{t("settings.wsMinutes", { n: m.status?.autoLockMinutes ?? 0 })}</span>
              </div>
              <div className="kv">
                <span className="muted">{t("settings.wsWrites")}</span>
                <span>{m.status?.writesLocked ? t("settings.wsWritesYes") : t("settings.wsWritesNo")}</span>
              </div>
            </div>
          </Card>
        )}

        {/* 9. GitHub PAT */}
        {subSection === "pat" && (
          <Card title={t("settings.patTitle")}>
            <GithubPatSettings writesLocked={!!m.status?.writesLocked} />
          </Card>
        )}

        {/* 10. 关于与更新 */}
        {subSection === "about" && <MobileAboutUpdateCard />}

        {/* 11. 出厂还原 */}
        {subSection === "danger" && (
          <div className="danger-card card">
            <div className="card-head">
              <div className="card-title" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <AlertTriangle size={15} />
                {t("settings.dangerTitle")}
              </div>
            </div>
            <div className="card-body">
              <FactoryResetPanel onDone={m.refresh} />
            </div>
          </div>
        )}
      </div>
    );
  }

  // 渲染移动端一级菜单列表 (Index)
  return (
    <div className="m-settings-wrap">
      <ErrorDialog message={m.err} onClose={() => m.setErr("")} />
      {m.msg && <div className="callout info">{m.msg}</div>}

      {/* 顶部应用信息卡片 */}
      <div className="m-settings-app-card">
        <div className="m-settings-app-avatar" style={{ background: "linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)" }}>
          <ShieldCheck size={28} style={{ color: "#ffffff" }} />
        </div>
        <div className="m-settings-app-info">
          <div className="m-settings-app-name">{APP_NAME}</div>
          <div className="m-settings-app-desc">{t("settings.appCardDesc")}</div>
        </div>
        <Badge kind="ok">{t("settings.protected")}</Badge>
      </div>

      {/* 分组 1: 外观与个性化 */}
      <div className="m-settings-group">
        <div className="m-settings-group-header">{t("settings.groupAppear")}</div>

        <button
          type="button"
          className="m-settings-cell"
          onClick={() => setSubSection("language")}
        >
          <div className="m-settings-cell-icon" style={{ background: "rgba(14, 165, 233, 0.12)", color: "#0ea5e9" }}>
            <Languages size={16} />
          </div>
          <span className="m-settings-cell-title">{t("settings.language.cell")}</span>
          <span className="m-settings-cell-value">{localeLabel}</span>
          <ChevronRight size={16} className="m-settings-cell-chevron" />
        </button>

        <button
          type="button"
          className="m-settings-cell"
          onClick={() => setSubSection("theme")}
        >
          <div className="m-settings-cell-icon" style={{ background: "rgba(99, 102, 241, 0.12)", color: "var(--accent)" }}>
            <Palette size={16} />
          </div>
          <span className="m-settings-cell-title">{t("settings.themeCell")}</span>
          <span className="m-settings-cell-value">{currentThemeName}</span>
          <ChevronRight size={16} className="m-settings-cell-chevron" />
        </button>

        <button
          type="button"
          className="m-settings-cell"
          onClick={() => setSubSection("animation")}
        >
          <div className="m-settings-cell-icon" style={{ background: "rgba(168, 85, 247, 0.12)", color: "#a855f7" }}>
            <Sparkles size={16} />
          </div>
          <span className="m-settings-cell-title">{t("settings.animCell")}</span>
          <span className="m-settings-cell-value">{m.unlockAnimEnabled ? t("common.on") : t("common.off")}</span>
          <ChevronRight size={16} className="m-settings-cell-chevron" />
        </button>

        <button
          type="button"
          className="m-settings-cell"
          title={t("settings.notesAutoSaveTip")}
          onClick={() => {
            const next = !notesAutoSave;
            setNotesAutoSave(next);
            setNotesAutoSaveStored(next);
          }}
        >
          <div className="m-settings-cell-icon" style={{ background: "rgba(14, 165, 233, 0.12)", color: "#0ea5e9" }}>
            <NotebookPen size={16} />
          </div>
          <span className="m-settings-cell-title">{t("settings.notesAutoSave")}</span>
          <span className="m-settings-cell-value">{notesAutoSave ? t("common.on") : t("common.off")}</span>
        </button>
      </div>

      {/* 分组 2: 安全与凭据保护 */}
      <div className="m-settings-group">
        <div className="m-settings-group-header">{t("settings.groupSecurity")}</div>

        <button
          type="button"
          className="m-settings-cell"
          onClick={() => setSubSection("checklist")}
        >
          <div className="m-settings-cell-icon" style={{ background: "rgba(16, 185, 129, 0.12)", color: "var(--green)" }}>
            <ShieldCheck size={16} />
          </div>
          <span className="m-settings-cell-title">{t("settings.checklistCell")}</span>
          <ChevronRight size={16} className="m-settings-cell-chevron" />
        </button>

        <button
          type="button"
          className="m-settings-cell"
          onClick={() => setSubSection("password")}
        >
          <div className="m-settings-cell-icon" style={{ background: "rgba(59, 130, 246, 0.12)", color: "#3b82f6" }}>
            <KeyRound size={16} />
          </div>
          <span className="m-settings-cell-title">{t("settings.passwordCell")}</span>
          <ChevronRight size={16} className="m-settings-cell-chevron" />
        </button>

        <button
          type="button"
          className="m-settings-cell"
          onClick={() => setSubSection("biometric")}
        >
          <div className="m-settings-cell-icon" style={{ background: "rgba(245, 158, 11, 0.12)", color: "#f59e0b" }}>
            <Fingerprint size={16} />
          </div>
          <span className="m-settings-cell-title">{t("settings.bioCell")}</span>
          <span className="m-settings-cell-value">{m.bio?.enabled ? t("settings.fingerprint") : t("settings.password")}</span>
          <ChevronRight size={16} className="m-settings-cell-chevron" />
        </button>

        <button
          type="button"
          className="m-settings-cell"
          onClick={() => setSubSection("screenshot")}
        >
          <div className="m-settings-cell-icon" style={{ background: "rgba(99, 102, 241, 0.12)", color: "#6366f1" }}>
            <MonitorOff size={16} />
          </div>
          <span className="m-settings-cell-title">{t("settings.screenshotCell")}</span>
          <span className="m-settings-cell-value">{m.allowScreenshots ? t("common.on") : t("common.off")}</span>
          <ChevronRight size={16} className="m-settings-cell-chevron" />
        </button>

        <button
          type="button"
          className="m-settings-cell"
          onClick={() => setSubSection("timeout")}
        >
          <div className="m-settings-cell-icon" style={{ background: "rgba(14, 165, 233, 0.12)", color: "#0ea5e9" }}>
            <Timer size={16} />
          </div>
          <span className="m-settings-cell-title">{t("settings.timeoutCell")}</span>
          <span className="m-settings-cell-value">{t("settings.clipClearValue", { sec: m.clipSec })}</span>
          <ChevronRight size={16} className="m-settings-cell-chevron" />
        </button>

        <button
          type="button"
          className="m-settings-cell"
          onClick={() => setSubSection("recovery")}
        >
          <div className="m-settings-cell-icon" style={{ background: "rgba(239, 68, 68, 0.12)", color: "var(--red)" }}>
            <RefreshCw size={16} />
          </div>
          <span className="m-settings-cell-title">{t("settings.recoveryCell")}</span>
          <ChevronRight size={16} className="m-settings-cell-chevron" />
        </button>
      </div>

      {/* 分组 3: 工作空间与服务 */}
      <div className="m-settings-group">
        <div className="m-settings-group-header">{t("settings.groupWorkspace")}</div>

        <button
          type="button"
          className="m-settings-cell"
          onClick={() => void m.toggleMobileBackgroundRun(!m.status?.mobileBackgroundRun)}
        >
          <div className="m-settings-cell-icon" style={{ background: "rgba(16, 185, 129, 0.12)", color: "var(--green)" }}>
            <Rocket size={16} />
          </div>
          <span className="m-settings-cell-title" title={t("settings.backgroundRunTip")}>{t("settings.backgroundRun")}</span>
          <span className="m-settings-cell-value">{m.status?.mobileBackgroundRun ? t("common.on") : t("common.off")}</span>
        </button>

        <button
          type="button"
          className="m-settings-cell"
          onClick={() => setSubSection("workspace")}
        >
          <div className="m-settings-cell-icon" style={{ background: "rgba(107, 114, 128, 0.14)", color: "var(--text)" }}>
            <FolderKanban size={16} />
          </div>
          <span className="m-settings-cell-title">{t("settings.workspaceCell")}</span>
          <ChevronRight size={16} className="m-settings-cell-chevron" />
        </button>

        <button
          type="button"
          className="m-settings-cell"
          onClick={() => setSubSection("pat")}
        >
          <div className="m-settings-cell-icon" style={{ background: "rgba(99, 102, 241, 0.12)", color: "var(--accent)" }}>
            <Info size={16} />
          </div>
          <span className="m-settings-cell-title">{t("settings.patCell")}</span>
          <ChevronRight size={16} className="m-settings-cell-chevron" />
        </button>

        <button
          type="button"
          className="m-settings-cell"
          onClick={() => m.navigate("/sync", { replace: true })}
        >
          <div className="m-settings-cell-icon" style={{ background: "rgba(16, 185, 129, 0.12)", color: "var(--green)" }}>
            <Cloud size={16} />
          </div>
          <span className="m-settings-cell-title">{t("settings.syncCell")}</span>
          <ChevronRight size={16} className="m-settings-cell-chevron" />
        </button>
      </div>

      {/* 分组 4: 软件关于 */}
      <div className="m-settings-group">
        <div className="m-settings-group-header">{t("settings.groupAbout")}</div>

        <button
          type="button"
          className="m-settings-cell"
          onClick={() => setSubSection("about")}
        >
          <div className="m-settings-cell-icon" style={{ background: "rgba(59, 130, 246, 0.12)", color: "#3b82f6" }}>
            <Rocket size={16} />
          </div>
          <span className="m-settings-cell-title">{t("settings.aboutCell")}</span>
          <ChevronRight size={16} className="m-settings-cell-chevron" />
        </button>
      </div>

      {/* 分组 5: 高危操作 */}
      <div className="m-settings-group">
        <div className="m-settings-group-header">{t("settings.groupDanger")}</div>

        <button
          type="button"
          className="m-settings-cell danger"
          onClick={() => setSubSection("danger")}
        >
          <div className="m-settings-cell-icon" style={{ background: "rgba(239, 68, 68, 0.12)", color: "var(--red)" }}>
            <AlertTriangle size={16} />
          </div>
          <span className="m-settings-cell-title">{t("settings.dangerCell")}</span>
          <ChevronRight size={16} className="m-settings-cell-chevron" />
        </button>
      </div>
    </div>
  );
}
