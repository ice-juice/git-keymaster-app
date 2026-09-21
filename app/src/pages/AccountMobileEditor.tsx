import { useMemo, useRef, useState, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ChevronLeft,
  Eye,
  EyeOff,
  Globe,
  KeyRound,
  Layers,
  Lock,
  Pin,
  Shield,
  Tag,
  Trash2,
  Upload,
  User,
  Check,
  FileText,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/ipc";
import { detectAccountSource, resolvePlatformBrand, suggestIcon } from "../lib/accountInput";
import { Badge } from "../ui/common";
import { IconMark } from "../ui/IconMark";
import { GroupPicker } from "../ui/GroupPicker";
import { type AccountsModel } from "../shared/hooks/useAccountsModel";
import { useOverlayBack } from "../shared/mobileBack";
import { AccountExtraFields } from "../ui/AccountExtraFields";
import { PasswordGenerateControls } from "../ui/PasswordGenerate";

export function AccountMobileEditor({
  m,
  onClose,
}: {
  m: AccountsModel;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const value = m.editor;

  useOverlayBack(!!value, onClose);

  const [showPw, setShowPw] = useState(false);
  const [platformMsg, setPlatformMsg] = useState("");
  const [suggestOpen, setSuggestOpen] = useState(false);
  const suggestRef = useRef<HTMLDivElement>(null);

  const isEditing = !!value?.id;
  const isPlatformLocked = !!value?.isPlatformLocked;
  const existingPlatforms = useMemo(
    () => [...new Set(m.entries.map((e) => e.platform).filter(Boolean))].sort(),
    [m.entries],
  );
  const existingRecords = useMemo(
    () =>
      m.entries
        .filter((e) => e.id !== value?.id)
        .map((e) => ({ platform: e.platform, icon: e.icon })),
    [m.entries, value?.id],
  );

  const candidates = useMemo(() => {
    const q = (value?.platform || "").trim().toLowerCase();
    const uniqueList: string[] = [];
    const seen = new Set<string>();
    for (const name of existingPlatforms) {
      if (!name) continue;
      const key = name.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        uniqueList.push(name);
      }
    }

    if (!q) {
      return uniqueList.slice(0, 8).map((name) => ({
        name,
        isExisting: true,
        icon: existingRecords.find((e) => e.platform === name)?.icon || suggestIcon(name, m.builtins),
      }));
    }

    const filtered = uniqueList.filter((name) => name.toLowerCase().includes(q));
    return filtered.slice(0, 8).map((name) => ({
      name,
      isExisting: true,
      icon: existingRecords.find((e) => e.platform === name)?.icon || suggestIcon(name, m.builtins),
    }));
  }, [value?.platform, existingPlatforms, existingRecords, m.builtins]);

  useEffect(() => {
    if (!suggestOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (suggestRef.current && !suggestRef.current.contains(e.target as Node)) {
        setSuggestOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [suggestOpen]);

  if (!value) return null;

  function applyPlatform(raw: string) {
    if (!value) return;
    const d = detectAccountSource(raw, m.builtins);
    const brand = resolvePlatformBrand(d.platform || raw, d.icon, existingRecords, m.builtins);
    const keepCustom = value.icon?.startsWith("custom:");
    const hasSibling = existingRecords.some(
      (e) => e.platform.trim().toLowerCase() === (brand.platform || raw).trim().toLowerCase(),
    );
    const iconName = m.builtins.find((b) => `builtin:${b.id}` === brand.icon)?.name;

    setPlatformMsg(
      d.kind === "url"
        ? t("accounts.urlDetected", { name: brand.platform })
        : hasSibling && brand.platform !== raw.trim()
          ? t("accounts.aligned", { name: brand.platform })
          : d.kind === "empty"
            ? t("accounts.detectEmpty")
            : iconName
              ? t("accounts.detectIcon", { name: iconName })
              : t("accounts.detectName"),
    );

    m.setEditor({
      ...value,
      platform: brand.platform || raw,
      url: d.url || value.url,
      icon: keepCustom ? value.icon : brand.icon || value.icon,
    });
  }

  function applyUrl(raw: string) {
    if (!value) return;
    const next = { ...value, url: raw };
    if (!value.platform?.trim() && raw.trim()) {
      const d = detectAccountSource(raw, m.builtins);
      if (d.kind === "url") {
        const brand = resolvePlatformBrand(d.platform, d.icon, existingRecords, m.builtins);
        next.platform = brand.platform;
        next.url = d.url || raw;
        if (!value.icon?.startsWith("custom:")) next.icon = brand.icon || d.icon;
        setPlatformMsg(t("accounts.urlDetected", { name: brand.platform }));
      }
    }
    m.setEditor(next);
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

  const canSave =
    !m.writesLocked &&
    !m.busy &&
    !!value.platform?.trim() &&
    !!value.username?.trim() &&
    (isEditing ? (value.hasPassword !== false || !!value.password?.trim()) : !!value.password?.trim());

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
          {isEditing ? t("accounts.editTitle") : t("accounts.addTitle")}
        </h1>

        <button
          type="button"
          className="m-subpage-nav-save"
          disabled={!canSave}
          onClick={() => void m.saveEditor()}
        >
          <Check size={15} />
          <span>{m.busy ? t("accounts.saving") : t("common.save")}</span>
        </button>
      </header>

      {/* 2. 表单主体滚动区 */}
      <main className="m-subpage-content">
        {/* 卡片 1: 平台与账号信息 */}
        <section className="m-form-card">
          <div className="m-form-card-title">
            <div className="row" style={{ gap: 6 }}>
              <Shield size={15} style={{ color: "var(--accent)" }} />
              <span>{t("accounts.platform")} & {t("accounts.username")}</span>
            </div>
          </div>

          <div className="m-field" ref={suggestRef} style={{ position: "relative" }}>
            <label className="m-field-label">{t("accounts.platform")}</label>
            {isPlatformLocked ? (
              <div
                className="row"
                style={{
                  gap: 10,
                  padding: "10px 12px",
                  background: "var(--gray-soft)",
                  borderRadius: "12px",
                  border: "1px solid var(--border)",
                  alignItems: "center",
                }}
              >
                <IconMark icon={value.icon} builtins={m.builtins} label={value.platform} size={26} />
                <span style={{ fontWeight: 700, fontSize: "14.5px", flex: 1 }}>{value.platform}</span>
                <Badge kind="info">{t("accounts.lockedInGroup")}</Badge>
              </div>
            ) : (
              <>
                <input
                  className="input"
                  autoFocus={!value.platform}
                  enterKeyHint="next"
                  autoCapitalize="none"
                  placeholder={t("accounts.platformPh")}
                  value={value.platform || ""}
                  onChange={(e) => {
                    applyPlatform(e.target.value);
                    setSuggestOpen(true);
                  }}
                  onFocus={() => setSuggestOpen(true)}
                />
                {suggestOpen && candidates.length > 0 && (
                  <div className="platform-suggest-menu" style={{ width: "100%", zIndex: 30 }}>
                    {candidates.map((item) => (
                      <div
                        key={item.name}
                        className="platform-suggest-item"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          applyPlatform(item.name);
                          setSuggestOpen(false);
                        }}
                      >
                        <IconMark icon={item.icon} builtins={m.builtins} label={item.name} size={22} />
                        <span style={{ fontSize: "13.5px", fontWeight: 600, flex: 1 }}>{item.name}</span>
                        {item.isExisting && <Badge kind="info">{t("accounts.existing")}</Badge>}
                      </div>
                    ))}
                  </div>
                )}
                {platformMsg && <div className="m-field-hint">{platformMsg}</div>}
              </>
            )}
          </div>

          <div className="m-field">
            <label className="m-field-label">
              <span className="row" style={{ gap: 4 }}>
                <User size={13} />
                <span>{t("accounts.username")}</span>
              </span>
            </label>
            <input
              className="input"
              inputMode="email"
              autoCapitalize="none"
              autoCorrect="off"
              enterKeyHint="next"
              placeholder={t("accounts.usernamePh")}
              value={value.username || ""}
              onChange={(e) => m.setEditor({ ...value, username: e.target.value })}
            />
          </div>

          {!isPlatformLocked && (
            <div className="m-field">
              <label className="m-field-label">{t("accounts.icon")}</label>
              <div className="row" style={{ gap: 8, alignItems: "center" }}>
                <IconMark icon={value.icon} builtins={m.builtins} label={value.platform} size={38} />
                <select
                  className="input"
                  style={{ flex: 1 }}
                  value={value.icon?.startsWith("builtin:") ? value.icon : ""}
                  onChange={(e) => m.setEditor({ ...value, icon: e.target.value || undefined })}
                >
                  <option value="">{t("accounts.iconAutoByPlatform")}</option>
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
                  <span>{t("accounts.upload")}</span>
                </button>
              </div>
            </div>
          )}
        </section>

        {/* 卡片 2: 密码凭据 */}
        <section className="m-form-card">
          <div className="m-form-card-title">
            <div className="row" style={{ gap: 6 }}>
              <Lock size={15} style={{ color: "var(--accent)" }} />
              <span>
                {isEditing
                  ? (value.hasPassword === false ? t("accounts.passwordRefill") : t("accounts.passwordKeep"))
                  : t("accounts.password")}
              </span>
            </div>
          </div>

          <div className="m-field">
            <div className="row" style={{ gap: 8 }}>
              <input
                className="input mono"
                type={showPw ? "text" : "password"}
                autoComplete="new-password"
                enterKeyHint="done"
                placeholder={
                  isEditing
                    ? (value.hasPassword === false ? t("accounts.passwordRefillPh") : t("accounts.passwordKeepPh"))
                    : t("accounts.passwordPh")
                }
                value={value.password || ""}
                onChange={(e) => m.setEditor({ ...value, password: e.target.value })}
                style={{ flex: 1, letterSpacing: showPw ? "normal" : "0.15em" }}
              />
              <button
                type="button"
                className="btn sm pw-gen-touch"
                style={{ flexShrink: 0 }}
                onClick={() => setShowPw((prev) => !prev)}
              >
                {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
                <span>{showPw ? t("accounts.hide") : t("accounts.show")}</span>
              </button>
            </div>
            <PasswordGenerateControls
              compact
              password={value.password || ""}
              onFill={(pw) => m.setEditor({ ...value, password: pw })}
            />
            <div className="m-field-hint">{t("accounts.passwordTip")}</div>
          </div>
        </section>

        {/* 卡片 3: 分组、2FA 关联与详情 */}
        <section className="m-form-card">
          <div className="m-form-card-title">
            <div className="row" style={{ gap: 6 }}>
              <Layers size={15} style={{ color: "var(--accent)" }} />
              <span>{t("accounts.group")} & {t("accounts.linkedTotp")}</span>
            </div>
          </div>

          <div className="m-field">
            <label className="m-field-label">{t("accounts.group")}</label>
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
                <KeyRound size={13} />
                <span>{t("accounts.linkTotp")}</span>
              </span>
            </label>
            <select
              className="input"
              value={value.totpRef || ""}
              onChange={(e) => m.setEditor({ ...value, totpRef: e.target.value || undefined })}
            >
              <option value="">{t("accounts.noLink")}</option>
              {m.totps.map((totp) => (
                <option key={totp.id} value={totp.id}>
                  {totp.issuer} / {totp.account}
                </option>
              ))}
            </select>
            {m.totps.length === 0 && (
              <div className="m-field-hint">{t("accounts.noTotp")}</div>
            )}
          </div>

          <div className="m-field">
            <label className="m-field-label">{t("accounts.displayName")}</label>
            <input
              className="input"
              placeholder={t("accounts.displayNamePh")}
              value={value.displayName || ""}
              onChange={(e) => m.setEditor({ ...value, displayName: e.target.value })}
            />
          </div>

          <div className="m-field">
            <label className="m-field-label">
              <span className="row" style={{ gap: 4 }}>
                <Globe size={13} />
                <span>{t("accounts.url")}</span>
              </span>
            </label>
            <input
              className="input"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              placeholder="https://github.com/login"
              value={value.url || ""}
              onChange={(e) => applyUrl(e.target.value)}
            />
          </div>

          <div className="m-field">
            <label className="m-field-label">
              <span className="row" style={{ gap: 4 }}>
                <Tag size={13} />
                <span>{t("accounts.tags")}</span>
              </span>
            </label>
            <input
              className="input"
              placeholder={t("accounts.tagsPh")}
              value={(value.tags || []).join(" ")}
              onChange={(e) =>
                m.setEditor({
                  ...value,
                  tags: e.target.value.split(/\s+/).filter(Boolean),
                })
              }
            />
          </div>

          <div className="m-field">
            <label className="m-field-label">
              <span className="row" style={{ gap: 4 }}>
                <FileText size={13} />
                <span>{t("accounts.note")}</span>
              </span>
            </label>
            <input
              className="input"
              placeholder={t("accounts.notePh")}
              value={value.note || ""}
              onChange={(e) => m.setEditor({ ...value, note: e.target.value })}
            />
          </div>

          <AccountExtraFields
            compact
            draft={value.extraFieldsDraft || []}
            disabled={m.writesLocked || m.busy}
            canReveal={!!value.id}
            onChange={(draft, dirty) =>
              m.setEditor({
                ...value,
                extraFieldsDraft: draft,
                extraFieldsDirty: dirty === false ? value.extraFieldsDirty : true,
              })
            }
            onReveal={() => m.revealEditorFields()}
          />

          {/* 置顶开关 */}
          <div
            className="m-switch-row"
            onClick={() => m.setEditor({ ...value, pinned: !value.pinned })}
          >
            <div className="row" style={{ gap: 8 }}>
              <Pin size={15} style={{ color: value.pinned ? "var(--amber)" : "var(--text-mute)" }} />
              <span className="m-switch-label">{t("accounts.pinFront")}</span>
            </div>
            <div className={"m-switch" + (value.pinned ? " on" : "")}>
              <div className="m-switch-thumb" />
            </div>
          </div>
        </section>

        {/* 卡片 4: 危险操作 (仅编辑时展示) */}
        {isEditing && (
          <section className="m-form-card" style={{ marginTop: 4 }}>
            <button
              type="button"
              className="m-danger-btn"
              disabled={m.writesLocked || m.busy}
              onClick={() => {
                onClose();
                m.deleteEditorAccount();
              }}
            >
              <Trash2 size={16} />
              <span>{t("common.delete")}</span>
            </button>
          </section>
        )}
      </main>
    </div>
  );
}
