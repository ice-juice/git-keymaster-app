import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  api,
  errMessage,
  type AuthResult,
  type ConfigPreview,
  type CreateIdentityResult,
  type GitProvider,
  type Identity,
  type KeyRecord,
} from "../lib/ipc";
import { useApp } from "../store";
import { FieldLabel } from "../ui/common";
import { writeClipboard } from "../lib/clipboard";

const DRAFT_KEY = "gam.newIdentity.draft";

const PLATFORMS = [
  { id: "github", label: "GitHub", host: "github.com", alias: "github", keysUrl: "https://github.com/settings/keys" },
  { id: "gitlab", label: "GitLab", host: "gitlab.com", alias: "gitlab", keysUrl: "https://gitlab.com/-/user_settings/ssh_keys" },
  { id: "gitee", label: "Gitee", host: "gitee.com", alias: "gitee", keysUrl: "https://gitee.com/profile/sshkeys" },
  { id: "gitea", label: "Gitea / 自建", host: "", alias: "git", keysUrl: "" },
  { id: "other", label: "其他", host: "", alias: "git", keysUrl: "" },
] as const;

const PAT_TOKEN_URL: Record<GitProvider, string> = {
  github: "https://github.com/settings/tokens/new",
  gitlab: "https://gitlab.com/-/user_settings/personal_access_tokens",
  gitee: "https://gitee.com/profile/personal_access_tokens",
};

function asPatProvider(platform: string): GitProvider | null {
  if (platform === "github" || platform === "gitlab" || platform === "gitee") return platform;
  return null;
}

interface Draft {
  step: number;
  maxReached: number;
  platform: string;
  name: string;
  email: string;
  gitUserName: string;
  hostAlias: string;
  aliasTouched: boolean;
  realHost: string;
  hostTouched: boolean;
  user: string;
  keyMode: "new" | "reuse";
  keyId: string;
  keyComment: string;
  commentTouched: boolean;
  strictMode: boolean;
  pendingKeyId: string;
  pendingPub: string;
  staged: boolean;
  created: CreateIdentityResult | null;
  uploaded: boolean;
  auth: AuthResult | null;
  ownersText: string;
}

function emptyDraft(): Draft {
  return {
    step: 0,
    maxReached: 0,
    platform: "github",
    name: "",
    email: "",
    gitUserName: "",
    hostAlias: "github-",
    aliasTouched: false,
    realHost: "github.com",
    hostTouched: false,
    user: "git",
    keyMode: "new",
    keyId: "",
    keyComment: "",
    commentTouched: false,
    strictMode: false,
    pendingKeyId: "",
    pendingPub: "",
    staged: false,
    created: null,
    uploaded: false,
    auth: null,
    ownersText: "",
  };
}

function loadDraft(): Draft {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return emptyDraft();
    return { ...emptyDraft(), ...JSON.parse(raw) };
  } catch {
    return emptyDraft();
  }
}

function saveDraft(d: Draft) {
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d));
}

