import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ChevronDown,
  ChevronsDown,
  ChevronsUp,
  KeyRound,
  Layers,
  LayoutGrid,
  Link2,
  List,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { api, errMessage, type BuiltinIconInfo, type GroupMeta, type ParsedTotpPreview, type TotpEntry, type TotpImportResult } from "../lib/ipc";
import { copyWithClear, rememberCustomIcon } from "../lib/secretsUi";
import { colorIconRef, platformListIcon } from "../shared/iconColor";
import { findBuiltinAccount, platformEntryMode } from "../shared/iconAliases";
import { Badge, ConfirmDangerDialog, Empty, FieldLabel, ErrorDialog } from "../ui/common";
import { detectTotpInput } from "../lib/totpInput";
import { ReauthDialog } from "../ui/ReauthDialog";
import { BuiltinIconSelect } from "../ui/BuiltinIconSelect";
import { IconMark } from "../ui/IconMark";
import { IconUploadStack } from "../ui/IconColorPicker";
import { GroupManageDialogs, groupManageHandlers } from "../ui/GroupDialog";
import { GroupPicker } from "../ui/GroupPicker";
import { GroupTabs } from "../ui/GroupTabs";
import { OptionSelect } from "../ui/OptionSelect";
import { clipRemainSeconds, formatCode, TotpCodeSlot } from "../ui/TotpCodeSlot";
import { useTranslation } from "react-i18next";
import { clipNote, NOTE_MAX, type TotpEditorState, type TotpModel, type TotpView } from "../shared/hooks/useTotpModel";
import { useOverlayBack } from "../shared/mobileBack";
import { EditPlatformModal } from "./Accounts.shared";

export { formatCode };

export function TotpViewSwitcher({ view, setViewMode }: { view: TotpView; setViewMode: (m: TotpView) => void }) {
  const { t } = useTranslation();
  return (
    <div className="view-switcher">
      <button type="button" className={"view-btn" + (view === "grid" ? " on" : "")} onClick={() => setViewMode("grid")}>
        <LayoutGrid size={13} aria-hidden /> {t("totp.cards")}
      </button>
      <button type="button" className={"view-btn" + (view === "list" ? " on" : "")} onClick={() => setViewMode("list")}>
        <List size={13} aria-hidden /> {t("totp.list")}
      </button>
      <button type="button" className={"view-btn" + (view === "platform" ? " on" : "")} onClick={() => setViewMode("platform")}>
        <Layers size={13} aria-hidden /> {t("totp.byPlatform")}
      </button>
    </div>
  );
}

export function TotpFoldToggle({ m }: { m: TotpModel }) {
  const { t } = useTranslation();
  const allFolded = m.platforms.length > 0 && m.platforms.every((g) => m.collapsed[g.key]);
  const label = allFolded ? t("pages.expandAll") : t("pages.collapseAll");
  return (
    <button
      type="button"
      className={"btn sm" + (allFolded ? " is-folded" : "")}
      aria-pressed={allFolded}
      aria-label={label}
      onClick={() => (allFolded ? m.expandAll() : m.collapseAll())}
    >
      {allFolded ? <ChevronsDown size={13} aria-hidden /> : <ChevronsUp size={13} aria-hidden />}
      {label}
    </button>
  );
}

export function TotpFilters({ m, hideSearch, trailing }: { m: TotpModel; hideSearch?: boolean; trailing?: ReactNode }) {
  const { t } = useTranslation();
  const manage = groupManageHandlers(m);
  return (
    <div className="group-filter-row totp-filters">
      <GroupTabs
        value={m.group}
        onChange={m.setGroup}
        hideZeroCount
        wrapChips
        items={m.groupTabs.map((g) => ({
          key: g,
          label: g === "全部" ? t("common.all") : g === "未分组" ? t("common.ungrouped") : g,
          count: g === "全部" ? m.entries.length : m.entries.filter((e) => (e.group || "未分组") === g).length,
          color: m.groups.find((item) => item.name === g)?.color,
          sortable: g !== "全部" && g !== "未分组",
        }))}
        onCreate={manage.onCreate}
        onEdit={manage.onEdit}
        onDelete={manage.onDelete}
        onReorder={m.writesLocked ? undefined : m.reorderGroups}
        createLabel={t("totp.newGroup")}
        createDisabled={m.writesLocked}
        trailing={trailing}
      />
      {!hideSearch && (
        <label className="totp-search">
          <Search size={14} className="totp-search-icon" aria-hidden />
          <input
            className="input"
            type="search"
            placeholder={t("totp.search")}
            value={m.q}
            onChange={(e) => m.setQ(e.target.value)}
          />
        </label>
      )}
    </div>
  );
}

export function TotpEmpty({ m, mobile }: { m: TotpModel; mobile?: boolean }) {
  const { t } = useTranslation();
  const hasFilter = !!m.q.trim() || m.group !== "全部";
  const groupLabel = m.group === "全部" ? t("common.all") : m.group === "未分组" ? t("common.ungrouped") : m.group;
  const text = hasFilter
    ? t("totp.emptyFiltered", { group: groupLabel, q: m.q.trim() || t("common.emDash") })
    : mobile
      ? t("totp.emptyMobile")
      : t("totp.empty");
  return (
    <div className="totp-empty">
      <Empty icon={hasFilter ? "🔎" : "⏳"} text={text} />
      {hasFilter && (
        <button type="button" className="btn sm" onClick={m.clearFilters}>
          {t("totp.clearFilters")}
        </button>
      )}
    </div>
  );
}

