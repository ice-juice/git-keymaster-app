import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  api,
  errMessage,
  type Identity,
  type KeyRecord,
  type AgentStatus,
  type ConfigView,
  type AuthResult,
  type UpdateIdentityArgs,
} from "../../lib/ipc";
import { loadAgentStatus } from "../../lib/agentCache";
import { writeClipboard } from "../../lib/clipboard";
import { useApp } from "../../store";
import { resolvePlatform } from "../../platform/resolve";

const AVATAR_COLORS = [
  "linear-gradient(135deg, #6366f1, #4f46e5)",
  "linear-gradient(135deg, #10b981, #059669)",
  "linear-gradient(135deg, #f59e0b, #d97706)",
  "linear-gradient(135deg, #0ea5e9, #0284c7)",
  "linear-gradient(135deg, #ec4899, #db2777)",
  "linear-gradient(135deg, #8b5cf6, #7c3aed)",
  "linear-gradient(135deg, #14b8a6, #0d9488)",
];

export function getAvatarBg(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0;
  }
  const idx = Math.abs(hash) % AVATAR_COLORS.length;
  return AVATAR_COLORS[idx];
}

export interface TestResultMap {
  [hostAlias: string]: {
    loading?: boolean;
    result?: AuthResult;
    testedAt?: string;
  };
}

