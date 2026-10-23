import { useState } from "react";
import { useTranslation } from "react-i18next";
import { downloadTextFile } from "../../shared/certgen";
import {
  keyFileStemForAlgo,
  opensshPubDownloadName,
  opensshPubFileBody,
  rsaPemDownloadName,
} from "../../shared/keyCatalog";
import { api, errCode, errMessage } from "../../lib/ipc";
import { isMobilePlatform } from "../../platform/resolve";
import { useApp } from "../../store";
import { Card } from "../../ui/common";
import { KeyExportMenu } from "../../ui/KeyExportMenu";
import { CopyField, ToolSubPage } from "./ToolsShared";

type AlgoChoice = "rsa2048" | "rsa4096" | "ed25519";
type SaveIntent = "git" | "server" | "export";

interface Material {
  algorithm: string;
  bits: number | null;
  fingerprint: string;
  publicOpenssh: string;
  privateOpenssh: string;
  passphrase: string;
}

const ALGOS: { id: AlgoChoice; labelKey: string }[] = [
  { id: "rsa2048", labelKey: "tools.sshRsa2048" },
  { id: "rsa4096", labelKey: "tools.sshRsa4096" },
  { id: "ed25519", labelKey: "tools.sshEd25519" },
];

const INTENTS: { id: SaveIntent; labelKey: string }[] = [
  { id: "git", labelKey: "tools.sshIntentGit" },
  { id: "server", labelKey: "tools.sshIntentServer" },
  { id: "export", labelKey: "tools.sshIntentExport" },
];

function saveFailure(e: unknown, locked: string, busy: string, duplicate: string): string {
  const code = errCode(e);
  const raw = errMessage(e);
  if (code === "LOCKED" || code === "NOT_INITIALIZED" || raw.includes("未解锁") || raw.includes("未初始化")) return locked;
  if (code === "BUSY" || raw.includes("请稍后再修改") || raw.includes("写入已锁定")) return busy;
  if (raw.includes("相同指纹")) return duplicate;
  return raw;
}

