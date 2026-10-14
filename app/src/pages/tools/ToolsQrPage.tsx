import { useEffect, useMemo, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { copyWithClear } from "../../lib/secretsUi";
import { encodeQrDataUrl, encodeQrSvg } from "../../shared/qrEncode";
import {
  clearQrGenHistory,
  clearQrScanHistory,
  listQrGenHistory,
  listQrScanHistory,
  pushQrGenHistory,
  pushQrScanHistory,
  removeQrGenHistory,
  removeQrScanHistory,
  type QrGenHistoryEntry,
  type QrScanHistoryEntry,
} from "../../shared/qrHistory";
import { QrScannerDialog } from "../../ui/QrScannerDialog";
import { showAppToast } from "../../ui/Toast";
import { CopyField, ToolSubPage, formatToolTime } from "./ToolsShared";

type QrTab = "scan" | "generate";

function safeQrSvg(text: string): string {
  const payload = text.trim();
  if (!payload) return "";
  try {
    return encodeQrSvg(payload);
  } catch {
    return "";
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("qr-image"));
    img.src = src;
  });
}

/**
 * 导出 PNG。`noteWriteExportFile` 只允许文档扩展名，不能写 .png，
 * 所以把 GIF 二维码画到 canvas 后用 data URL 下载。
 */
async function qrPngDataUrl(text: string): Promise<string> {
  const gif = encodeQrDataUrl(text.trim());
  const img = await loadImage(gif);
  const srcW = img.naturalWidth;
  const srcH = img.naturalHeight;
  if (!srcW || !srcH) throw new Error("qr-image");
  const scale = Math.max(1, Math.ceil(512 / Math.max(srcW, srcH)));
  const width = srcW * scale;
  const height = srcH * scale;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL("image/png");
}

