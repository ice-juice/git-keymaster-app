import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { api, entryAttachments, errMessage, type FileAttachment, type FileEntry } from "../../lib/ipc";
import { isNeedReauth, tryBiometricReauth } from "../../lib/secretsUi";
import { useOverlayBack } from "../../shared/mobileBack";
import { QRBEAM_DEFAULT_BLOCK_SIZE, QRBEAM_DEFAULT_FPS, estimateDurationSec } from "../../shared/qrbeam/protocol";
import { decodeRasterFallback, exportQrBeamGif, gifDownloadName, receiveQrBeamGif } from "../../shared/qrbeam/gif";
import { createQrBeamReceiver, type QrBeamFile } from "../../shared/qrbeam/receiver";
import { createQrBeamSender, type QrBeamSender } from "../../shared/qrbeam/sender";
import { encodeQrSvg } from "../../shared/qrEncode";
import { formatBytes } from "../../shared/hooks/useFilesModel";
import { Card } from "../../ui/common";
import { QrScannerDialog } from "../../ui/QrScannerDialog";
import { ReauthDialog } from "../../ui/ReauthDialog";
import { showAppToast } from "../../ui/Toast";
import { ToolSubPage } from "./ToolsShared";

type BeamTab = "send" | "receive";

type PickedFile = {
  name: string;
  bytes: Uint8Array;
  contentType: string;
};

const MIN_FPS = 3;
const MAX_FPS = 15;
const MIN_BLOCK = 256;
const MAX_BLOCK = 768;
const BLOCK_STEP = 64;

function fileNameFromPath(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return (i >= 0 ? trimmed.slice(i + 1) : trimmed) || "file";
}

function guessContentType(name: string, fallback?: string | null): string {
  const given = fallback?.trim();
  if (given) return given;
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "txt":
      return "text/plain";
    case "md":
      return "text/markdown";
    case "json":
      return "application/json";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "pdf":
      return "application/pdf";
    case "pem":
    case "crt":
    case "cer":
      return "application/x-pem-file";
    default:
      return "application/octet-stream";
  }
}

function toUint8(bytes: number[]): Uint8Array {
  return Uint8Array.from(bytes);
}

