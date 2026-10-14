import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Hash, QrCode, ScanLine, Sparkles, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { copyWithClear } from "../lib/secretsUi";
import { md5, sha256Hex } from "../shared/hash";
import { useOverlayBack } from "../shared/mobileBack";
import { encodeQrSvg } from "../shared/qrEncode";
import {
  DEFAULT_PASSWORD_OPTS,
  generatePassword,
  passwordRootTooLong,
  type GeneratePasswordOpts,
} from "../shared/password";
import { generateRsaPem, type RsaModulus, type RsaPemPair } from "../shared/rsaKeygen";
import { PasswordRootControls, PasswordStrengthBar } from "../ui/PasswordGenerate";
import { QrScannerDialog } from "../ui/QrScannerDialog";
import { FileBeamTool } from "./Overview.mobileFileBeam";

type ToolId = "password" | "crypto" | "qr" | "filebeam";
type CryptoKind = "hash" | "rsa";
type QrTab = "scan" | "generate";

const CRYPTO_KINDS: { id: CryptoKind; labelKey: "home.cryptoHash" | "home.cryptoRsa" }[] = [
  { id: "hash", labelKey: "home.cryptoHash" },
  { id: "rsa", labelKey: "home.cryptoRsa" },
];

function ToolOverlay({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="wizard-overlay" onClick={onClose}>
      <div className="card dialog-card m-tool-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <div className="card-title">{title}</div>
          <button type="button" className="btn ghost sm" onClick={onClose} aria-label={t("common.close")}>
            <X size={16} />
          </button>
        </div>
        <div className="card-body m-tool-dialog-body">{children}</div>
      </div>
    </div>
  );
}

function CopyField({
  label,
  value,
  secret = false,
  mono = true,
}: {
  label: string;
  value: string;
  secret?: boolean;
  mono?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <label className="m-tool-field">
      <span>{label}</span>
      <textarea className={"input m-tool-output" + (mono ? " m-tool-mono" : "")} readOnly rows={3} value={value} />
      <button
        type="button"
        className="btn sm"
        disabled={!value}
        onClick={() => {
          if (value) void copyWithClear(value, undefined, secret);
        }}
      >
        {t("common.copy")}
      </button>
    </label>
  );
}

function PasswordTool() {
  const { t } = useTranslation();
  const [opts, setOpts] = useState<GeneratePasswordOpts>(DEFAULT_PASSWORD_OPTS);
  const [pw, setPw] = useState("");
  const [hint, setHint] = useState("");

  function patch(partial: Partial<GeneratePasswordOpts>) {
    setOpts((prev) => ({ ...prev, ...partial }));
    setHint("");
  }

  function generate() {
    const charsetOk = opts.lower || opts.upper || opts.digits || opts.symbols;
    if (!charsetOk && !passwordRootTooLong(opts)) {
      setHint(t("home.pwNeedCharset"));
      return;
    }
    try {
      setPw(generatePassword(opts));
      setHint("");
    } catch {
      setHint(t("home.pwNeedCharset"));
    }
  }

  return (
    <div className="m-tool-stack">
      <label className="m-tool-range">
        <span>{t("home.pwLength")}</span>
        <input
          type="range"
          min={8}
          max={64}
          value={opts.length}
          onChange={(e) => patch({ length: Number(e.target.value) })}
        />
        <strong>{opts.length}</strong>
      </label>
      <PasswordRootControls layout="mobile" opts={opts} onChange={patch} />
      <label className="m-tool-check">
        <input type="checkbox" checked={opts.lower} onChange={(e) => patch({ lower: e.target.checked })} />
        <span>{t("home.pwLower")}</span>
      </label>
      <label className="m-tool-check">
        <input type="checkbox" checked={opts.upper} onChange={(e) => patch({ upper: e.target.checked })} />
        <span>{t("home.pwUpper")}</span>
      </label>
      <label className="m-tool-check">
        <input type="checkbox" checked={opts.digits} onChange={(e) => patch({ digits: e.target.checked })} />
        <span>{t("home.pwDigits")}</span>
      </label>
      <label className="m-tool-check">
        <input type="checkbox" checked={opts.symbols} onChange={(e) => patch({ symbols: e.target.checked })} />
        <span>{t("home.pwSymbols")}</span>
      </label>
      <label className="m-tool-check">
        <input
          type="checkbox"
          checked={opts.excludeAmbiguous}
          onChange={(e) => patch({ excludeAmbiguous: e.target.checked })}
        />
        <span>{t("home.pwNoAmbiguous")}</span>
      </label>
      {hint && <div className="hint">{hint}</div>}
      <button type="button" className="btn primary" onClick={generate}>
        {t("home.pwGenerate")}
      </button>
      <CopyField label={t("home.pwResult")} value={pw} secret />
      <PasswordStrengthBar password={pw} />
    </div>
  );
}

