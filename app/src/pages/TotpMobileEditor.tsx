import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  KeyRound,
  Trash2,
  Check,
  Globe,
  FileText,
  Sliders,
  Shield,
  Layers,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, type TotpEntry } from "../lib/ipc";
import { rememberCustomIcon } from "../lib/secretsUi";
import { detectTotpInput } from "../lib/totpInput";
import { colorIconRef } from "../shared/iconColor";
import { findBuiltinAccount, platformEntryMode } from "../shared/iconAliases";
import { BuiltinIconSelect } from "../ui/BuiltinIconSelect";
import { IconUploadStack } from "../ui/IconColorPicker";
import { GroupPicker } from "../ui/GroupPicker";
import { OptionSelect } from "../ui/OptionSelect";
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
  const [platformMode, setPlatformMode] = useState<"builtin" | "custom">("builtin");
  const platformSync = useRef("");
  useEffect(() => {
    if (!value || m.builtins.length === 0) return;
    const key = value.id || "new";
    if (platformSync.current === key) return;
    platformSync.current = key;
    setPlatformMode(platformEntryMode(m.builtins, value.issuer, value.icon));
  }, [value, m.builtins]);

  if (!value) return null;

  const pickedBuiltin = findBuiltinAccount(m.builtins, value.issuer, value.icon);

  function chooseBuiltinIssuer() {
    if (!value) return;
    setPlatformMode("builtin");
    const hit = findBuiltinAccount(m.builtins, value.issuer, value.icon);
    if (!hit) {
      m.setEditor({
        ...value,
        issuer: "",
        icon: value.icon?.startsWith("custom:") ? value.icon : undefined,
      });
      return;
    }
    m.setEditor({
      ...value,
      issuer: hit.name,
      icon: value.icon?.startsWith("custom:") ? value.icon : `builtin:${hit.id}`,
    });
  }

  function chooseCustomIssuer() {
    if (!value) return;
    setPlatformMode("custom");
    if (value.icon?.startsWith("builtin:")) m.setEditor({ ...value, icon: undefined });
  }

  function chooseListedBuiltin(next: string) {
    if (!value) return;
    if (!next) {
      m.setEditor({
        ...value,
        issuer: "",
        icon: value.icon?.startsWith("custom:") ? value.icon : undefined,
      });
      return;
    }
    const hit = m.builtins.find((item) => `builtin:${item.id}` === next);
    if (!hit) return;
    m.setEditor({
      ...value,
      issuer: hit.name,
      icon: value.icon?.startsWith("custom:") ? value.icon : next,
    });
  }

  function applyIssuerText(raw: string) {
    if (!value) return;
    const matched = findBuiltinAccount(m.builtins, raw);
    if (matched && raw.trim().toLowerCase() === matched.name.toLowerCase()) {
      setPlatformMode("builtin");
      m.setEditor({
        ...value,
        issuer: matched.name,
        icon: value.icon?.startsWith("custom:") ? value.icon : `builtin:${matched.id}`,
      });
      return;
    }
    m.setEditor({ ...value, issuer: raw });
  }

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
      const issuerRaw = d.issuer || value.issuer || "";
      const keepCustom = value.icon?.startsWith("custom:");
      const matched = findBuiltinAccount(m.builtins, issuerRaw);
      if (matched) setPlatformMode("builtin");
      else if (issuerRaw.trim()) setPlatformMode("custom");
      m.setEditor({
        ...value,
        secret: d.secret,
        issuer: matched ? matched.name : issuerRaw,
        account: d.account || value.account,
        algorithm: d.algorithm || value.algorithm || "SHA1",
        digits: d.digits || value.digits || 6,
        period: d.period || value.period || 30,
        icon: keepCustom ? value.icon : matched ? `builtin:${matched.id}` : value.icon,
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
    rememberCustomIcon(info.iconRef, info.dataUrl);
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
            <div className="platform-brand">
              <IconUploadStack
                icon={value.icon}
                builtins={m.builtins}
                label={value.issuer}
                size={44}
                onPickColor={(hex) => m.setEditor({ ...value, icon: colorIconRef(hex) })}
                onUpload={() => void pickIcon()}
              />
              <div className="platform-brand-main">
                <div className="choice-row">
                  <button type="button" className={"choice" + (platformMode === "builtin" ? " on" : "")} onClick={chooseBuiltinIssuer}>
                    {t("accounts.platformBuiltin")}
                  </button>
                  <button type="button" className={"choice" + (platformMode === "custom" ? " on" : "")} onClick={chooseCustomIssuer}>
                    {t("accounts.platformCustom")}
                  </button>
                </div>
                <div className="platform-brand-tools">
                  {platformMode === "builtin" ? (
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <BuiltinIconSelect
                        value={pickedBuiltin ? `builtin:${pickedBuiltin.id}` : ""}
                        builtins={m.builtins}
                        autoLabel={t("accounts.platformBuiltinPh")}
                        onChange={chooseListedBuiltin}
                      />
                    </div>
                  ) : (
                    <input
                      className="input"
                      value={value.issuer || ""}
                      placeholder={t("totp.issuerPh")}
                      onChange={(e) => applyIssuerText(e.target.value)}
                    />
                  )}
                </div>
              </div>
            </div>
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
              onReorder={m.writesLocked ? undefined : m.reorderGroups}
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
                <OptionSelect
                  title={t("totp.algo")}
                  value={value.algorithm || "SHA1"}
                  onChange={(next) => m.setEditor({ ...value, algorithm: next })}
                  options={[
                    { value: "SHA1", label: "SHA1 (标准推荐)" },
                    { value: "SHA256", label: "SHA256" },
                    { value: "SHA512", label: "SHA512" },
                  ]}
                />
              </div>

              <div className="m-field">
                <label className="m-field-label">{t("totp.digitsLabel")}</label>
                <OptionSelect
                  title={t("totp.digitsLabel")}
                  value={String(value.digits || 6)}
                  onChange={(next) => m.setEditor({ ...value, digits: Number(next) })}
                  options={[
                    { value: "6", label: t("totp.digits6") },
                    { value: "8", label: t("totp.digits8") },
                  ]}
                />
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