export function ToolsSshKeyPage() {
  const { t } = useTranslation();
  const unlocked = useApp((s) => s.status?.unlocked);
  const writesLocked = useApp((s) => s.writesLocked);
  const bumpData = useApp((s) => s.bumpData);
  const mobile = isMobilePlatform();
  const [algo, setAlgo] = useState<AlgoChoice>("ed25519");
  const [name, setName] = useState("");
  const [comment, setComment] = useState("");
  const [material, setMaterial] = useState<Material | null>(null);
  const [intent, setIntent] = useState<SaveIntent | "">("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedName, setSavedName] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  const algoId = algo === "ed25519" ? "ed25519" : "rsa";
  const bits = algo === "rsa4096" ? 4096 : algo === "rsa2048" ? 2048 : null;
  const stem = keyFileStemForAlgo(material?.algorithm ?? algoId, name);

  async function generate() {
    setErr("");
    setMsg("");
    setSavedName("");
    setBusy(true);
    try {
      const next = await api.generateSshMaterial(algoId, bits, comment.trim());
      setMaterial(next);
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!material) return;
    setErr("");
    setMsg("");
    if (!intent) {
      setErr(t("tools.sshNeedIntent"));
      return;
    }
    if (unlocked !== true) {
      setErr(t("tools.sshVaultLocked"));
      return;
    }
    if (writesLocked) {
      setErr(t("tools.sshWritesLocked"));
      return;
    }
    setSaving(true);
    try {
      const saved = await api.saveGeneratedSshKey({
        privateOpenssh: material.privateOpenssh,
        publicOpenssh: material.publicOpenssh,
        passphrase: material.passphrase,
        name: name.trim() || undefined,
        purposeIntent: intent,
      });
      setSavedName(saved.name);
      setMsg(t("tools.sshSaved", { name: saved.name }));
      bumpData();
    } catch (e) {
      setErr(saveFailure(e, t("tools.sshVaultLocked"), t("tools.sshWritesLocked"), t("tools.sshDuplicate")));
    } finally {
      setSaving(false);
    }
  }

  async function exportMaterial(format: "pub" | "pem") {
    if (!material) return;
    setErr("");
    setMsg("");
    try {
      if (format === "pub") {
        const saved = await downloadTextFile(
          opensshPubDownloadName(material.algorithm, stem),
          opensshPubFileBody(material.publicOpenssh),
        );
        if (saved) setMsg(t("keys.exportSaved"));
        return;
      }
      setBusy(true);
      const pem = await api.opensshRsaToPem(material.privateOpenssh, material.passphrase);
      const saved = await downloadTextFile(rsaPemDownloadName(stem), pem.endsWith("\n") ? pem : `${pem}\n`);
      if (saved) setMsg(t("keys.exportPemHint"));
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ToolSubPage title={t("tools.sshTitle")} desc={t("tools.sshDesc")}>
      <Card>
        <div className="stack">
          <p className="muted sm">{t("tools.sshLocalHint")}</p>
          <div className="field">
            <span className="field-label">{t("tools.sshAlgo")}</span>
            <div className="choice-row">
              {ALGOS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={"choice" + (algo === item.id ? " on" : "")}
                  onClick={() => setAlgo(item.id)}
                >
                  {t(item.labelKey)}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label className="field-label">{t("tools.sshName")}</label>
            <input
              className="input"
              value={name}
              placeholder={t("tools.sshNamePh")}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="field-label">{t("tools.sshComment")}</label>
            <input
              className="input"
              value={comment}
              placeholder={t("tools.sshCommentPh")}
              onChange={(e) => setComment(e.target.value)}
            />
          </div>
          <div className="row">
            <button type="button" className="btn primary" disabled={busy} onClick={() => void generate()}>
              {busy ? t("tools.sshGenerating") : t("tools.sshGenerate")}
            </button>
          </div>
          {err && <div className="err-text">{err}</div>}
          {msg && <div className="callout info">{msg}</div>}
        </div>
      </Card>

      {material && (
        <Card>
          <div className="stack">
            <div className="mono muted sm">{material.fingerprint}</div>
            <CopyField label={t("tools.sshPublic")} value={material.publicOpenssh} rows={4} />
            <CopyField label={t("tools.sshPrivate")} value={material.privateOpenssh} secret rows={8} />
            <CopyField label={t("tools.sshPassphrase")} value={material.passphrase} secret rows={2} />
            {mobile ? (
              <p className="muted sm">{t("tools.sshDownloadUnavailable")}</p>
            ) : (
              <KeyExportMenu
                rsa={material.algorithm.toLowerCase() === "rsa"}
                disabled={busy}
                onExport={(format) => void exportMaterial(format)}
              />
            )}
          </div>
        </Card>
      )}

      {material && (
        <Card title={t("tools.sshSave")}>
          <div className="stack">
            <p className="muted sm">{t("tools.sshIntentHint")}</p>
            {unlocked === false && <div className="callout warn">{t("tools.sshVaultLocked")}</div>}
            {writesLocked && <div className="callout warn">{t("tools.sshWritesLocked")}</div>}
            <div className="field">
              <span className="field-label">{t("tools.sshIntent")}</span>
              <div className="choice-row">
                {INTENTS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={"choice" + (intent === item.id ? " on" : "")}
                    onClick={() => setIntent(item.id)}
                  >
                    {t(item.labelKey)}
                  </button>
                ))}
              </div>
            </div>
            <div className="row">
              <button type="button" className="btn primary" disabled={saving || !!savedName} onClick={() => void save()}>
                {saving ? t("tools.sshSaving") : t("tools.sshSave")}
              </button>
            </div>
            {err && <div className="err-text">{err}</div>}
            {msg && <div className="callout info">{msg}</div>}
          </div>
        </Card>
      )}
    </ToolSubPage>
  );
}
