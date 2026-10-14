import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { copyWithClear } from "../lib/secretsUi";
import { useOverlayBack } from "../shared/mobileBack";
import { encodeQrDataUrl, encodeQrSvg } from "../shared/qrEncode";
import {
  clearQrGenHistory,
  clearQrScanHistory,
  removeQrGenHistory,
  removeQrScanHistory,
  type QrHistoryEntry,
  type QrHistoryLists,
} from "../shared/qrHistory";
import { formatToolTime } from "./tools/ToolsShared";
import { showAppToast } from "../ui/Toast";

type HistoryKind = "scan" | "generate";

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

/** 与电脑端历史详情同一套缩放：白底、关闭平滑，按原文导出 PNG。 */
async function qrPngFile(text: string): Promise<File> {
  const gif = encodeQrDataUrl(text.trim());
  const img = await loadImage(gif);
  const srcW = img.naturalWidth;
  const srcH = img.naturalHeight;
  if (!srcW || !srcH) throw new Error("qr-image");
  const scale = Math.max(1, Math.ceil(512 / Math.max(srcW, srcH)));
  const canvas = document.createElement("canvas");
  canvas.width = srcW * scale;
  canvas.height = srcH * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((next) => (next ? resolve(next) : reject(new Error("png"))), "image/png");
  });
  return new File([blob], "qrcode.png", { type: "image/png" });
}

function downloadFile(file: File) {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** 手机优先走系统分享，方便存到相册或文件；没有分享能力时再退回下载。 */
async function shareOrDownloadQrPng(text: string): Promise<"shared" | "downloaded" | "cancelled"> {
  const file = await qrPngFile(text);
  const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
  if (typeof nav.share === "function" && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: file.name });
      return "shared";
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return "cancelled";
    }
  }
  downloadFile(file);
  return "downloaded";
}

function HistoryStage({
  title,
  onClose,
  footer,
  children,
  detail = false,
}: {
  title: string;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
  detail?: boolean;
}) {
  const { t } = useTranslation();
  useOverlayBack(true, onClose);
  return (
    <div className={"m-subpage-stage m-tool-subpage" + (detail ? " m-qr-history-detail" : "")}>
      <header className="m-subpage-nav">
        <button type="button" className="m-subpage-nav-back" aria-label={t("common.back")} onClick={onClose}>
          <ChevronLeft size={22} />
          <span>{t("common.back")}</span>
        </button>
        <h1 className="m-subpage-nav-title">{title}</h1>
        <span className="m-subpage-nav-balance" aria-hidden="true" />
      </header>
      <main className="m-subpage-content">{children}</main>
      {footer}
    </div>
  );
}

function HistoryDetail({
  kind,
  entry,
  busy,
  onClose,
  onDelete,
}: {
  kind: HistoryKind;
  entry: QrHistoryEntry;
  busy: boolean;
  onClose: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [armed, setArmed] = useState(false);
  const svg = useMemo(() => safeQrSvg(entry.text), [entry.text]);
  const label = kind === "scan" ? t("home.qrResult") : t("home.qrInput");

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    setArmed(false);
    setCopied(false);
  }, [entry.id]);

  return (
    <HistoryStage
      detail
      title={kind === "scan" ? t("tools.qrScanHistory") : t("tools.qrGenHistory")}
      onClose={onClose}
      footer={
        <div className="m-qr-history-dock">
          <button
            type="button"
            className="btn"
            disabled={!entry.text}
            onClick={() => {
              void copyWithClear(entry.text, undefined, false)
                .then(() => setCopied(true))
                .catch(() => {});
            }}
          >
            {copied ? t("common.copied") : t("tools.qrCopySource")}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!svg || saving}
            onClick={() => {
              if (!svg || saving) return;
              setSaving(true);
              void shareOrDownloadQrPng(entry.text)
                .catch(() => showAppToast(t("tools.qrDownloadFailed")))
                .finally(() => setSaving(false));
            }}
          >
            {saving ? t("common.busy") : t("tools.qrDownload")}
          </button>
        </div>
      }
    >
      <section className="m-form-card">
        <div className="m-form-card-title">{label}</div>
        <div className="m-qr-history-full">{entry.text}</div>
      </section>
      <section className="m-form-card">
        {svg ? (
          <div className="m-tool-qr" dangerouslySetInnerHTML={{ __html: svg }} />
        ) : (
          <div className="muted sm">{t("tools.qrEncodeFailed")}</div>
        )}
      </section>
      <section className="m-form-card m-qr-history-danger">
        {armed ? (
          <>
            <p className="m-qr-history-hint">{t("tools.qrHistoryDeleteHint")}</p>
            <div className="m-qr-history-confirm">
              <button type="button" className="btn" disabled={busy} onClick={() => setArmed(false)}>
                {t("common.cancel")}
              </button>
              <button type="button" className="btn danger" disabled={busy} onClick={onDelete}>
                {busy ? t("common.deleting") : t("common.confirmDelete")}
              </button>
            </div>
          </>
        ) : (
          <button type="button" className="m-danger-btn" disabled={busy} onClick={() => setArmed(true)}>
            {t("tools.qrHistoryDeleteOne")}
          </button>
        )}
      </section>
    </HistoryStage>
  );
}

