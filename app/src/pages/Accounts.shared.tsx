import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ChevronDown, Copy, Eye, EyeOff, Plus, Clock, ExternalLink, Check, Pencil } from "lucide-react";
import {
  api,
  type AccountEntry,
  type BuiltinIconInfo,
  type GroupMeta,
  type TotpEntry,
} from "../lib/ipc";
import { copyWithClear } from "../lib/secretsUi";
import { Empty, Badge, ConfirmDangerDialog, FieldLabel, ErrorDialog } from "../ui/common";
import { detectAccountSource, resolvePlatformBrand, suggestIcon } from "../lib/accountInput";
import { ReauthDialog } from "../ui/ReauthDialog";
import { IconMark } from "../ui/IconMark";
import { CountdownRing } from "../ui/CountdownRing";
import { GroupDialog } from "../ui/GroupDialog";
import { GroupPicker } from "../ui/GroupPicker";
import { useTranslation } from "react-i18next";
import { type AccountsModel } from "../shared/hooks/useAccountsModel";
import { useOverlayBack } from "../shared/mobileBack";

export function AccountsFilters({ m, hideSearch }: { m: AccountsModel; hideSearch?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="row between">
      <div className="group-tabs">
        {m.tabs.map((g) => {
          const count = g === "全部" ? m.entries.length : m.entries.filter((e) => (e.group || "未分组") === g).length;
          const color = m.groups.find((item) => item.name === g)?.color;
          const label = g === "全部" ? t("common.all") : g === "未分组" ? t("common.ungrouped") : g;
          return (
            <button key={g} type="button" className={"group-tab" + (m.group === g ? " on" : "")} onClick={() => m.setGroup(g)}>
              {color && <span className="group-tab-dot" style={{ background: color }} />}
              <span>{label}</span>
              <span className="group-tab-count">{count}</span>
            </button>
          );
        })}
        <button
          type="button"
          className="group-tab dashed"
          disabled={m.writesLocked}
          onClick={() => m.setGroupDlg(true)}
        >
          {t("accounts.newGroup")}
        </button>
      </div>
      {!hideSearch && (
        <input className="input" style={{ maxWidth: 280 }} placeholder={t("accounts.search")} value={m.q} onChange={(e) => m.setQ(e.target.value)} />
      )}
    </div>
  );
}

