import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, entryAttachments, errMessage, type FileEntry } from "../lib/ipc";
import { isNeedReauth, tryBiometricReauth } from "../lib/secretsUi";
import { useOverlayBack } from "../shared/mobileBack";
import { encodeQrSvg } from "../shared/qrEncode";
import {
  QRBEAM_DEFAULT_BLOCK_SIZE,
  QRBEAM_DEFAULT_FPS,
  estimateDurationSec,
} from "../shared/qrbeam/protocol";
import { decodeRasterFallback, exportQrBeamGif, receiveQrBeamGif, shareOrDownloadGif } from "../shared/qrbeam/gif";
import { createQrBeamReceiver, type QrBeamFile } from "../shared/qrbeam/receiver";
import { createQrBeamSender, type QrBeamSender } from "../shared/qrbeam/sender";
import { formatBytes } from "../shared/hooks/useFilesModel";
import { useApp } from "../store";
import { ReauthDialog } from "../ui/ReauthDialog";
import { QrScannerDialog } from "../ui/QrScannerDialog";
import { showAppToast } from "../ui/Toast";

type BeamTab = "send" | "receive";
type BeamSource = { data: Uint8Array; filename: string; contentType: string };
type VaultPick = {
  entryId: string;
  attachmentId?: string;
  name: string;
  filename: string;
  size: number;
  mime?: string | null;
};

const FPS_MIN = 3;
const FPS_MAX = 15;
const BLOCK_MIN = 256;
const BLOCK_MAX = 768;
const BLOCK_STEP = 64;

function flattenVault(entries: FileEntry[]): VaultPick[] {
  const out: VaultPick[] = [];
  for (const entry of entries) {
    const atts = entryAttachments(entry);
    if (atts.length === 0) {
      out.push({
        entryId: entry.id,
        name: entry.name || entry.originalName,
        filename: entry.originalName || entry.name || "file",
        size: entry.size,
        mime: entry.mime,
      });
      continue;
    }
    for (const att of atts) {
      out.push({
        entryId: entry.id,
        attachmentId: atts.length > 1 ? att.id : undefined,
        name: atts.length > 1 ? `${entry.name} / ${att.originalName}` : entry.name || att.originalName,
        filename: att.originalName || entry.originalName || entry.name || "file",
        size: att.size || entry.size,
        mime: att.mime ?? entry.mime,
      });
    }
  }
  return out;
}

function toNumberArray(data: Uint8Array): number[] {
  return Array.from(data);
}