export function MobileQrHistory({
  initialKind,
  lists,
  loading,
  loadError,
  onClose,
  onLists,
}: {
  initialKind: HistoryKind;
  lists: QrHistoryLists;
  loading: boolean;
  loadError: boolean;
  onClose: () => void;
  onLists: (next: QrHistoryLists) => void;
}) {
  const { t, i18n } = useTranslation();
  const [kind, setKind] = useState<HistoryKind>(initialKind);
  const [openId, setOpenId] = useState<string | null>(null);
  const [clearArmed, setClearArmed] = useState(false);
  const [busy, setBusy] = useState<"delete" | "clear" | null>(null);
  const entries = kind === "scan" ? lists.scans : lists.generations;
  const selected = entries.find((entry) => entry.id === openId) ?? null;

  const closeDetail = useCallback(() => setOpenId(null), []);

  useEffect(() => {
    if (openId && !entries.some((entry) => entry.id === openId)) setOpenId(null);
  }, [entries, openId]);

  function selectKind(next: HistoryKind) {
    if (next === kind) return;
    setKind(next);
    setOpenId(null);
    setClearArmed(false);
  }

  async function removeSelected() {
    if (!selected || busy) return;
    setBusy("delete");
    try {
      const next =
        kind === "scan" ? await removeQrScanHistory(selected.id) : await removeQrGenHistory(selected.id);
      onLists(next);
      setOpenId(null);
    } catch {
      showAppToast(t("common.errorTitle"));
    } finally {
      setBusy(null);
    }
  }

  async function clearKind() {
    if (busy) return;
    setBusy("clear");
    try {
      const next = kind === "scan" ? await clearQrScanHistory() : await clearQrGenHistory();
      onLists(next);
      setOpenId(null);
      setClearArmed(false);
    } catch {
      showAppToast(t("common.errorTitle"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <HistoryStage title={t("tools.qrHistoryTitle")} onClose={onClose}>
        <div className="m-qr-history-tabs" role="tablist" aria-label={t("tools.qrHistoryTitle")}>
          <button
            type="button"
            role="tab"
            aria-selected={kind === "scan"}
            className={"m-qr-history-tab" + (kind === "scan" ? " on" : "")}
            onClick={() => selectKind("scan")}
          >
            {t("tools.qrScanHistory")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={kind === "generate"}
            className={"m-qr-history-tab" + (kind === "generate" ? " on" : "")}
            onClick={() => selectKind("generate")}
          >
            {t("tools.qrGenHistory")}
          </button>
        </div>

        {loading && entries.length === 0 ? (
          <div className="m-qr-history-empty">{t("common.loading")}</div>
        ) : loadError && entries.length === 0 ? (
          <div className="m-qr-history-empty">{t("tools.qrHistoryLoadFailed")}</div>
        ) : entries.length === 0 ? (
          <div className="m-qr-history-empty">
            {kind === "scan" ? t("tools.qrHistoryEmptyScan") : t("tools.qrHistoryEmptyGen")}
          </div>
        ) : (
          <ul className="m-qr-history-list">
            {entries.map((entry) => (
              <li key={entry.id}>
                <button type="button" className="m-qr-history-item" onClick={() => setOpenId(entry.id)}>
                  <span className="m-qr-history-main">
                    <span className="m-qr-history-text">{entry.text}</span>
                    <span className="m-qr-history-time">{formatToolTime(entry.at, i18n.language)}</span>
                  </span>
                  <ChevronRight className="m-qr-history-chevron" size={18} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}

        {entries.length > 0 && (
          <section className="m-form-card m-qr-history-danger">
            {clearArmed ? (
              <>
                <p className="m-qr-history-hint">{t("tools.qrHistoryClearHint")}</p>
                <div className="m-qr-history-confirm">
                  <button type="button" className="btn" disabled={busy === "clear"} onClick={() => setClearArmed(false)}>
                    {t("common.cancel")}
                  </button>
                  <button type="button" className="btn danger" disabled={busy === "clear"} onClick={() => void clearKind()}>
                    {busy === "clear" ? t("common.busy") : t("tools.qrHistoryClearConfirm")}
                  </button>
                </div>
              </>
            ) : (
              <button type="button" className="m-danger-btn" onClick={() => setClearArmed(true)}>
                {t("tools.qrHistoryClearAll")}
              </button>
            )}
          </section>
        )}
      </HistoryStage>

      {selected && (
        <HistoryDetail
          kind={kind}
          entry={selected}
          busy={busy === "delete"}
          onClose={closeDetail}
          onDelete={() => void removeSelected()}
        />
      )}
    </>
  );
}