export function AccountsList({ m, compact }: { m: AccountsModel; compact?: boolean }) {
  const { t } = useTranslation();
  if (m.platforms.length === 0) {
    return <Empty text={compact ? t("accounts.emptyCompact") : t("accounts.empty")} />;
  }
  return (
    <>
      {m.platforms.map(([platform, list]) => {
        const folded = !!m.collapsed[platform];
        return (
          <div key={platform} className={"platform-group" + (folded ? " collapsed" : "")}>
            <button
              type="button"
              className="platform-header"
              onClick={() => m.setCollapsed((prev) => ({ ...prev, [platform]: !prev[platform] }))}
            >
              <div className="platform-title">
                <ChevronDown size={15} className={"chevron" + (folded ? " rot" : "")} />
                <IconMark
                  icon={list.find((e) => e.icon)?.icon || list[0]?.icon}
                  builtins={m.builtins}
                  label={platform}
                  size={28}
                />
                <span>{platform}</span>
                {list.find((e) => e.url)?.url && (
                  <span
                    role="button"
                    tabIndex={0}
                    className="btn ghost sm"
                    style={{ padding: "2px 5px", display: "inline-flex", alignItems: "center" }}
                    title={t("accounts.openSite")}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      void api.openUrl(list.find((item) => item.url)!.url!);
                    }}
                  >
                    <ExternalLink size={12} />
                  </span>
                )}
                <Badge kind="info">{t("accounts.accountCount", { n: list.length })}</Badge>
              </div>
              <div className="row" style={{ gap: 4 }} onClick={(ev) => ev.stopPropagation()}>
                <button
                  type="button"
                  className="btn ghost sm"
                  style={{ padding: "4px 8px" }}
                  title={t("accounts.editPlatform")}
                  onClick={() =>
                    m.setEditingPlatformModal({
                      platform,
                      icon: list.find((e) => e.icon)?.icon ?? undefined,
                    })
                  }
                >
                  <Pencil size={12} /> {t("accounts.editPlatformLabel")}
                </button>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() =>
                    m.setEditor({
                      platform,
                      url: list.find((e) => e.url)?.url,
                      icon: list.find((e) => e.icon)?.icon ?? undefined,
                      isPlatformLocked: true,
                    })
                  }
                >
                  <Plus size={12} /> {t("pages.add")}
                </button>
              </div>
            </button>
            {!folded && (
              <div className="platform-body">
                {list.map((e) => {
                  const linked = e.totpRef ? m.totpShown[e.totpRef] : undefined;
                  const isCopiedUser = m.copiedKey === `user-${e.id}`;
                  const isCopiedPw = m.copiedKey === `pw-${e.id}`;
                  const isCopiedTotp = e.totpRef ? m.copiedKey === `totp-${e.totpRef}` : false;
                  const pwMissing = e.hasPassword === false;

                  return (
                    <div key={e.id} className="account-item">
                      <div className="account-user-info">
                        <div className="account-user">
                          <span>{e.username}</span>
                          {e.pinned && <Badge kind="warn">{t("accounts.pinned")}</Badge>}
                          {e.tags?.map((tag) => (
                            <Badge key={tag}>{tag}</Badge>
                          ))}
                        </div>
                        <div className="account-meta">
                          {e.displayName && <span>{e.displayName}</span>}
                          {e.displayName && e.note && <span>·</span>}
                          {e.note && <span className="muted">{e.note}</span>}
                        </div>
                      </div>

                      <div className="account-mid">
                        {e.totpRef && (
                          <div className="linked-totp" title={t("accounts.linkedTotp")}>
                            <span className="linked-totp-badge">2FA</span>
                            {linked ? (
                              <div
                                className="row"
                                style={{ gap: 6, cursor: "pointer" }}
                                onClick={() => m.copyLinkedTotp(e.totpRef!)}
                                title={t("accounts.copyCodeQuick")}
                              >
                                <span className="mono" style={{ fontWeight: 700, color: "var(--accent)" }}>
                                  {linked.code}
                                </span>
                                <CountdownRing remain={linked.remain} period={linked.period} size={22} />
                              </div>
                            ) : (
                              <>
                                <span className="muted">••••••</span>
                                <button
                                  type="button"
                                  className="btn ghost sm"
                                  style={{ padding: "1px 4px" }}
                                  title={t("accounts.showCode")}
                                  onClick={() => m.revealLinkedTotp(e.totpRef!)}
                                >
                                  <Eye size={12} />
                                </button>
                              </>
                            )}
                            {linked && (
                              <button
                                type="button"
                                className={"btn ghost sm " + (isCopiedTotp ? "good" : "")}
                                style={{ padding: "1px 4px" }}
                                title={t("accounts.copyCode")}
                                onClick={() => m.copyLinkedTotp(e.totpRef!)}
                              >
                                {isCopiedTotp ? <Check size={11} /> : <Copy size={11} />}
                              </button>
                            )}
                          </div>
                        )}

                        {pwMissing && (
                          <div className="callout danger sm">{t("accounts.pwLost")}</div>
                        )}
                        <div className="pwd-box">
                          <span className="mono">{m.pwShown[e.id] || "••••••••"}</span>
                          {m.pwShown[e.id] ? (
                            <button
                              type="button"
                              className="btn ghost sm"
                              style={{ padding: "1px 4px" }}
                              title={t("accounts.hidePw")}
                              onClick={() => m.hidePw(e.id)}
                            >
                              <EyeOff size={12} />
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="btn ghost sm"
                              style={{ padding: "1px 4px" }}
                              title={pwMissing ? t("accounts.pwLostShort") : t("accounts.showPw")}
                              disabled={pwMissing}
                              onClick={() => m.revealPw(e.id)}
                            >
                              <Eye size={12} />
                            </button>
                          )}
                          <button
                            type="button"
                            className={"btn sm " + (isCopiedPw ? "good" : "primary")}
                            style={{ padding: "2px 8px" }}
                            title={pwMissing ? t("accounts.pwLostShort") : t("accounts.copyPw")}
                            disabled={pwMissing}
                            onClick={() => m.copyPw(e.id)}
                          >
                            {isCopiedPw ? <Check size={12} /> : <Copy size={12} />}
                          </button>
                        </div>
                      </div>

                      <div className="row" style={{ gap: 5 }}>
                        <button
                          type="button"
                          className={"btn sm " + (isCopiedUser ? "good" : "")}
                          title={t("accounts.copyUser")}
                          onClick={() => m.copyUsername(e.id, e.username)}
                        >
                          {isCopiedUser ? <Check size={12} /> : <Copy size={12} />} {t("accounts.account")}
                        </button>
                        <button
                          type="button"
                          className="btn ghost sm"
                          title={t("accounts.history")}
                          onClick={() => m.openHistory(e.id)}
                        >
                          <Clock size={13} />
                        </button>
                        <button
                          type="button"
                          className="btn sm"
                          disabled={m.writesLocked}
                          title={t("accounts.edit")}
                          onClick={() => m.setEditor({ ...e })}
                        >
                          {t("common.edit")}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

function EditPlatformModal({
  originalPlatform,
  currentIcon,
  builtins,
  busy,
  onCancel,
  onConfirm,
}: {
  originalPlatform: string;
  currentIcon?: string;
  builtins: BuiltinIconInfo[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: (newName: string, newIcon?: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(originalPlatform);
  const [icon, setIcon] = useState<string | undefined>(currentIcon);

  async function pickIcon() {
    const path = await open({
      filters: [{ name: t("common.imageFilter"), extensions: ["png", "jpg", "jpeg", "webp", "ico", "bmp"] }],
    });
    if (typeof path !== "string") return;
    const info = await api.iconUploadCustom(path);
    setIcon(info.iconRef);
  }

  return (
    <div className="wizard-overlay" style={{ zIndex: 60 }}>
      <div className="card dialog-card" style={{ width: 440, maxWidth: "95vw" }} onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <div className="card-title">{t("accounts.platformTitle")}</div>
        </div>
        <div className="card-body stack" style={{ gap: 14 }}>
          <div className="field">
            <FieldLabel name={t("accounts.platformName")} tip={t("accounts.platformNameTip")} />
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("accounts.platformNamePh")}
            />
          </div>

          <div className="field">
            <label className="field-label">{t("accounts.unifiedIcon")}</label>
            <div className="row" style={{ gap: 10 }}>
              <IconMark icon={icon} builtins={builtins} label={name} size={36} />
              <select
                className="input"
                style={{ flex: 1 }}
                value={icon?.startsWith("builtin:") ? icon : ""}
                onChange={(e) => setIcon(e.target.value || undefined)}
              >
                <option value="">{t("accounts.iconAuto")}</option>
                {builtins.map((b) => (
                  <option key={b.id} value={`builtin:${b.id}`}>{b.name}</option>
                ))}
              </select>
              <button type="button" className="btn sm" onClick={pickIcon}>{t("accounts.upload")}</button>
            </div>
          </div>

          <div className="hint">
            {t("accounts.platformSync", { name: originalPlatform })}
          </div>
        </div>
        <div className="card-foot" style={{ justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn ghost sm" disabled={busy} onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn primary sm"
            disabled={busy || !name.trim()}
            onClick={() => void onConfirm(name, icon)}
          >
            {busy ? t("accounts.saving") : t("accounts.confirmEdit")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function AccountsDialogs({ m, compact, skipEditor }: { m: AccountsModel; compact?: boolean; skipEditor?: boolean }) {
  const { t } = useTranslation();
  useOverlayBack(!skipEditor && !!m.editor, () => m.setEditor(null));
  useOverlayBack(!!m.groupDlg, () => m.setGroupDlg(false));
  useOverlayBack(!!m.reauth, () => m.reauthCancel.current?.());
  useOverlayBack(!!m.editingPlatformModal, () => m.setEditingPlatformModal(null));
  useOverlayBack(!!m.pendingDelete, () => m.setPendingDelete(null));
  return (
    <>
      <ErrorDialog message={m.err} onClose={() => m.setErr("")} />

      {m.reauth && <ReauthDialog onCancel={() => m.reauthCancel.current?.()} onConfirm={(pw) => m.reauth!(pw)} />}

      {m.groupDlg && (
        <GroupDialog
          existing={m.groups.map((g) => g.name)}
          onCancel={() => m.setGroupDlg(false)}
          onConfirm={m.saveGroup}
        />
      )}

      {m.editingPlatformModal && (
        <EditPlatformModal
          originalPlatform={m.editingPlatformModal.platform}
          currentIcon={m.editingPlatformModal.icon}
          builtins={m.builtins}
          busy={m.busy}
          onCancel={() => m.setEditingPlatformModal(null)}
          onConfirm={async (newName, newIcon) => {
            await m.updatePlatformBrand(
              m.editingPlatformModal!.platform,
              newName,
              newIcon,
            );
          }}
        />
      )}

      {!skipEditor && m.editor && !m.pendingDelete && (
        <AccountEditor
          compact={compact}
          value={m.editor}
          builtins={m.builtins}
          groups={m.groups}
          platforms={m.entries.map((e) => e.platform)}
          existing={m.entries
            .filter((e) => e.id !== m.editor?.id)
            .map((e) => ({ platform: e.platform, icon: e.icon }))}
          totps={m.totps}
          busy={m.busy}
          onChange={m.setEditor}
          onClose={() => m.setEditor(null)}
          onSave={m.saveEditor}
          onDelete={m.editor.id ? () => m.deleteEditorAccount() : undefined}
        />
      )}

      {m.historyFor && <AccountsHistoryDialog m={m} />}

      {m.pendingDelete && (
        <ConfirmDangerDialog
          title={t("accounts.deleteTitle")}
          message={t("accounts.deleteMsg", {
            name: m.pendingDelete.username
              ? `${m.pendingDelete.platform} / ${m.pendingDelete.username}`
              : m.pendingDelete.platform,
          })}
          detail={t("accounts.deleteDetail")}
          busy={m.busy}
          onCancel={() => m.setPendingDelete(null)}
          onConfirm={() => void m.confirmDeleteEditorAccount()}
        />
      )}
    </>
  );
}

function AccountsHistoryDialog({ m }: { m: AccountsModel }) {
  const { t } = useTranslation();
  const historyFor = m.historyFor;
  if (!historyFor) return null;
  return (
    <div className="wizard-overlay">
      <div className="card" style={{ width: 460, maxWidth: "96vw" }} onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <div className="card-title">{t("accounts.historyTitle")}</div>
          <button type="button" className="btn ghost sm" onClick={() => m.setHistoryFor(null)}>
            {t("common.close")}
          </button>
        </div>
        <div className="card-body stack">
          {historyFor.items.length === 0 ? (
            <div className="muted" style={{ padding: "16px 0", textAlign: "center" }}>
              {t("accounts.noHistory")}
            </div>
          ) : (
            <div className="timeline">
              {historyFor.items.map((h, idx) => {
                const isLatest = idx === 0;
                const shownPw = historyFor.shown?.[h.index];
                return (
                  <div key={h.index} className="timeline-item">
                    <div className={"timeline-dot" + (isLatest ? " current" : "")} />
                    <div className="timeline-content">
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div className="row" style={{ gap: 6, marginBottom: 4 }}>
                          <span className="mono" style={{ fontWeight: 600, fontSize: "13px" }}>
                            {shownPw || "••••••••"}
                          </span>
                          {isLatest && <Badge kind="good">{t("accounts.latestHist")}</Badge>}
                        </div>
                        <div className="muted" style={{ fontSize: "11px" }}>
                          {t("accounts.replacedAt", { time: h.replacedAt })}
                        </div>
                      </div>
                      <div className="row" style={{ gap: 5 }}>
                        {!shownPw ? (
                          <button type="button" className="btn sm" onClick={() => m.revealHistory(h.index)}>
                            {t("common.view")}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn sm"
                            title={t("accounts.copyThis")}
                            onClick={() => copyWithClear(shownPw)}
                          >
                            <Copy size={12} /> {t("common.copy")}
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn sm"
                          disabled={m.writesLocked}
                          title={t("accounts.rollback")}
                          onClick={() => m.rollbackHistory(h.index, h.replacedAt)}
                        >
                          {t("accounts.rollbackShort")}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {historyFor.items.length > 0 && (
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 8 }}>
              <button
                type="button"
                className="btn danger sm"
                disabled={m.writesLocked}
                onClick={() => m.clearHistory()}
              >
                {t("accounts.clearHist")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PlatformInput({
  value,
  builtins,
  existingPlatforms,
  existing,
  autoFocus,
  onChange,
}: {
  value: string;
  builtins: BuiltinIconInfo[];
  existingPlatforms: string[];
  existing: { platform: string; icon?: string | null }[];
  autoFocus?: boolean;
  onChange: (val: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const candidates = useMemo(() => {
    const q = (value || "").trim().toLowerCase();

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
      return uniqueList.slice(0, 10).map((name) => ({
        name,
        isExisting: true,
        icon: existing.find((e) => e.platform === name)?.icon || suggestIcon(name, builtins),
      }));
    }

    const filtered = uniqueList.filter((name) =>
      name.toLowerCase().includes(q)
    );

    return filtered.slice(0, 10).map((name) => ({
      name,
      isExisting: true,
      icon: existing.find((e) => e.platform === name)?.icon || suggestIcon(name, builtins),
    }));
  }, [value, existingPlatforms, existing, builtins]);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  return (
    <div ref={containerRef} style={{ position: "relative", width: "100%" }}>
      <input
        className="input"
        autoFocus={autoFocus}
        enterKeyHint="next"
        autoCapitalize="none"
        placeholder={t("accounts.platformPh")}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
      />

      {open && candidates.length > 0 && (
        <div className="platform-suggest-menu">
          {candidates.map((item) => (
            <div
              key={item.name}
              className="platform-suggest-item"
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(item.name);
                setOpen(false);
              }}
            >
              <IconMark icon={item.icon} builtins={builtins} label={item.name} size={20} />
              <span style={{ fontSize: "13px", fontWeight: 500, flex: 1 }}>{item.name}</span>
              {item.isExisting && <Badge kind="info">{t("accounts.existing")}</Badge>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AccountEditor({
  compact,
  value,
  builtins,
  groups,
  platforms,
  existing,
  totps,
  busy,
  onChange,
  onClose,
  onSave,
  onDelete,
}: {
  compact?: boolean;
  value: Partial<AccountEntry> & { password?: string; isPlatformLocked?: boolean };
  builtins: BuiltinIconInfo[];
  groups: GroupMeta[];
  platforms: string[];
  existing: { platform: string; icon?: string | null }[];
  totps: TotpEntry[];
  busy: boolean;
  onChange: (v: Partial<AccountEntry> & { password?: string; isPlatformLocked?: boolean }) => void;
  onClose: () => void;
  onSave: () => void;
  onDelete?: () => void;
}) {
  const { t } = useTranslation();
  const [showPw, setShowPw] = useState(false);
  const hasExtra = !!(value.displayName || value.url || value.note || value.group || value.totpRef || value.pinned || (value.tags && value.tags.length));
  const [showMore, setShowMore] = useState(hasExtra);
  const [platformMsg, setPlatformMsg] = useState("");
  const uniquePlatforms = [...new Set(platforms.filter(Boolean))].sort();

  function applyPlatform(raw: string) {
    const d = detectAccountSource(raw, builtins);
    const brand = resolvePlatformBrand(d.platform || raw, d.icon, existing, builtins);
    const keepCustom = value.icon?.startsWith("custom:");
    const hasSibling = existing.some(
      (e) => e.platform.trim().toLowerCase() === (brand.platform || raw).trim().toLowerCase(),
    );
    const iconName = builtins.find((b) => `builtin:${b.id}` === brand.icon)?.name;
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
    onChange({
      ...value,
      platform: brand.platform || raw,
      url: d.url || value.url,
      icon: keepCustom ? value.icon : brand.icon || value.icon,
    });
    if (d.kind === "url") setShowMore(true);
  }

  function applyUrl(raw: string) {
    const next: Partial<AccountEntry> & { password?: string; isPlatformLocked?: boolean } = { ...value, url: raw };
    if (!value.platform?.trim() && raw.trim()) {
      const d = detectAccountSource(raw, builtins);
      if (d.kind === "url") {
        const brand = resolvePlatformBrand(d.platform, d.icon, existing, builtins);
        next.platform = brand.platform;
        next.url = d.url || raw;
        if (!value.icon?.startsWith("custom:")) next.icon = brand.icon || d.icon;
        setPlatformMsg(t("accounts.urlDetected", { name: brand.platform }));
      }
    }
    onChange(next);
  }

  async function pickIcon() {
    const path = await open({ filters: [{ name: t("common.imageFilter"), extensions: ["png", "jpg", "jpeg", "webp", "ico", "bmp"] }] });
    if (typeof path !== "string") return;
    const info = await api.iconUploadCustom(path);
    onChange({ ...value, icon: info.iconRef });
  }

  return (
    <div className="wizard-overlay">
      <div className={"card dialog-card" + (compact ? " account-editor-mobile" : "")}>
        <div className="card-head"><div className="card-title">{value.id ? (compact ? t("accounts.editCompact") : t("accounts.editTitle")) : (compact ? t("accounts.addCompact") : t("accounts.addTitle"))}</div></div>
        <div className="card-body stack">
          <div className={compact ? "stack" : "grid-sum"}>
            <div className="field">
              <FieldLabel
                name={t("accounts.platform")}
                tip={t("accounts.platformTip")}
              />
              {value.isPlatformLocked ? (
                <div>
                  <div
                    className="row"
                    style={{
                      gap: 10,
                      padding: "8px 12px",
                      background: "var(--gray-soft)",
                      borderRadius: "8px",
                      border: "1px solid var(--border)",
                      alignItems: "center",
                    }}
                  >
                    <IconMark icon={value.icon} builtins={builtins} label={value.platform} size={24} />
                    <span style={{ fontWeight: 600, fontSize: "14px", flex: 1 }}>{value.platform}</span>
                    <Badge kind="info">{t("accounts.lockedInGroup")}</Badge>
                  </div>
                  <div className="hint" style={{ marginTop: 4 }}>
                    {t("accounts.fromGroup")}
                  </div>
                </div>
              ) : (
                <>
                  <PlatformInput
                    value={value.platform || ""}
                    builtins={builtins}
                    existingPlatforms={uniquePlatforms}
                    existing={existing}
                    autoFocus={!value.platform}
                    onChange={(val) => applyPlatform(val)}
                  />
                  {platformMsg && <div className="hint">{platformMsg}</div>}
                </>
              )}
            </div>
            <div className="field">
              <FieldLabel name={t("accounts.username")} tip={t("accounts.usernameTip")} />
              <input
                className="input"
                inputMode="email"
                autoCapitalize="none"
                autoCorrect="off"
                enterKeyHint="next"
                placeholder={t("accounts.usernamePh")}
                value={value.username || ""}
                onChange={(e) => onChange({ ...value, username: e.target.value })}
              />
            </div>
          </div>

          <div className="field">
            <FieldLabel
              name={value.id ? (value.hasPassword === false ? t("accounts.passwordRefill") : t("accounts.passwordKeep")) : t("accounts.password")}
              tip={t("accounts.passwordTip")}
            />
            <div className={compact ? "stack" : "row"}>
              <input
                className="input"
                type={showPw ? "text" : "password"}
                autoComplete="new-password"
                enterKeyHint="done"
                placeholder={value.id ? (value.hasPassword === false ? t("accounts.passwordRefillPh") : t("accounts.passwordKeepPh")) : t("accounts.passwordPh")}
                value={value.password || ""}
                onChange={(e) => onChange({ ...value, password: e.target.value })}
              />
              <button type="button" className="btn sm" onClick={() => setShowPw((v) => !v)}>
                {showPw ? t("accounts.hide") : t("accounts.show")}
              </button>
            </div>
          </div>

          {!value.isPlatformLocked && (
            <div className="field">
              <label className="field-label">{t("accounts.icon")}</label>
              <div className={compact ? "stack" : "row"}>
                <IconMark icon={value.icon} builtins={builtins} label={value.platform} size={36} />
                <select
                  className="input"
                  value={value.icon?.startsWith("builtin:") ? value.icon : ""}
                  onChange={(e) => onChange({ ...value, icon: e.target.value || undefined })}
                >
                  <option value="">{t("accounts.iconAutoByPlatform")}</option>
                  {builtins.map((b) => (
                    <option key={b.id} value={`builtin:${b.id}`}>{b.name}</option>
                  ))}
                </select>
                <button type="button" className="btn sm" onClick={pickIcon}>{t("accounts.upload")}</button>
              </div>
              <div className="hint">{t("accounts.iconHint")}</div>
            </div>
          )}

          <button type="button" className="btn ghost sm" onClick={() => setShowMore((v) => !v)}>
            {showMore ? t("accounts.less") : t("accounts.more")}
          </button>

          {showMore && (
            <div className="totp-advanced stack">
              <div className="field">
                <FieldLabel name={t("accounts.displayName")} tip={t("accounts.displayNameTip")} />
                <input
                  className="input"
                  placeholder={t("accounts.displayNamePh")}
                  value={value.displayName || ""}
                  onChange={(e) => onChange({ ...value, displayName: e.target.value })}
                />
              </div>
              <div className="field">
                <FieldLabel name={t("accounts.group")} tip={t("accounts.groupTip")} />
                <GroupPicker
                  groups={groups}
                  value={value.group}
                  onChange={(group) => onChange({ ...value, group })}
                />
              </div>
              <div className="field">
                <FieldLabel name={t("accounts.url")} tip={t("accounts.urlTip")} />
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
              <div className="field">
                <FieldLabel name={t("accounts.tags")} tip={t("accounts.tagsTip")} />
                <input
                  className="input"
                  placeholder={t("accounts.tagsPh")}
                  value={(value.tags || []).join(" ")}
                  onChange={(e) => onChange({ ...value, tags: e.target.value.split(/\s+/).filter(Boolean) })}
                />
              </div>
              <div className="field">
                <label className="field-label">{t("accounts.note")}</label>
                <input
                  className="input"
                  placeholder={t("accounts.notePh")}
                  value={value.note || ""}
                  onChange={(e) => onChange({ ...value, note: e.target.value })}
                />
              </div>
              <div className="field">
                <FieldLabel
                  name={t("accounts.linkTotp")}
                  tip={t("accounts.linkTotpTip")}
                />
                <select
                  className="input"
                  value={value.totpRef || ""}
                  onChange={(e) => onChange({ ...value, totpRef: e.target.value || undefined })}
                >
                  <option value="">{t("accounts.noLink")}</option>
                  {totps.map((totp) => (
                    <option key={totp.id} value={totp.id}>{totp.issuer} / {totp.account}</option>
                  ))}
                </select>
                {totps.length === 0 && <div className="hint">{t("accounts.noTotp")}</div>}
              </div>
              <label className="row" style={{ gap: 8 }}>
                <input type="checkbox" checked={!!value.pinned} onChange={(e) => onChange({ ...value, pinned: e.target.checked })} />
                <span>{t("accounts.pinFront")}</span>
              </label>
            </div>
          )}

        </div>
        <div className="card-foot">
          {onDelete ? (
            <button type="button" className="btn danger sm" onClick={onDelete}>{t("common.delete")}</button>
          ) : (
            <span />
          )}
          <div className="row">
            <button type="button" className="btn ghost sm" onClick={onClose}>{t("common.cancel")}</button>
            <button type="button" className="btn primary sm" disabled={busy} onClick={onSave}>{t("common.save")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