export function TotpEntries({ m, forceList }: { m: TotpModel; forceList?: boolean }) {
  if (!forceList && m.view === "platform") {
    return <TotpPlatformGroups m={m} />;
  }
  if (!forceList && m.view === "grid") {
    return (
      <div className="totp-grid">
        {m.filtered.map((e) => (
          <TotpCard key={e.id} e={e} m={m} />
        ))}
      </div>
    );
  }

  return (
    <div className="totp-list-card">
      {m.filtered.map((e) => (
        <TotpListRow key={e.id} e={e} m={m} />
      ))}
    </div>
  );
}

export function TotpPlatformGroups({
  m,
  renderRow,
  variant = "desktop",
}: {
  m: TotpModel;
  renderRow?: (e: TotpEntry) => ReactNode;
  variant?: "desktop" | "mobile";
}) {
  const { t } = useTranslation();
  const mobile = variant === "mobile";
  return (
    <div className={mobile ? "m-platform-stack" : "totp-platform-stack"}>
      {m.platforms.map((g) => {
        const folded = !!m.collapsed[g.key];
        const name = g.name || t("totp.unnamed");
        const iconItem = platformListIcon(name, g.list.map((e) => e.icon), m.builtins) || g.icon;
        const siteUrl = g.list.find((e) => e.url)?.url;
        const HeaderTag = mobile ? "div" : "button";
        return (
          <section
            key={g.key}
            className={(mobile ? "m-platform-group" : "platform-group") + (folded ? (mobile ? " is-folded" : " collapsed") : "")}
          >
            <HeaderTag
              {...(mobile
                ? {
                    role: "button" as const,
                    tabIndex: 0,
                    onKeyDown: (ev: ReactKeyboardEvent) => {
                      if (ev.key === "Enter" || ev.key === " ") {
                        ev.preventDefault();
                        m.setCollapsed((prev) => ({ ...prev, [g.key]: !prev[g.key] }));
                      }
                    },
                  }
                : { type: "button" as const })}
              className={mobile ? "m-platform-header" : "platform-header"}
              aria-expanded={!folded}
              onClick={() => m.setCollapsed((prev) => ({ ...prev, [g.key]: !prev[g.key] }))}
            >
              <div className={mobile ? "m-platform-header-left" : "platform-title"}>
                <ChevronDown
                  size={mobile ? 16 : 15}
                  className={(mobile ? "m-platform-chevron" : "chevron") + (folded ? (mobile ? " is-folded" : " rot") : "")}
                  aria-hidden
                />
                <IconMark icon={iconItem} builtins={m.builtins} label={name} size={mobile ? 32 : 28} />
                {mobile ? (
                  <div className="m-platform-copy">
                    <span className="m-platform-name">{name}</span>
                    <span className="m-platform-count">{t("totp.accountCount", { n: g.list.length })}</span>
                  </div>
                ) : (
                  <>
                    <span>{name}</span>
                    {siteUrl && (
                      <span
                        role="button"
                        tabIndex={0}
                        className="btn ghost sm"
                        style={{ padding: "2px 5px", display: "inline-flex", alignItems: "center" }}
                        title={t("totp.openSite")}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          void api.openUrl(siteUrl);
                        }}
                      >
                        <Link2 size={12} aria-hidden />
                      </span>
                    )}
                    <Badge kind="info">{t("totp.accountCount", { n: g.list.length })}</Badge>
                  </>
                )}
                {siteUrl && mobile && (
                  <button
                    type="button"
                    className="m-platform-link"
                    title={t("totp.openSite")}
                    aria-label={t("totp.openSite")}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      void api.openUrl(siteUrl);
                    }}
                  >
                    <Link2 size={14} aria-hidden />
                  </button>
                )}
              </div>
              <div className={mobile ? "m-totp-platform-ops" : "row"} style={mobile ? undefined : { gap: 4 }} onClick={(ev) => ev.stopPropagation()}>
                <button
                  type="button"
                  className={mobile ? "m-totp-platform-edit" : "btn ghost sm"}
                  style={mobile ? undefined : { padding: "4px 8px" }}
                  disabled={m.writesLocked}
                  title={t("totp.editPlatform")}
                  aria-label={t("totp.editPlatformLabel")}
                  onClick={() =>
                    m.setEditingPlatformModal({
                      key: g.key,
                      platform: g.name,
                      icon: iconItem,
                    })
                  }
                >
                  <Pencil size={mobile ? 15 : 12} aria-hidden />
                  {!mobile && t("totp.editPlatformLabel")}
                </button>
                <button
                  type="button"
                  className={mobile ? "m-totp-platform-add" : "btn sm"}
                  disabled={m.writesLocked}
                  title={t("pages.add")}
                  aria-label={t("pages.add")}
                  onClick={() =>
                    m.setEditor({
                      issuer: g.name || "",
                      icon: iconItem,
                      url: siteUrl,
                      isPlatformLocked: true,
                    })
                  }
                >
                  <Plus size={mobile ? 16 : 12} aria-hidden />
                  {!mobile && t("pages.add")}
                </button>
              </div>
            </HeaderTag>
            {!folded && (
              <div className={mobile ? "m-account-list" : "platform-body"}>
                {g.list.map((e) => (renderRow ? renderRow(e) : <TotpPlatformRow key={e.id} e={e} m={m} />))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

export function totpSlotProps(m: TotpModel, e: TotpEntry) {
  return {
    entry: e,
    shown: m.codes[e.id],
    copied: m.copiedId === e.id,
    clipRemain: clipRemainSeconds(m.clipHint[e.id], m.nowMs),
    nowMs: m.nowMs,
    onReveal: () => void m.reveal(e.id),
    onHide: () => m.hideCode(e.id),
    onCopy: () => void m.copyCode(e.id),
    onEdit: () => void m.openExistingEditor(e),
  };
}

function TotpListRow({ e, m }: { e: TotpEntry; m: TotpModel }) {
  return (
    <div className="totp-list-row" data-focus-id={e.id} {...totpContextMenuProps(m, e)}>
      <div className="totp-list-identity">
        <IconMark icon={e.icon} builtins={m.builtins} label={e.issuer} size={32} />
        <div className="totp-id-copy">
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            <ExpandableText className="totp-card-issuer" text={e.issuer} />
            {e.group && <Badge kind="info">{e.group}</Badge>}
          </div>
          <ExpandableText className="totp-card-account" text={e.account} />
          {e.note?.trim() && (
            <ExpandableText className="totp-card-note" text={clipNote(e.note)} full={e.note.trim()} />
          )}
        </div>
      </div>
      <div className="totp-list-code">
        <TotpCodeSlot {...totpSlotProps(m, e)} />
      </div>
      <div className="totp-list-actions">
        <TotpQuickActions e={e} m={m} />
      </div>
    </div>
  );
}

function TotpPlatformRow({ e, m }: { e: TotpEntry; m: TotpModel }) {
  return (
    <div className="totp-platform-row" data-focus-id={e.id} {...totpContextMenuProps(m, e)}>
      <div className="totp-list-identity">
        <IconMark icon={e.icon} builtins={m.builtins} label={e.issuer} size={28} />
        <div className="totp-id-copy">
          <ExpandableText className="totp-card-issuer" text={e.issuer || e.account} />
          <ExpandableText className="totp-card-account" text={e.account} />
          {e.note?.trim() && (
            <ExpandableText className="totp-card-note" text={clipNote(e.note)} full={e.note.trim()} />
          )}
        </div>
      </div>
      <div className="totp-list-code">
        <TotpCodeSlot {...totpSlotProps(m, e)} />
      </div>
      <div className="totp-list-actions">
        <TotpQuickActions e={e} m={m} />
      </div>
    </div>
  );
}

export function TotpDialogs({ m, skipEditor }: { m: TotpModel; skipEditor?: boolean; includeScanHits?: boolean }) {
  const { t } = useTranslation();
  useOverlayBack(!skipEditor && !!m.editor, () => m.setEditor(null));
  useOverlayBack(!!m.groupDlg, () => m.setGroupDlg(null));
  useOverlayBack(!!m.pendingDeleteGroup, () => m.setPendingDeleteGroup(null));
  useOverlayBack(!!m.reauth, () => m.reauthCancel.current?.());
  useOverlayBack(!!m.secretDlg, () => m.setSecretDlg(null));
  useOverlayBack(!!m.pendingDelete, () => m.setPendingDelete(null));
  useOverlayBack(!!m.batchImport, () => m.setBatchImport(null));
  useOverlayBack(!!m.editingPlatformModal, () => m.setEditingPlatformModal(null));
  return (
    <>
      <ErrorDialog message={m.err} onClose={() => m.setErr("")} />

      {m.reauth && (
        <ReauthDialog
          onCancel={() => m.reauthCancel.current?.()}
          onConfirm={async (pw) => {
            await m.reauth!(pw);
          }}
        />
      )}

      <GroupManageDialogs
        groups={m.groups}
        groupDlg={m.groupDlg}
        pendingDeleteGroup={m.pendingDeleteGroup}
        busy={m.busy}
        onCancel={() => m.setGroupDlg(null)}
        onConfirm={m.saveGroup}
        onCancelDelete={() => m.setPendingDeleteGroup(null)}
        onConfirmDelete={() => void m.confirmDeleteGroup()}
        deleteCount={m.entries.filter((e) => e.group === m.pendingDeleteGroup).length}
      />

      {m.editingPlatformModal && (
        <EditPlatformModal
          originalPlatform={m.editingPlatformModal.platform}
          currentIcon={m.editingPlatformModal.icon}
          builtins={m.builtins}
          busy={m.busy}
          title={t("totp.platformTitle")}
          syncHint={t("totp.platformSync", {
            name: m.editingPlatformModal.platform || t("totp.unnamed"),
          })}
          onError={m.setErr}
          onCancel={() => m.setEditingPlatformModal(null)}
          onConfirm={async (newName, newIcon) => {
            await m.updatePlatformBrand(m.editingPlatformModal!.key, newName, newIcon);
          }}
        />
      )}

      {!skipEditor && m.editor && (
        <Editor
          key={m.editor.id || m.editor.secret || "new"}
          value={m.editor}
          builtins={m.builtins}
          groups={m.groups}
          busy={m.busy}
          onChange={m.setEditor}
          onClose={() => m.setEditor(null)}
          onSave={m.saveEditor}
          onDelete={
            m.editor.id
              ? () => {
                  const entry = m.entries.find((item) => item.id === m.editor?.id);
                  if (!entry) return;
                  m.setEditor(null);
                  m.deleteEntry(entry);
                }
              : undefined
          }
          deleteDisabled={m.writesLocked}
          onMigration={!m.editor.id ? (uri) => { m.setEditor(null); void m.ingestImportTexts([uri]); } : undefined}
          onReorderGroups={m.writesLocked ? undefined : m.reorderGroups}
        />
      )}

      {m.secretDlg && (
        <SecretDialog dlg={m.secretDlg} onConfirm={m.confirmSecret} onClose={() => m.setSecretDlg(null)} />
      )}

      {m.batchImport && (
        <BatchImportDialog
          result={m.batchImport}
          entries={m.entries}
          groups={m.groups}
          busy={m.busy}
          locked={m.writesLocked}
          onCancel={() => m.setBatchImport(null)}
          onImport={(selected, group) => void m.confirmBatchImport(selected, group)}
          onReorderGroups={m.writesLocked ? undefined : m.reorderGroups}
        />
      )}

      {m.pendingDelete && (
        <ConfirmDangerDialog
          title={t("totp.deleteTitle")}
          message={t("totp.deleteMsg", { name: `${m.pendingDelete.issuer} / ${m.pendingDelete.account}` })}
          detail={t("totp.deleteDetail")}
          busy={m.busy}
          onCancel={() => m.setPendingDelete(null)}
          onConfirm={() => void m.confirmDeleteEntry()}
        />
      )}
    </>
  );
}

function SecretDialog({
  dlg,
  onConfirm,
  onClose,
}: {
  dlg: { id: string; secret?: string; uri?: string; qr?: string };
  onConfirm: (pw: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="wizard-overlay">
      <div className="card" style={{ width: 420 }}>
        <div className="card-head"><div className="card-title">{t("totp.secretTitle")}</div></div>
        <div className="card-body stack">
          {!dlg.secret ? (
            <ReauthInner hint={t("totp.secretReauth")} onConfirm={onConfirm} onCancel={onClose} />
          ) : (
            <>
              {dlg.qr && <img alt="otpauth qr" src={`data:image/png;base64,${dlg.qr}`} style={{ width: 180, height: 180, margin: "0 auto", display: "block" }} />}
              <div className="field">
                <label className="field-label">{t("totp.base32")}</label>
                <div className="row">
                  <input className="input mono" readOnly value={dlg.secret} />
                  <button type="button" className="btn sm" onClick={() => copyWithClear(dlg.secret!)}>{t("common.copy")}</button>
                </div>
              </div>
              <div className="field">
                <label className="field-label">{t("totp.otpauth")}</label>
                <div className="row">
                  <input className="input mono" readOnly value={dlg.uri} />
                  <button type="button" className="btn sm" onClick={() => copyWithClear(dlg.uri!)}>{t("common.copy")}</button>
                </div>
              </div>
              <button type="button" className="btn primary sm" onClick={onClose}>{t("common.close")}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function itemKey(e: ParsedTotpPreview) {
  return `${e.issuer}\0${e.account}\0${e.secret || ""}`;
}

function BatchImportDialog({
  result,
  entries,
  groups,
  busy,
  locked,
  onCancel,
  onImport,
  onReorderGroups,
}: {
  result: TotpImportResult;
  entries: TotpEntry[];
  groups: GroupMeta[];
  busy: boolean;
  locked: boolean;
  onCancel: () => void;
  onImport: (selected: ParsedTotpPreview[], group?: string) => void;
  onReorderGroups?: (orderedNames: string[]) => void;
}) {
  const { t } = useTranslation();
  const existing = new Set(entries.map((e) => `${e.issuer.toLowerCase()}\0${e.account.toLowerCase()}`));
  const [picked, setPicked] = useState<Set<string>>(() => {
    const next = new Set<string>();
    for (const e of result.entries) {
      const dup = existing.has(`${e.issuer.toLowerCase()}\0${e.account.toLowerCase()}`);
      if (!dup) next.add(itemKey(e));
    }
    return next;
  });
  const [group, setGroup] = useState("");

  const selectedCount = picked.size;
  const allKeys = result.entries.map(itemKey);
  const allOn = allKeys.length > 0 && allKeys.every((k) => picked.has(k));

  function toggle(key: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAll() {
    setPicked(allOn ? new Set() : new Set(allKeys));
  }

  const isGoogle = result.source === "google-migration";
  return (
    <div className="wizard-overlay">
      <div className="card dialog-card totp-batch-dialog">
        <div className="card-head">
          <div className="card-title">{isGoogle ? t("totp.batchGoogle") : t("totp.batchTitle")}</div>
        </div>
        <div className="card-body stack">
          <div className="hint">
            {isGoogle && result.batchSize > 1
              ? t("totp.batchPage", { index: result.batchIndex + 1, size: result.batchSize, n: result.entries.length })
              : t("totp.batchCount", { n: result.entries.length })}
            {result.skippedHotp > 0 ? ` ${t("totp.batchHotpSkipped", { n: result.skippedHotp })}` : ""}
          </div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <button type="button" className="btn ghost sm" onClick={toggleAll}>
              {allOn ? t("totp.batchSelectNone") : t("totp.batchSelectAll")}
            </button>
            <span className="muted">{t("totp.batchPicked", { n: selectedCount })}</span>
          </div>
          <div className="totp-batch-list">
            {result.entries.map((e) => {
              const key = itemKey(e);
              const dup = existing.has(`${e.issuer.toLowerCase()}\0${e.account.toLowerCase()}`);
              const on = picked.has(key);
              return (
                <label key={key} className={"totp-batch-item" + (on ? " on" : "") + (dup ? " dup" : "")}>
                  <input type="checkbox" checked={on} onChange={() => toggle(key)} />
                  <span>
                    <b>{e.issuer}</b>
                    <span className="muted"> · {e.account}</span>
                    {dup && <span className="totp-batch-dup">{t("totp.batchAlready")}</span>}
                    <div className="muted">{e.algorithm} · {t("totp.digits", { n: e.digits })}</div>
                  </span>
                </label>
              );
            })}
          </div>
          <div className="field">
            <FieldLabel name={t("totp.group")} tip={t("totp.batchGroupTip")} />
            <GroupPicker groups={groups} value={group} onChange={setGroup} onReorder={onReorderGroups} />
          </div>
        </div>
        <div className="card-foot">
          <button type="button" className="btn ghost sm" onClick={onCancel}>{t("common.cancel")}</button>
          <button
            type="button"
            className="btn primary sm"
            disabled={busy || locked || selectedCount === 0}
            onClick={() => onImport(result.entries.filter((e) => picked.has(itemKey(e))), group || undefined)}
          >
            {t("totp.batchImport", { n: selectedCount })}
          </button>
        </div>
      </div>
    </div>
  );
}

function ExpandableText({
  text,
  full,
  className,
}: {
  text: string;
  full?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const shown = full || text;
  if (!text) return null;
  return (
    <span
      className={"totp-expandable" + (open ? " is-open" : "") + (className ? ` ${className}` : "")}
      tabIndex={0}
      title={shown}
      aria-label={shown}
      aria-expanded={open}
      onClick={() => setOpen((v) => !v)}
      onKeyDown={(ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          setOpen((v) => !v);
        }
      }}
    >
      {open ? shown : text}
      <span className="sr-only">{open ? t("common.close") : t("totp.expandName")}</span>
    </span>
  );
}

export type TotpActionItem = {
  key: "edit" | "site" | "secret" | "delete";
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
};

export function totpActionItems(
  e: TotpEntry,
  m: TotpModel,
  t: (key: string) => string,
  iconSize = 14,
): TotpActionItem[] {
  const seedMissing = e.hasSeed === false;
  const items: TotpActionItem[] = [
    {
      key: "edit",
      label: t("totp.edit"),
      icon: <Pencil size={iconSize} aria-hidden />,
      disabled: m.writesLocked,
      onClick: () => void m.openExistingEditor(e),
    },
  ];
  if (e.url) {
    const url = e.url;
    items.push({
      key: "site",
      label: t("totp.openSite"),
      icon: <Link2 size={iconSize} aria-hidden />,
      onClick: () => void api.openUrl(url),
    });
  }
  items.push(
    {
      key: "secret",
      label: seedMissing ? t("totp.secretLostHint") : t("totp.showSecret"),
      icon: <KeyRound size={iconSize} aria-hidden />,
      disabled: seedMissing,
      onClick: () => m.openSecret(e.id),
    },
    {
      key: "delete",
      label: t("totp.delete"),
      icon: <Trash2 size={iconSize} aria-hidden />,
      disabled: m.writesLocked,
      danger: true,
      onClick: () => m.deleteEntry(e),
    },
  );
  return items;
}

/** 悬停或键盘聚焦到条目时才显现；删除只放在编辑弹窗和右键菜单里。 */
export function TotpQuickActions({ e, m }: { e: TotpEntry; m: TotpModel }) {
  const { t } = useTranslation();
  const items = totpActionItems(e, m, t).filter((item) => item.key !== "delete");
  return (
    <div className="totp-quick-actions">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          className="totp-quick-btn"
          disabled={item.disabled}
          aria-label={item.label}
          title={item.label}
          onClick={(ev) => {
            ev.stopPropagation();
            item.onClick();
          }}
        >
          {item.icon}
        </button>
      ))}
    </div>
  );
}

export function totpContextMenuProps(m: TotpModel, e: TotpEntry) {
  return {
    onContextMenu: (ev: ReactMouseEvent<HTMLElement>) => {
      ev.preventDefault();
      let x = ev.clientX;
      let y = ev.clientY;
      // 键盘菜单键触发时没有指针坐标，退回到条目左上角。
      if (x === 0 && y === 0) {
        const rect = ev.currentTarget.getBoundingClientRect();
        x = rect.left + 16;
        y = rect.top + 16;
      }
      m.openContextMenu(e.id, x, y);
    },
  };
}

const MENU_PAD = 8;

export function TotpContextMenu({ m }: { m: TotpModel }) {
  const { t } = useTranslation();
  const popRef = useRef<HTMLDivElement>(null);
  const ctx = m.ctxMenu;
  const entry = ctx ? m.entries.find((e) => e.id === ctx.id) : undefined;
  const close = m.closeContextMenu;
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!ctx) {
      setPos(null);
      return;
    }
    const pop = popRef.current;
    if (!pop) return;
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const left = Math.max(MENU_PAD, Math.min(ctx.x, window.innerWidth - MENU_PAD - w));
    const top = ctx.y + h > window.innerHeight - MENU_PAD ? Math.max(MENU_PAD, ctx.y - h) : ctx.y;
    setPos({ top, left });
    pop.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [ctx]);

  useEffect(() => {
    if (!ctx) return;
    function onDoc(ev: PointerEvent) {
      if (!popRef.current?.contains(ev.target as Node)) close();
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") close();
    }
    document.addEventListener("pointerdown", onDoc, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", onDoc, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [ctx, close]);

  if (!ctx || !entry) return null;

  function onMenuKey(ev: ReactKeyboardEvent<HTMLDivElement>) {
    if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
    ev.preventDefault();
    const buttons = [...(popRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    if (buttons.length === 0) return;
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const step = ev.key === "ArrowDown" ? 1 : -1;
    buttons[(at + step + buttons.length) % buttons.length].focus();
  }

  const items = totpActionItems(entry, m, t);
  return createPortal(
    <div
      ref={popRef}
      className="totp-menu"
      role="menu"
      aria-label={entry.issuer || t("totp.unnamed")}
      style={{
        position: "fixed",
        top: pos?.top ?? ctx.y,
        left: pos?.left ?? ctx.x,
        visibility: pos ? "visible" : "hidden",
      }}
      onContextMenu={(ev) => ev.preventDefault()}
      onKeyDown={onMenuKey}
    >
      {items.map((item) => (
        <Fragment key={item.key}>
          {item.danger && <div className="totp-menu-sep" role="separator" />}
          <button
            type="button"
            role="menuitem"
            className={"totp-menu-item" + (item.danger ? " is-danger" : "")}
            disabled={item.disabled}
            onClick={() => {
              close();
              item.onClick();
            }}
          >
            <span className="totp-menu-item-icon">{item.icon}</span>
            <span>{item.label}</span>
          </button>
        </Fragment>
      ))}
    </div>,
    document.body,
  );
}

function TotpCard({ e, m }: { e: TotpEntry; m: TotpModel }) {
  return (
    <div className="totp-card" data-focus-id={e.id} {...totpContextMenuProps(m, e)}>
      <div className="totp-card-head">
        <div className="row" style={{ minWidth: 0, gap: 10 }}>
          <IconMark icon={e.icon} builtins={m.builtins} label={e.issuer} size={36} />
          <div className="totp-id-copy">
            <ExpandableText className="totp-card-issuer" text={e.issuer} />
            <ExpandableText className="totp-card-account" text={e.account} />
            {e.note?.trim() && (
              <ExpandableText className="totp-card-note" text={clipNote(e.note)} full={e.note.trim()} />
            )}
          </div>
        </div>
        <div className="totp-card-head-end">
          {e.group && <Badge kind="info">{e.group}</Badge>}
          <TotpQuickActions e={e} m={m} />
        </div>
      </div>
      <TotpCodeSlot {...totpSlotProps(m, e)} />
    </div>
  );
}

function ReauthInner({ hint, onConfirm, onCancel }: { hint: string; onConfirm: (pw: string) => Promise<void>; onCancel: () => void }) {
  const { t } = useTranslation();
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [allowBio, setAllowBio] = useState(false);
  useEffect(() => {
    api.biometricStatus().then((s) => setAllowBio(!!s.revealSecret && s.enabled && s.available)).catch(() => {});
  }, []);
  return (
    <div className="stack">
      <div className="muted">{hint}</div>
      <input className="input" type="password" placeholder={t("reauth.password")} value={pw} onChange={(e) => setPw(e.target.value)} />
      {err && <div className="callout danger sm">{err}</div>}
      <div className="row">
        <button type="button" className="btn ghost sm" onClick={onCancel}>{t("common.cancel")}</button>
        {allowBio && (
          <button
            type="button"
            className="btn ghost sm"
            onClick={async () => {
              try {
                await onConfirm("");
              } catch (e) {
                setErr(errMessage(e));
              }
            }}
          >
            {t("totp.useBio")}
          </button>
        )}
        <button
          type="button"
          className="btn primary sm"
          onClick={async () => {
            try {
              await onConfirm(pw);
            } catch (e) {
              setErr(errMessage(e));
            }
          }}
        >
          {t("totp.verifyShow")}
        </button>
      </div>
    </div>
  );
}

function Editor({
  value, builtins, groups, busy, onChange, onClose, onSave, onDelete, deleteDisabled, onMigration, onReorderGroups,
}: {
  value: TotpEditorState;
  builtins: BuiltinIconInfo[];
  groups: GroupMeta[];
  busy: boolean;
  onChange: (v: TotpEditorState) => void;
  onClose: () => void;
  onSave: () => void;
  onDelete?: () => void;
  deleteDisabled?: boolean;
  onMigration?: (uri: string) => void;
  onReorderGroups?: (orderedNames: string[]) => void;
}) {
  const { t } = useTranslation();
  const [secretDraft, setSecretDraft] = useState(value.secret || "");
  const detected = detectTotpInput(secretDraft);
  const nonDefaultAlgo =
    (value.algorithm && value.algorithm !== "SHA1") ||
    (value.digits && value.digits !== 6) ||
    (value.period && value.period !== 30);
  const [showAdvanced, setShowAdvanced] = useState(!!nonDefaultAlgo);
  const [platformMode, setPlatformMode] = useState<"builtin" | "custom">("builtin");
  const platformSync = useRef("");
  useEffect(() => {
    if (builtins.length === 0) return;
    const key = value.id || "new";
    if (platformSync.current === key) return;
    platformSync.current = key;
    setPlatformMode(platformEntryMode(builtins, value.issuer, value.icon));
  }, [value, builtins]);
  const pickedBuiltin = findBuiltinAccount(builtins, value.issuer, value.icon);

  function chooseBuiltinIssuer() {
    setPlatformMode("builtin");
    const hit = findBuiltinAccount(builtins, value.issuer, value.icon);
    if (!hit) {
      onChange({
        ...value,
        issuer: "",
        icon: value.icon?.startsWith("custom:") ? value.icon : undefined,
      });
      return;
    }
    onChange({
      ...value,
      issuer: hit.name,
      icon: value.icon?.startsWith("custom:") ? value.icon : `builtin:${hit.id}`,
    });
  }

  function chooseCustomIssuer() {
    setPlatformMode("custom");
    if (value.icon?.startsWith("builtin:")) onChange({ ...value, icon: undefined });
  }

  function chooseListedBuiltin(next: string) {
    if (!next) {
      onChange({
        ...value,
        issuer: "",
        icon: value.icon?.startsWith("custom:") ? value.icon : undefined,
      });
      return;
    }
    const hit = builtins.find((item) => `builtin:${item.id}` === next);
    if (!hit) return;
    onChange({
      ...value,
      issuer: hit.name,
      icon: value.icon?.startsWith("custom:") ? value.icon : next,
    });
  }

  function applySecretDraft(next: string) {
    setSecretDraft(next);
    const d = detectTotpInput(next);
    if (d.kind === "migration") {
      if (onMigration && /data=/i.test(next)) {
        onMigration(next.trim());
      } else {
        onChange({ ...value, secret: undefined });
      }
      return;
    }
    if (d.kind === "otpauth") {
      const issuerRaw = d.issuer || value.issuer || "";
      const keepCustom = value.icon?.startsWith("custom:");
      const matched = findBuiltinAccount(builtins, issuerRaw);
      if (!value.isPlatformLocked) {
        if (matched) setPlatformMode("builtin");
        else if (issuerRaw.trim()) setPlatformMode("custom");
      }
      onChange({
        ...value,
        secret: d.secret,
        issuer: value.isPlatformLocked ? value.issuer : matched ? matched.name : issuerRaw,
        account: d.account || value.account,
        algorithm: d.algorithm || value.algorithm || "SHA1",
        digits: d.digits || value.digits || 6,
        period: d.period || value.period || 30,
        icon: value.isPlatformLocked ? value.icon : keepCustom ? value.icon : matched ? `builtin:${matched.id}` : value.icon,
      });
      if ((d.algorithm && d.algorithm !== "SHA1") || d.digits !== 6 || d.period !== 30) {
        setShowAdvanced(true);
      }
    } else if (d.kind === "base32") {
      onChange({ ...value, secret: d.secret });
    } else {
      onChange({ ...value, secret: next.trim() || undefined });
    }
  }

  async function pickIcon() {
    const path = await open({ filters: [{ name: t("common.imageFilter"), extensions: ["png", "jpg", "jpeg", "webp", "ico", "bmp"] }] });
    if (typeof path !== "string") return;
    const info = await api.iconUploadCustom(path);
    rememberCustomIcon(info.iconRef, info.dataUrl);
    onChange({ ...value, icon: info.iconRef });
  }

  const detectKind = detected.kind === "otpauth" || detected.kind === "migration" ? "good" : detected.kind === "base32" ? "info" : detected.kind === "unknown" ? "warn" : "";

  return (
    <div className="wizard-overlay">
      <div className="card totp-editor dialog-card">
        <div className="card-head"><div className="card-title">{value.id ? t("totp.editTitle") : t("totp.addTitle")}</div></div>
        <div className="card-body stack">
          <div className="field">
            <FieldLabel
              name={value.id ? (value.hasSeed === false ? t("totp.secretRefill") : t("totp.secretChange")) : t("totp.secretLabel")}
              tip={t("totp.secretTip")}
            />
            <textarea
              className="input mono totp-secret-box"
              rows={3}
              autoFocus={!value.id}
              value={secretDraft}
              placeholder={value.id ? t("totp.secretKeep") : t("totp.secretPh")}
              onChange={(e) => applySecretDraft(e.target.value)}
            />
            <div className={"hint" + (detectKind ? "" : "")}>{detected.message}</div>
            {detectKind && (
              <div className={"callout sm " + detectKind} style={{ marginTop: 6 }}>
                {detected.kind === "otpauth" && t("totp.detectedOtpauth")}
                {detected.kind === "migration" && t("totp.detectedMigration")}
                {detected.kind === "base32" && t("totp.detectedBase32")}
                {detected.kind === "unknown" && t("totp.detectedUnknown")}
              </div>
            )}
            <div className="field-example">
              {t("totp.exampleSecret")}<code>JBSW Y3DP EHPK 3PXP</code>
              <br />
              {t("totp.exampleUri")}<code>otpauth://totp/GitHub:you@mail.com?secret=JBSWY3DPEHPK3PXP</code>
            </div>
          </div>

          <div className="totp-advanced stack">
            <div className="field">
              <FieldLabel name={t("totp.issuer")} tip={t("totp.issuerTip")} />
              {value.isPlatformLocked ? (
                <div>
                  <div className="platform-brand is-locked">
                    <IconMark icon={value.icon} builtins={builtins} label={value.issuer || t("totp.unnamed")} size={36} />
                    <div className="platform-brand-main">
                      <span className="platform-brand-name">{value.issuer || t("totp.unnamed")}</span>
                      <Badge kind="info">{t("totp.lockedInGroup")}</Badge>
                    </div>
                  </div>
                  <div className="hint" style={{ marginTop: 4 }}>{t("totp.fromGroup")}</div>
                </div>
              ) : (
              <div className="platform-brand">
                <IconUploadStack
                  icon={value.icon}
                  builtins={builtins}
                  label={value.issuer}
                  size={44}
                  onPickColor={(hex) => onChange({ ...value, icon: colorIconRef(hex) })}
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
                          builtins={builtins}
                          autoLabel={t("accounts.platformBuiltinPh")}
                          onChange={chooseListedBuiltin}
                        />
                      </div>
                    ) : (
                      <input
                        className="input"
                        value={value.issuer || ""}
                        placeholder={t("totp.issuerPh")}
                        onChange={(e) => {
                          const raw = e.target.value;
                          const matched = findBuiltinAccount(builtins, raw);
                          if (matched && raw.trim().toLowerCase() === matched.name.toLowerCase()) {
                            setPlatformMode("builtin");
                            onChange({
                              ...value,
                              issuer: matched.name,
                              icon: value.icon?.startsWith("custom:") ? value.icon : `builtin:${matched.id}`,
                            });
                            return;
                          }
                          onChange({ ...value, issuer: raw });
                        }}
                      />
                    )}
                  </div>
                </div>
              </div>
              )}
            </div>
            <div className="field">
              <FieldLabel name={t("totp.account")} tip={t("totp.accountTip")} />
              <input
                className="input"
                value={value.account || ""}
                placeholder={t("totp.accountPh")}
                onChange={(e) => onChange({ ...value, account: e.target.value })}
              />
            </div>
          </div>

          <div className="field">
            <FieldLabel name={t("totp.group")} tip={t("totp.groupTip")} />
            <GroupPicker
              groups={groups}
              value={value.group}
              onChange={(group) => onChange({ ...value, group })}
              onReorder={onReorderGroups}
            />
          </div>
          <div className="field">
            <FieldLabel name={t("totp.url")} tip={t("totp.urlTip")} />
            <input className="input" placeholder="https://github.com/login" value={value.url || ""} onChange={(e) => onChange({ ...value, url: e.target.value })} />
          </div>
          <div className="field">
            <FieldLabel name={t("totp.note")} tip={t("totp.noteTip")} />
            <input
              className="input"
              maxLength={NOTE_MAX}
              placeholder={t("totp.notePh")}
              value={value.note || ""}
              onChange={(e) => onChange({ ...value, note: e.target.value.slice(0, NOTE_MAX) })}
            />
            <div className="hint">{(value.note || "").length}/{NOTE_MAX}</div>
          </div>

          <button type="button" className="btn ghost sm" onClick={() => setShowAdvanced((v) => !v)}>
            {showAdvanced ? t("totp.less") : t("totp.more")}
          </button>
          {showAdvanced && (
            <div className="totp-advanced">
              <div className="hint" style={{ marginBottom: 6 }}>{t("totp.advHint")}</div>
              <div className="row">
                <div className="field" style={{ flex: 1 }}>
                  <label className="field-label">{t("totp.algo")}</label>
                  <OptionSelect
                    title={t("totp.algo")}
                    value={value.algorithm || "SHA1"}
                    onChange={(next) => onChange({ ...value, algorithm: next })}
                    options={[
                      { value: "SHA1", label: "SHA1" },
                      { value: "SHA256", label: "SHA256" },
                      { value: "SHA512", label: "SHA512" },
                    ]}
                  />
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <label className="field-label">{t("totp.digitsLabel")}</label>
                  <OptionSelect
                    title={t("totp.digitsLabel")}
                    value={String(value.digits || 6)}
                    onChange={(next) => onChange({ ...value, digits: Number(next) })}
                    options={[
                      { value: "6", label: t("totp.digits6") },
                      { value: "8", label: t("totp.digits8") },
                    ]}
                  />
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <label className="field-label">{t("totp.period")}</label>
                  <input className="input" type="number" min={1} value={value.period || 30} onChange={(e) => onChange({ ...value, period: Number(e.target.value) })} />
                </div>
              </div>
            </div>
          )}

        </div>
        <div className="card-foot">
          {onDelete ? (
            <button type="button" className="btn sm danger" disabled={busy || deleteDisabled} onClick={onDelete}>
              <Trash2 size={13} aria-hidden /> {t("totp.delete")}
            </button>
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
