import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  KeyRound,
  Trash2,
  Upload,
  Check,
  Globe,
  FileText,
  Sliders,
  Shield,
  Layers,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, type TotpEntry } from "../lib/ipc";
import { detectTotpInput } from "../lib/totpInput";
import { IconMark } from "../ui/IconMark";
import { GroupPicker } from "../ui/GroupPicker";
import { NOTE_MAX, type TotpModel } from "../shared/hooks/useTotpModel";
import { useOverlayBack } from "../shared/mobileBack";

export function TotpMobileEditor({
  m,
  onClose,
}: {
  m: TotpModel;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const value = m.editor;
  useOverlayBack(!!value, onClose);

  const [secretDraft, setSecretDraft] = useState(value?.secret || "");
  const detected = detectTotpInput(secretDraft);
  const nonDefaultAlgo =
    (value?.algorithm && value.algorithm !== "SHA1") ||
    (value?.digits && value.digits !== 6) ||
    (value?.period && value.period !== 30);
  const [showAdvanced, setShowAdvanced] = useState(!!nonDefaultAlgo);

  if (!value) return null;

  function applySecretDraft(next: string) {
    if (!value) return;
    setSecretDraft(next);
    const d = detectTotpInput(next);
    if (d.kind === "migration") {
      if (/data=/i.test(next)) {
        onClose();
        void m.ingestImportTexts([next.trim()]);
      } else {
        m.setEditor({ ...value, secret: undefined });
      }
      return;
    }
    if (d.kind === "otpauth") {
      m.setEditor({
        ...value,
        secret: d.secret,
        issuer: d.issuer || value.issuer,
        account: d.account || value.account,
        algorithm: d.algorithm || value.algorithm || "SHA1",
        digits: d.digits || value.digits || 6,
        period: d.period || value.period || 30,
        icon: value.icon,
      });
      if ((d.algorithm && d.algorithm !== "SHA1") || d.digits !== 6 || d.period !== 30) {
        setShowAdvanced(true);
      }
    } else if (d.kind === "base32") {
      m.setEditor({ ...value, secret: d.secret });
    } else {
      m.setEditor({ ...value, secret: next.trim() || undefined });
    }
  }

  async function pickIcon() {
    if (!value) return;
    const path = await open({
      filters: [{ name: t("common.imageFilter"), extensions: ["png", "jpg", "jpeg", "webp", "ico", "bmp"] }],
    });
    if (typeof path !== "string") return;
    const info = await api.iconUploadCustom(path);
    m.setEditor({ ...value, icon: info.iconRef });
  }

  const isEditing = !!value.id;
  const isSeedMissing = value.hasSeed === false;
  const canSave = !m.writesLocked && !m.busy && (isEditing ? (!isSeedMissing || !!value.secret?.trim()) : (!!secretDraft.trim() || !!value.secret?.trim()));

  const detectBadgeKind =
    detected.kind === "otpauth" || detected.kind === "migration"
      ? "good"
      : detected.kind === "base32"
        ? "info"
        : detected.kind === "unknown"
          ? "warn"
          : "";

  return (
    <div className="m-subpage-stage">
      {/* 1. 顶部导航栏 */}
      <header className="m-subpage-nav">
        <button
          type="button"
          className="m-subpage-nav-back"
          aria-label={t("common.back")}
          onClick={onClose}
        >
          <ChevronLeft size={22} />
          <span>{t("common.back")}</span>
        </button>

        <h1 className="m-subpage-nav-title">
          {isEditing ? t("totp.editTitle") : t("totp.addTitle")}
        </h1>

        <button
          type="button"
          className="m-subpage-nav-save"
          disabled={!canSave}
          onClick={() => void m.saveEditor()}
        >
          <Check size={15} />
          <span>{m.busy ? t("common.saving") : t("common.save")}</span>
        </button>
      </header>

      {/* 2. 表单内容主滚动区 */}
      <main className="m-subpage-content">
        {/* 卡片 1: 密钥输入与格式检测 */}
        <section className="m-form-card">
          <div className="m-form-card-title">
            <div className="row" style={{ gap: 6 }}>
              <KeyRound size={15} style={{ color: "var(--accent)" }} />
              <span>
                {isEditing
                  ? (isSeedMissing ? t("totp.secretRefill") : t("totp.secretChange"))
                  : t("totp.secretLabel")}
              </span>
            </div>
            {detectBadgeKind && (
              <span className={"badge " + detectBadgeKind}>
                {detected.kind.toUpperCase()}
              </span>
            )}
          </div>

          <div className="m-field">
            <textarea
              className="input mono"
              rows={3}
              autoFocus={!isEditing}
              value={secretDraft}
              placeholder={isEditing ? t("totp.secretKeep") : t("totp.secretPh")}
              onChange={(e) => applySecretDraft(e.target.value)}
              style={{ fontSize: 13, minHeight: 72 }}
            />

            {detected.message && (
              <div className="m-field-hint">{detected.message}</div>
            )}

            {detectBadgeKind && (
              <div className={"callout sm " + detectBadgeKind} style={{ margin: "2px 0 0" }}>
                {detected.kind === "otpauth" && t("totp.detectedOtpauth")}
                {detected.kind === "migration" && t("totp.detectedMigration")}
                {detected.kind === "base32" && t("totp.detectedBase32")}
                {detected.kind === "unknown" && t("totp.detectedUnknown")}
              </div>
            )}
          </div>
        </section>

        {/* 卡片 2: 平台与账号基本信息 */}
        <section className="m-form-card">
          <div className="m-form-card-title">
            <div className="row" style={{ gap: 6 }}>
              <Shield size={15} style={{ color: "var(--accent)" }} />
              <span>{t("nav.overview")}</span>
            </div>
          </div>

          <div className="m-field">
            <label className="m-field-label">{t("totp.issuer")}</label>
            <input
              className="input"
              value={value.issuer || ""}
              placeholder={t("totp.issuerPh")}
              onChange={(e) => m.setEditor({ ...value, issuer: e.target.value })}
            />
          </div>

          <div className="m-field">
            <label className="m-field-label">{t("totp.account")}</label>
            <input
              className="input"
              value={value.account || ""}
              placeholder={t("totp.accountPh")}
              onChange={(e) => m.setEditor({ ...value, account: e.target.value })}
            />
          </div>

          <div className="m-field">
            <label className="m-field-label">{t("totp.icon")}</label>
            <div className="row" style={{ gap: 8, alignItems: "center" }}>
              <IconMark icon={value.icon} builtins={m.builtins} label={value.issuer} size={38} />
              <select
                className="input"
                style={{ flex: 1 }}
                value={value.icon?.startsWith("builtin:") ? value.icon : ""}
                onChange={(e) => m.setEditor({ ...value, icon: e.target.value || undefined })}
              >
                <option value="">{t("totp.iconAuto")}</option>
                {m.builtins.map((b) => (
                  <option key={b.id} value={`builtin:${b.id}`}>
                    {b.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn sm"
                style={{ flexShrink: 0 }}
                onClick={pickIcon}
              >
                <Upload size={13} />
                <span>{t("totp.upload")}</span>
              </button>
            </div>
          </div>
        </section>

        {/* 卡片 3: 分组与扩展详情 */}
        <section className="m-form-card">
          <div className="m-form-card-title">
            <div className="row" style={{ gap: 6 }}>
              <Layers size={15} style={{ color: "var(--accent)" }} />
              <span>{t("group.title")}</span>
            </div>
          </div>

          <div className="m-field">
            <label className="m-field-label">{t("totp.group")}</label>
            <GroupPicker
              groups={m.groups}
              value={value.group}
              onChange={(group) => m.setEditor({ ...value, group })}
            />
          </div>

          <div className="m-field">
            <label className="m-field-label">
              <span className="row" style={{ gap: 4 }}>
                <Globe size={13} />
                <span>{t("totp.url")}</span>
              </span>
            </label>
            <input
              className="input"
              inputMode="url"
              autoCapitalize="none"
              placeholder="https://github.com/login"
              value={value.url || ""}
              onChange={(e) => m.setEditor({ ...value, url: e.target.value })}
            />
          </div>

          <div className="m-field">
            <label className="m-field-label">
              <span className="row" style={{ gap: 4 }}>
                <FileText size={13} />
                <span>{t("totp.note")}</span>
              </span>
              <span className="muted" style={{ fontSize: 11 }}>
                {(value.note || "").length}/{NOTE_MAX}
              </span>
            </label>
            <input
              className="input"
              maxLength={NOTE_MAX}
              placeholder={t("totp.notePh")}
              value={value.note || ""}
              onChange={(e) =>
                m.setEditor({ ...value, note: e.target.value.slice(0, NOTE_MAX) })
              }
            />
          </div>
        </section>

        {/* 卡片 4: 高级算法与周期 (折叠控制器) */}
        <section className="m-form-card">
          <button
            type="button"
            className="m-form-accordion-toggle"
            onClick={() => setShowAdvanced((prev) => !prev)}
          >
            <div className="row" style={{ gap: 6, fontWeight: 700, fontSize: 13.5 }}>
              <Sliders size={15} style={{ color: "var(--accent)" }} />
              <span>{t("totp.advHint")}</span>
            </div>
            {showAdvanced ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>

          {showAdvanced && (
            <div className="stack" style={{ gap: 12, marginTop: 4 }}>
              <div className="m-field">
                <label className="m-field-label">{t("totp.algo")}</label>
                <select
                  className="input"
                  value={value.algorithm || "SHA1"}
                  onChange={(e) => m.setEditor({ ...value, algorithm: e.target.value })}
                >
                  <option value="SHA1">SHA1 (标准推荐)</option>
                  <option value="SHA256">SHA256</option>
                  <option value="SHA512">SHA512</option>
                </select>
              </div>

              <div className="m-field">
                <label className="m-field-label">{t("totp.digitsLabel")}</label>
                <select
                  className="input"
                  value={value.digits || 6}
                  onChange={(e) => m.setEditor({ ...value, digits: Number(e.target.value) })}
                >
                  <option value={6}>{t("totp.digits6")}</option>
                  <option value={8}>{t("totp.digits8")}</option>
                </select>
              </div>

              <div className="m-field">
                <label className="m-field-label">{t("totp.period")}</label>
                <input
                  className="input"
                  type="number"
                  min={1}
                  value={value.period || 30}
                  onChange={(e) => m.setEditor({ ...value, period: Number(e.target.value) })}
                />
              </div>
            </div>
          )}
        </section>

        {/* 卡片 5: 危险操作区 (仅在编辑现有条目时展示) */}
        {isEditing && (
          <section className="m-form-card" style={{ marginTop: 4 }}>
            <button
              type="button"
              className="m-danger-btn"
              disabled={m.writesLocked || m.busy}
              onClick={() => {
                onClose();
                m.deleteEntry(value as TotpEntry);
              }}
            >
              <Trash2 size={16} />
              <span>{t("totp.delete")}</span>
            </button>
          </section>
        )}
      </main>
    </div>
  );
}