export function FileBeamTool() {
  const { t } = useTranslation();
  const bumpData = useApp((s) => s.bumpData);
  const writesLocked = useApp((s) => s.writesLocked);
  const [tab, setTab] = useState<BeamTab>("send");
  const [err, setErr] = useState("");

  const [source, setSource] = useState<BeamSource | null>(null);
  const [fps, setFps] = useState(QRBEAM_DEFAULT_FPS);
  const [blockSize, setBlockSize] = useState(QRBEAM_DEFAULT_BLOCK_SIZE);
  const [playing, setPlaying] = useState(false);
  const [frame, setFrame] = useState("");
  const [sendMeta, setSendMeta] = useState<{ overSoftLimit: boolean; neededFrames: number; k: number } | null>(null);
  const senderRef = useRef<QrBeamSender | null>(null);

  const [pickingVault, setPickingVault] = useState(false);
  const [vaultItems, setVaultItems] = useState<VaultPick[]>([]);
  const [vaultLoading, setVaultLoading] = useState(false);
  const diskRef = useRef<HTMLInputElement>(null);

  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState({ decoded: 0, k: 0, ratio: 0 });
  const [received, setReceived] = useState<QrBeamFile | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [gifBusy, setGifBusy] = useState(false);
  const [gifImporting, setGifImporting] = useState(false);
  const [gifRecognized, setGifRecognized] = useState(0);
  const gifLock = useRef(false);
  const gifInputRef = useRef<HTMLInputElement>(null);
  const receiverRef = useRef(createQrBeamReceiver());

  const [reauth, setReauth] = useState<null | ((pw: string) => Promise<void>)>(null);
  const reauthCancel = useRef<(() => void) | null>(null);

  const withAuth = useCallback(async function withAuth<T>(fn: (pw?: string) => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (e) {
      if (!isNeedReauth(e)) throw e;
      if (await tryBiometricReauth()) {
        try {
          return await fn();
        } catch (err) {
          if (!isNeedReauth(err)) throw err;
        }
      }
      return await new Promise<T | undefined>((resolve) => {
        reauthCancel.current = () => {
          reauthCancel.current = null;
          setReauth(null);
          resolve(undefined);
        };
        setReauth(() => async (pw: string) => {
          try {
            const r = await fn(pw);
            reauthCancel.current = null;
            setReauth(null);
            resolve(r);
          } catch (err) {
            throw new Error(errMessage(err));
          }
        });
      });
    }
  }, []);

  useOverlayBack(pickingVault, () => setPickingVault(false));
  useOverlayBack(scanning, () => setScanning(false));
  useOverlayBack(!!reauth, () => reauthCancel.current?.());

  useEffect(() => {
    if (!source) {
      senderRef.current = null;
      setSendMeta(null);
      setFrame("");
      setPlaying(false);
      return;
    }
    try {
      const next = createQrBeamSender(source.data, {
        filename: source.filename,
        contentType: source.contentType,
        blockSize,
      });
      senderRef.current = next;
      setSendMeta({ overSoftLimit: next.overSoftLimit, neededFrames: next.neededFrames, k: next.k });
      setFrame(next.nextFrame());
      setPlaying(true);
      setErr("");
    } catch (e) {
      senderRef.current = null;
      setSendMeta(null);
      setFrame("");
      setPlaying(false);
      setErr(t("tools.fileBeamError") + (e instanceof Error ? `: ${e.message}` : ""));
    }
  }, [source, blockSize, t]);

  useEffect(() => {
    if (!playing || !senderRef.current) return;
    const ms = 1000 / Math.max(FPS_MIN, fps);
    const id = window.setInterval(() => {
      const sender = senderRef.current;
      if (!sender) return;
      try {
        setFrame(sender.nextFrame());
      } catch (e) {
        setPlaying(false);
        setErr(t("tools.fileBeamError") + (e instanceof Error ? `: ${e.message}` : ""));
      }
    }, ms);
    return () => window.clearInterval(id);
  }, [playing, fps, source, blockSize, t]);

  const svg = useMemo(() => {
    if (!frame) return "";
    try {
      return encodeQrSvg(frame);
    } catch {
      return "";
    }
  }, [frame]);

  const etaSec = sendMeta ? Math.ceil(estimateDurationSec(sendMeta.k, fps)) : 0;

  function applySource(data: Uint8Array, filename: string, contentType?: string | null) {
    setSource({
      data,
      filename: filename.trim() || "file",
      contentType: contentType || "application/octet-stream",
    });
    setPickingVault(false);
  }

  async function openVaultPicker() {
    setErr("");
    setPickingVault(true);
    setVaultLoading(true);
    try {
      const data = await api.fileList();
      setVaultItems(flattenVault(data.entries));
    } catch (e) {
      setPickingVault(false);
      setErr(t("tools.fileBeamError") + `: ${errMessage(e)}`);
    } finally {
      setVaultLoading(false);
    }
  }

  async function pickVaultItem(item: VaultPick) {
    setErr("");
    setBusy(true);
    try {
      const bytes = await withAuth((pw) => api.fileReadBytes(item.entryId, item.attachmentId, pw));
      if (!bytes) return;
      applySource(new Uint8Array(bytes), item.filename, item.mime);
    } catch (e) {
      setErr(t("tools.fileBeamError") + `: ${errMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function loadDiskFile(file: File) {
    setErr("");
    setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      applySource(new Uint8Array(buf), file.name, file.type);
    } catch (e) {
      setErr(t("tools.fileBeamError") + `: ${errMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }

  function onFrame(text: string) {
    const result = receiverRef.current.feed(text);
    if (result.status === "ignored") return;
    if (result.status === "error") {
      setErr(t("tools.fileBeamError") + (result.message ? `: ${result.message}` : ""));
      return;
    }
    setProgress(result.progress);
    if (result.status === "complete") {
      setReceived(result.file);
      setSaved(false);
      setScanning(false);
      setErr("");
    }
  }

  function startScan() {
    setErr("");
    if (!received) {
      receiverRef.current.reset();
      setProgress({ decoded: 0, k: 0, ratio: 0 });
    }
    setScanning(true);
  }

  async function saveVault() {
    if (!received) return;
    setBusy(true);
    setErr("");
    try {
      await api.fileAddBytes(received.filename, toNumberArray(received.data), { name: received.filename });
      bumpData();
      setSaved(true);
    } catch (e) {
      setErr(t("tools.fileBeamError") + `: ${errMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function exportGif() {
    const current = senderRef.current;
    const file = source;
    if (!current || !file || gifLock.current) return;
    gifLock.current = true;
    const wasPlaying = playing;
    setPlaying(false);
    setGifBusy(true);
    setErr("");
    try {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      const bytes = await exportQrBeamGif(current, { fps, data: file.data, filename: file.filename });
      const outcome = await shareOrDownloadGif(file.filename, bytes);
      if (outcome !== "cancelled") showAppToast(t("tools.fileBeamGifReady"));
    } catch {
      setErr(t("tools.fileBeamGifFailed"));
    } finally {
      gifLock.current = false;
      setGifBusy(false);
      if (wasPlaying) setPlaying(true);
    }
  }

  async function importGifFile(file: File) {
    if (gifLock.current) return;
    gifLock.current = true;
    setScanning(false);
    setErr("");
    setSaved(false);
    setGifImporting(true);
    setGifRecognized(0);
    setReceived(null);
    setProgress({ decoded: 0, k: 0, ratio: 0 });
    receiverRef.current.reset();
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await receiveQrBeamGif(bytes, receiverRef.current, {
        decodeFallback: (raster) => decodeRasterFallback(raster, (png) => api.decodeQrFromImage(Array.from(png))),
        onProgress: (progress) => {
          setGifRecognized(progress.recognized);
          const feed = progress.feed;
          if (!feed || feed.status === "ignored") return;
          if (feed.status === "error") {
            setErr(t("tools.fileBeamError") + (feed.message ? `: ${feed.message}` : ""));
            return;
          }
          setProgress(feed.progress);
          if (feed.status === "complete") {
            setReceived(feed.file);
            setSaved(false);
            setErr("");
          }
        },
      });
      if (result.file) setErr("");
      else setErr(t("tools.fileBeamGifNoFrames"));
    } catch {
      setErr(t("tools.fileBeamGifNoFrames"));
    } finally {
      gifLock.current = false;
      setGifImporting(false);
    }
  }

  function switchTab(next: BeamTab) {
    if (next === tab) return;
    setTab(next);
    setErr("");
    setPlaying(false);
    setScanning(false);
    setPickingVault(false);
  }

  return (
    <div className="m-tool-stack m-tool-beam">
      <input
        ref={diskRef}
        type="file"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void loadDiskFile(file);
        }}
      />

      <div className="m-tool-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "send"}
          className={"m-tool-tab" + (tab === "send" ? " on" : "")}
          onClick={() => switchTab("send")}
        >
          {t("tools.fileBeamSend")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "receive"}
          className={"m-tool-tab" + (tab === "receive" ? " on" : "")}
          onClick={() => switchTab("receive")}
        >
          {t("tools.fileBeamReceive")}
        </button>
      </div>

      {err && <div className="callout danger sm">{err}</div>}

      {tab === "send" ? (
        pickingVault ? (
          <div className="m-tool-stack">
            <button type="button" className="btn ghost sm" onClick={() => setPickingVault(false)}>
              {t("common.back")}
            </button>
            {vaultLoading ? (
              <div className="muted sm">{t("common.loading")}</div>
            ) : vaultItems.length === 0 ? (
              <div className="muted sm">{t("tools.fileBeamNoFile")}</div>
            ) : (
              <div className="m-tool-vault-list">
                {vaultItems.map((item) => (
                  <button
                    key={`${item.entryId}:${item.attachmentId ?? ""}`}
                    type="button"
                    className="m-tool-vault-item"
                    disabled={busy}
                    onClick={() => void pickVaultItem(item)}
                  >
                    <span className="m-tool-vault-name">{item.name}</span>
                    <span className="m-tool-vault-meta">{formatBytes(item.size)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="m-tool-btn-row">
              <button type="button" className="btn sm" disabled={busy} onClick={() => void openVaultPicker()}>
                {t("tools.fileBeamPickVault")}
              </button>
              <button type="button" className="btn sm" disabled={busy} onClick={() => diskRef.current?.click()}>
                {t("tools.fileBeamPickDisk")}
              </button>
            </div>

            {source ? (
              <>
                <div className="muted sm">
                  {source.filename} · {formatBytes(source.data.byteLength)}
                </div>
                {sendMeta?.overSoftLimit && <div className="callout warn sm">{t("tools.fileBeamSoftLimit")}</div>}
                {svg ? (
                  <div className="m-tool-beam-stage">
                    <div className="m-tool-qr m-tool-beam-qr" dangerouslySetInnerHTML={{ __html: svg }} />
                  </div>
                ) : (
                  <div className="muted sm">{t("tools.fileBeamNoFile")}</div>
                )}
                <div className="m-tool-beam-dock">
                  <div className="m-tool-btn-row">
                    <button type="button" className="btn primary" onClick={() => setPlaying((v) => !v)}>
                      {playing ? t("tools.fileBeamPause") : t("tools.fileBeamPlay")}
                    </button>
                    <button type="button" className="btn" disabled={!source || gifBusy} onClick={() => void exportGif()}>
                      {gifBusy ? t("tools.fileBeamExportingGif") : t("tools.fileBeamExportGif")}
                    </button>
                  </div>
                  <label className="m-tool-range">
                    <span>{t("tools.fileBeamFps")}</span>
                    <input
                      type="range"
                      min={FPS_MIN}
                      max={FPS_MAX}
                      value={fps}
                      onChange={(e) => setFps(Number(e.target.value))}
                    />
                    <strong>{fps}</strong>
                  </label>
                  <label className="m-tool-range">
                    <span>{t("tools.fileBeamBlockSize")}</span>
                    <input
                      type="range"
                      min={BLOCK_MIN}
                      max={BLOCK_MAX}
                      step={BLOCK_STEP}
                      value={blockSize}
                      onChange={(e) => setBlockSize(Number(e.target.value))}
                    />
                    <strong>{blockSize}</strong>
                  </label>
                  {sendMeta && (
                    <div className="muted sm">
                      {t("tools.fileBeamNeeded", { n: sendMeta.neededFrames, frames: sendMeta.neededFrames })}
                      {" · "}
                      {t("tools.fileBeamEta", { sec: etaSec, n: etaSec })}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="muted sm">{t("tools.fileBeamNoFile")}</div>
            )}
          </>
        )
      ) : (
        <>
          <input
            ref={gifInputRef}
            type="file"
            accept="image/gif,.gif"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void importGifFile(file);
            }}
          />
          <div className="m-tool-btn-row">
            {scanning ? (
              <button type="button" className="btn" onClick={() => setScanning(false)}>
                {t("tools.fileBeamStopScan")}
              </button>
            ) : (
              <button type="button" className="btn primary" disabled={gifImporting} onClick={startScan}>
                {t("tools.fileBeamStartScan")}
              </button>
            )}
            <button type="button" className="btn" disabled={gifImporting} onClick={() => gifInputRef.current?.click()}>
              {gifImporting ? t("tools.fileBeamImportingGif") : t("tools.fileBeamImportGif")}
            </button>
          </div>

          {received ? (
            <>
              <div className="callout good sm">{t("tools.fileBeamComplete")}</div>
              <div className="muted sm">
                {received.filename} · {formatBytes(received.data.byteLength)}
              </div>
              <button
                type="button"
                className="btn primary"
                disabled={busy || writesLocked || saved}
                onClick={() => void saveVault()}
              >
                {busy ? t("common.busy") : t("tools.fileBeamSaveVault")}
              </button>
              {saved && <div className="callout good sm">{t("tools.fileBeamSaved")}</div>}
            </>
          ) : progress.k > 0 || gifImporting || gifRecognized > 0 ? (
            <>
              <div className="m-tool-progress" aria-hidden="true">
                <i style={{ width: `${Math.round(progress.ratio * 100)}%` }} />
              </div>
              <div className="muted sm">
                {gifImporting ? `${t("tools.fileBeamImportingGif")} · ` : ""}
                {progress.k > 0
                  ? t("tools.fileBeamProgress", { decoded: progress.decoded, k: progress.k, n: progress.decoded })
                  : t("tools.fileBeamWaiting")}
                {gifRecognized > 0 ? ` · ${t("tools.fileBeamGifRecognized", { n: gifRecognized })}` : ""}
              </div>
            </>
          ) : (
            <div className="muted sm">{t("tools.fileBeamWaiting")}</div>
          )}
        </>
      )}

      <div className="callout warn sm m-tool-security">
        <strong>{t("tools.fileBeamSecurity")}</strong>
        <p>{t("tools.fileBeamSecurityBody")}</p>
      </div>

      <QrScannerDialog
        open={scanning}
        hint={t("tools.fileBeamWaiting")}
        continuous
        onFrame={onFrame}
        onScan={() => {}}
        onClose={() => setScanning(false)}
      />

      {reauth && (
        <ReauthDialog onCancel={() => reauthCancel.current?.()} onConfirm={(pw) => reauth(pw)} />
      )}
    </div>
  );
}
