import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Eye, EyeOff, LayoutGrid, List, Copy, KeyRound, Trash2, Link2, Check } from "lucide-react";
import { api, errMessage, type BuiltinIconInfo, type GroupMeta, type ParsedTotpPreview, type TotpEntry, type TotpImportResult } from "../lib/ipc";
import { copyWithClear } from "../lib/secretsUi";
import { Badge, ConfirmDangerDialog, FieldLabel, ErrorDialog } from "../ui/common";
import { detectTotpInput } from "../lib/totpInput";
import { ReauthDialog } from "../ui/ReauthDialog";
import { IconMark } from "../ui/IconMark";
import { CountdownRing } from "../ui/CountdownRing";
import { GroupDialog } from "../ui/GroupDialog";
import { GroupPicker } from "../ui/GroupPicker";
import { GroupTabs } from "../ui/GroupTabs";
import { useTranslation } from "react-i18next";
import { clipNote, NOTE_MAX, type TotpModel } from "../shared/hooks/useTotpModel";
import { useOverlayBack } from "../shared/mobileBack";

export function formatCode(code: string) {
  if (code.length === 6) return `${code.slice(0, 3)} ${code.slice(3)}`;
  if (code.length === 8) return `${code.slice(0, 4)} ${code.slice(4)}`;
  return code;
}

export function TotpViewSwitcher({ view, setViewMode }: { view: "grid" | "list"; setViewMode: (m: "grid" | "list") => void }) {
  const { t } = useTranslation();
  return (
    <div className="view-switcher">
      <button type="button" className={"view-btn" + (view === "grid" ? " on" : "")} onClick={() => setViewMode("grid")}>
        <LayoutGrid size={13} /> {t("totp.cards")}
      </button>
      <button type="button" className={"view-btn" + (view === "list" ? " on" : "")} onClick={() => setViewMode("list")}>
        <List size={13} /> {t("totp.list")}
      </button>
    </div>
  );
}

export function TotpFilters({ m, hideSearch }: { m: TotpModel; hideSearch?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="group-filter-row">
      <GroupTabs
        value={m.group}
        onChange={m.setGroup}
        items={m.groupTabs.map((g) => ({
          key: g,
          label: g === "全部" ? t("common.all") : g === "未分组" ? t("common.ungrouped") : g,
          count: g === "全部" ? m.entries.length : m.entries.filter((e) => (e.group || "未分组") === g).length,
          color: m.groups.find((item) => item.name === g)?.color,
          sortable: g !== "全部" && g !== "未分组",
        }))}
        onCreate={() => m.setGroupDlg(true)}
        onReorder={m.writesLocked ? undefined : m.reorderGroups}
        createLabel={t("totp.newGroup")}
        createDisabled={m.writesLocked}
      />
      {!hideSearch && (
        <input className="input" style={{ maxWidth: 260 }} placeholder={t("totp.search")} value={m.q} onChange={(e) => m.setQ(e.target.value)} />
      )}
    </div>
  );
}

