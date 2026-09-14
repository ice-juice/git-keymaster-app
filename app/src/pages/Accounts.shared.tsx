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
import { type AccountsModel } from "../shared/hooks/useAccountsModel";

export function AccountsFilters({ m, hideSearch }: { m: AccountsModel; hideSearch?: boolean }) {
  return (
    <div className="row between">
      <div className="group-tabs">
        {m.tabs.map((g) => {
          const count = g === "全部" ? m.entries.length : m.entries.filter((e) => (e.group || "未分组") === g).length;
          const color = m.groups.find((item) => item.name === g)?.color;
          return (
            <button key={g} type="button" className={"group-tab" + (m.group === g ? " on" : "")} onClick={() => m.setGroup(g)}>
              {color && <span className="group-tab-dot" style={{ background: color }} />}
              <span>{g}</span>
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
          + 新建分组
        </button>
      </div>
      {!hideSearch && (
        <input className="input" style={{ maxWidth: 280 }} placeholder="检索平台 / 账号 / 标签 (多词 AND)" value={m.q} onChange={(e) => m.setQ(e.target.value)} />
      )}
    </div>
  );
}

export function AccountsList({ m, compact }: { m: AccountsModel; compact?: boolean }) {
  if (m.platforms.length === 0) {
    return <Empty text={compact ? "还没有账密。" : "还没有隐私账号。"} />;
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
                    title="打开官方网站"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      void api.openUrl(list.find((item) => item.url)!.url!);
                    }}
                  >
                    <ExternalLink size={12} />
                  </span>
                )}
                <Badge kind="info">{list.length} 个账号</Badge>
              </div>
              <div className="row" style={{ gap: 4 }} onClick={(ev) => ev.stopPropagation()}>
                <button
                  type="button"
                  className="btn ghost sm"
                  style={{ padding: "4px 8px" }}
                  title="统一修改该平台的名称和图标"
                  onClick={() =>
                    m.setEditingPlatformModal({
                      platform,
                      icon: list.find((e) => e.icon)?.icon ?? undefined,
                    })
                  }
                >
                  <Pencil size={12} /> 编辑平台
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
                  <Plus size={12} /> 添加
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
                          {e.pinned && <Badge kind="warn">置顶</Badge>}
                          {e.tags?.map((t) => (
                            <Badge key={t}>{t}</Badge>
                          ))}
                        </div>
                        <div className="account-meta">
                          {e.displayName && <span>{e.displayName}</span>}
                          {e.displayName && e.note && <span>·</span>}
                          {e.note && <span className="muted">{e.note}</span>}
                          {(e.displayName || e.note) && e.lastUsedAt && <span>·</span>}
                          {e.lastUsedAt && (
                            <span className="muted" title="最近使用时间">
                              使用: {e.lastUsedAt.slice(0, 16)}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="account-mid">
                        {e.totpRef && (
                          <div className="linked-totp" title="关联 2FA 动态令牌">
                            <span className="linked-totp-badge">2FA</span>
                            {linked ? (
                              <div
                                className="row"
                                style={{ gap: 6, cursor: "pointer" }}
                                onClick={() => m.copyLinkedTotp(e.totpRef!)}
                                title="点击快速复制 2FA 验证码"
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
                                  title="显示 2FA 验证码"
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
                                title="复制验证码"
                                onClick={() => m.copyLinkedTotp(e.totpRef!)}
                              >
                                {isCopiedTotp ? <Check size={11} /> : <Copy size={11} />}
                              </button>
                            )}
                          </div>
                        )}

                        {pwMissing && (
                          <div className="callout danger sm">密码已丢失，请编辑并重新填入。</div>
                        )}
                        <div className="pwd-box">
                          <span className="mono">{m.pwShown[e.id] || "••••••••"}</span>
                          {m.pwShown[e.id] ? (
                            <button
                              type="button"
                              className="btn ghost sm"
                              style={{ padding: "1px 4px" }}
                              title="隐藏密码"
                              onClick={() => m.hidePw(e.id)}
                            >
                              <EyeOff size={12} />
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="btn ghost sm"
                              style={{ padding: "1px 4px" }}
                              title={pwMissing ? "密码已丢失" : "显示明文"}
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
                            title={pwMissing ? "密码已丢失" : "复制密码"}
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
                          title="复制用户名"
                          onClick={() => m.copyUsername(e.id, e.username)}
                        >
                          {isCopiedUser ? <Check size={12} /> : <Copy size={12} />} 账号
                        </button>
                        <button
                          type="button"
                          className="btn ghost sm"
                          title="查看密码历史版本"
                          onClick={() => m.openHistory(e.id)}
                        >
                          <Clock size={13} />
                        </button>
                        <button
                          type="button"
                          className="btn sm"
                          disabled={m.writesLocked}
                          title="编辑账号"
                          onClick={() => m.setEditor({ ...e })}
                        >
                          编辑
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
  const [name, setName] = useState(originalPlatform);
  const [icon, setIcon] = useState<string | undefined>(currentIcon);

  async function pickIcon() {
    const path = await open({
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "ico", "bmp"] }],
    });
    if (typeof path !== "string") return;
    const info = await api.iconUploadCustom(path);
    setIcon(info.iconRef);
  }

  return (
    <div className="wizard-overlay" style={{ zIndex: 60 }}>
      <div className="card dialog-card" style={{ width: 440, maxWidth: "95vw" }} onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <div className="card-title">编辑平台信息</div>
        </div>
        <div className="card-body stack" style={{ gap: 14 }}>
          <div className="field">
            <FieldLabel name="平台名称" tip="平台统一显示名称，保存后该平台下的所有账号将统一更名。" />
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="请输入平台名称"
            />
          </div>

          <div className="field">
            <label className="field-label">统一图标</label>
            <div className="row" style={{ gap: 10 }}>
              <IconMark icon={icon} builtins={builtins} label={name} size={36} />
              <select
                className="input"
                style={{ flex: 1 }}
                value={icon?.startsWith("builtin:") ? icon : ""}
                onChange={(e) => setIcon(e.target.value || undefined)}
              >
                <option value="">自动匹配</option>
                {builtins.map((b) => (
                  <option key={b.id} value={`builtin:${b.id}`}>{b.name}</option>
                ))}
              </select>
              <button type="button" className="btn sm" onClick={pickIcon}>上传</button>
            </div>
          </div>

          <div className="hint">
            修改后将一次性同步更新「{originalPlatform}」分组下所有账号的平台名称和图标。
          </div>
        </div>
        <div className="card-foot" style={{ justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn ghost sm" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="btn primary sm"
            disabled={busy || !name.trim()}
            onClick={() => void onConfirm(name, icon)}
          >
            {busy ? "正在保存…" : "确认修改"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function AccountsDialogs({ m, compact }: { m: AccountsModel; compact?: boolean }) {
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

      {m.editor && !m.pendingDelete && (
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
          title="删除账号确认"
          message={
            <>
              确定要删除隐私账号「<strong>{m.pendingDelete.platform}</strong>
              {m.pendingDelete.username ? ` / ${m.pendingDelete.username}` : ""}」吗？
            </>
          }
          detail="删除后本机不再保存这条账密和密码历史，也无法用访问密码找回。云端要再推送一次才会同步到其他设备。"
          busy={m.busy}
          onCancel={() => m.setPendingDelete(null)}
          onConfirm={() => void m.confirmDeleteEditorAccount()}
        />
      )}
    </>
  );
}

function AccountsHistoryDialog({ m }: { m: AccountsModel }) {
  const historyFor = m.historyFor;
  if (!historyFor) return null;
  return (
    <div className="wizard-overlay">
      <div className="card" style={{ width: 460, maxWidth: "96vw" }} onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <div className="card-title">密码历史版本记录</div>
          <button type="button" className="btn ghost sm" onClick={() => m.setHistoryFor(null)}>
            关闭
          </button>
        </div>
        <div className="card-body stack">
          {historyFor.items.length === 0 ? (
            <div className="muted" style={{ padding: "16px 0", textAlign: "center" }}>
              暂无历史版本记录。
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
                          {isLatest && <Badge kind="good">最新历史</Badge>}
                        </div>
                        <div className="muted" style={{ fontSize: "11px" }}>
                          替换时间: {h.replacedAt}
                        </div>
                      </div>
                      <div className="row" style={{ gap: 5 }}>
                        {!shownPw ? (
                          <button type="button" className="btn sm" onClick={() => m.revealHistory(h.index)}>
                            查看
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn sm"
                            title="复制此密码"
                            onClick={() => copyWithClear(shownPw)}
                          >
                            <Copy size={12} /> 复制
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn sm"
                          disabled={m.writesLocked}
                          title="将密码回滚到此版本"
                          onClick={() => m.rollbackHistory(h.index, h.replacedAt)}
                        >
                          回滚
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
                清空历史
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
        placeholder="例如 GitHub，或 https://github.com/login"
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
              {item.isExisting && <Badge kind="info">已有</Badge>}
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
    setPlatformMsg(
      d.kind === "url"
        ? d.message
        : hasSibling && brand.platform !== raw.trim()
          ? `已对齐已有平台「${brand.platform}」的大小写规范。`
          : d.message,
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
        setPlatformMsg(`已识别网址，平台填为「${brand.platform}」。`);
      }
    }
    onChange(next);
  }

  async function pickIcon() {
    const path = await open({ filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "ico", "bmp"] }] });
    if (typeof path !== "string") return;
    const info = await api.iconUploadCustom(path);
    onChange({ ...value, icon: info.iconRef });
  }

  return (
    <div className="wizard-overlay">
      <div className={"card dialog-card" + (compact ? " account-editor-mobile" : "")}>
        <div className="card-head"><div className="card-title">{value.id ? (compact ? "编辑账密" : "编辑账号") : (compact ? "添加账密" : "添加账号")}</div></div>
        <div className="card-body stack">
          <div className={compact ? "stack" : "grid-sum"}>
            <div className="field">
              <FieldLabel
                name="平台"
                tip="这个账号属于哪个网站。也可以直接粘贴登录页网址，会自动拆出平台名和链接。"
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
                    <Badge kind="info">组内锁定</Badge>
                  </div>
                  <div className="hint" style={{ marginTop: 4 }}>
                    从已有平台组添加，平台与图标已与该分组绑定。
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
              <FieldLabel name="用户名" tip="登录用的邮箱、手机号或用户名。列表里可直接复制这一项。" />
              <input
                className="input"
                inputMode="email"
                autoCapitalize="none"
                autoCorrect="off"
                enterKeyHint="next"
                placeholder="例如 you@mail.com"
                value={value.username || ""}
                onChange={(e) => onChange({ ...value, username: e.target.value })}
              />
            </div>
          </div>

          <div className="field">
            <FieldLabel
              name={value.id ? (value.hasPassword === false ? "重新填入密码（必填）" : "密码（留空则不改）") : "密码"}
              tip="改密会自动留下旧密码，可在卡片上的时钟入口查看或回滚。"
            />
            <div className={compact ? "stack" : "row"}>
              <input
                className="input"
                type={showPw ? "text" : "password"}
                autoComplete="new-password"
                enterKeyHint="done"
                placeholder={value.id ? (value.hasPassword === false ? "请重新填入密码" : "不改请留空") : "登录密码"}
                value={value.password || ""}
                onChange={(e) => onChange({ ...value, password: e.target.value })}
              />
              <button type="button" className="btn sm" onClick={() => setShowPw((v) => !v)}>
                {showPw ? "隐藏" : "显示"}
              </button>
            </div>
          </div>

          {!value.isPlatformLocked && (
            <div className="field">
              <label className="field-label">图标</label>
              <div className={compact ? "stack" : "row"}>
                <IconMark icon={value.icon} builtins={builtins} label={value.platform} size={36} />
                <select
                  className="input"
                  value={value.icon?.startsWith("builtin:") ? value.icon : ""}
                  onChange={(e) => onChange({ ...value, icon: e.target.value || undefined })}
                >
                  <option value="">按平台名自动匹配</option>
                  {builtins.map((b) => (
                    <option key={b.id} value={`builtin:${b.id}`}>{b.name}</option>
                  ))}
                </select>
                <button type="button" className="btn sm" onClick={pickIcon}>上传</button>
              </div>
              <div className="hint">可不选。填 GitHub、Google 等常见平台会自动套对应图标。</div>
            </div>
          )}

          <button type="button" className="btn ghost sm" onClick={() => setShowMore((v) => !v)}>
            {showMore ? "收起更多选项" : "更多选项（显示名、分组、网址、2FA…）"}
          </button>

          {showMore && (
            <div className="totp-advanced stack">
              <div className="field">
                <FieldLabel name="显示名" tip="同一平台有多个号时用来区分，例如「公司号」「个人号」。不填则列表只显示用户名。" />
                <input
                  className="input"
                  placeholder="例如 公司号"
                  value={value.displayName || ""}
                  onChange={(e) => onChange({ ...value, displayName: e.target.value })}
                />
              </div>
              <div className="field">
                <FieldLabel name="分组" tip="点选已有分组，或直接输入新名称。留空表示不分组。" />
                <GroupPicker
                  groups={groups}
                  value={value.group}
                  onChange={(group) => onChange({ ...value, group })}
                />
              </div>
              <div className="field">
                <FieldLabel name="登录网址" tip="可选。填了之后能从卡片打开该网站。若还没填平台，粘贴网址也会自动识别。" />
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
                <FieldLabel name="标签" tip="可选，多个标签用空格分开，方便搜索。" />
                <input
                  className="input"
                  placeholder="例如 work personal"
                  value={(value.tags || []).join(" ")}
                  onChange={(e) => onChange({ ...value, tags: e.target.value.split(/\s+/).filter(Boolean) })}
                />
              </div>
              <div className="field">
                <label className="field-label">备注</label>
                <input
                  className="input"
                  placeholder="可选，只有你自己能看到"
                  value={value.note || ""}
                  onChange={(e) => onChange({ ...value, note: e.target.value })}
                />
              </div>
              <div className="field">
                <FieldLabel
                  name="联动 2FA"
                  tip="如果这个账号的验证码已经存在「2FA / TOTP」里，选中后卡片上就能一起看。"
                />
                <select
                  className="input"
                  value={value.totpRef || ""}
                  onChange={(e) => onChange({ ...value, totpRef: e.target.value || undefined })}
                >
                  <option value="">不联动</option>
                  {totps.map((t) => (
                    <option key={t.id} value={t.id}>{t.issuer} / {t.account}</option>
                  ))}
                </select>
                {totps.length === 0 && <div className="hint">还没有 TOTP 条目。可先到「2FA / TOTP」添加，再回来关联。</div>}
              </div>
              <label className="row" style={{ gap: 8 }}>
                <input type="checkbox" checked={!!value.pinned} onChange={(e) => onChange({ ...value, pinned: e.target.checked })} />
                <span>置顶到该平台最前面</span>
              </label>
            </div>
          )}

        </div>
        <div className="card-foot">
          {onDelete ? (
            <button type="button" className="btn danger sm" onClick={onDelete}>删除</button>
          ) : (
            <span />
          )}
          <div className="row">
            <button type="button" className="btn ghost sm" onClick={onClose}>取消</button>
            <button type="button" className="btn primary sm" disabled={busy} onClick={onSave}>保存</button>
          </div>
        </div>
      </div>
    </div>
  );
}
