import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { base64DecodeUtf8, base64EncodeUtf8 } from "../../shared/base64Util";
import { md5, sha1Hex, sha256Hex } from "../../shared/hash";
import { packJsSource, unpackJsSource } from "../../shared/jsPack";
import { generateRsaPem, type RsaModulus, type RsaPemPair } from "../../shared/rsaKeygen";
import { symDecrypt, symEncrypt, type SymAlgo } from "../../shared/symmetricCrypto";
import { Card } from "../../ui/common";
import { CopyField, ToolSubPage } from "./ToolsShared";

type CryptoTab = "sym" | "base64" | "hash" | "js" | "rsa";
type SymMode = "encrypt" | "decrypt";

const SYM_ALGOS: { id: SymAlgo; labelKey: string }[] = [
  { id: "aes", labelKey: "tools.cryptoAes" },
  { id: "des", labelKey: "tools.cryptoDes" },
  { id: "3des", labelKey: "tools.crypto3des" },
  { id: "rc4", labelKey: "tools.cryptoRc4" },
  { id: "rabbit", labelKey: "tools.cryptoRabbit" },
];

function HashPanel() {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [md5Out, setMd5Out] = useState("");
  const [sha1Out, setSha1Out] = useState("");
  const [shaOut, setShaOut] = useState("");

  useEffect(() => {
    if (!text) {
      setMd5Out("");
      setSha1Out("");
      setShaOut("");
      return;
    }
    setMd5Out(md5(text));
    let cancelled = false;
    void sha1Hex(text).then((hex) => {
      if (!cancelled) setSha1Out(hex);
    });
    void sha256Hex(text).then((hex) => {
      if (!cancelled) setShaOut(hex);
    });
    return () => {
      cancelled = true;
    };
  }, [text]);

  return (
    <div className="stack">
      <p className="muted sm">{t("tools.hashOneWay")}</p>
      <div className="field">
        <label className="field-label">{t("home.hashInput")}</label>
        <textarea
          className="input"
          rows={4}
          value={text}
          placeholder={t("home.hashInputPh")}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      {text ? (
        <div className="grid c2">
          <CopyField label={t("home.hashMd5")} value={md5Out} rows={2} />
          <CopyField label={t("tools.hashSha1")} value={sha1Out} rows={2} />
          <CopyField label={t("home.hashSha256")} value={shaOut} rows={2} />
        </div>
      ) : (
        <div className="muted sm">{t("home.hashEmpty")}</div>
      )}
    </div>
  );
}

function SymPanel() {
  const { t } = useTranslation();
  const [algo, setAlgo] = useState<SymAlgo>("aes");
  const [mode, setMode] = useState<SymMode>("encrypt");
  const [key, setKey] = useState("");
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setErr("");
    setOutput("");
    try {
      if (!key.trim()) throw new Error("need_key");
      if (mode === "encrypt") {
        setOutput(await symEncrypt(algo, input, key));
      } else {
        setOutput(await symDecrypt(algo, input.trim(), key));
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <p className="muted sm">{t("tools.symHint")}</p>
      <div className="field">
        <label className="field-label">{t("tools.cryptoAlgo")}</label>
        <select className="input" value={algo} onChange={(e) => setAlgo(e.target.value as SymAlgo)}>
          {SYM_ALGOS.map((a) => (
            <option key={a.id} value={a.id}>
              {t(a.labelKey)}
            </option>
          ))}
        </select>
      </div>
      <div className="view-switcher" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "encrypt"}
          className={"view-btn" + (mode === "encrypt" ? " on" : "")}
          onClick={() => setMode("encrypt")}
        >
          {t("tools.encrypt")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "decrypt"}
          className={"view-btn" + (mode === "decrypt" ? " on" : "")}
          onClick={() => setMode("decrypt")}
        >
          {t("tools.decrypt")}
        </button>
      </div>
      <div className="field">
        <label className="field-label">{t("tools.cryptoKey")}</label>
        <input className="input" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
      </div>
      <div className="field">
        <label className="field-label">{mode === "encrypt" ? t("tools.plaintext") : t("tools.ciphertext")}</label>
        <textarea className="input mono" rows={4} value={input} onChange={(e) => setInput(e.target.value)} />
      </div>
      <div>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void run()}>
          {busy ? t("common.busy") : mode === "encrypt" ? t("tools.encrypt") : t("tools.decrypt")}
        </button>
      </div>
      {err && <div className="hint">{t("tools.cryptoFailed")}</div>}
      {output && (
        <CopyField label={mode === "encrypt" ? t("tools.ciphertext") : t("tools.plaintext")} value={output} rows={4} />
      )}
    </div>
  );
}

