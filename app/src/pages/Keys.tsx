import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, Eye, KeyRound, Pencil, Trash2, X } from "lucide-react";
import { api, errCode, errMessage, type KeyRecord, type ScannedKey } from "../lib/ipc";
import { writeClipboard } from "../lib/clipboard";
import { downloadTextFile } from "../shared/certgen";
import {
  classifyKeyUse,
  describeKeyUse,
  gitHostingBlocksKeyDelete,
  identityNamesLosingKey,
  isRsaPubExportable,
  keyVisible,
  matchesKeySearch,
  opensshPubDownloadName,
  opensshPubFileBody,
  opensshPublicComment,
  rsaPemDownloadName,
  type KeyAlgoFilter,
  type KeyGroupFilter,
  type KeyUseCopy,
} from "../shared/keyCatalog";
import { PageHead, Card, Empty, Badge } from "../ui/common";
import { KeyExportMenu } from "../ui/KeyExportMenu";
import { useApp } from "../store";
import { can } from "../platform/capabilities";
import { isMobilePlatform } from "../platform/resolve";

type Copied = "" | "pub" | "priv" | "pass";

async function copyKeyText(text: string, secret = false) {
  await writeClipboard(text.replace(/\r\n/g, "\n").trim() + "\n", secret);
}

export function Keys() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"vault" | "scan">("vault");
  const [keys, setKeys] = useState<KeyRecord[]>([]);
  const [identities, setIdentities] = useState<Awaited<ReturnType<typeof api.listIdentities>>>([]);
  const [scanned, setScanned] = useState<ScannedKey[]>([]);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [genComment, setGenComment] = useState("");
  const [genName, setGenName] = useState("");
  const [showGen, setShowGen] = useState(false);
  const [viewing, setViewing] = useState<KeyRecord | null>(null);
  const [editing, setEditing] = useState<KeyRecord | null>(null);
  const [pemTarget, setPemTarget] = useState<KeyRecord | null>(null);
  const [pendingDelete, setPendingDelete] = useState<KeyRecord | null>(null);
  const [query, setQuery] = useState("");
  const [scanQuery, setScanQuery] = useState("");
  const [groupFilter, setGroupFilter] = useState<KeyGroupFilter>("all");
  const [algoFilter, setAlgoFilter] = useState<KeyAlgoFilter>("all");
  const [tagBusyId, setTagBusyId] = useState("");
  const { writesLocked, dataVersion } = useApp();
  const mobile = isMobilePlatform();
  const useCopy: KeyUseCopy = useMemo(
    () => ({
      git: t("keys.groupGit"),
      server: t("keys.groupServer"),
      unattached: t("keys.groupUnattached"),
      exportOnly: t("keys.intentExport"),
    }),
    [t],
  );

  async function loadVault() {
    try {
      const [nextKeys, nextIdentities] = await Promise.all([api.listKeys(), api.listIdentities()]);
      setKeys(nextKeys);
      setIdentities(nextIdentities);
    } catch (e) {
      setErr(errMessage(e));
    }
  }
  async function loadScan() {
    setErr("");
    try {
      setScanned(await api.scanKeys());
    } catch (e) {
      setErr(errMessage(e));
    }
  }

  useEffect(() => {
    loadVault();
  }, [dataVersion]);

  async function doGenerate() {
    setErr("");
    setMsg("");
    setBusy(true);
    try {
      const k = await api.generateKey(genComment || "git-keymaster", genName || undefined);
      setMsg(t("keys.generated", { name: k.name, fp: k.fingerprint }));
      setShowGen(false);
      setGenComment("");
      setGenName("");
      await loadVault();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function importPath(p: string) {
    setErr("");
    setMsg("");
    setBusy(true);
    try {
      const k = await api.importKeyFromPath(p);
      setMsg(t("keys.imported", { name: k.name }));
      await loadVault();
      await loadScan();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function changeTag(k: KeyRecord, purposeIntent: string) {
    if ((k.purposeIntent ?? "") === purposeIntent) return true;
    setErr("");
    setMsg("");
    setTagBusyId(k.id);
    try {
      const updated = await api.setKeyPurposeIntent(k.id, purposeIntent);
      setKeys((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      setMsg(t("keys.tagSaved", { name: updated.name }));
      return true;
    } catch (e) {
      setErr(errMessage(e));
      return false;
    } finally {
      setTagBusyId("");
    }
  }

  async function exportPublicFile(k: KeyRecord) {
    setErr("");
    setMsg("");
    try {
      const saved = await downloadTextFile(
        opensshPubDownloadName(k.algorithm, k.name),
        opensshPubFileBody(k.publicOpenssh),
      );
      if (saved) setMsg(t("keys.exportSaved"));
    } catch (e) {
      setErr(errMessage(e));
    }
  }

  function deleteKeyError(e: unknown): string {
    const code = errCode(e);
    const raw = errMessage(e);
    if (code === "LOCKED" || code === "NOT_INITIALIZED") return t("keys.deleteLocked");
    if (code === "BUSY") return t("keys.deleteBusy");
    if (raw.includes("已被 Git 托管身份使用")) return t("keys.deleteBlocked");
    return raw;
  }

  async function confirmDelete(k: KeyRecord) {
    setErr("");
    setMsg("");
    setTagBusyId(k.id);
    try {
      await api.deleteKey(k.id);
      setPendingDelete(null);
      setMsg(t("keys.deleteDone", { name: k.name }));
      if (viewing?.id === k.id) setViewing(null);
      if (editing?.id === k.id) setEditing(null);
      if (pemTarget?.id === k.id) setPemTarget(null);
      await loadVault();
    } catch (e) {
      setErr(deleteKeyError(e));
    } finally {
      setTagBusyId("");
    }
  }

  const visibleKeys = useMemo(
    () =>
      keys.filter((k) => {
        const classification = classifyKeyUse(k.id, identities);
        const described = describeKeyUse(classification, k.purposeIntent ?? "", useCopy);
        return keyVisible({
          classification,
          intent: k.purposeIntent ?? "",
          algorithm: k.algorithm,
          fields: {
            name: k.name,
            fingerprint: k.fingerprint,
            algorithm: k.algorithm,
            comment: opensshPublicComment(k.publicOpenssh),
            labels: described.searchLabels,
          },
          query,
          group: groupFilter,
          algo: algoFilter,
        });
      }),
    [keys, identities, useCopy, query, groupFilter, algoFilter],
  );

  const visibleScan = useMemo(
    () =>
      scanned.filter((s) => {
        const vault = keys.find((k) => k.fingerprint === s.info.fingerprint);
        const labels = vault
          ? describeKeyUse(classifyKeyUse(vault.id, identities), vault.purposeIntent ?? "", useCopy).searchLabels
          : [];
        return matchesKeySearch(
          {
            name: s.path,
            fingerprint: s.info.fingerprint,
            algorithm: s.info.algorithm,
            comment: s.info.comment,
            labels,
          },
          scanQuery,
        );
      }),
    [scanned, keys, identities, useCopy, scanQuery],
  );

  const showMobilePubHint = mobile && visibleKeys.some((k) => isRsaPubExportable(k.algorithm, k.publicOpenssh));

  return (
    <div className="stack-lg">
      <PageHead
        title={t("keys.title")}
        desc={t("keys.desc")}
        actions={
          <>
            <button className="btn primary" disabled={writesLocked} onClick={() => setShowGen((v) => !v)}>
              {t("keys.generateNew")}
            </button>
          </>
        }
      />
      {err && <div className="err-text">{err}</div>}
      {msg && <div className="callout info">{msg}</div>}

      {showGen && (
        <Card title={t("keys.generateTitle")}>
          <div className="stack">
            <div className="field">
              <label className="field-label">{t("keys.nameOptional")}</label>
              <input className="input" value={genName} onChange={(e) => setGenName(e.target.value)} />
            </div>
            <div className="field">
              <label className="field-label">{t("keys.comment")}</label>
              <input
                className="input"
                placeholder="nova.reyes@example.com"
                value={genComment}
                onChange={(e) => setGenComment(e.target.value)}
              />
            </div>
            <div className="row">
              <button className="btn primary" disabled={busy} onClick={doGenerate}>
                {busy ? t("keys.generating") : t("keys.generateSave")}
              </button>
              <button className="btn ghost" onClick={() => setShowGen(false)}>
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </Card>
      )}

      {can("localGitTools") && (
      <div className="tabs">
        <button className={"tab" + (tab === "vault" ? " active" : "")} onClick={() => setTab("vault")}>
          {t("keys.vaultKeys")}
        </button>
        <button
          className={"tab" + (tab === "scan" ? " active" : "")}
          onClick={() => {
            setTab("scan");
            loadScan();
          }}
        >
          {t("keys.systemScan")}
        </button>
      </div>
      )}

      {tab === "vault" && (
        <Card>
          <div className="stack">
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <input
                className="input"
                value={query}
                placeholder={t("keys.searchPh")}
                aria-label={t("keys.search")}
                onChange={(e) => setQuery(e.target.value)}
                style={{ flex: "1 1 220px" }}
              />
              <select
                className="input"
                aria-label={t("keys.filterGroup")}
                value={groupFilter}
                onChange={(e) => setGroupFilter(e.target.value as KeyGroupFilter)}
              >
                <option value="all">{t("keys.filterAll")}</option>
                <option value="git">{t("keys.groupGit")}</option>
                <option value="server">{t("keys.groupServer")}</option>
                <option value="unattached">{t("keys.groupUnattached")}</option>
              </select>
              <select
                className="input"
                aria-label={t("keys.filterAlgo")}
                value={algoFilter}
                onChange={(e) => setAlgoFilter(e.target.value as KeyAlgoFilter)}
              >
                <option value="all">{t("keys.algoAll")}</option>
                <option value="rsa">{t("keys.algoRsa")}</option>
                <option value="ed25519">{t("keys.algoEd25519")}</option>
              </select>
            </div>
            {showMobilePubHint && <p className="muted sm">{t("keys.exportPubMobile")}</p>}
            {keys.length === 0 ? (
              <Empty icon="🔑" text={t("keys.emptyVault")} />
            ) : visibleKeys.length === 0 ? (
              <Empty icon="🔍" text={t("keys.noMatch")} />
            ) : (
              <div className="list">
                {visibleKeys.map((k) => {
                  const classification = classifyKeyUse(k.id, identities);
                  const described = describeKeyUse(classification, k.purposeIntent ?? "", useCopy);
                  const canExport = isRsaPubExportable(k.algorithm, k.publicOpenssh);
                  const deleteBlocked = gitHostingBlocksKeyDelete(k.id, identities);
                  const deleteTitle = deleteBlocked ? t("keys.deleteBlocked") : writesLocked ? t("keys.deleteBusy") : undefined;
                  return (
                    <div className="list-row" key={k.id} style={{ alignItems: "center" }}>
                      <div className="grow">
                        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                          <strong>{k.name}</strong>
                          <Badge kind="info">{k.algorithm}</Badge>
                          {described.groupBadges.map((label) => (
                            <Badge key={label}>{label}</Badge>
                          ))}
                          {described.platformBadges.map((label) => (
                            <Badge key={label} kind="info">
                              {label}
                            </Badge>
                          ))}
                          {k.hasPassphrase && <Badge kind="good">{t("keys.encrypted")}</Badge>}
                          {k.weak && <Badge kind="danger">{t("keys.weak")}</Badge>}
                        </div>
                        <div className="mono muted sm">{k.fingerprint}</div>
                        {k.deployedPath && <div className="mono muted sm">{k.deployedPath}</div>}
                      </div>
                      <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
                        {!mobile && k.publicOpenssh.trim() && (
                          <KeyExportMenu
                            rsa={canExport}
                            onExport={(format) => {
                              if (format === "pub") {
                                void exportPublicFile(k);
                                return;
                              }
                              setErr("");
                              setPemTarget(k);
                            }}
                          />
                        )}
                        <button
                          type="button"
                          className="btn sm"
                          disabled={writesLocked || tagBusyId === k.id}
                          onClick={() => {
                            setErr("");
                            setEditing(k);
                          }}
                          title={t("keys.editTag")}
                        >
                          <Pencil size={12} />
                          <span>{t("common.edit")}</span>
                        </button>
                        <button type="button" className="btn sm" onClick={() => setViewing(k)} title={t("keys.viewKey")}>
                          <Eye size={12} />
                          <span>{t("common.view")}</span>
                        </button>
                        <span title={deleteTitle}>
                          <button
                            type="button"
                            className="btn danger sm"
                            title={deleteTitle}
                            disabled={writesLocked || deleteBlocked || tagBusyId === k.id}
                            onClick={() => {
                              if (writesLocked || deleteBlocked) return;
                              setErr("");
                              setPendingDelete(k);
                            }}
                          >
                            <Trash2 size={12} />
                            <span>{t("common.delete")}</span>
                          </button>
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Card>
      )}

      {tab === "scan" && (
        <Card actions={<button className="btn ghost sm" onClick={loadScan}>{t("keys.rescan")}</button>}>
          <div className="stack">
            <input
              className="input"
              value={scanQuery}
              placeholder={t("keys.scanSearchPh")}
              aria-label={t("keys.search")}
              onChange={(e) => setScanQuery(e.target.value)}
            />
            {scanned.length === 0 ? (
              <Empty icon="📁" text={t("keys.emptyScan")} />
            ) : visibleScan.length === 0 ? (
              <Empty icon="🔍" text={t("keys.noMatch")} />
            ) : (
              <div className="list">
                {visibleScan.map((s) => (
                  <div className="list-row" key={s.path}>
                    <div className="grow">
                      <div className="row" style={{ gap: 8 }}>
                        <strong className="mono sm">{s.path}</strong>
                        <Badge kind="info">{s.info.algorithm}</Badge>
                        {s.inVault && <Badge kind="good">{t("keys.inVault")}</Badge>}
                      </div>
                      <div className="mono muted sm">{s.info.fingerprint}</div>
                      {s.info.comment && <div className="muted sm">{s.info.comment}</div>}
                    </div>
                    {!s.inVault && (
                      <button className="btn sm" disabled={busy || writesLocked} onClick={() => importPath(s.path)}>
                        {t("common.import")}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>
      )}

      {editing && (
        <KeyTagDialog
          record={editing}
          attached={!classifyKeyUse(editing.id, identities).unattached}
          busy={tagBusyId === editing.id}
          err={err}
          onClose={() => setEditing(null)}
          onSave={async (purposeIntent) => {
            const ok = await changeTag(editing, purposeIntent);
            if (ok) setEditing(null);
          }}
        />
      )}
      {pemTarget && (
        <PemExportDialog
          record={pemTarget}
          busy={tagBusyId === pemTarget.id}
          err={err}
          onClose={() => {
            setErr("");
            setPemTarget(null);
          }}
          onSave={async (password) => {
            setErr("");
            setTagBusyId(pemTarget.id);
            try {
              const pem = await api.exportVaultKeyPem(password, pemTarget.id);
              const saved = await downloadTextFile(
                rsaPemDownloadName(pemTarget.name),
                pem.endsWith("\n") ? pem : `${pem}\n`,
              );
              if (!saved) return false;
              setPemTarget(null);
              setMsg(t("keys.exportPemHint"));
              return true;
            } catch (e) {
              setErr(errMessage(e));
              return false;
            } finally {
              setTagBusyId("");
            }
          }}
        />
      )}
      {viewing && <KeyViewDialog record={viewing} onClose={() => setViewing(null)} />}
      {pendingDelete && (
        <KeyDeleteDialog
          record={pendingDelete}
          identityNames={identityNamesLosingKey(
            pendingDelete.id,
            identities.map((id) => ({
              keyId: id.keyId,
              platform: id.platform,
              name: id.name.trim() || id.hostAlias,
            })),
          )}
          busy={tagBusyId === pendingDelete.id}
          err={err}
          onClose={() => {
            if (tagBusyId === pendingDelete.id) return;
            setErr("");
            setPendingDelete(null);
          }}
          onConfirm={() => void confirmDelete(pendingDelete)}
        />
      )}
    </div>
  );
}

function PemExportDialog({
  record,
  busy,
  err,
  onClose,
  onSave,
}: {
  record: KeyRecord;
  busy: boolean;
  err: string;
  onClose: () => void;
  onSave: (password: string) => void;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  return (
    <div className="wizard-overlay" style={{ zIndex: 60 }}>
      <div className="card dialog-card" role="dialog" aria-modal="true" aria-labelledby="key-pem-title" style={{ width: 420 }}>
        <div className="card-head">
          <div className="card-title" id="key-pem-title">{t("keys.exportPemTitle")}</div>
          <button type="button" className="btn ghost sm" onClick={onClose} disabled={busy} aria-label={t("common.close")}>
            <X size={15} />
          </button>
        </div>
        <div className="card-body stack">
          <p className="muted sm">{record.name}</p>
          <p className="muted sm">{t("keys.exportPemHint")}</p>
          <p className="muted sm">{t("keys.needReauth")}</p>
          {err && <div className="err-text">{err}</div>}
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            placeholder={t("keys.wsPassword")}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && password && !busy && onSave(password)}
          />
        </div>
        <div className="card-foot">
          <button type="button" className="btn ghost sm" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn primary sm" disabled={busy || !password} onClick={() => onSave(password)}>
            {busy ? t("common.busy") : t("keys.export")}
          </button>
        </div>
      </div>
    </div>
  );
}

function KeyDeleteDialog({
  record,
  identityNames,
  busy,
  err,
  onClose,
  onConfirm,
}: {
  record: KeyRecord;
  identityNames: string[];
  busy: boolean;
  err: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  return (
    <div className="wizard-overlay" style={{ zIndex: 60 }}>
      <div className="card" role="dialog" aria-modal="true" aria-labelledby="key-delete-title" style={{ width: 440, maxWidth: "95%", border: "1px solid var(--red)" }}>
        <div className="card-head" style={{ background: "var(--red-soft)" }}>
          <div className="row" style={{ gap: 6, color: "var(--red)" }}>
            <Trash2 size={16} />
            <div className="card-title" id="key-delete-title" style={{ color: "var(--red)", fontWeight: 700 }}>
              {t("keys.deleteTitle")}
            </div>
          </div>
          <button type="button" className="btn ghost sm" onClick={onClose} disabled={busy} aria-label={t("common.close")}>
            <X size={15} />
          </button>
        </div>
        <div className="card-body stack" style={{ gap: 10, padding: "14px 16px" }}>
          <div>{t("keys.deleteConfirm", { name: record.name })}</div>
          {identityNames.length > 0 && (
            <p className="muted sm">{t("keys.deleteUsed", { identities: identityNames.join(t("keys.deleteNameSep")) })}</p>
          )}
          <div className="callout danger sm">{t("keys.deleteDetail")}</div>
          {err && <div className="err-text">{err}</div>}
        </div>
        <div className="card-head" style={{ justifyContent: "flex-end", gap: 8, borderTop: "1px solid var(--border)", borderBottom: "none" }}>
          <button type="button" className="btn ghost sm" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn danger sm" onClick={onConfirm} disabled={busy}>
            {busy ? t("common.deleting") : t("common.delete")}
          </button>
        </div>
      </div>
    </div>
  );
}

function KeyTagDialog({
  record,
  attached,
  busy,
  err,
  onClose,
  onSave,
}: {
  record: KeyRecord;
  attached: boolean;
  busy: boolean;
  err: string;
  onClose: () => void;
  onSave: (purposeIntent: string) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(record.purposeIntent ?? "");
  const options = [
    { id: "", label: t("keys.tagNone") },
    { id: "git", label: t("keys.groupGit") },
    { id: "server", label: t("keys.groupServer") },
    { id: "export", label: t("keys.intentExport") },
  ];

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  return (
    <div className="wizard-overlay" style={{ zIndex: 60 }}>
      <div className="card dialog-card" role="dialog" aria-modal="true" aria-labelledby="key-tag-title" style={{ width: 420 }}>
        <div className="card-head">
          <div className="row" style={{ gap: 6 }}>
            <Pencil size={15} style={{ color: "var(--accent)" }} aria-hidden="true" />
            <div className="card-title" id="key-tag-title">{t("keys.editTagTitle", { name: record.name })}</div>
          </div>
          <button type="button" className="btn ghost sm" onClick={onClose} disabled={busy} aria-label={t("common.close")}>
            <X size={15} />
          </button>
        </div>
        <div className="card-body stack">
          <p className="muted sm">{attached ? t("keys.tagFollowsIdentity") : t("keys.editTagHint")}</p>
          <div className="choice-row" role="group" aria-label={t("keys.editTag")}>
            {options.map((option) => (
              <button
                key={option.id || "none"}
                type="button"
                className={"choice" + (draft === option.id ? " on" : "")}
                aria-pressed={draft === option.id}
                disabled={busy}
                onClick={() => setDraft(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
          {err && <div className="err-text">{err}</div>}
        </div>
        <div className="card-foot">
          <button type="button" className="btn ghost sm" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn primary sm" disabled={busy} onClick={() => onSave(draft)}>
            {busy ? t("common.busy") : t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

function KeyViewDialog({ record, onClose }: { record: KeyRecord; onClose: () => void }) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [privateText, setPrivateText] = useState("");
  const [passphrase, setPassphrase] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState<Copied>("");
  const publicText = record.publicOpenssh.trim();

  function markCopied(which: Copied) {
    setCopied(which);
    window.setTimeout(() => setCopied((c) => (c === which ? "" : c)), 1600);
  }

  async function copy(which: Copied, text: string) {
    if (!text.trim()) return;
    await copyKeyText(text, which !== "pub");
    markCopied(which);
  }

  async function revealPrivate() {
    setErr("");
    setRevealing(true);
    try {
      const material = await api.revealKeyMaterial(password, record.id);
      setPrivateText(material.privateOpenssh);
      setPassphrase(material.passphrase);
      setPassword("");
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setRevealing(false);
    }
  }

  function close() {
    setPrivateText("");
    setPassphrase(null);
    setPassword("");
    onClose();
  }

  return (
    <div className="wizard-overlay" style={{ zIndex: 60 }}>
      <div className="card" style={{ width: 560, maxWidth: "96%", maxHeight: "90vh", display: "flex", flexDirection: "column" }}>
        <div className="card-head">
          <div className="row" style={{ gap: 6 }}>
            <KeyRound size={15} style={{ color: "var(--accent)" }} />
            <div className="card-title">{t("keys.viewTitle", { name: record.name })}</div>
          </div>
          <button type="button" className="btn ghost sm" onClick={close} aria-label={t("common.close")}>
            <X size={15} />
          </button>
        </div>
        <div className="card-body" style={{ overflow: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <Badge kind="info">{record.algorithm}</Badge>
            {record.hasPassphrase && <Badge kind="good">{t("keys.encrypted")}</Badge>}
            {record.weak && <Badge kind="danger">{t("keys.weak")}</Badge>}
          </div>
          <div className="mono muted sm">{record.fingerprint}</div>

          <div className="field">
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <label className="field-label">{t("keys.publicKey")}</label>
              <button
                type="button"
                className="btn sm"
                disabled={!publicText}
                onClick={() => copy("pub", record.publicOpenssh)}
              >
                {copied === "pub" ? (
                  <>
                    <Check size={12} style={{ color: "var(--green)" }} />
                    <span style={{ color: "var(--green)" }}>{t("common.copied")}</span>
                  </>
                ) : (
                  <>
                    <Copy size={12} />
                    <span>{t("overview.copyPub")}</span>
                  </>
                )}
              </button>
            </div>
            <div className="code" style={{ maxHeight: 90 }}>
              {publicText || t("keys.noPublic")}
            </div>
          </div>

          <div className="field">
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <label className="field-label">{t("keys.privateKey")}</label>
              {privateText && (
                <button type="button" className="btn sm" onClick={() => copy("priv", privateText)}>
                  {copied === "priv" ? (
                    <>
                      <Check size={12} style={{ color: "var(--green)" }} />
                      <span style={{ color: "var(--green)" }}>{t("common.copied")}</span>
                    </>
                  ) : (
                    <>
                      <Copy size={12} />
                      <span>{t("keys.copyPrivate")}</span>
                    </>
                  )}
                </button>
              )}
            </div>
            {privateText ? (
              <>
                <div className="code" style={{ maxHeight: 180 }}>
                  {privateText}
                </div>
                <div className="callout warn sm">{t("keys.privateWarn")}</div>
                {passphrase != null && passphrase !== "" && (
                  <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
                    <div className="muted sm">{t("keys.passHint")}</div>
                    <button type="button" className="btn sm" onClick={() => copy("pass", passphrase)}>
                      {copied === "pass" ? t("keys.copiedPass") : t("keys.copyPass")}
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div className="stack">
                <div className="callout warn sm">{t("keys.needReauth")}</div>
                {err && <div className="err-text">{err}</div>}
                <input
                  className="input"
                  type="password"
                  autoComplete="current-password"
                  placeholder={t("keys.wsPassword")}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && password && revealPrivate()}
                />
                <div className="row">
                  <button type="button" className="btn primary sm" disabled={revealing || !password} onClick={revealPrivate}>
                    {revealing ? t("reauth.verifying") : t("keys.showPrivate")}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
