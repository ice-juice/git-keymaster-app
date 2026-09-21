import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Pencil, Trash2, X, Plus, FolderGit2, Download } from "lucide-react";
import { api, errMessage, type Identity, type ManagedRepoView } from "../lib/ipc";
import { PageHead, Card, Empty, Badge } from "../ui/common";
import { useApp } from "../store";
import { ClonePage } from "./Clone";

const SOURCE_KEYS: Record<string, string> = {
  scan: "repos.scan",
  clone: "repos.clone",
  init: "repos.init",
  addRemote: "repos.addRemote",
  manual: "repos.manual",
};

export function Repos() {
  const { t } = useTranslation();
  const { writesLocked } = useApp();
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get("tab");
  const hasUrlParam = !!searchParams.get("url");
  const [tab, setTabState] = useState<"list" | "clone">(rawTab === "clone" || hasUrlParam ? "clone" : "list");
  const [repos, setRepos] = useState<ManagedRepoView[]>([]);
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [root, setRoot] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [removingBusy, setRemovingBusy] = useState(false);
  const [editing, setEditing] = useState<ManagedRepoView | null>(null);
  const [removing, setRemoving] = useState<ManagedRepoView | null>(null);

  useEffect(() => {
    const next = searchParams.get("tab");
    if (next === "clone" || searchParams.get("url")) {
      setTabState("clone");
    } else if (next === "list") {
      setTabState("list");
    }
  }, [searchParams]);

  function switchTab(next: "list" | "clone") {
    setTabState(next);
    const newParams = new URLSearchParams(searchParams);
    if (next === "clone") {
      newParams.set("tab", "clone");
    } else {
      newParams.delete("tab");
      newParams.delete("url");
    }
    setSearchParams(newParams, { replace: true });
    if (next === "list") {
      void load();
    }
  }

  async function load() {
    try {
      const [list, ids] = await Promise.all([api.listManagedRepos(), api.listIdentities()]);
      setRepos(list);
      setIdentities(ids);
    } catch (e) {
      setErr(errMessage(e));
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function pickRoot() {
    setErr("");
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t("repos.pickRoot"),
        defaultPath: root.trim() || undefined,
      });
      if (typeof selected !== "string" || !selected) return;
      setRoot(selected);
    } catch (e) {
      setErr(errMessage(e));
    }
  }

  async function scanImport() {
    setErr("");
    setMsg("");
    if (!root.trim()) return setErr(t("repos.needRoot"));
    setBusy(true);
    try {
      const result = await api.scanAndImportRepos(root, 4);
      setRepos(result.repos);
      setMsg(
        t("repos.scanDone", {
          imported: result.imported,
          updated: result.updated,
          skipped: result.skippedNoRemote,
        }),
      );
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function openDir(path: string) {
    setErr("");
    try {
      await api.openRepoDir(path);
    } catch (e) {
      setErr(errMessage(e));
    }
  }

  async function confirmRemove() {
    if (!removing || removingBusy) return;
    const target = removing;
    setErr("");
    setRemovingBusy(true);
    setRepos((prev) => prev.filter((r) => r.id !== target.id));
    setRemoving(null);
    try {
      await api.removeManagedRepo(target.id);
    } catch (e) {
      setErr(errMessage(e));
      await load();
    } finally {
      setRemovingBusy(false);
    }
  }

  return (
    <div className="stack-lg">
      <PageHead
        title={t("repos.title")}
        desc={t("repos.desc")}
        actions={
          <div className="row" style={{ gap: 6, alignItems: "center" }}>
            <div
              style={{
                display: "inline-flex",
                gap: 3,
                background: "rgba(255, 255, 255, 0.05)",
                padding: "3px 4px",
                borderRadius: 8,
                border: "1px solid var(--border)",
              }}
            >
              <button
                type="button"
                className={`btn sm ${tab === "list" ? "primary" : "ghost"}`}
                style={{ padding: "4px 10px", fontSize: 12 }}
                onClick={() => switchTab("list")}
              >
                <FolderGit2 size={13} />
                <span>{t("repos.tabList")}</span>
                {repos.length > 0 && (
                  <span
                    className="nav-badge"
                    style={{
                      marginLeft: 4,
                      background: tab === "list" ? "rgba(255, 255, 255, 0.25)" : "var(--sidebar-badge-bg)",
                      color: tab === "list" ? "#fff" : "var(--text-soft)",
                    }}
                  >
                    {repos.length}
                  </span>
                )}
              </button>
              <button
                type="button"
                className={`btn sm ${tab === "clone" ? "primary" : "ghost"}`}
                style={{ padding: "4px 10px", fontSize: 12 }}
                onClick={() => switchTab("clone")}
              >
                <Download size={13} />
                <span>{t("repos.tabClone")}</span>
              </button>
            </div>
          </div>
        }
      />
      {err && <div className="err-text">{err}</div>}
      {msg && <div className="callout good">{msg}</div>}

      {tab === "clone" ? (
        <ClonePage embedded onGoRepos={() => switchTab("list")} />
      ) : (
        <>
          <Card title={t("repos.scanTitle")}>
            <div className="stack">
              <div className="path-pick">
                <input
                  className="input mono"
                  placeholder={t("repos.rootPh")}
                  value={root}
                  onChange={(e) => setRoot(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && scanImport()}
                />
                <button type="button" className="btn" onClick={pickRoot}>
                  {t("common.browse")}
                </button>
                <button type="button" className="btn primary" disabled={busy || writesLocked} onClick={scanImport}>
                  {busy ? t("repos.scanning") : t("repos.scanImport")}
                </button>
              </div>
              <div className="muted sm">{t("repos.scanHint")}</div>
            </div>
          </Card>

          <Card title={t("repos.registered", { n: repos.length })}>
            {repos.length === 0 ? (
              <div className="stack" style={{ alignItems: "center", padding: "16px 0", gap: 10 }}>
                <Empty icon="📦" text={t("repos.empty")} />
                <button
                  type="button"
                  className="btn primary sm"
                  disabled={writesLocked}
                  onClick={() => switchTab("clone")}
                >
                  <Plus size={13} />
                  <span>{t("repos.goClone")}</span>
                </button>
              </div>
            ) : (
              <div className="list">
                {repos.map((r) => (
                  <div className="list-row" key={r.id} style={{ alignItems: "flex-start" }}>
                    <div className="grow">
                      <div className="row" style={{ gap: 6 }}>
                        <strong>{r.name}</strong>
                        <Badge>{SOURCE_KEYS[r.source] ? t(SOURCE_KEYS[r.source]) : r.source}</Badge>
                        {!r.exists && <Badge kind="danger">{t("repos.missingDir")}</Badge>}
                        {r.needsAliasFix && <Badge kind="warn">{t("repos.aliasFix")}</Badge>}
                        {r.identityName && <Badge kind="info">{r.identityName}</Badge>}
                      </div>
                      <div className="mono muted sm">{r.path}</div>
                      <div className="mono sm" style={{ marginTop: 2 }}>
                        {r.remoteUrl ?? t("repos.noRemote")}
                      </div>
                    </div>
                    <div className="row" style={{ gap: 4 }}>
                      <button
                        type="button"
                        className="btn sm"
                        disabled={!r.exists}
                        title={t("repos.openExplorer")}
                        onClick={() => openDir(r.path)}
                      >
                        <FolderOpen size={12} />
                        <span>{t("common.open")}</span>
                      </button>
                      <button
                        type="button"
                        className="btn sm"
                        disabled={!r.exists || writesLocked}
                        onClick={() => setEditing(r)}
                        title={writesLocked ? t("repos.syncLocked") : t("repos.changeUrlTip")}
                      >
                        <Pencil size={12} />
                        <span>{t("repos.changeUrl")}</span>
                      </button>
                      <button type="button" className="btn ghost sm" disabled={writesLocked} onClick={() => setRemoving(r)} title={t("repos.removeOnly")}>
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      )}

      {editing && (
        <RemoteEditModal
          repo={editing}
          identities={identities}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            setMsg(t("repos.updatedRemote"));
            await load();
          }}
        />
      )}

      {removing && (
        <div className="wizard-overlay" style={{ zIndex: 60 }}>
          <div className="card" style={{ width: 400, maxWidth: "95%" }}>
            <div className="card-head">
              <div className="card-title">{t("repos.removeTitle")}</div>
              <button type="button" className="btn ghost sm" onClick={() => setRemoving(null)}>
                <X size={15} />
              </button>
            </div>
            <div className="card-body stack" style={{ gap: 8 }}>
              <div>{t("repos.removeMsg", { name: removing.name })}</div>
              <div className="callout info sm">{t("repos.removeHint")}</div>
              <div className="mono muted sm">{removing.path}</div>
            </div>
            <div
              className="card-head"
              style={{ justifyContent: "flex-end", gap: 8, borderTop: "1px solid var(--border)", borderBottom: "none" }}
            >
              <button type="button" className="btn ghost sm" onClick={() => setRemoving(null)}>
                {t("common.cancel")}
              </button>
              <button type="button" className="btn danger sm" disabled={removingBusy} onClick={confirmRemove}>
                {removingBusy ? t("repos.removing") : t("common.remove")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RemoteEditModal({
  repo,
  identities,
  onClose,
  onSaved,
}: {
  repo: ManagedRepoView;
  identities: Identity[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const { writesLocked } = useApp();
  const [remoteUrl, setRemoteUrl] = useState(repo.remoteUrl ?? "");
  const [identityId, setIdentityId] = useState(repo.identityId ?? "");
  const [rewrite, setRewrite] = useState(!!repo.identityId);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    setErr("");
    if (!remoteUrl.trim()) return setErr(t("repos.needUrl"));
    setBusy(true);
    try {
      await api.setRepoRemote({
        repoId: repo.id,
        remoteUrl: remoteUrl.trim(),
        identityId: rewrite && identityId ? identityId : undefined,
      });
      await onSaved();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wizard-overlay" style={{ zIndex: 60 }}>
      <div className="card" style={{ width: 480, maxWidth: "95%" }}>
        <div className="card-head">
          <div className="card-title">{t("repos.changeTitle", { name: repo.name })}</div>
          <button type="button" className="btn ghost sm" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
        <div className="card-body stack" style={{ gap: 10 }}>
          {err && <div className="callout danger sm">{err}</div>}
          <div className="field">
            <label className="field-label">origin URL</label>
            <input
              className="input mono"
              value={remoteUrl}
              onChange={(e) => setRemoteUrl(e.target.value)}
              placeholder="git@github-alias:owner/repo.git"
            />
          </div>
          <div className="field">
            <label className="field-label">{t("repos.bindIdentity")}</label>
            <select className="input" value={identityId} onChange={(e) => setIdentityId(e.target.value)}>
              <option value="">{t("repos.noSwitch")}</option>
              {identities.map((id) => (
                <option key={id.id} value={id.id}>
                  {t("repos.identityOption", { name: id.name, alias: id.hostAlias })}
                </option>
              ))}
            </select>
          </div>
          <div className="between" style={{ padding: "4px 0" }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 11.5 }}>{t("repos.rewriteAlias")}</div>
              <div className="hint">{t("repos.rewriteHint")}</div>
            </div>
            <div
              className={`switch ${rewrite && identityId ? "" : "off"}`}
              onClick={() => identityId && setRewrite(!rewrite)}
            />
          </div>
        </div>
        <div
          className="card-head"
          style={{ justifyContent: "flex-end", gap: 8, borderTop: "1px solid var(--border)", borderBottom: "none" }}
        >
          <button type="button" className="btn ghost sm" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn primary sm" disabled={busy || writesLocked} onClick={save}>
            {busy ? t("repos.saving") : t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
