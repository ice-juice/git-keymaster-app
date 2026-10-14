import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  caMaterialFromPem,
  downloadTextFile,
  generateCaCert,
  generateSelfSignedCert,
  generateServerCertSignedByCa,
  type PemCertBundle,
} from "../../shared/certgen";
import { Card } from "../../ui/common";
import { CopyField, ToolSubPage } from "./ToolsShared";

type CertTab = "android" | "ssl" | "ca";

const CA_SESSION_KEY = "gk-tools-ca-session";

type CaSession = {
  certPem: string;
  keyPem: string;
  subjectCn: string;
};

function saveCaSession(ca: CaSession) {
  try {
    sessionStorage.setItem(CA_SESSION_KEY, JSON.stringify(ca));
  } catch {
    /* ignore */
  }
}

function readCaSession(): CaSession | null {
  try {
    const raw = sessionStorage.getItem(CA_SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as CaSession;
  } catch {
    return null;
  }
}

function ResultBlock({ bundle, prefix }: { bundle: PemCertBundle | null; prefix: string }) {
  const { t } = useTranslation();
  if (!bundle) return null;
  return (
    <div className="stack">
      <CopyField label={t("tools.certPem")} value={bundle.certPem} rows={8} />
      <CopyField label={t("tools.keyPem")} value={bundle.keyPem} secret rows={8} />
      <div className="row">
        <button type="button" className="btn sm" onClick={() => downloadTextFile(`${prefix}-cert.pem`, bundle.certPem)}>
          {t("tools.downloadCert")}
        </button>
        <button type="button" className="btn sm" onClick={() => downloadTextFile(`${prefix}-key.pem`, bundle.keyPem)}>
          {t("tools.downloadKey")}
        </button>
      </div>
    </div>
  );
}

export function ToolsCertsPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<CertTab>("android");
  const [alias, setAlias] = useState("my-release-key");
  const [keystorePass, setKeystorePass] = useState("");
  const [cn, setCn] = useState("localhost");
  const [days, setDays] = useState(3650);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [androidBundle, setAndroidBundle] = useState<PemCertBundle | null>(null);
  const [caBundle, setCaBundle] = useState<PemCertBundle | null>(null);
  const [sslBundle, setSslBundle] = useState<PemCertBundle | null>(null);
  const [sslMode, setSslMode] = useState<"self" | "ca">("self");
  const [caCertPaste, setCaCertPaste] = useState(readCaSession()?.certPem ?? "");
  const [caKeyPaste, setCaKeyPaste] = useState(readCaSession()?.keyPem ?? "");
  const [caCnPaste, setCaCnPaste] = useState(readCaSession()?.subjectCn ?? "Local CA");

  async function genAndroid() {
    setBusy(true);
    setErr("");
    try {
      const bundle = await generateSelfSignedCert({
        commonName: alias.trim() || "android-release",
        daysValid: days,
        isCa: false,
      });
      setAndroidBundle(bundle);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function genCa() {
    setBusy(true);
    setErr("");
    try {
      const out = await generateCaCert(cn.trim() || "Local CA", days);
      setCaBundle(out);
      saveCaSession({ certPem: out.certPem, keyPem: out.keyPem, subjectCn: out.subjectCn });
      setCaCertPaste(out.certPem);
      setCaKeyPaste(out.keyPem);
      setCaCnPaste(out.subjectCn);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function genSsl() {
    setBusy(true);
    setErr("");
    try {
      if (sslMode === "self") {
        setSslBundle(
          await generateSelfSignedCert({
            commonName: cn.trim() || "localhost",
            daysValid: days,
            isCa: false,
          }),
        );
      } else {
        const ca = await caMaterialFromPem(caCertPaste, caKeyPaste, caCnPaste.trim() || "Local CA");
        setSslBundle(
          await generateServerCertSignedByCa({
            commonName: cn.trim() || "localhost",
            daysValid: days,
            ca,
          }),
        );
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ToolSubPage title={t("tools.certsTitle")} desc={t("tools.certsDesc")}>
      <Card>
        <div className="stack">
          <p className="muted sm">{t("tools.certsLocalHint")}</p>
          <div className="view-switcher" role="tablist">
            <button
              type="button"
              className={"view-btn" + (tab === "android" ? " on" : "")}
              onClick={() => setTab("android")}
            >
              {t("tools.certAndroid")}
            </button>
            <button type="button" className={"view-btn" + (tab === "ssl" ? " on" : "")} onClick={() => setTab("ssl")}>
              {t("tools.certSsl")}
            </button>
            <button type="button" className={"view-btn" + (tab === "ca" ? " on" : "")} onClick={() => setTab("ca")}>
              {t("tools.certCa")}
            </button>
          </div>

          <div className="field">
            <label className="field-label">{t("tools.certDays")}</label>
            <input
              type="number"
              className="input"
              min={1}
              max={36500}
              value={days}
              onChange={(e) => setDays(Number(e.target.value) || 365)}
            />
          </div>

          {tab === "android" && (
            <>
              <p className="muted sm">{t("tools.certAndroidHint")}</p>
              <div className="field">
                <label className="field-label">{t("tools.certAlias")}</label>
                <input className="input" value={alias} onChange={(e) => setAlias(e.target.value)} />
              </div>
              <div className="field">
                <label className="field-label">{t("tools.certKeystorePass")}</label>
                <input
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={keystorePass}
                  placeholder={t("tools.certKeystorePassPh")}
                  onChange={(e) => setKeystorePass(e.target.value)}
                />
                <div className="muted sm">
                  {t("tools.certKeystorePassNote")}
                  {keystorePass
                    ? ` ${t("tools.certPkcs12Cmd", { alias: alias.trim() || "release", pass: keystorePass })}`
                    : ""}
                </div>
              </div>
              <button type="button" className="btn primary" disabled={busy} onClick={() => void genAndroid()}>
                {busy ? t("common.busy") : t("tools.certGenerate")}
              </button>
              <ResultBlock bundle={androidBundle} prefix="android-signing" />
            </>
          )}

          {tab === "ca" && (
            <>
              <p className="muted sm">{t("tools.certCaHint")}</p>
              <div className="field">
                <label className="field-label">{t("tools.certCommonName")}</label>
                <input className="input" value={cn} onChange={(e) => setCn(e.target.value)} />
              </div>
              <button type="button" className="btn primary" disabled={busy} onClick={() => void genCa()}>
                {busy ? t("common.busy") : t("tools.certGenerateCa")}
              </button>
              <ResultBlock bundle={caBundle} prefix="ca-root" />
            </>
          )}

          {tab === "ssl" && (
            <>
              <p className="muted sm">{t("tools.certSslHint")}</p>
              <div className="field">
                <label className="field-label">{t("tools.certCommonName")}</label>
                <input className="input" value={cn} onChange={(e) => setCn(e.target.value)} />
              </div>
              <div className="view-switcher">
                <button
                  type="button"
                  className={"view-btn" + (sslMode === "self" ? " on" : "")}
                  onClick={() => setSslMode("self")}
                >
                  {t("tools.certSelfSigned")}
                </button>
                <button
                  type="button"
                  className={"view-btn" + (sslMode === "ca" ? " on" : "")}
                  onClick={() => setSslMode("ca")}
                >
                  {t("tools.certSignedByCa")}
                </button>
              </div>
              {sslMode === "ca" && (
                <>
                  <div className="field">
                    <label className="field-label">{t("tools.certCaCn")}</label>
                    <input className="input" value={caCnPaste} onChange={(e) => setCaCnPaste(e.target.value)} />
                  </div>
                  <div className="field">
                    <label className="field-label">{t("tools.certCaCertPem")}</label>
                    <textarea className="input mono" rows={4} value={caCertPaste} onChange={(e) => setCaCertPaste(e.target.value)} />
                  </div>
                  <div className="field">
                    <label className="field-label">{t("tools.certCaKeyPem")}</label>
                    <textarea
                      className="input mono"
                      rows={4}
                      value={caKeyPaste}
                      onChange={(e) => setCaKeyPaste(e.target.value)}
                    />
                  </div>
                </>
              )}
              <button type="button" className="btn primary" disabled={busy} onClick={() => void genSsl()}>
                {busy ? t("common.busy") : t("tools.certGenerateSsl")}
              </button>
              <ResultBlock bundle={sslBundle} prefix="server-tls" />
            </>
          )}

          {err && <div className="hint">{err}</div>}
        </div>
      </Card>
    </ToolSubPage>
  );
}