function downloadDataUrl(href: string, filename: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function QrHistoryDetail({
  text,
  label,
  resumeLabel,
  onResume,
}: {
  text: string;
  label: string;
  resumeLabel: string;
  onResume: () => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const svg = useMemo(() => safeQrSvg(text), [text]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <div className="tools-qr-detail">
      <div className="field">
        <div className="tools-field-head">
          <span className="field-label">{label}</span>
          <div className="tools-qr-detail-head-actions">
            <button type="button" className="btn primary sm" onClick={onResume}>
              {resumeLabel}
            </button>
            <button
              type="button"
              className="btn sm"
              disabled={!text}
              onClick={() => {
                void copyWithClear(text, undefined, false)
                  .then(() => setCopied(true))
                  .catch(() => showAppToast(t("common.copyFailed")));
              }}
            >
              {copied ? t("common.copied") : t("tools.qrCopySource")}
            </button>
          </div>
        </div>
        <div className="tools-qr-detail-text">{text}</div>
      </div>
      {svg ? (
        <div className="tools-qr tools-qr-detail-code" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div className="muted sm tools-qr-detail-note">{t("tools.qrEncodeFailed")}</div>
      )}
      <div className="tools-qr-detail-actions">
        <button
          type="button"
          className="btn sm"
          disabled={!svg || saving}
          onClick={() => {
            if (!svg || saving) return;
            setSaving(true);
            void qrPngDataUrl(text)
              .then((url) => downloadDataUrl(url, "qrcode.png"))
              .catch(() => showAppToast(t("tools.qrDownloadFailed")))
              .finally(() => setSaving(false));
          }}
        >
          {saving ? t("common.busy") : t("tools.qrDownload")}
        </button>
      </div>
    </div>
  );
}

function HistoryList({
  kind,
  entries,
  selectedId,
  onToggle,
  onRemove,
  onClear,
}: {
  kind: "scan" | "gen";
  entries: (QrScanHistoryEntry | QrGenHistoryEntry)[];
  selectedId: string | null;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  const { t, i18n } = useTranslation();
  return (
    <div className="stack tools-qr-history">
      <div className="tools-qr-history-bar">
        <span className="field-label">{kind === "scan" ? t("tools.qrScanHistory") : t("tools.qrGenHistory")}</span>
        {entries.length > 0 && (
          <button type="button" className="btn ghost sm" onClick={onClear}>
            {t("tools.qrHistoryClearAll")}
          </button>
        )}
      </div>
      {!entries.length ? (
        <div className="muted sm">{t("tools.qrHistoryEmpty")}</div>
      ) : (
        <ul className="tools-history-list">
          {entries.map((entry) => {
            const selected = selectedId === entry.id;
            return (
              <li
                key={entry.id}
                className={"tools-history-item tools-qr-history-item" + (selected ? " is-selected" : "")}
              >
                <div className="tools-qr-history-head">
                  <button
                    type="button"
                    className="tools-qr-history-pick"
                    aria-pressed={selected}
                    onClick={() => onToggle(entry.id)}
                  >
                    <div className="tools-history-meta">{formatToolTime(entry.at, i18n.language)}</div>
                    <div className="tools-qr-history-text">{entry.text}</div>
                  </button>
                  <button
                    type="button"
                    className="btn ghost sm tools-qr-history-remove"
                    aria-label={t("common.delete")}
                    onClick={() => onRemove(entry.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function ToolsQrPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<QrTab>("scan");
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState("");
  const [text, setText] = useState("");
  const [scanHistory, setScanHistory] = useState(listQrScanHistory);
  const [genHistory, setGenHistory] = useState(listQrGenHistory);
  const [openId, setOpenId] = useState<string | null>(null);
  const svg = useMemo(() => {
    const payload = text.trim();
    if (!payload) return "";
    try {
      return encodeQrSvg(payload);
    } catch {
      return "";
    }
  }, [text]);
  const lastGenRecorded = useRef("");
  const history = tab === "scan" ? scanHistory : genHistory;
  const selected = history.find((entry) => entry.id === openId) ?? null;

  function refreshHistory() {
    setScanHistory(listQrScanHistory());
    setGenHistory(listQrGenHistory());
  }

  function toggleOpen(id: string) {
    setOpenId((cur) => (cur === id ? null : id));
  }

  function selectTab(next: QrTab) {
    if (next === tab) return;
    setTab(next);
    setOpenId(null);
  }

  function resumeFromHistory() {
    if (tab === "generate") {
      const pending = text.trim();
      if (pending && svg && lastGenRecorded.current !== pending) {
        lastGenRecorded.current = pending;
        pushQrGenHistory(pending);
        refreshHistory();
      }
      setText("");
    }
    setOpenId(null);
  }

  useEffect(() => {
    const payload = text.trim();
    if (!payload || !svg) return;
    if (lastGenRecorded.current === payload) return;
    const timer = window.setTimeout(() => {
      const latest = text.trim();
      if (!latest || lastGenRecorded.current === latest) return;
      lastGenRecorded.current = latest;
      pushQrGenHistory(latest);
      refreshHistory();
    }, 700);
    return () => window.clearTimeout(timer);
  }, [text, svg]);

  return (
    <ToolSubPage title={t("home.toolQr")} desc={t("home.toolQrDesc")}>
        <div className="tools-qr-page">
          <div className="view-switcher" role="tablist" aria-label={t("home.toolQr")}>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "scan"}
              className={"view-btn" + (tab === "scan" ? " on" : "")}
              onClick={() => selectTab("scan")}
            >
              {t("home.qrScan")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "generate"}
              className={"view-btn" + (tab === "generate" ? " on" : "")}
              onClick={() => selectTab("generate")}
            >
              {t("home.qrGenerate")}
            </button>
          </div>

          <div className="tools-qr-split">
            <div className="stack tools-qr-main">
              {selected ? (
                <QrHistoryDetail
                  text={selected.text}
                  label={tab === "scan" ? t("home.qrResult") : t("home.qrInput")}
                  resumeLabel={tab === "scan" ? t("tools.qrResumeScan") : t("tools.qrResumeGenerate")}
                  onResume={resumeFromHistory}
                />
              ) : tab === "scan" ? (
                <>
                  <div>
                    <button
                      type="button"
                      className="btn primary"
                      onClick={() => {
                        setOpenId(null);
                        setScanning(true);
                      }}
                    >
                      {t("home.qrStartScan")}
                    </button>
                  </div>
                  {scanned ? (
                    <CopyField label={t("home.qrResult")} value={scanned} mono={false} rows={3} />
                  ) : (
                    <div className="muted sm">{t("home.qrEmptyScan")}</div>
                  )}
                </>
              ) : (
                <div className="tools-qr-layout">
                  <div className="field">
                    <label className="field-label">{t("home.qrInput")}</label>
                    <textarea
                      className="input"
                      rows={4}
                      value={text}
                      placeholder={t("home.qrInputPh")}
                      onChange={(e) => {
                        setOpenId(null);
                        setText(e.target.value);
                      }}
                    />
                  </div>
                  {svg ? (
                    <div className="tools-qr" dangerouslySetInnerHTML={{ __html: svg }} />
                  ) : (
                    <div className="muted sm tools-qr-empty">
                      {text.trim() ? t("tools.qrEncodeFailed") : t("home.qrEmptyGen")}
                    </div>
                  )}
                </div>
              )}
            </div>

            <aside className="tools-qr-side">
              {tab === "scan" ? (
                <HistoryList
                  kind="scan"
                  entries={scanHistory}
                  selectedId={openId}
                  onToggle={toggleOpen}
                  onRemove={(id) => {
                    if (openId === id) setOpenId(null);
                    removeQrScanHistory(id);
                    refreshHistory();
                  }}
                  onClear={() => {
                    setOpenId(null);
                    clearQrScanHistory();
                    refreshHistory();
                  }}
                />
              ) : (
                <HistoryList
                  kind="gen"
                  entries={genHistory}
                  selectedId={openId}
                  onToggle={toggleOpen}
                  onRemove={(id) => {
                    if (openId === id) setOpenId(null);
                    removeQrGenHistory(id);
                    refreshHistory();
                  }}
                  onClear={() => {
                    setOpenId(null);
                    clearQrGenHistory();
                    refreshHistory();
                  }}
                />
              )}
            </aside>
          </div>
        </div>
        <QrScannerDialog
          open={scanning}
          onScan={(texts) => {
            setScanning(false);
            const joined = texts.filter(Boolean).join("\n");
            setScanned(joined);
            if (joined.trim()) {
              pushQrScanHistory(joined.trim());
              refreshHistory();
            }
          }}
          onClose={() => setScanning(false)}
        />
    </ToolSubPage>
  );
}
