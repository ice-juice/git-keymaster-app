import { useState } from "react";
import {
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
  RefreshCw,
  Sparkles,
  Info,
  Play,
  Cloud,
} from "lucide-react";
import { useSettingsModel } from "../shared/hooks/useSettingsModel";
import { THEME_OPTIONS } from "../lib/theme";
import { UNLOCK_ANIM_STYLES } from "../lib/prefs";
import { writeClipboard } from "../lib/clipboard";
import { Badge, Card, ErrorDialog, FieldLabel } from "../ui/common";
import {
  AboutUpdateCard,
  FactoryResetPanel,
  GithubPatSettings,
  SecurityChecklistCard,
} from "./Settings.shared";

type SubSection =
  | "theme"
  | "animation"
  | "checklist"
  | "password"
  | "biometric"
  | "timeout"
  | "recovery"
  | "workspace"
  | "pat"
  | "about"
  | "danger"
  | null;

export function SettingsMobile() {
  const m = useSettingsModel();
  const [subSection, setSubSection] = useState<SubSection>(null);

  // 辅助获取当前主题名称
  const currentThemeName = THEME_OPTIONS.find((t) => t.id === m.theme)?.name ?? "默认";

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
            <span>设置</span>
          </button>
          <div className="m-subpage-title">
            {subSection === "theme" && "界面主题与色彩"}
            {subSection === "animation" && "解锁开门动画"}
            {subSection === "checklist" && "安全健康自查"}
            {subSection === "password" && "修改主访问密码"}
            {subSection === "biometric" && "生物识别解锁"}
            {subSection === "timeout" && "时效与剪贴板保护"}
            {subSection === "recovery" && "灾难恢复密钥"}
            {subSection === "workspace" && "工作空间存储信息"}
            {subSection === "pat" && "GitHub 个人访问令牌"}
            {subSection === "about" && "关于与检查更新"}
            {subSection === "danger" && "高危操作 · 出厂清空"}
          </div>
        </div>

        {/* 1. 主题与外观 */}
        {subSection === "theme" && (
          <Card title="选择配色风格">
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
                        <strong style={{ fontSize: 14 }}>{opt.name}</strong>
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
                      <div className="muted sm">{opt.desc}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          </Card>
        )}

        {/* 2. 解锁动画 */}
        {subSection === "animation" && (
          <Card title="开门过场动画">
            <div className="stack">
              <div className="row between">
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>解锁过场动画</div>
                  <div className="hint" style={{ marginTop: 2 }}>
                    密码验证成功后播放视觉过渡动画
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
                      动画风格
                    </span>
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => m.startUnlockAnim(m.unlockAnimStyle)}
                      style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
                    >
                      <Play size={13} /> 预览动画
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
                            <span style={{ fontWeight: 650, fontSize: 13.5 }}>{st.label}</span>
                            {active && <Badge kind="info">当前选中</Badge>}
                          </div>
                          <div className="muted sm">{st.desc}</div>
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
              } else if (anchor === "workspace-path" || anchor === "auto-lock") {
                setSubSection("workspace");
              }
            }}
          />
        )}

        {/* 4. 修改密码 */}
        {subSection === "password" && (
          <Card title="更新主访问密码">
            <div className="stack">
              <div className="field">
                <label className="field-label">当前密码</label>
                <input
                  className="input"
                  type="password"
                  placeholder="请输入当前生效的密码"
                  value={m.oldPw}
                  onChange={(e) => m.setOldPw(e.target.value)}
                />
              </div>
              <div className="field">
                <label className="field-label">新密码（至少 8 位）</label>
                <input
                  className="input"
                  type="password"
                  placeholder="新访问密码"
                  value={m.newPw}
                  onChange={(e) => m.setNewPw(e.target.value)}
                />
              </div>
              <div className="field">
                <label className="field-label">确认新密码</label>
                <input
                  className="input"
                  type="password"
                  placeholder="再次输入以确认"
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
                  {m.busy ? "正在更新…" : "确认修改密码"}
                </button>
              </div>
            </div>
          </Card>
        )}

        {/* 5. 生物识别解锁 */}
        {subSection === "biometric" && (
          <Card title="指纹 / 人脸生物识别">
            <div className="stack">
              <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                使用移动设备录入的指纹或人脸快速解锁与验证。密钥由系统底层安全芯片保护，密码与恢复密钥随时可兜底。
              </div>

              {!m.bio?.available && (
                <div className="callout warn">
                  当前设备未检测到可用的系统生物识别或硬件支持。
                </div>
              )}

              {m.bio?.stale && (
                <div className="callout warn">
                  指纹凭据已失效，请重新输入访问密码开启。
                </div>
              )}

              {m.bio?.available && !m.bio.enabled && (
                <div className="stack" style={{ marginTop: 8 }}>
                  <label className="field-label">输入访问密码以启用</label>
                  <input
                    className="input"
                    type="password"
                    placeholder="输入当前访问密码"
                    value={m.bioPw}
                    onChange={(e) => m.setBioPw(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn primary"
                    disabled={m.busy || !m.bioPw.trim()}
                    onClick={() => m.enableBio(m.bioPw)}
                  >
                    <Fingerprint size={15} /> 立即启用生物识别
                  </button>
                </div>
              )}

              {m.bio?.enabled && (
                <div className="stack" style={{ marginTop: 6 }}>
                  <div className="callout good">
                    ✓ 系统生物识别已启用，启动解锁与查看凭据时可轻触指纹直接解锁。
                  </div>

                  <div className="field">
                    <FieldLabel name="查看验证码 / 账密时允许生物识别" tip="金库已解锁后，查看一次性验证码或账户密码可用指纹代替访问密码。" />
                    <label className="row" style={{ marginTop: 6, gap: 8 }}>
                      <input
                        type="checkbox"
                        checked={!!m.bio.revealEnabled}
                        disabled={m.busy}
                        onChange={(e) => m.toggleBioReveal(e.target.checked)}
                      />
                      <span className="hint">允许免输密码直接指纹解锁凭据</span>
                    </label>
                  </div>

                  <div className="field">
                    <FieldLabel name="取回 TOTP 原始密钥也允许生物识别" tip="这是导出级操作，默认建议关闭以确保最高安全性。" />
                    <label className="row" style={{ marginTop: 6, gap: 8 }}>
                      <input
                        type="checkbox"
                        checked={!!m.bio.revealSecret}
                        disabled={m.busy}
                        onChange={(e) => m.toggleBioSecret(e.target.checked)}
                      />
                      <span className="hint">导出级操作，默认建议关闭</span>
                    </label>
                  </div>

                  <button
                    type="button"
                    className="btn ghost sm danger"
                    style={{ marginTop: 8 }}
                    disabled={m.busy}
                    onClick={m.disableBio}
                  >
                    关闭生物识别
                  </button>
                </div>
              )}
            </div>
          </Card>
        )}

        {/* 6. 时效与剪贴板 */}
        {subSection === "timeout" && (
          <Card title="安全时效与剪贴板保护">
            <div className="stack">
              <div className="field">
                <FieldLabel name="免密查看凭据时效" tip="验证后在该时间内查看验证码或账号密码不重复询问密码。" />
                <div className="row" style={{ marginTop: 6 }}>
                  <select
                    className="input"
                    style={{ flex: 1 }}
                    value={m.revealGrace}
                    onChange={(e) => m.setRevealGrace(e.target.value)}
                  >
                    <option value="0">每次都验证（最严格）</option>
                    <option value="1">1 分钟</option>
                    <option value="5">5 分钟（推荐）</option>
                    <option value="15">15 分钟</option>
                    <option value="30">30 分钟</option>
                  </select>
                  <button
                    type="button"
                    className="btn primary sm"
                    disabled={m.busy}
                    onClick={() => m.saveRevealGrace()}
                  >
                    保存
                  </button>
                </div>
              </div>

              <hr className="sep" />

              <div className="field">
                <FieldLabel name="复制后清空剪贴板" tip="防止密码在系统剪贴板中被其他恶意应用偷窥。" />
                <div className="row" style={{ marginTop: 6 }}>
                  <select
                    className="input"
                    style={{ flex: 1 }}
                    value={m.clipSec}
                    onChange={(e) => m.setClipSec(e.target.value)}
                  >
                    <option value="0">不清空</option>
                    <option value="10">10 秒后清空</option>
                    <option value="20">20 秒后清空（推荐）</option>
                    <option value="60">60 秒后清空</option>
                  </select>
                  <button
                    type="button"
                    className="btn primary sm"
                    disabled={m.busy}
                    onClick={() => m.saveClipSec()}
                  >
                    保存
                  </button>
                </div>
              </div>

              <hr className="sep" />

              <div className="field">
                <FieldLabel name="密码历史保留条数" tip="修改密码时自动保存的历史旧密码数量上限。" />
                <div className="row" style={{ marginTop: 6 }}>
                  <select
                    className="input"
                    style={{ flex: 1 }}
                    value={m.histLimit}
                    onChange={(e) => m.setHistLimit(e.target.value)}
                  >
                    <option value="5">保留 5 条</option>
                    <option value="10">保留 10 条（默认）</option>
                    <option value="20">保留 20 条</option>
                  </select>
                  <button
                    type="button"
                    className="btn primary sm"
                    disabled={m.busy}
                    onClick={() => m.saveHistLimit()}
                  >
                    保存
                  </button>
                </div>
              </div>
            </div>
          </Card>
        )}

        {/* 7. 恢复密钥 */}
        {subSection === "recovery" && (
          <Card title="灾难恢复密钥 (Emergency Key)">
            <div className="stack">
              <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                灾难恢复密钥可用于在遗忘主访问密码时解密金库并重新设置密码。生成新密钥后旧密钥立即失效。
              </div>

              {m.newRecovery ? (
                <div className="stack" style={{ marginTop: 6 }}>
                  <div className="callout danger">
                    ⚠️ <strong>仅显示一次，请务必妥善记录或存入安全位置：</strong>
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
                      复制密钥
                    </button>
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => m.setNewRecovery("")}
                    >
                      我已安全保存
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
                    <RefreshCw size={14} /> 轮换生成新的灾难恢复密钥
                  </button>
                </div>
              )}
            </div>
          </Card>
        )}

        {/* 8. 工作空间信息 */}
        {subSection === "workspace" && (
          <Card title="工作空间存储详情">
            <div className="stack">
              <div className="kv">
                <span className="muted">存储路径</span>
                <span className="mono" style={{ wordBreak: "break-all", fontSize: 12 }}>
                  {m.status?.workspacePath ?? "—"}
                </span>
              </div>
              <div className="kv">
                <span className="muted">工作空间 ID</span>
                <span className="mono" style={{ fontSize: 12 }}>
                  {m.status?.workspaceId ?? "—"}
                </span>
              </div>
              <div className="kv">
                <span className="muted">自动锁定</span>
                <span>{m.status?.autoLockMinutes ?? 0} 分钟</span>
              </div>
              <div className="kv">
                <span className="muted">写入锁定</span>
                <span>{m.status?.writesLocked ? "是 (只读)" : "否 (正常)"}</span>
              </div>
            </div>
          </Card>
        )}

        {/* 9. GitHub PAT */}
        {subSection === "pat" && (
          <Card title="GitHub 个人访问令牌">
            <GithubPatSettings writesLocked={!!m.status?.writesLocked} />
          </Card>
        )}

        {/* 10. 关于与更新 */}
        {subSection === "about" && <AboutUpdateCard />}

        {/* 11. 出厂还原 */}
        {subSection === "danger" && (
          <div className="danger-card card">
            <div className="card-head">
              <div className="card-title" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <AlertTriangle size={15} />
                高危操作 · 出厂清空还原
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
          <div className="m-settings-app-name">御钥师 · Git Keymaster</div>
          <div className="m-settings-app-desc">端到端加密金库与凭据安全中心</div>
        </div>
        <Badge kind="ok">已保护</Badge>
      </div>

      {/* 分组 1: 外观与个性化 */}
      <div className="m-settings-group">
        <div className="m-settings-group-header">外观与偏好</div>

        <button
          type="button"
          className="m-settings-cell"
          onClick={() => setSubSection("theme")}
        >
          <div className="m-settings-cell-icon" style={{ background: "rgba(99, 102, 241, 0.12)", color: "var(--accent)" }}>
            <Palette size={16} />
          </div>
          <span className="m-settings-cell-title">界面主题与色彩</span>
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
          <span className="m-settings-cell-title">解锁开门动画</span>
          <span className="m-settings-cell-value">{m.unlockAnimEnabled ? "已开启" : "已关闭"}</span>
          <ChevronRight size={16} className="m-settings-cell-chevron" />
        </button>
      </div>

      {/* 分组 2: 安全与凭据保护 */}
      <div className="m-settings-group">
        <div className="m-settings-group-header">安全与凭据保护</div>

        <button
          type="button"
          className="m-settings-cell"
          onClick={() => setSubSection("checklist")}
        >
          <div className="m-settings-cell-icon" style={{ background: "rgba(16, 185, 129, 0.12)", color: "var(--green)" }}>
            <ShieldCheck size={16} />
          </div>
          <span className="m-settings-cell-title">安全健康自查</span>
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
          <span className="m-settings-cell-title">修改主访问密码</span>
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
          <span className="m-settings-cell-title">指纹 / 生物识别解锁</span>
          <span className="m-settings-cell-value">{m.bio?.enabled ? "已开启" : "未开启"}</span>
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
          <span className="m-settings-cell-title">时效与剪贴板保护</span>
          <span className="m-settings-cell-value">{m.clipSec}秒清空</span>
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
          <span className="m-settings-cell-title">灾难恢复密钥轮换</span>
          <ChevronRight size={16} className="m-settings-cell-chevron" />
        </button>
      </div>

      {/* 分组 3: 工作空间与服务 */}
      <div className="m-settings-group">
        <div className="m-settings-group-header">工作空间与同步</div>

        <button
          type="button"
          className="m-settings-cell"
          onClick={() => setSubSection("workspace")}
        >
          <div className="m-settings-cell-icon" style={{ background: "rgba(107, 114, 128, 0.14)", color: "var(--text)" }}>
            <FolderKanban size={16} />
          </div>
          <span className="m-settings-cell-title">工作空间详情</span>
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
          <span className="m-settings-cell-title">GitHub 个人访问令牌 (PAT)</span>
          <ChevronRight size={16} className="m-settings-cell-chevron" />
        </button>

        <button
          type="button"
          className="m-settings-cell"
          onClick={() => m.navigate("/sync")}
        >
          <div className="m-settings-cell-icon" style={{ background: "rgba(16, 185, 129, 0.12)", color: "var(--green)" }}>
            <Cloud size={16} />
          </div>
          <span className="m-settings-cell-title">云端同步与备份管理</span>
          <ChevronRight size={16} className="m-settings-cell-chevron" />
        </button>
      </div>

      {/* 分组 4: 软件关于 */}
      <div className="m-settings-group">
        <div className="m-settings-group-header">关于软件</div>

        <button
          type="button"
          className="m-settings-cell"
          onClick={() => setSubSection("about")}
        >
          <div className="m-settings-cell-icon" style={{ background: "rgba(59, 130, 246, 0.12)", color: "#3b82f6" }}>
            <Rocket size={16} />
          </div>
          <span className="m-settings-cell-title">关于与检查更新</span>
          <ChevronRight size={16} className="m-settings-cell-chevron" />
        </button>
      </div>

      {/* 分组 5: 高危操作 */}
      <div className="m-settings-group">
        <div className="m-settings-group-header">危险区域</div>

        <button
          type="button"
          className="m-settings-cell danger"
          onClick={() => setSubSection("danger")}
        >
          <div className="m-settings-cell-icon" style={{ background: "rgba(239, 68, 68, 0.12)", color: "var(--red)" }}>
            <AlertTriangle size={16} />
          </div>
          <span className="m-settings-cell-title">出厂清空还原</span>
          <ChevronRight size={16} className="m-settings-cell-chevron" />
        </button>
      </div>
    </div>
  );
}