function Base64Panel() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"encode" | "decode">("encode");
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [err, setErr] = useState("");

  function run() {
    setErr("");
    try {
      setOutput(mode === "encode" ? base64EncodeUtf8(input) : base64DecodeUtf8(input));
    } catch {
      setErr(t("tools.base64Failed"));
      setOutput("");
    }
  }

  return (
    <div className="stack">
      <div className="view-switcher" role="tablist">
        <button
          type="button"
          className={"view-btn" + (mode === "encode" ? " on" : "")}
          onClick={() => setMode("encode")}
        >
          {t("tools.base64Encode")}
        </button>
        <button
          type="button"
          className={"view-btn" + (mode === "decode" ? " on" : "")}
          onClick={() => setMode("decode")}
        >
          {t("tools.base64Decode")}
        </button>
      </div>
      <div className="field">
        <label className="field-label">{t("tools.base64Input")}</label>
        <textarea className="input" rows={4} value={input} onChange={(e) => setInput(e.target.value)} />
      </div>
      <button type="button" className="btn primary" onClick={run}>
        {t("common.generate")}
      </button>
      {err && <div className="hint">{err}</div>}
      {output && <CopyField label={t("tools.base64Output")} value={output} rows={4} />}
    </div>
  );
}

function JsPanel() {
  const { t } = useTranslation();
  const [source, setSource] = useState("");
  const [wrapped, setWrapped] = useState("");
  const [decoded, setDecoded] = useState("");
  const [err, setErr] = useState("");

  function encode() {
    setErr("");
    setWrapped(packJsSource(source));
    setDecoded("");
  }

  function decode() {
    setErr("");
    try {
      setDecoded(unpackJsSource(wrapped));
    } catch {
      setErr(t("tools.jsPackFailed"));
      setDecoded("");
    }
  }

  return (
    <div className="stack">
      <p className="muted sm">{t("tools.jsHint")}</p>
      <div className="field">
        <label className="field-label">{t("tools.jsSource")}</label>
        <textarea className="input mono" rows={5} value={source} onChange={(e) => setSource(e.target.value)} />
      </div>
      <button type="button" className="btn primary" onClick={encode}>
        {t("tools.jsEncode")}
      </button>
      {wrapped && <CopyField label={t("tools.jsWrapped")} value={wrapped} rows={3} />}
      <div className="field">
        <label className="field-label">{t("tools.jsWrapped")}</label>
        <textarea className="input mono" rows={3} value={wrapped} onChange={(e) => setWrapped(e.target.value)} />
      </div>
      <button type="button" className="btn" onClick={decode}>
        {t("tools.jsDecode")}
      </button>
      {err && <div className="hint">{err}</div>}
      {decoded && <CopyField label={t("tools.jsSource")} value={decoded} rows={5} />}
    </div>
  );
}

function RsaPanel() {
  const { t } = useTranslation();
  const [bits, setBits] = useState<RsaModulus>(2048);
  const [pair, setPair] = useState<RsaPemPair | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function run() {
    setBusy(true);
    setErr("");
    try {
      setPair(await generateRsaPem(bits));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <p className="muted sm">{t("home.rsaHint")}</p>
      <div className="field">
        <label className="field-label">{t("home.rsaBits")}</label>
        <select className="input" value={bits} onChange={(e) => setBits(Number(e.target.value) as RsaModulus)}>
          <option value={2048}>2048</option>
          <option value={4096}>4096</option>
        </select>
      </div>
      <div>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void run()}>
          {busy ? t("home.rsaGenerating") : t("home.rsaGenerate")}
        </button>
      </div>
      {err && <div className="hint">{err}</div>}
      {pair ? (
        <>
          <CopyField label={t("home.rsaPublic")} value={pair.publicPem} rows={6} />
          <CopyField label={t("home.rsaPrivate")} value={pair.privatePem} secret rows={8} />
        </>
      ) : (
        <div className="muted sm">{t("home.rsaEmpty")}</div>
      )}
    </div>
  );
}

export function ToolsCryptoPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<CryptoTab>("sym");
  const tabs: { id: CryptoTab; label: string }[] = [
    { id: "sym", label: t("tools.tabSym") },
    { id: "base64", label: t("tools.tabBase64") },
    { id: "hash", label: t("tools.tabHash") },
    { id: "js", label: t("tools.tabJs") },
    { id: "rsa", label: t("home.cryptoRsa") },
  ];

  return (
    <ToolSubPage title={t("home.toolCrypto")} desc={t("tools.cryptoDesc")}>
      <Card>
        <div className="stack">
          <div className="view-switcher tools-crypto-tabs" role="tablist" aria-label={t("home.cryptoType")}>
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                className={"view-btn" + (tab === item.id ? " on" : "")}
                onClick={() => setTab(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          {tab === "sym" && <SymPanel />}
          {tab === "base64" && <Base64Panel />}
          {tab === "hash" && <HashPanel />}
          {tab === "js" && <JsPanel />}
          {tab === "rsa" && <RsaPanel />}
        </div>
      </Card>
    </ToolSubPage>
  );
}