function HashPanel() {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [md5Out, setMd5Out] = useState("");
  const [shaOut, setShaOut] = useState("");

  useEffect(() => {
    if (!text) {
      setMd5Out("");
      setShaOut("");
      return;
    }
    setMd5Out(md5(text));
    let cancelled = false;
    sha256Hex(text).then((hex) => {
      if (!cancelled) setShaOut(hex);
    });
    return () => {
      cancelled = true;
    };
  }, [text]);

  return (
    <div className="m-tool-stack">
      <label className="m-tool-field">
        <span>{t("home.hashInput")}</span>
        <textarea
          className="input"
          rows={4}
          value={text}
          placeholder={t("home.hashInputPh")}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      {text ? (
        <>
          <CopyField label={t("home.hashMd5")} value={md5Out} />
          <CopyField label={t("home.hashSha256")} value={shaOut} />
        </>
      ) : (
        <div className="muted sm">{t("home.hashEmpty")}</div>
      )}
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
    <div className="m-tool-stack">
      <p className="muted sm">{t("home.rsaHint")}</p>
      <label className="m-tool-field">
        <span>{t("home.rsaBits")}</span>
        <select className="input" value={bits} onChange={(e) => setBits(Number(e.target.value) as RsaModulus)}>
          <option value={2048}>2048</option>
          <option value={4096}>4096</option>
        </select>
      </label>
      <button type="button" className="btn primary" disabled={busy} onClick={() => void run()}>
        {busy ? t("home.rsaGenerating") : t("home.rsaGenerate")}
      </button>
      {err && <div className="hint">{err}</div>}
      {pair ? (
        <>
          <CopyField label={t("home.rsaPublic")} value={pair.publicPem} />
          <CopyField label={t("home.rsaPrivate")} value={pair.privatePem} secret />
        </>
      ) : (
        <div className="muted sm">{t("home.rsaEmpty")}</div>
      )}
    </div>
  );
}

function CryptoTool() {
  const { t } = useTranslation();
  const [kind, setKind] = useState<CryptoKind>("hash");

  return (
    <div className="m-tool-stack">
      <label className="m-tool-field">
        <span>{t("home.cryptoType")}</span>
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value as CryptoKind)}>
          {CRYPTO_KINDS.map((item) => (
            <option key={item.id} value={item.id}>
              {t(item.labelKey)}
            </option>
          ))}
        </select>
      </label>
      {kind === "hash" ? <HashPanel /> : <RsaPanel />}
    </div>
  );
}

function QrTool() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<QrTab>("scan");
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState("");
  const [text, setText] = useState("");
  const svg = useMemo(() => (text.trim() ? encodeQrSvg(text.trim()) : ""), [text]);

  return (
    <div className="m-tool-stack">
      <div className="m-tool-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "scan"}
          className={"m-tool-tab" + (tab === "scan" ? " on" : "")}
          onClick={() => setTab("scan")}
        >
          {t("home.qrScan")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "generate"}
          className={"m-tool-tab" + (tab === "generate" ? " on" : "")}
          onClick={() => setTab("generate")}
        >
          {t("home.qrGenerate")}
        </button>
      </div>

      {tab === "scan" ? (
        <>
          <button type="button" className="btn primary" onClick={() => setScanning(true)}>
            {t("home.qrStartScan")}
          </button>
          {scanned ? (
            <CopyField label={t("home.qrResult")} value={scanned} mono={false} />
          ) : (
            <div className="muted sm">{t("home.qrEmptyScan")}</div>
          )}
          <QrScannerDialog
            open={scanning}
            onScan={(texts) => {
              setScanning(false);
              setScanned(texts.filter(Boolean).join("\n"));
            }}
            onClose={() => setScanning(false)}
          />
        </>
      ) : (
        <>
          <label className="m-tool-field">
            <span>{t("home.qrInput")}</span>
            <textarea
              className="input"
              rows={3}
              value={text}
              placeholder={t("home.qrInputPh")}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          {svg ? (
            <div className="m-tool-qr" dangerouslySetInnerHTML={{ __html: svg }} />
          ) : (
            <div className="muted sm">{t("home.qrEmptyGen")}</div>
          )}
        </>
      )}
    </div>
  );
}

export function OverviewMobileTools() {
  const { t } = useTranslation();
  const [open, setOpen] = useState<ToolId | null>(null);
  useOverlayBack(open !== null, () => setOpen(null));

  const cards: { id: ToolId; title: string; desc: string; icon: ReactNode }[] = [
    {
      id: "password",
      title: t("home.toolPassword"),
      desc: t("home.toolPasswordDesc"),
      icon: <Sparkles size={18} />,
    },
    {
      id: "crypto",
      title: t("home.toolCrypto"),
      desc: t("home.toolCryptoDesc"),
      icon: <Hash size={18} />,
    },
    {
      id: "qr",
      title: t("home.toolQr"),
      desc: t("home.toolQrDesc"),
      icon: <QrCode size={18} />,
    },
    {
      id: "filebeam",
      title: t("tools.fileBeamTitle"),
      desc: t("tools.fileBeamDesc"),
      icon: <ScanLine size={18} />,
    },
  ];

  return (
    <section className="m-tools">
      <div className="m-tools-title">{t("home.toolsTitle")}</div>
      <div className="m-tools-grid">
        {cards.map((card) => (
          <button key={card.id} type="button" className={`m-tool-card tone-${card.id}`} onClick={() => setOpen(card.id)}>
            <span className="m-tool-card-icon">{card.icon}</span>
            <span className="m-tool-card-title">{card.title}</span>
            <span className="m-tool-card-desc">{card.desc}</span>
          </button>
        ))}
      </div>

      {open === "password" && (
        <ToolOverlay title={t("home.toolPassword")} onClose={() => setOpen(null)}>
          <PasswordTool />
        </ToolOverlay>
      )}
      {open === "crypto" && (
        <ToolOverlay title={t("home.toolCrypto")} onClose={() => setOpen(null)}>
          <CryptoTool />
        </ToolOverlay>
      )}
      {open === "qr" && (
        <ToolOverlay title={t("home.toolQr")} onClose={() => setOpen(null)}>
          <QrTool />
        </ToolOverlay>
      )}
      {open === "filebeam" && (
        <ToolOverlay title={t("tools.fileBeamTitle")} onClose={() => setOpen(null)}>
          <FileBeamTool />
        </ToolOverlay>
      )}
    </section>
  );
}