export function useOverviewModel() {
  const nav = useNavigate();
  const { writesLocked } = useApp();
  const skipLocalGit = resolvePlatform() === "mobile";
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [keys, setKeys] = useState<KeyRecord[]>([]);
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [configView, setConfigView] = useState<ConfigView | null>(null);
  const [testResults, setTestResults] = useState<TestResultMap>({});
  const [loadingAll, setLoadingAll] = useState(false);
  const [err, setErr] = useState("");
  const [copiedKeyId, setCopiedKeyId] = useState<string | null>(null);
  const [editingIdentity, setEditingIdentity] = useState<Identity | null>(null);
  const [confirmAliasChange, setConfirmAliasChange] = useState<{
    original: Identity;
    updated: UpdateIdentityArgs;
  } | null>(null);
  const [deletingIdentity, setDeletingIdentity] = useState<Identity | null>(null);

  const loadData = async () => {
    try {
      setErr("");
      if (skipLocalGit) {
        const [ids, ks] = await Promise.all([api.listIdentities(), api.listKeys()]);
        setIdentities(ids);
        setKeys(ks);
        setAgentStatus(null);
        setConfigView(null);
        return;
      }
      const [ids, ks, ag, cfg] = await Promise.all([
        api.listIdentities(),
        api.listKeys(),
        loadAgentStatus().catch(() => null),
        api.readSshConfig().catch(() => null),
      ]);
      setIdentities(ids);
      setKeys(ks);
      setAgentStatus(ag);
      setConfigView(cfg);
    } catch (e) {
      setErr(errMessage(e));
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (writesLocked) return;
    Promise.all([api.listIdentities(), api.listKeys()])
      .then(([ids, ks]) => {
        setIdentities(ids);
        setKeys(ks);
      })
      .catch(() => {});
  }, [writesLocked]);

  const handleCopyPublic = async (keyId: string | null) => {
    if (!keyId) return;
    const k = keys.find((item) => item.id === keyId);
    if (!k || !k.publicOpenssh) return;
    await writeClipboard(k.publicOpenssh.trim());
    setCopiedKeyId(keyId);
    setTimeout(() => setCopiedKeyId(null), 1800);
  };

  const handleTestConnection = async (hostAlias: string) => {
    setTestResults((prev) => ({
      ...prev,
      [hostAlias]: { ...prev[hostAlias], loading: true },
    }));
    try {
      const res = await api.testConnection(hostAlias);
      setTestResults((prev) => ({
        ...prev,
        [hostAlias]: {
          loading: false,
          result: res,
          testedAt: new Date().toLocaleTimeString(),
        },
      }));
    } catch (e) {
      setTestResults((prev) => ({
        ...prev,
        [hostAlias]: {
          loading: false,
          result: {
            ok: false,
            account: null,
            message: errMessage(e),
            errorCode: "ERR",
          },
          testedAt: new Date().toLocaleTimeString(),
        },
      }));
    }
  };

  const handleTestAll = async () => {
    if (loadingAll || identities.length === 0) return;
    setLoadingAll(true);
    setErr("");
    try {
      await api.agentEnsure().catch(() => null);
      const [ag, cfg] = await Promise.all([
        loadAgentStatus(true).catch(() => null),
        api.readSshConfig().catch(() => null),
      ]);
      setAgentStatus(ag);
      setConfigView(cfg);

      for (const id of identities) {
        setTestResults((prev) => ({
          ...prev,
          [id.hostAlias]: { ...prev[id.hostAlias], loading: true },
        }));
        try {
          const res = await api.testConnection(id.hostAlias);
          setTestResults((prev) => ({
            ...prev,
            [id.hostAlias]: {
              loading: false,
              result: res,
              testedAt: new Date().toLocaleTimeString(),
            },
          }));
        } catch (e) {
          setTestResults((prev) => ({
            ...prev,
            [id.hostAlias]: {
              loading: false,
              result: {
                ok: false,
                account: null,
                message: errMessage(e),
                errorCode: "ERR",
              },
              testedAt: new Date().toLocaleTimeString(),
            },
          }));
        }
      }
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setLoadingAll(false);
    }
  };

  const handleLoadToAgent = async (identityId: string) => {
    try {
      setErr("");
      await api.agentEnsure();
      await api.agentLoadIdentity(identityId);
      const ag = await loadAgentStatus(true);
      setAgentStatus(ag);
    } catch (e) {
      setErr(errMessage(e));
    }
  };

  const handleFixConfig = async (id: Identity) => {
    try {
      const k = keys.find((key) => key.id === id.keyId);
      const identityFile = k?.deployedPath || k?.sourcePath || "";
      await api.applyConfig({
        alias: id.hostAlias,
        hostName: id.realHost,
        user: id.user || "git",
        identityFile,
        identitiesOnly: true,
      });
      const cfg = await api.readSshConfig();
      setConfigView(cfg);
    } catch (e) {
      setErr(errMessage(e));
    }
  };

  const stats = useMemo(() => {
    let okCount = 0;
    let issuesCount = 0;

    identities.forEach((id) => {
      let hasIssue = false;
      const k = keys.find((item) => item.id === id.keyId);
      if (!k) hasIssue = true;

      const block = configView?.blocks.find((b) => b.patterns.includes(id.hostAlias));
      const hasIdentitiesOnly = block?.options.some(
        ([key, v]) => key.toLowerCase() === "identitiesonly" && v.toLowerCase() === "yes",
      );
      if (!block || !hasIdentitiesOnly) hasIssue = true;

      const inAgent =
        agentStatus?.running &&
        agentStatus?.keys.some(
          (ak) => ak.identityName === id.name || (k && ak.agent.fingerprint === k.fingerprint),
        );
      if (!inAgent) hasIssue = true;

      const test = testResults[id.hostAlias];
      if (test?.result?.ok) {
        okCount++;
      } else if (test?.result && !test.result.ok) {
        hasIssue = true;
      }

      if (hasIssue) issuesCount++;
    });

    return {
      totalIdentities: identities.length,
      totalKeys: keys.length,
      okCount,
      issuesCount,
    };
  }, [identities, keys, agentStatus, configView, testResults]);

  const handleSaveIdentity = async (formData: UpdateIdentityArgs) => {
    if (!editingIdentity) return;
    const isAliasChanged = editingIdentity.hostAlias !== formData.hostAlias.trim();

    if (isAliasChanged) {
      setConfirmAliasChange({
        original: editingIdentity,
        updated: formData,
      });
      return;
    }

    await executeUpdateIdentity(formData);
  };

  const executeUpdateIdentity = async (formData: UpdateIdentityArgs) => {
    try {
      await api.updateIdentity(formData);
      setEditingIdentity(null);
      setConfirmAliasChange(null);
      await loadData();
    } catch (e) {
      setErr(errMessage(e));
    }
  };

  const handleDeleteIdentity = async (identityId: string) => {
    try {
      await api.deleteIdentity(identityId);
      setDeletingIdentity(null);
      setEditingIdentity(null);
      await loadData();
    } catch (e) {
      setErr(errMessage(e));
    }
  };

  return {
    writesLocked,
    identities,
    keys,
    agentStatus,
    configView,
    testResults,
    loadingAll,
    err,
    copiedKeyId,
    editingIdentity,
    setEditingIdentity,
    confirmAliasChange,
    setConfirmAliasChange,
    deletingIdentity,
    setDeletingIdentity,
    stats,
    handleCopyPublic,
    handleTestConnection,
    handleTestAll,
    handleLoadToAgent,
    handleFixConfig,
    handleSaveIdentity,
    executeUpdateIdentity,
    handleDeleteIdentity,
    goNewIdentity: () => nav("/identities/new"),
  };
}