function slug(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function suggestAlias(platform: string, name: string): string {
  const p = PLATFORMS.find((x) => x.id === platform) ?? PLATFORMS[0];
  const n = slug(name);
  return n ? `${p.alias}-${n}` : `${p.alias}-`;
}

function suggestKeyComment(email: string, name: string, gitUserName: string): string {
  const em = email.trim();
  if (em) return em;
  const n = name.trim();
  if (n) return `${n}@gam`;
  const g = gitUserName.trim();
  if (g) return `${g.split(/\s+/).join(".")}@gam`;
  return "";
}

export function NewIdentity() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { status, writesLocked, startupNote } = useApp();
  const STEPS = [
    t("identity.stepInfo"),
    t("identity.stepKey"),
    t("identity.stepUpload"),
    t("identity.stepVerify"),
    t("identity.stepOwners"),
  ];
  const workspacePath = status?.workspacePath;
  const [d, setDraft] = useState<Draft>(loadDraft);
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [keys, setKeys] = useState<KeyRecord[]>([]);
  const [preview, setPreview] = useState<ConfigPreview | null>(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [patConfigured, setPatConfigured] = useState(false);
  const [patInput, setPatInput] = useState("");
  const [patLogin, setPatLogin] = useState("");

  const set = (p: Partial<Draft>) => {
    setDraft((prev) => {
      const next = { ...prev, ...p };
      saveDraft(next);
      return next;
    });
  };

  async function refreshPat(platform: string) {
    const provider = asPatProvider(platform);
    if (!provider) {
      setPatConfigured(false);
      setPatLogin("");
      return;
    }
    const pat = await api.gitPatStatus(provider);
    setPatConfigured(pat.configured);
    if (!pat.configured) setPatLogin("");
  }

  useEffect(() => {
    (async () => {
      try {
        setIdentities(await api.listIdentities());
        setKeys(await api.listKeys());
        await refreshPat(d.platform);
      } catch (e) {
        setErr(errMessage(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const locked = !!d.created || d.staged;
  const plat = PLATFORMS.find((p) => p.id === d.platform) ?? PLATFORMS[0];
  const aliasClash = identities.some(
    (i) => i.hostAlias.toLowerCase() === d.hostAlias.trim().toLowerCase() && i.id !== d.created?.identity.id,
  );
  const nameClash = identities.some(
    (i) => i.name.toLowerCase() === d.name.trim().toLowerCase() && i.id !== d.created?.identity.id,
  );

  const identityFileHint = useMemo(() => {
    const root = (workspacePath || t("identity.wsPlaceholder")).replace(/\\/g, "/");
    const stem = d.name.trim() ? `id_ed25519_${d.name.trim()}` : t("identity.keyStemPh");
    return `${root}/ssh-keys/${stem}${d.strictMode ? ".pub" : ""}`;
  }, [workspacePath, d.name, d.strictMode, t]);

  const publicKey = d.created?.publicOpenssh || d.pendingPub || keys.find((k) => k.id === d.keyId)?.publicOpenssh || "";

  function applyPlatform(id: string) {
    if (locked) return;
    const p = PLATFORMS.find((x) => x.id === id) ?? PLATFORMS[0];
    set({
      platform: id,
      hostAlias: d.aliasTouched ? d.hostAlias : suggestAlias(id, d.name),
      realHost: d.hostTouched || !p.host ? d.realHost : p.host,
    });
    refreshPat(id).catch((e) => setErr(errMessage(e)));
  }

  function onName(v: string) {
    if (locked) return;
    set({
      name: v,
      hostAlias: d.aliasTouched ? d.hostAlias : suggestAlias(d.platform, v),
      keyComment: d.commentTouched ? d.keyComment : suggestKeyComment(d.email, v, d.gitUserName),
    });
  }

  function onEmail(v: string) {
    if (locked) return;
    set({
      email: v,
      keyComment: d.commentTouched ? d.keyComment : suggestKeyComment(v, d.name, d.gitUserName),
    });
  }

  function onGitUserName(v: string) {
    if (locked) return;
    set({
      gitUserName: v,
      keyComment: d.commentTouched ? d.keyComment : suggestKeyComment(d.email, d.name, v),
    });
  }

  async function discardDraftStaging() {
    if (d.created || !d.staged) return;
    const keyId = d.pendingKeyId || d.keyId;
    try {
      await api.abortIdentityDraft({
        hostAlias: d.hostAlias.trim(),
        keyId: keyId || "",
      });
    } catch {
      /* 取消时尽力卸下临时密钥，失败不阻断退出 */
    }
    set({ staged: false, auth: null });
  }

  async function exitWizard() {
    if (!d.created) {
      await discardDraftStaging();
    } else {
      sessionStorage.removeItem(DRAFT_KEY);
    }
    nav("/");
  }

  async function loadPreview() {
    if (!d.hostAlias.trim() || !d.realHost.trim()) return;
    try {
      setPreview(
        await api.previewConfig({
          alias: d.hostAlias.trim(),
          hostName: d.realHost.trim(),
          user: d.user.trim() || "git",
          identityFile: identityFileHint,
          identitiesOnly: true,
        }),
      );
    } catch {
      /* 预览失败不阻断 */
    }
  }

  useEffect(() => {
    if (d.step === 1) loadPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.step, d.hostAlias, d.realHost, d.user, identityFileHint]);

  function validateInfo(): string | null {
    if (!d.name.trim()) return t("identity.needName");
    if (!d.hostAlias.trim()) return t("identity.needAlias");
    if (!/^[A-Za-z0-9._-]+$/.test(d.hostAlias.trim())) return t("identity.aliasChars");
    if (!d.realHost.trim()) return t("identity.needHost");
    if (aliasClash) return t("identity.aliasClash", { alias: d.hostAlias });
    if (nameClash) return t("identity.nameClash", { name: d.name });
    return null;
  }

  async function ensurePublicKey(): Promise<{ keyId: string; pub: string }> {
    if (d.created?.publicOpenssh) {
      return { keyId: d.created.identity.keyId || d.pendingKeyId || d.keyId, pub: d.created.publicOpenssh };
    }
    if (d.pendingPub && (d.pendingKeyId || d.keyId)) {
      return { keyId: d.pendingKeyId || d.keyId, pub: d.pendingPub };
    }
    if (d.keyMode === "reuse") {
      const k = keys.find((x) => x.id === d.keyId);
      if (!k) throw new Error(t("identity.pickReuse"));
      set({ pendingKeyId: k.id, pendingPub: k.publicOpenssh });
      return { keyId: k.id, pub: k.publicOpenssh };
    }
    const k = await api.generateKey(
      d.keyComment.trim() || suggestKeyComment(d.email, d.name, d.gitUserName),
      d.name.trim() || undefined,
    );
    setKeys(await api.listKeys());
    set({ pendingKeyId: k.id, pendingPub: k.publicOpenssh, keyId: k.id });
    return { keyId: k.id, pub: k.publicOpenssh };
  }

  async function ensureCreated(keyId?: string) {
    if (d.created) return d.created;
    const resolved = keyId || (d.keyMode === "reuse" ? d.keyId : d.pendingKeyId) || undefined;
    const r = await api.createIdentity({
      name: d.name.trim(),
      platform: d.platform,
      hostAlias: d.hostAlias.trim(),
      realHost: d.realHost.trim(),
      user: d.user.trim() || "git",
      email: d.email.trim() || undefined,
      gitUserName: d.gitUserName.trim() || undefined,
      strictMode: d.strictMode,
      keyId: resolved,
      keyComment: d.keyComment.trim() || suggestKeyComment(d.email, d.name, d.gitUserName) || undefined,
      owners: [],
    });
    set({ created: r, pendingKeyId: r.identity.keyId ?? resolved ?? "", pendingPub: r.publicOpenssh });
    return r;
  }

  async function goTo(target: number) {
    if (target === d.step) return;
    setErr("");
    setMsg("");
    if (target < d.step) {
      set({ step: target });
      return;
    }
    const infoErr = validateInfo();
    if (target >= 1 && infoErr) {
      set({ step: 0 });
      setErr(infoErr);
      return;
    }
    if (target >= 2) {
      if (d.keyMode === "reuse" && !d.keyId && !d.pendingKeyId) {
        set({ step: 1 });
        return setErr(t("identity.pickReuse"));
      }
      setBusy(true);
      try {
        if (!d.keyComment.trim() && d.keyMode === "new") {
          set({ keyComment: suggestKeyComment(d.email, d.name, d.gitUserName) });
        }
        await ensurePublicKey();
      } catch (e) {
        set({ step: 1 });
        setErr(errMessage(e));
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    set({ step: target, maxReached: Math.max(d.maxReached, target) });
  }

  async function copyPub() {
    if (!publicKey) return;
    await writeClipboard(publicKey.trim());
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function openKeysPage() {
    setErr("");
    if (!plat.keysUrl) return setErr(t("identity.noKeysUrl"));
    try {
      await api.openUrl(plat.keysUrl);
    } catch (e) {
      setErr(errMessage(e));
    }
  }

  async function savePat() {
    const provider = asPatProvider(d.platform);
    if (!provider) return;
    const token = patInput.trim();
    const platLabel = t(`pat.platform.${provider}`);
    if (!token) return setErr(t("pat.needToken", { platform: platLabel }));
    setErr("");
    setMsg("");
    setBusy(true);
    try {
      await api.setGitPat(provider, token);
      const login = await api.testGitPat(provider);
      setPatConfigured(true);
      setPatLogin(login);
      setPatInput("");
      setMsg(t("pat.saved", { name: login, platform: platLabel }));
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function uploadViaPat() {
    const provider = asPatProvider(d.platform);
    if (!provider) return;
    const keyId = d.created?.identity.keyId || d.pendingKeyId || d.keyId;
    if (!keyId) return;
    if (!patConfigured) return setErr(t("identity.needPatFirst", { platform: t(`pat.platform.${provider}`) }));
    setErr("");
    setMsg("");
    setBusy(true);
    try {
      await api.uploadGitPublicKey(provider, keyId, d.name.trim() || t("brand.name"));
      set({ uploaded: true });
      setMsg(t("identity.uploadedMsg", { platform: t(`pat.platform.${provider}`) }));
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setErr("");
    setMsg("");
    setBusy(true);
    try {
      const keyId = (await ensurePublicKey()).keyId;
      await api.stageIdentityDraft({
        name: d.name.trim(),
        hostAlias: d.hostAlias.trim(),
        realHost: d.realHost.trim(),
        user: d.user.trim() || "git",
        strictMode: d.strictMode,
        keyId,
      });
      const r = await api.testConnection(d.hostAlias.trim());
      let owners = d.ownersText;
      if (r.account) {
        const lines = owners
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (!lines.some((l) => l.toLowerCase() === r.account!.toLowerCase())) {
          owners = [r.account, ...lines].join("\n");
        }
      }
      set({ staged: true, pendingKeyId: keyId, auth: r, ownersText: owners });
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function importOrgs() {
    const provider = asPatProvider(d.platform);
    if (!provider) return;
    setErr("");
    setBusy(true);
    try {
      const orgs = await api.listGitOrgs(provider);
      const have = new Set(
        d.ownersText
          .split(/\r?\n/)
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
      );
      const extra = orgs.filter((o) => !have.has(o.toLowerCase()));
      const cur = d.ownersText.trim();
      set({ ownersText: extra.length ? (cur ? `${cur}\n${extra.join("\n")}` : extra.join("\n")) : cur });
      setMsg(orgs.length ? t("identity.orgsImported", { count: orgs.length }) : t("identity.noOrgs"));
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    setErr("");
    setBusy(true);
    try {
      const created = await ensureCreated(d.pendingKeyId || d.keyId || undefined);
      const owners = d.ownersText
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      for (const o of owners) {
        await api.addOwner(created.identity.id, o);
      }
      sessionStorage.removeItem(DRAFT_KEY);
      nav("/");
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const nameMatch = d.auth?.account
    ? d.auth.account.toLowerCase() === d.name.trim().toLowerCase() ||
      d.auth.account.toLowerCase() === d.gitUserName.trim().toLowerCase()
    : null;

  function jumpStep(i: number) {
    if (i === d.step) return;
    if (i <= d.maxReached) goTo(i);
  }

  return (
    <div className="wizard-overlay">
      <div className="wizard">
        <div className="wizard-head">
          <div className="between">
            <div>
              <div className="title-lg">{t("identity.title")}</div>
              <div className="muted">{t("identity.subtitle")}</div>
              {writesLocked && (
                <div className="callout warn sm" style={{ marginTop: 8 }}>
                  {startupNote || t("identity.syncLocked")}
                </div>
              )}
            </div>
          </div>
          <div className="steps">
            {STEPS.map((s, i) => (
              <div
                key={s}
                className={"step" + (i === d.step ? " active" : i < d.step || i <= d.maxReached ? " done" : "")}
                onClick={() => jumpStep(i)}
                style={i <= d.maxReached && i !== d.step ? { cursor: "pointer" } : undefined}
              >
                <span className="n">{i < d.step || (i <= d.maxReached && i !== d.step) ? "✓" : i + 1}</span>
                {s}
              </div>
            ))}
          </div>
        </div>

        <div className="wizard-body">
          {d.step === 0 && (
            <div className="stack">
              {d.created && <div className="callout warn">{t("identity.createdLocked")}</div>}
              {d.staged && !d.created && <div className="callout warn">{t("identity.stagedLocked")}</div>}
              <div className="field">
                <FieldLabel
                  name={t("identity.platform")}
                  tip={t("identity.platformTip")}
                />
                <div className="choice-row">
                  {PLATFORMS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className={"choice" + (d.platform === p.id ? " on" : "")}
                      disabled={locked}
                      onClick={() => applyPlatform(p.id)}
                    >
                      {p.id === "gitea" ? t("identity.platGitea") : p.id === "other" ? t("identity.platOther") : p.label}
                    </button>
                  ))}
                </div>
                <div className="hint">{t("identity.platformHint")}</div>
              </div>
              <div className="grid c2">
                <div className="field">
                  <FieldLabel
                    name={t("identity.name")}
                    tip={t("identity.nameTip")}
                  />
                  <input className="input" value={d.name} disabled={locked} onChange={(e) => onName(e.target.value)} placeholder={t("identity.namePh")} />
                  <div className="hint">{t("identity.nameHint")}</div>
                </div>
                <div className="field">
                  <FieldLabel
                    name={t("identity.email")}
                    tip={t("identity.emailTip")}
                  />
                  <input
                    className="input"
                    value={d.email}
                    disabled={locked}
                    onChange={(e) => onEmail(e.target.value)}
                    placeholder={t("identity.emailPh")}
                  />
                  <div className="hint">{t("identity.emailHint")}</div>
                </div>
                <div className="field">
                  <FieldLabel
                    name={t("identity.gitUserName")}
                    tip={t("identity.gitUserNameTip")}
                  />
                  <input
                    className="input"
                    value={d.gitUserName}
                    disabled={locked}
                    onChange={(e) => onGitUserName(e.target.value)}
                    placeholder={t("identity.gitUserNamePh")}
                  />
                  <div className="hint">{t("identity.gitUserNameHint")}</div>
                </div>
                <div className="field">
                  <FieldLabel
                    name={t("identity.sshUser")}
                    tip={t("identity.sshUserTip")}
                  />
                  <input
                    className="input mono"
                    value={d.user}
                    disabled={locked}
                    onChange={(e) => set({ user: e.target.value })}
                    placeholder={t("identity.sshUserPh")}
                  />
                  <div className="hint">{t("identity.sshUserHint")}</div>
                </div>
                <div className="field">
                  <FieldLabel
                    name={t("identity.hostAlias")}
                    tip={t("identity.hostAliasTip")}
                  />
                  <input
                    className="input mono"
                    value={d.hostAlias}
                    disabled={locked}
                    placeholder={t("identity.hostAliasPh")}
                    onChange={(e) => set({ aliasTouched: true, hostAlias: e.target.value })}
                  />
                  <div className="hint">{t("identity.hostAliasHint")}</div>
                  {aliasClash && <div className="hint" style={{ color: "var(--red)" }}>{t("identity.aliasTaken")}</div>}
                </div>
                <div className="field">
                  <FieldLabel
                    name={t("identity.realHost")}
                    tip={t("identity.realHostTip")}
                  />
                  <input
                    className="input mono"
                    value={d.realHost}
                    disabled={locked}
                    placeholder={t("identity.realHostPh")}
                    onChange={(e) => set({ hostTouched: true, realHost: e.target.value })}
                  />
                  <div className="hint">{t("identity.realHostHint")}</div>
                </div>
              </div>
            </div>
          )}

          {d.step === 1 && (
            <div className="stack">
              {locked && <div className="callout info">{t("identity.keyLocked")}</div>}
              <div className="field">
                <FieldLabel
                  name={t("identity.keySource")}
                  tip={t("identity.keySourceTip")}
                />
                <div className="choice-row">
                  <button
                    type="button"
                    className={"choice grow" + (d.keyMode === "new" ? " on" : "")}
                    disabled={locked}
                    onClick={() => set({ keyMode: "new", pendingKeyId: "", pendingPub: "" })}
                  >
                    <strong>{t("identity.newKey")}</strong>
                    <div className="muted sm">{t("identity.newKeyDesc")}</div>
                  </button>
                  <button
                    type="button"
                    className={"choice grow" + (d.keyMode === "reuse" ? " on" : "")}
                    disabled={locked}
                    onClick={() => set({ keyMode: "reuse", pendingKeyId: "", pendingPub: "" })}
                  >
                    <strong>{t("identity.reuseKey")}</strong>
                    <div className="muted sm">{t("identity.reuseKeyDesc")}</div>
                  </button>
                </div>
                <div className="hint">{t("identity.keySourceHint")}</div>
              </div>
              {d.keyMode === "new" && (
                <div className="field">
                  <FieldLabel
                    name={t("identity.keyComment")}
                    tip={t("identity.keyCommentTip")}
                  />
                  <input
                    className="input"
                    value={d.keyComment}
                    disabled={locked}
                    placeholder={t("identity.keyCommentPh")}
                    onChange={(e) => set({ commentTouched: true, keyComment: e.target.value })}
                  />
                  <div className="hint">
                    {t("identity.keyCommentHint")}
                  </div>
                </div>
              )}
              {d.keyMode === "reuse" && (
                <div className="field">
                  <FieldLabel name={t("identity.pickKey")} tip={t("identity.pickKeyTip")} />
                  {keys.length === 0 ? (
                    <div className="muted">{t("identity.noKeys")}</div>
                  ) : (
                    <select className="input" value={d.keyId} disabled={locked} onChange={(e) => set({ keyId: e.target.value, pendingPub: "", pendingKeyId: "" })}>
                      <option value="">{t("identity.pickKeyPh")}</option>
                      {keys.map((k) => (
                        <option key={k.id} value={k.id}>
                          {k.name} · {k.algorithm} · {k.fingerprint.slice(0, 24)}
                        </option>
                      ))}
                    </select>
                  )}
                  <div className="hint">{t("identity.pickKeyHint")}</div>
                </div>
              )}
              <div className="field">
                <div className="between">
                  <div>
                    <FieldLabel
                      name={t("identity.strict")}
                      tip={t("identity.strictTip")}
                    />
                    <div className="hint">{t("identity.strictHint")}</div>
                  </div>
                  <button
                    type="button"
                    className={"switch" + (d.strictMode ? "" : " off")}
                    disabled={locked}
                    onClick={() => !locked && set({ strictMode: !d.strictMode })}
                  />
                </div>
              </div>
              <div className="callout info">{t("identity.identityFile", { path: identityFileHint })}</div>
              {preview?.diff && (
                <div>
                  <div className="section-title">{t("identity.diffTitle")}</div>
                  <pre className="code">{preview.diff}</pre>
                </div>
              )}
            </div>
          )}

          {d.step === 2 && (
            <div className="stack">
              <div className="field">
                <FieldLabel
                  name={t("identity.pubKey")}
                  tip={t("identity.pubKeyTip")}
                />
                <div className="code">{publicKey || t("identity.noPub")}</div>
                <div className="hint">{t("identity.pubHint")}</div>
              </div>
              <div className="row" style={{ flexWrap: "wrap" }}>
                <button className="btn" onClick={copyPub} disabled={!publicKey}>
                  {copied ? t("common.copied") : t("identity.copyPub")}
                </button>
                {plat.keysUrl && (
                  <button className="btn" onClick={openKeysPage}>
                    {t("identity.openSshSettings", { label: plat.label })}
                  </button>
                )}
                {asPatProvider(d.platform) && (
                  <button className="btn primary" disabled={busy || d.uploaded || !publicKey || !patConfigured} onClick={uploadViaPat}>
                    {d.uploaded ? t("identity.uploaded") : t("identity.uploadPat")}
                  </button>
                )}
              </div>
              {asPatProvider(d.platform) && (
                <div className="field">
                  <FieldLabel
                    name={t("identity.pat", { platform: t(`pat.platform.${d.platform}`) })}
                    tip={t(`identity.patTip.${d.platform}`)}
                  />
                  {patConfigured ? (
                    <div className="callout good sm">
                      {patLogin
                        ? t("identity.patSavedAccount", { login: patLogin, platform: t(`pat.platform.${d.platform}`) })
                        : t("identity.patSaved")}
                    </div>
                  ) : (
                    <div className="stack" style={{ gap: 8 }}>
                      <div className="muted sm">
                        {t(`identity.patNeed.${d.platform}`)}
                      </div>
                      <input
                        className="input mono"
                        type="password"
                        autoComplete="off"
                        placeholder={t(`pat.tokenPh.${d.platform}`)}
                        value={patInput}
                        onChange={(e) => setPatInput(e.target.value)}
                      />
                      <div className="row" style={{ flexWrap: "wrap" }}>
                        <button type="button" className="btn primary sm" disabled={busy || !patInput.trim()} onClick={savePat}>
                          {t("identity.savePat")}
                        </button>
                        <button
                          type="button"
                          className="btn ghost sm"
                          onClick={() => api.openUrl(PAT_TOKEN_URL[asPatProvider(d.platform)!])}
                        >
                          {t("pat.openTokenPage", { platform: t(`pat.platform.${d.platform}`) })}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
              <hr className="sep" />
              <div className="grid-sum">
                <div>
                  <div className="muted">{t("identity.summaryName")}</div>
                  <div style={{ fontWeight: 600 }}>{d.name || t("common.emDash")}</div>
                </div>
                <div>
                  <div className="muted">{t("identity.summaryAlias")}</div>
                  <div className="mono" style={{ fontWeight: 600 }}>
                    {d.hostAlias || t("common.emDash")}
                  </div>
                </div>
                <div>
                  <div className="muted">{t("identity.summaryPolicy")}</div>
                  <div style={{ fontWeight: 600 }}>{d.strictMode ? t("identity.policyStrict") : t("identity.policyDefault")}</div>
                </div>
                <div>
                  <div className="muted">{t("identity.summaryConfig")}</div>
                  <div style={{ fontWeight: 600 }}>{d.created ? (d.created.configVerified ? t("identity.configWrittenOk") : t("identity.configWrittenFail")) : d.staged ? t("identity.configStaged") : t("identity.configPending")}</div>
                </div>
              </div>
              {d.created?.configBackup && <div className="muted sm">{t("identity.configBackup", { path: d.created.configBackup })}</div>}
            </div>
          )}

          {d.step === 3 && (
            <div className="stack">
              <div className="field">
                <FieldLabel
                  name={t("identity.connVerify")}
                  tip={t("identity.connVerifyTip")}
                />
                <div className="muted">{t("identity.willRun", { alias: d.hostAlias || t("identity.aliasFallback") })}</div>
                <div className="hint">{t("identity.verifyHint")}</div>
              </div>
              <div className="row">
                <button className="btn primary" disabled={busy} onClick={verify}>
                  {busy ? t("identity.verifying") : d.auth ? t("identity.reverify") : t("identity.startVerify")}
                </button>
              </div>
              {d.auth && (
                <div className={"callout " + (d.auth.ok ? "good" : "danger")}>
                  <div>
                    <div>{d.auth.message}</div>
                    {d.auth.account && (
                      <div className="muted sm" style={{ marginTop: 6 }}>
                        {t("identity.measuredAccount", { account: d.auth.account })}
                        {nameMatch === false && t("identity.nameMismatch")}
                        {nameMatch === true && t("identity.nameMatch")}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {d.step === 4 && (
            <div className="stack">
              <div className="field">
                <FieldLabel
                  name={t("identity.owners")}
                  tip={t("identity.ownersTip")}
                />
                <textarea
                  className="input mono"
                  placeholder={t("identity.ownersPh")}
                  value={d.ownersText}
                  onChange={(e) => set({ ownersText: e.target.value })}
                />
                <div className="hint">{t("identity.ownersHint")}</div>
              </div>
              {asPatProvider(d.platform) && (
                <div>
                  <button className="btn" disabled={busy} onClick={importOrgs}>
                    {t("identity.importOrgs", { platform: t(`pat.platform.${d.platform}`) })}
                  </button>
                </div>
              )}
            </div>
          )}

          {msg && <div className="callout info" style={{ marginTop: 16 }}>{msg}</div>}
          {err && <div className="err-text">{err}</div>}
        </div>

        <div className="wizard-foot">
          <div className="row" style={{ gap: 8 }}>
          <button type="button" className="btn danger-frame" onClick={exitWizard}>
            {t("identity.cancelBack")}
          </button>
          {d.step > 0 && (
            <button type="button" className="btn ghost" onClick={() => goTo(d.step - 1)}>
              {t("init.prev")}
            </button>
          )}
          </div>
          {d.step < 4 && (
            <button type="button" className="btn primary" disabled={busy || writesLocked} onClick={() => goTo(d.step + 1)}>
              {busy ? t("common.busy") : d.step === 2 ? t("identity.nextVerify") : d.step === 3 ? (d.auth ? t("common.next") : t("identity.skipVerify")) : t("common.next")}
            </button>
          )}
          {d.step === 4 && (
            <button type="button" className="btn primary" disabled={busy || writesLocked} onClick={finish}>
              {busy ? t("repos.saving") : t("identity.finish")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
