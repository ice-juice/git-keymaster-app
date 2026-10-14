import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, Hash, QrCode, ScanLine, ShieldCheck, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { copyWithClear } from "../lib/secretsUi";
import { useOverlayBack } from "../shared/mobileBack";
import { encodeQrSvg } from "../shared/qrEncode";
import {
  loadSyncedQrHistory,
  pushQrGenHistory,
  pushQrScanHistory,
  type QrHistoryLists,
} from "../shared/qrHistory";
import { useApp } from "../store";
import {
  DEFAULT_PASSWORD_OPTS,
  generatePassword,
  passwordRootTooLong,
  type GeneratePasswordOpts,
} from "../shared/password";
import { PasswordRootControls, PasswordStrengthBar } from "../ui/PasswordGenerate";
import { QrScannerDialog } from "../ui/QrScannerDialog";
import { showAppToast } from "../ui/Toast";
import { MobileQrHistory } from "./Overview.mobileQrHistory";
import { FileBeamTool } from "./Overview.mobileFileBeam";
import { ToolsCertsPage } from "./tools/ToolsCertsPage";
import { ToolsCryptoPage } from "./tools/ToolsCryptoPage";
import { ToolEmbed } from "./tools/ToolsShared";

type ToolId = "password" | "crypto" | "qr" | "certs" | "filebeam";
type QrTab = "scan" | "generate";

function ToolSubpage({
  title,
  onClose,
  beam = false,
  children,
}: {
  title: string;
  onClose: () => void;
  beam?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  useOverlayBack(true, onClose);
  return (
    <div className="m-subpage-stage m-tool-subpage">
      <header className="m-subpage-nav">
        <button type="button" className="m-subpage-nav-back" aria-label={t("common.back")} onClick={onClose}>
          <ChevronLeft size={22} />
          <span>{t("common.back")}</span>
        </button>
        <h1 className="m-subpage-nav-title">{title}</h1>
        <span className="m-subpage-nav-balance" aria-hidden="true" />
      </header>
      <main className={"m-subpage-content" + (beam ? " is-beam" : "")}>{children}</main>
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

function QrTool() {
  const { t } = useTranslation();
  const dataVersion = useApp((s) => s.dataVersion);
  const [tab, setTab] = useState<QrTab>("scan");
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState("");
  const [text, setText] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLists, setHistoryLists] = useState<QrHistoryLists>({ scans: [], generations: [] });
  const [historyReady, setHistoryReady] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const lastGenRecorded = useRef("");
  const historyTicket = useRef(0);
  const closeHistory = useCallback(() => setHistoryOpen(false), []);
  const applyHistory = useCallback((data: QrHistoryLists) => {
    historyTicket.current += 1;
    setHistoryLists(data);
    setHistoryReady(true);
    setHistoryError(false);
  }, []);
  const svg = useMemo(() => {
    const payload = text.trim();
    if (!payload) return "";
    try {
      return encodeQrSvg(payload);
    } catch {
      return "";
    }
  }, [text]);

  useEffect(() => {
    const ticket = ++historyTicket.current;
    let cancelled = false;
    void loadSyncedQrHistory()
      .then((data) => {
        if (cancelled || ticket !== historyTicket.current) return;
        setHistoryLists(data);
        setHistoryReady(true);
        setHistoryError(false);
      })
      .catch(() => {
        if (cancelled || ticket !== historyTicket.current) return;
        setHistoryError(true);
        showAppToast(t("common.errorTitle"));
      });
    return () => {
      cancelled = true;
    };
  }, [dataVersion, t]);

  useEffect(() => {
    const payload = text.trim();
    if (!payload || !svg) return;
    if (lastGenRecorded.current === payload) return;
    const timer = window.setTimeout(() => {
      const latest = text.trim();
      if (!latest || lastGenRecorded.current === latest) return;
      lastGenRecorded.current = latest;
      void pushQrGenHistory(latest)
        .then(applyHistory)
        .catch(() => showAppToast(t("common.errorTitle")));
    }, 700);
    return () => window.clearTimeout(timer);
  }, [text, svg, t, applyHistory]);

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

      <button type="button" className="btn m-qr-history-open" onClick={() => setHistoryOpen(true)}>
        {t("tools.qrHistoryOpen")}
      </button>

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
              const joined = texts.filter(Boolean).join("\n");
              setScanned(joined);
              if (joined.trim()) {
                void pushQrScanHistory(joined.trim())
                  .then(applyHistory)
                  .catch(() => showAppToast(t("common.errorTitle")));
              }
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
      {historyOpen && (
        <MobileQrHistory
          initialKind={tab}
          lists={historyLists}
          loading={!historyReady && !historyError}
          loadError={historyError}
          onClose={closeHistory}
          onLists={applyHistory}
        />
      )}
    </div>
  );
}

export function OverviewMobileTools() {
  const { t } = useTranslation();
  const [open, setOpen] = useState<ToolId | null>(null);
  const close = useCallback(() => setOpen(null), []);

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
      id: "certs",
      title: t("tools.certsTitle"),
      desc: t("tools.certsDesc"),
      icon: <ShieldCheck size={18} />,
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
        <ToolSubpage title={t("home.toolPassword")} onClose={close}>
          <PasswordTool />
        </ToolSubpage>
      )}
      {open === "crypto" && (
        <ToolSubpage title={t("home.toolCrypto")} onClose={close}>
          <ToolEmbed>
            <ToolsCryptoPage />
          </ToolEmbed>
        </ToolSubpage>
      )}
      {open === "qr" && (
        <ToolSubpage title={t("home.toolQr")} onClose={close}>
          <QrTool />
        </ToolSubpage>
      )}
      {open === "certs" && (
        <ToolSubpage title={t("tools.certsTitle")} onClose={close}>
          <ToolEmbed>
            <ToolsCertsPage />
          </ToolEmbed>
        </ToolSubpage>
      )}
      {open === "filebeam" && (
        <ToolSubpage title={t("tools.fileBeamTitle")} onClose={close} beam>
          <FileBeamTool />
        </ToolSubpage>
      )}
    </section>
  );
}