export function TotpEntries({ m, forceList }: { m: TotpModel; forceList?: boolean }) {
  const { t } = useTranslation();
  if (!forceList && m.view === "grid") {
    return (
      <div className="totp-grid">
        {m.filtered.map((e) => (
          <TotpCard
            key={e.id}
            e={e}
            builtins={m.builtins}
            shown={m.codes[e.id]}
            copied={m.copiedId === e.id}
            onReveal={() => m.reveal(e.id)}
            onHide={() => m.hideCode(e.id)}
            onCopy={() => m.copyCode(e.id)}
            onSecret={() => m.openSecret(e.id)}
            onEdit={() => m.setEditor({ ...e })}
            onDelete={() => m.deleteEntry(e)}
            locked={m.writesLocked}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="totp-list-card">
      {m.filtered.map((e) => {
        const shown = m.codes[e.id];
        const seedMissing = e.hasSeed === false;
        const isCopied = m.copiedId === e.id;
        return (
          <div key={e.id} className="totp-list-row" data-focus-id={e.id}>
            <div className="totp-list-identity">
              <IconMark icon={e.icon} builtins={m.builtins} label={e.issuer} size={32} />
              <div style={{ minWidth: 0, overflow: "hidden" }}>
                <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                  <span className="totp-card-issuer">{e.issuer}</span>
                  {e.group && <Badge kind="info">{e.group}</Badge>}
                  {e.url && (
                    <button
                      type="button"
                      className="btn ghost sm"
                      style={{ padding: "0 2px" }}
                      title={t("totp.openSite")}
                      onClick={() => api.openUrl(e.url!)}
                    >
                      <Link2 size={12} />
                    </button>
                  )}
                </div>
                <div className="totp-card-account">{e.account}</div>
                {e.note?.trim() && (
                  <div className="totp-card-note" title={e.note.trim()}>
                    {clipNote(e.note)}
                  </div>
                )}
              </div>
            </div>

            <div className="totp-list-code">
              {shown ? (
                <div
                  className="row"
                  style={{
                    background: "var(--gray-soft)",
                    padding: "4px 10px",
                    borderRadius: "8px",
                    gap: 10,
                    cursor: "pointer",
                  }}
                  title={t("totp.copyCodeQuick")}
                  onClick={() => m.copyCode(e.id)}
                >
                  <span className="totp-code" style={{ fontSize: "18px" }}>
                    {formatCode(shown.code)}
                  </span>
                  <CountdownRing
                    remain={shown.remain}
                    period={shown.period || e.period || 30}
                    size={26}
                  />
                </div>
              ) : (
                <button type="button" className="btn sm" onClick={() => m.reveal(e.id)}>
                  <Eye size={12} /> {t("totp.viewCode")}
                </button>
              )}
            </div>

            <div className="totp-list-actions">
              <button
                type="button"
                className={"btn sm " + (isCopied ? "good" : "primary")}
                title={seedMissing ? t("totp.secretLost") : t("totp.copyCode")}
                disabled={seedMissing}
                onClick={() => m.copyCode(e.id)}
              >
                {isCopied ? <Check size={12} /> : <Copy size={12} />}
              </button>
              {shown && (
                <button
                  type="button"
                  className="btn sm"
                  title={t("totp.hideCode")}
                  onClick={() => m.hideCode(e.id)}
                >
                  <EyeOff size={12} />
                </button>
              )}
              <button
                type="button"
                className="btn sm"
                title={seedMissing ? t("totp.secretLostHint") : t("totp.showSecret")}
                disabled={seedMissing}
                onClick={() => m.openSecret(e.id)}
              >
                <KeyRound size={12} />
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={m.writesLocked}
                title={t("totp.edit")}
                onClick={() => m.setEditor({ ...e })}
              >
                {t("common.edit")}
              </button>
              <button
                type="button"
                className="btn sm danger"
                disabled={m.writesLocked}
                title={t("totp.delete")}
                onClick={() => m.deleteEntry(e)}
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function TotpDialogs({ m, skipEditor }: { m: TotpModel; skipEditor?: boolean; includeScanHits?: boolean }) {
  const { t } = useTranslation();
  useOverlayBack(!skipEditor && !!m.editor, () => m.setEditor(null));
  useOverlayBack(!!m.groupDlg, () => m.setGroupDlg(false));
  useOverlayBack(!!m.reauth, () => m.reauthCancel.current?.());
  useOverlayBack(!!m.secretDlg, () => m.setSecretDlg(null));
  useOverlayBack(!!m.pendingDelete, () => m.setPendingDelete(null));
  useOverlayBack(!!m.batchImport, () => m.setBatchImport(null));
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

      {m.groupDlg && (
        <GroupDialog
          existing={m.groups.map((g) => g.name)}
          onCancel={() => m.setGroupDlg(false)}
          onConfirm={m.saveGroup}
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

function TotpCard({
  e,
  builtins,
  shown,
  copied,
  onReveal,
  onHide,
  onCopy,
  onSecret,
  onEdit,
  onDelete,
  locked,
}: {
  e: TotpEntry;
  builtins: BuiltinIconInfo[];
  shown?: { code: string; remain: number; period: number };
  copied?: boolean;
  onReveal: () => void;
  onHide: () => void;
  onCopy: () => void;
  onSecret: () => void;
  onEdit: () => void;
  onDelete: () => void;
  locked: boolean;
}) {
  const { t } = useTranslation();
  const seedMissing = e.hasSeed === false;
  return (
    <div className="totp-card" data-focus-id={e.id}>
      <div className="totp-card-head">
        <div className="row" style={{ minWidth: 0, gap: 10 }}>
          <IconMark icon={e.icon} builtins={builtins} label={e.issuer} size={36} />
          <div style={{ minWidth: 0, overflow: "hidden" }}>
            <div className="totp-card-issuer" title={e.issuer}>
              {e.issuer}
            </div>
            <div className="totp-card-account" title={e.account}>
              {e.account}
            </div>
            {e.note?.trim() && (
              <div className="totp-card-note" title={e.note.trim()}>
                {clipNote(e.note)}
              </div>
            )}
          </div>
        </div>
        <div className="row" style={{ gap: 4 }}>
          {e.group && <Badge kind="info">{e.group}</Badge>}
          {e.url && (
            <button
              type="button"
              className="btn ghost sm"
              title={t("totp.openSite")}
              onClick={() => api.openUrl(e.url!)}
            >
              <Link2 size={13} />
            </button>
          )}
        </div>
      </div>

      {seedMissing && (
        <div className="callout danger sm">{t("totp.secretLostEdit")}</div>
      )}

      <div
        className={"totp-code-box" + (shown ? " revealed" : "")}
        title={shown ? t("totp.copyQuick") : undefined}
        onClick={shown ? onCopy : undefined}
      >
        {shown ? (
          <>
            <span className="totp-code">{formatCode(shown.code)}</span>
            <CountdownRing remain={shown.remain} period={shown.period || e.period || 30} />
          </>
        ) : (
          <>
            <span className="totp-code masked">••••••</span>
            <button
              type="button"
              className="btn sm primary"
              disabled={seedMissing}
              onClick={(ev) => {
                ev.stopPropagation();
                onReveal();
              }}
            >
              <Eye size={13} /> {t("totp.view")}
            </button>
          </>
        )}
      </div>

      <div className="totp-card-actions">
        <button
          type="button"
          className={"btn sm " + (copied ? "good" : "primary")}
          style={{ flex: 1 }}
          disabled={seedMissing}
          onClick={onCopy}
        >
          {copied ? (
            <>
              <Check size={13} /> {t("totp.copied")}
            </>
          ) : (
            <>
              <Copy size={13} /> {t("totp.copyCode")}
            </>
          )}
        </button>
        {shown && (
          <button
            type="button"
            className="btn sm"
            title={t("totp.hideCode")}
            onClick={onHide}
          >
            <EyeOff size={13} />
          </button>
        )}
        <button
          type="button"
          className="btn sm"
          title={seedMissing ? t("totp.secretLostHint") : t("totp.secretExportTip")}
          disabled={seedMissing || locked}
          onClick={onSecret}
        >
          <KeyRound size={13} />
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={locked}
          title={t("totp.edit")}
          onClick={onEdit}
        >
          {t("common.edit")}
        </button>
        <button
          type="button"
          className="btn sm danger"
          disabled={locked}
          title={t("totp.delete")}
          onClick={onDelete}
        >
          <Trash2 size={13} />
        </button>
      </div>
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
  value, builtins, groups, busy, onChange, onClose, onSave, onMigration, onReorderGroups,
}: {
  value: Partial<TotpEntry> & { secret?: string };
  builtins: BuiltinIconInfo[];
  groups: GroupMeta[];
  busy: boolean;
  onChange: (v: Partial<TotpEntry> & { secret?: string }) => void;
  onClose: () => void;
  onSave: () => void;
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
      onChange({
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
      onChange({ ...value, secret: d.secret });
    } else {
      onChange({ ...value, secret: next.trim() || undefined });
    }
  }

  async function pickIcon() {
    const path = await open({ filters: [{ name: t("common.imageFilter"), extensions: ["png", "jpg", "jpeg", "webp", "ico", "bmp"] }] });
    if (typeof path !== "string") return;
    const info = await api.iconUploadCustom(path);
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

          <div className="grid-sum">
            <div className="field">
              <FieldLabel name={t("totp.issuer")} tip={t("totp.issuerTip")} />
              <input
                className="input"
                value={value.issuer || ""}
                placeholder={t("totp.issuerPh")}
                onChange={(e) => onChange({ ...value, issuer: e.target.value })}
              />
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
            <label className="field-label">{t("totp.icon")}</label>
            <div className="row">
              <IconMark icon={value.icon} builtins={builtins} label={value.issuer} size={36} />
              <select className="input" value={value.icon?.startsWith("builtin:") ? value.icon : ""} onChange={(e) => onChange({ ...value, icon: e.target.value || undefined })}>
                <option value="">{t("totp.iconAuto")}</option>
                {builtins.map((b) => (
                  <option key={b.id} value={`builtin:${b.id}`}>{b.name}</option>
                ))}
              </select>
              <button type="button" className="btn sm" onClick={pickIcon}>{t("totp.upload")}</button>
            </div>
            <div className="hint">{t("totp.iconHint")}</div>
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
                  <select className="input" value={value.algorithm || "SHA1"} onChange={(e) => onChange({ ...value, algorithm: e.target.value })}>
                    <option>SHA1</option><option>SHA256</option><option>SHA512</option>
                  </select>
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <label className="field-label">{t("totp.digitsLabel")}</label>
                  <select className="input" value={value.digits || 6} onChange={(e) => onChange({ ...value, digits: Number(e.target.value) })}>
                    <option value={6}>{t("totp.digits6")}</option><option value={8}>{t("totp.digits8")}</option>
                  </select>
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
          <span />
          <div className="row">
            <button type="button" className="btn ghost sm" onClick={onClose}>{t("common.cancel")}</button>
            <button type="button" className="btn primary sm" disabled={busy} onClick={onSave}>{t("common.save")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
