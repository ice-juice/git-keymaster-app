import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, Eye, KeyRound, X } from "lucide-react";
import { api, errMessage, type KeyRecord, type ScannedKey } from "../lib/ipc";
import { writeClipboard } from "../lib/clipboard";
import { PageHead, Card, Empty, Badge } from "../ui/common";
import { useApp } from "../store";
import { can } from "../platform/capabilities";

type Copied = "" | "pub" | "priv" | "pass";

async function copyKeyText(text: string, secret = false) {
  await writeClipboard(text.replace(/\r\n/g, "\n").trim() + "\n", secret);
}

export function Keys() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"vault" | "scan">("vault");
  const [keys, setKeys] = useState<KeyRecord[]>([]);
  const [scanned, setScanned] = useState<ScannedKey[]>([]);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [genComment, setGenComment] = useState("");
  const [genName, setGenName] = useState("");
  const [showGen, setShowGen] = useState(false);
  const [viewing, setViewing] = useState<KeyRecord | null>(null);
  const [copiedId, setCopiedId] = useState<string>("");
  const { writesLocked } = useApp();

  async function loadVault() {
    try {
      setKeys(await api.listKeys());
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
  }, []);

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

  async function copyPublic(k: KeyRecord) {
    if (!k.publicOpenssh.trim()) return;
    await copyKeyText(k.publicOpenssh);
    setCopiedId(k.id);
    window.setTimeout(() => setCopiedId((id) => (id === k.id ? "" : id)), 1600);
  }

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
          {keys.length === 0 ? (
            <Empty icon="🔑" text={t("keys.emptyVault")} />
          ) : (
            <div className="list">
              {keys.map((k) => (
                <div className="list-row" key={k.id} style={{ alignItems: "center" }}>
                  <div className="grow">
                    <div className="row" style={{ gap: 8 }}>
                      <strong>{k.name}</strong>
                      <Badge kind="info">{k.algorithm}</Badge>
                      {k.hasPassphrase && <Badge kind="good">{t("keys.encrypted")}</Badge>}
                      {k.weak && <Badge kind="danger">{t("keys.weak")}</Badge>}
                    </div>
                    <div className="mono muted sm">{k.fingerprint}</div>
                    {k.deployedPath && <div className="mono muted sm">{k.deployedPath}</div>}
                  </div>
                  <div className="row" style={{ gap: 4 }}>
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => copyPublic(k)}
                      disabled={!k.publicOpenssh.trim()}
                      title={t("keys.copyOpenssh")}
                    >
                      {copiedId === k.id ? (
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
                    <button type="button" className="btn sm" onClick={() => setViewing(k)} title={t("keys.viewKey")}>
                      <Eye size={12} />
                      <span>{t("common.view")}</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {tab === "scan" && (
        <Card actions={<button className="btn ghost sm" onClick={loadScan}>{t("keys.rescan")}</button>}>
          {scanned.length === 0 ? (
            <Empty icon="📁" text={t("keys.emptyScan")} />
          ) : (
            <div className="list">
              {scanned.map((s) => (
                <div className="list-row" key={s.path}>
                  <div className="grow">
                    <div className="row" style={{ gap: 8 }}>
                      <strong className="mono sm">{s.path}</strong>
                      <Badge kind="info">{s.info.algorithm}</Badge>
                      {s.inVault && <Badge kind="good">{t("keys.inVault")}</Badge>}
                    </div>
                    <div className="mono muted sm">{s.info.fingerprint}</div>
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
        </Card>
      )}

      {viewing && <KeyViewDialog record={viewing} onClose={() => setViewing(null)} />}
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