/** 保存对话框只接受文件名。光传载荷里的路径片段不能当成落盘位置。 */
function dialogFileName(name: string, fallback = "file"): string {
  const base = fileNameFromPath(name).replace(/[\\/:*?"<>|]/g, "_").replace(/^\.+/, "").trim();
  return base || fallback;
}

/** 只写入保存对话框返回的路径。用户取消时返回 null，不报错。 */
async function chooseAndWriteBytes(
  defaultPath: string,
  bytes: Uint8Array,
  filters?: { name: string; extensions: string[] }[],
): Promise<string | null> {
  const dest = await save(filters ? { defaultPath, filters } : { defaultPath });
  if (typeof dest !== "string" || !dest.trim()) return null;
  await api.writePathBytes(dest, Array.from(bytes));
  return dest;
}

export function ToolsFileBeamPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<BeamTab>("send");
  const [picked, setPicked] = useState<PickedFile | null>(null);
  const [fps, setFps] = useState(QRBEAM_DEFAULT_FPS);
  const [blockSize, setBlockSize] = useState(QRBEAM_DEFAULT_BLOCK_SIZE);
  const [advanced, setAdvanced] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [frameSvg, setFrameSvg] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [vaultOpen, setVaultOpen] = useState(false);
  const [vaultEntries, setVaultEntries] = useState<FileEntry[]>([]);
  const [vaultPick, setVaultPick] = useState<FileEntry | null>(null);
  const [reauth, setReauth] = useState<null | ((pw: string) => Promise<void>)>(null);
  const reauthCancel = useRef<(() => void) | null>(null);

  const receiverRef = useRef(createQrBeamReceiver());
  const [scanning, setScanning] = useState(false);
  const [recvProgress, setRecvProgress] = useState({ decoded: 0, k: 0, ratio: 0 });
  const [received, setReceived] = useState<QrBeamFile | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [folderErr, setFolderErr] = useState("");
  const [gifBusy, setGifBusy] = useState(false);
  const [gifImporting, setGifImporting] = useState(false);
  const [gifRecognized, setGifRecognized] = useState(0);
  const gifLock = useRef(false);
  const gifInputRef = useRef<HTMLInputElement>(null);

  const sendReady = useMemo(() => {
    if (!picked) return { sender: null as QrBeamSender | null, error: "" };
    try {
      return {
        sender: createQrBeamSender(picked.bytes, {
          filename: picked.name,
          contentType: picked.contentType,
          blockSize,
        }),
        error: "",
      };
    } catch (e) {
      return { sender: null, error: errMessage(e) };
    }
  }, [picked, blockSize]);

  useEffect(() => {
    setFrameSvg("");
    setPlaying(!!sendReady.sender);
    if (sendReady.error) setErr(sendReady.error);
  }, [sendReady.sender, sendReady.error]);

  useEffect(() => {
    const sender = sendReady.sender;
    if (!playing || !sender) return;
    const tick = () => {
      try {
        setFrameSvg(encodeQrSvg(sender.nextFrame()));
      } catch {
        setPlaying(false);
        setErr(t("tools.fileBeamError"));
      }
    };
    tick();
    const id = window.setInterval(tick, Math.max(40, Math.round(1000 / fps)));
    return () => window.clearInterval(id);
  }, [playing, sendReady.sender, fps, t]);

  useOverlayBack(vaultOpen, () => {
    setVaultOpen(false);
    setVaultPick(null);
  });
  useOverlayBack(savedPath != null, () => setSavedPath(null));
  useOverlayBack(!!reauth, () => reauthCancel.current?.());

  const withAuth = useCallback(async function withAuth<T>(fn: (pw?: string) => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (e) {
      if (!isNeedReauth(e)) {
        setErr(errMessage(e));
        return;
      }
      if (await tryBiometricReauth()) {
        try {
          return await fn();
        } catch (err) {
          if (!isNeedReauth(err)) {
            setErr(errMessage(err));
            return;
          }
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

  function applyPicked(file: PickedFile) {
    setErr("");
    setPicked(file);
    setVaultOpen(false);
    setVaultPick(null);
  }

  async function loadVaultBytes(entry: FileEntry, attachment?: FileAttachment) {
    const atts = entryAttachments(entry);
    const att = attachment ?? (atts.length === 1 ? atts[0] : undefined);
    if (!att) {
      setVaultPick(entry);
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const bytes = await withAuth((pw) => api.fileReadBytes(entry.id, att.id, pw));
      if (!bytes) return;
      applyPicked({
        name: att.originalName || entry.name || "file",
        bytes: toUint8(bytes),
        contentType: guessContentType(att.originalName || entry.name, att.mime),
      });
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function openVaultPicker() {
    setErr("");
    setBusy(true);
    try {
      const list = await api.fileList();
      setVaultEntries(list.entries);
      setVaultPick(null);
      setVaultOpen(true);
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function pickFromDisk() {
    setErr("");
    try {
      const selected = await open({ multiple: false, directory: false });
      if (!selected) return;
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (!path) return;
      setBusy(true);
      const bytes = await api.readPathBytes(path);
      const name = fileNameFromPath(path);
      applyPicked({
        name,
        bytes: toUint8(bytes),
        contentType: guessContentType(name),
      });
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function switchTab(next: BeamTab) {
    setTab(next);
    setErr("");
    if (next === "send") setScanning(false);
    if (next === "receive") setPlaying(false);
  }

  function startScan() {
    setErr("");
    if (received) {
      receiverRef.current.reset();
      setReceived(null);
      setRecvProgress({ decoded: 0, k: 0, ratio: 0 });
    }
    setScanning(true);
  }

  function stopScan() {
    setScanning(false);
  }

  function onBeamFrame(text: string) {
    const result = receiverRef.current.feed(text);
    if (result.status === "ignored") return;
    if (result.status === "error") {
      setErr(`${t("tools.fileBeamError")}: ${result.message}`);
      return;
    }
    setRecvProgress(result.progress);
    if (result.status === "complete") {
      setReceived(result.file);
      setScanning(false);
    }
  }

  async function saveToVault() {
    if (!received) return;
    setSaving(true);
    setErr("");
    try {
      await api.fileAddBytes(received.filename || "file", Array.from(received.data));
      showAppToast(t("tools.fileBeamSaved"));
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function exportToDisk() {
    if (!received) return;
    setSaving(true);
    setErr("");
    try {
      const dest = await chooseAndWriteBytes(
        dialogFileName(received.filename || "file"),
        received.data,
      );
      if (dest) {
        setFolderErr("");
        setSavedPath(dest);
      }
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function exportGif() {
    const current = sendReady.sender;
    const file = picked;
    if (!current || !file || gifLock.current) return;
    gifLock.current = true;
    const wasPlaying = playing;
    setPlaying(false);
    setGifBusy(true);
    setErr("");
    try {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      const bytes = await exportQrBeamGif(current, { fps, data: file.bytes, filename: file.name });
      let dest: string | null = null;
      try {
        dest = await chooseAndWriteBytes(gifDownloadName(file.name), bytes, [
          { name: "GIF", extensions: ["gif"] },
        ]);
      } catch (e) {
        setErr(errMessage(e));
        return;
      }
      if (dest) {
        setFolderErr("");
        setSavedPath(dest);
      }
    } catch {
      setErr(t("tools.fileBeamGifFailed"));
    } finally {
      gifLock.current = false;
      setGifBusy(false);
      if (wasPlaying) setPlaying(true);
    }
  }

  async function openSavedFolder() {
    if (!savedPath) return;
    setFolderErr("");
    try {
      await api.revealPath(savedPath);
    } catch (e) {
      setFolderErr(errMessage(e));
    }
  }

  async function importGifFile(file: File) {
    if (gifLock.current) return;
    gifLock.current = true;
    setScanning(false);
    setErr("");
    setGifImporting(true);
    setGifRecognized(0);
    setReceived(null);
    setRecvProgress({ decoded: 0, k: 0, ratio: 0 });
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
            setErr(`${t("tools.fileBeamError")}: ${feed.message}`);
            return;
          }
          setRecvProgress(feed.progress);
          if (feed.status === "complete") setReceived(feed.file);
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

  const sender = sendReady.sender;
  const etaSec = sender ? Math.max(1, Math.ceil(estimateDurationSec(sender.k, fps))) : 0;
  const recvPct = Math.round(recvProgress.ratio * 100);

  return (
    <ToolSubPage title={t("tools.fileBeamTitle")} desc={t("tools.fileBeamDesc")}>
      <Card title={t("tools.fileBeamTitle")}>
        <div className="tools-beam-fit">
          <div className="view-switcher" role="tablist" aria-label={t("tools.fileBeamTitle")}>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "send"}
              className={"view-btn" + (tab === "send" ? " on" : "")}
              onClick={() => switchTab("send")}
            >
              {t("tools.fileBeamSend")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "receive"}
              className={"view-btn" + (tab === "receive" ? " on" : "")}
              onClick={() => switchTab("receive")}
            >
              {t("tools.fileBeamReceive")}
            </button>
          </div>

          {err && <div className="callout danger sm">{err}</div>}

          {tab === "send" ? (
            <div className="tools-beam-send">
              <div className="row">
                <button type="button" className="btn" disabled={busy} onClick={() => void openVaultPicker()}>
                  {t("tools.fileBeamPickVault")}
                </button>
                <button type="button" className="btn" disabled={busy} onClick={() => void pickFromDisk()}>
                  {t("tools.fileBeamPickDisk")}
                </button>
              </div>
              {busy && <div className="muted sm">{t("tools.fileBeamLoading")}</div>}
              {picked ? (
                <div className="tools-beam-fileline">
                  <div className="tools-beam-file">
                    {t("tools.fileBeamPicked", { name: picked.name, size: formatBytes(picked.bytes.byteLength) })}
                  </div>
                  {sender && (
                    <div className="tools-beam-meta">
                      <span>{t("tools.fileBeamNeeded", { n: sender.neededFrames })}</span>
                      <span>{t("tools.fileBeamEta", { sec: etaSec })}</span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="muted sm">{t("tools.fileBeamNoFile")}</div>
              )}

              {sender && (
                <>
                  {sender.overSoftLimit && <div className="callout warn sm">{t("tools.fileBeamSoftLimit")}</div>}
                  <div className="tools-beam-stage">
                    {frameSvg ? (
                      <div className="tools-beam-qr" dangerouslySetInnerHTML={{ __html: frameSvg }} />
                    ) : (
                      <div className="tools-beam-qr tools-beam-qr-empty">{t("tools.fileBeamPlay")}</div>
                    )}
                  </div>
                  <div className="tools-beam-dock">
                    <div className="tools-beam-dock-main">
                      <div className="row tools-beam-actions">
                        <button
                          type="button"
                          className="btn primary"
                          disabled={!sender}
                          onClick={() => setPlaying((v) => !v)}
                        >
                          {playing ? t("tools.fileBeamPause") : t("tools.fileBeamPlay")}
                        </button>
                        <button type="button" className="btn ghost sm" onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced}>
                          {t("tools.fileBeamAdvanced")}
                        </button>
                      </div>
                      <button type="button" className="btn sm" disabled={!sender || gifBusy} onClick={() => void exportGif()}>
                        {gifBusy ? t("tools.fileBeamExportingGif") : t("tools.fileBeamExportGif")}
                      </button>
                      <label className="tools-beam-param">
                        <span>{t("tools.fileBeamFps")}</span>
                        <input
                          type="range"
                          min={MIN_FPS}
                          max={MAX_FPS}
                          value={fps}
                          onChange={(e) => setFps(Number(e.target.value))}
                        />
                        <strong>{t("tools.fileBeamFpsUnit", { n: fps })}</strong>
                      </label>
                    </div>
                    {advanced && (
                      <label className="tools-beam-param">
                        <span>{t("tools.fileBeamBlockSize")}</span>
                        <input
                          type="range"
                          min={MIN_BLOCK}
                          max={MAX_BLOCK}
                          step={BLOCK_STEP}
                          value={blockSize}
                          onChange={(e) => setBlockSize(Number(e.target.value))}
                        />
                        <strong>{t("tools.fileBeamBlockUnit", { n: blockSize })}</strong>
                      </label>
                    )}
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="tools-beam-recv">
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
              <div className="row">
                {scanning ? (
                  <button type="button" className="btn" onClick={stopScan}>
                    {t("tools.fileBeamStopScan")}
                  </button>
                ) : (
                  <button type="button" className="btn primary" disabled={gifImporting} onClick={startScan}>
                    {received ? t("tools.fileBeamReset") : t("tools.fileBeamStartScan")}
                  </button>
                )}
                <button type="button" className="btn" disabled={gifImporting} onClick={() => gifInputRef.current?.click()}>
                  {gifImporting ? t("tools.fileBeamImportingGif") : t("tools.fileBeamImportGif")}
                </button>
              </div>
              <div className="tools-beam-progress">
                <div className="tools-beam-progress-meta">
                  <span>
                    {gifImporting
                      ? t("tools.fileBeamImportingGif")
                      : received
                        ? t("tools.fileBeamComplete")
                        : recvProgress.k > 0
                          ? t("tools.fileBeamProgress", { decoded: recvProgress.decoded, k: recvProgress.k })
                          : t("tools.fileBeamWaiting")}
                  </span>
                  <span>{recvPct}%</span>
                </div>
                <div className="tools-beam-progress-bar" role="progressbar" aria-valuenow={recvPct} aria-valuemin={0} aria-valuemax={100}>
                  <span style={{ width: `${recvPct}%` }} />
                </div>
                {(gifImporting || gifRecognized > 0) && (
                  <div className="muted sm">{t("tools.fileBeamGifRecognized", { n: gifRecognized })}</div>
                )}
              </div>
              {received && (
                <div className="stack">
                  <div className="tools-beam-file">
                    {t("tools.fileBeamReceivedName", {
                      name: received.filename,
                      size: formatBytes(received.data.byteLength),
                    })}
                  </div>
                  <div className="row">
                    <button type="button" className="btn primary" disabled={saving} onClick={() => void saveToVault()}>
                      {t("tools.fileBeamSaveVault")}
                    </button>
                    <button type="button" className="btn" disabled={saving} onClick={() => void exportToDisk()}>
                      {t("tools.fileBeamExportDisk")}
                    </button>
                  </div>
                </div>
              )}
              <QrScannerDialog
                open={scanning}
                title={t("tools.fileBeamReceive")}
                hint={t("tools.fileBeamScanHint")}
                continuous
                onFrame={onBeamFrame}
                onScan={() => {}}
                onClose={stopScan}
              />
            </div>
          )}

          <div className="callout sm tools-beam-security">
            <strong>{t("tools.fileBeamSecurity")}</strong>
            <p>{t("tools.fileBeamSecurityBody")}</p>
          </div>
        </div>
      </Card>

      {vaultOpen && (
        <div className="wizard-overlay">
          <div className="card tools-beam-vault">
            <div className="card-head">
              <div className="card-title">
                {vaultPick ? t("tools.fileBeamChooseAttachment") : t("tools.fileBeamVaultTitle")}
              </div>
            </div>
            <div className="card-body stack">
              {vaultPick ? (
                entryAttachments(vaultPick).map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className="tools-pick"
                    disabled={busy}
                    onClick={() => void loadVaultBytes(vaultPick, a)}
                  >
                    <span className="tools-pick-title">{a.originalName}</span>
                    <span className="tools-pick-desc">{formatBytes(a.size)}</span>
                  </button>
                ))
              ) : vaultEntries.length === 0 ? (
                <div className="muted sm">{t("tools.fileBeamVaultEmpty")}</div>
              ) : (
                <div className="tools-beam-vault-list">
                  {vaultEntries.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      className="tools-pick"
                      disabled={busy}
                      onClick={() => void loadVaultBytes(entry)}
                    >
                      <span className="tools-pick-title">{entry.name}</span>
                      <span className="tools-pick-desc">
                        {entry.originalName && entry.originalName !== entry.name
                          ? `${entry.originalName} · ${formatBytes(entry.size)}`
                          : formatBytes(entry.size)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="card-foot" style={{ justifyContent: "flex-end" }}>
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => {
                  setVaultOpen(false);
                  setVaultPick(null);
                }}
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {savedPath && (
        <div className="wizard-overlay">
          <div className="card tools-beam-saved" role="dialog" aria-labelledby="tools-beam-saved-title">
            <div className="card-head">
              <div className="card-title" id="tools-beam-saved-title">
                {t("tools.fileBeamSavedTitle")}
              </div>
            </div>
            <div className="card-body stack">
              <p className="tools-beam-saved-path">{t("tools.fileBeamSavedBody", { path: savedPath })}</p>
              {folderErr && <div className="callout danger sm">{folderErr}</div>}
            </div>
            <div className="card-foot" style={{ justifyContent: "flex-end" }}>
              <button type="button" className="btn primary sm" onClick={() => void openSavedFolder()}>
                {t("tools.fileBeamOpenFolder")}
              </button>
              <button type="button" className="btn ghost sm" onClick={() => setSavedPath(null)}>
                {t("common.close")}
              </button>
            </div>
          </div>
        </div>
      )}

      {reauth && (
        <ReauthDialog
          hint={t("tools.fileBeamReauthHint")}
          onCancel={() => reauthCancel.current?.()}
          onConfirm={(pw) => reauth(pw)}
        />
      )}
    </ToolSubPage>
  );
}
