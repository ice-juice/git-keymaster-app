import { useEffect, useRef, useState, type FC } from "react";
import { createRoot } from "react-dom/client";
import { X, Zap, ZapOff, Image as ImageIcon, CameraOff, RefreshCw, SwitchCamera } from "lucide-react";
import jsQR from "jsqr";
import { pickQrFromGallery } from "../lib/qrCapture";
import { api } from "../lib/ipc";
import { i18n, displayNameForLocale } from "../lib/i18n";
import { isIOS, isMobilePlatform } from "../lib/platform";

function attachInlineVideo(video: HTMLVideoElement, stream: MediaStream) {
  video.setAttribute("playsinline", "true");
  video.setAttribute("webkit-playsinline", "true");
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  video.srcObject = stream;
}

async function openUserMedia(opts: {
  deviceId?: string | null;
  mobile: boolean;
  ios: boolean;
}): Promise<MediaStream> {
  const attempts: MediaStreamConstraints[] = [];
  if (opts.deviceId) {
    attempts.push({
      video: { deviceId: { exact: opts.deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } else if (opts.mobile) {
    // iOS Safari / WKWebView：exact facingMode 经常 OverconstrainedError，只用 ideal。
    attempts.push({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    if (opts.ios) {
      attempts.push({ video: { facingMode: "environment" }, audio: false });
      attempts.push({ video: true, audio: false });
    }
  } else {
    attempts.push({
      video: { facingMode: { ideal: "user" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  }

  let last: unknown;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

export interface QrScannerDialogProps {
  open: boolean;
  title?: string;
  hint?: string;
  onScan: (texts: string[]) => void;
  onClose: () => void;
}

export const QrScannerDialog: FC<QrScannerDialogProps> = ({
  open,
  title,
  hint,
  onScan,
  onClose,
}) => {
  const brand = displayNameForLocale(i18n.language);
  const dialogTitle = title ?? i18n.t("qrscan.title");
  const dialogHint = hint ?? i18n.t("qrscan.hint");
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [cameraError, setCameraError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [loadingCamera, setLoadingCamera] = useState(true);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const mobile = isMobilePlatform();
  const ios = isIOS();
  const detectorRef = useRef<{ detect: (source: CanvasImageSource) => Promise<Array<{ rawValue?: string }>> } | null>(null);

  // 停止所有摄像头轨道
  const stopStream = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // ignore
        }
      });
      streamRef.current = null;
    }
  };

  // 启动摄像头：先向系统申请 CAMERA 运行时权限，再打开镜头
  const startCamera = async (preferredId?: string | null) => {
    stopStream();
    setCameraError(null);
    setPermissionDenied(false);
    setTorchAvailable(false);
    setTorchOn(false);
    setLoadingCamera(true);

    try {
      const perm = await api.requestCameraPermission();
      if (!perm.granted) {
        setPermissionDenied(true);
        setLoadingCamera(false);
        setCameraError(
          perm.permanentlyDenied
            ? i18n.t(mobile ? "qrscan.permDeniedSettings" : "qrscan.permDeniedDesktop", { name: brand })
            : i18n.t("qrscan.permNeeded"),
        );
        return;
      }

      if (ios) {
        await new Promise((r) => window.setTimeout(r, 40));
      }

      const stream = await openUserMedia({
        deviceId: preferredId ?? deviceId,
        mobile,
        ios,
      });
      streamRef.current = stream;

      if (videoRef.current) {
        attachInlineVideo(videoRef.current, stream);
        await videoRef.current.play().catch(() => {});
      }

      // 检查手电筒 (Torch) 支持
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        const capabilities = (videoTrack as any).getCapabilities?.();
        if (capabilities && "torch" in capabilities) {
          setTorchAvailable(true);
        }
        const currentId = videoTrack.getSettings().deviceId;
        if (currentId) setDeviceId(currentId);
      }
      try {
        const all = await navigator.mediaDevices.enumerateDevices();
        setCameras(all.filter((d) => d.kind === "videoinput" && d.deviceId));
      } catch {
        setCameras([]);
      }

      setLoadingCamera(false);
    } catch (err: any) {
      setLoadingCamera(false);
      const name = err?.name || "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        setPermissionDenied(true);
        setCameraError(
          i18n.t(mobile ? "qrscan.permDeniedPhone" : "qrscan.permDeniedDesktop", { name: brand }),
        );
      } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        setCameraError(i18n.t("qrscan.noCamera"));
      } else {
        setCameraError(
          i18n.t("qrscan.openFailed", { error: err?.message || i18n.t("qrscan.unknownError") }),
        );
      }
    }
  };

  // 切换手电筒
  const toggleTorch = async () => {
    if (!streamRef.current) return;
    const track = streamRef.current.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      await (track as any).applyConstraints({
        advanced: [{ torch: next }],
      });
      setTorchOn(next);
    } catch {
      // 某些设备或浏览器在 applyConstraints 失败
    }
  };

  // 从相册选择
  const handlePickGallery = async () => {
    try {
      const texts = await pickQrFromGallery();
      if (texts && texts.length > 0) {
        handleSuccess(texts);
      } else if (texts) {
        alert(i18n.t("qrscan.noQrInImage"));
      }
    } catch (err: any) {
      alert(i18n.t("qrscan.galleryFailed", { error: err?.message || err }));
    }
  };

  // 成功识别
  const handleSuccess = (texts: string[]) => {
    try {
      navigator.vibrate?.(40);
    } catch {
      // ignore
    }
    stopStream();
    onScan(texts);
  };

  // 挂载/卸载时控制相机与连续帧扫描循环
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let timer: number | null = null;
    let detected = false;
    let frames = 0;

    if ("BarcodeDetector" in window && !detectorRef.current) {
      try {
        detectorRef.current = new (window as any).BarcodeDetector({ formats: ["qr_code"] });
      } catch {
        detectorRef.current = null;
      }
    }

    startCamera();

    const onVis = () => {
      if (cancelled) return;
      if (document.visibilityState === "hidden") {
        stopStream();
        return;
      }
      if (!streamRef.current) {
        void startCamera();
      } else if (videoRef.current) {
        void videoRef.current.play().catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pageshow", onVis);

    const scanFrame = async () => {
      if (cancelled || detected) return;

      const video = videoRef.current;
      const canvas = canvasRef.current;

      if (video && canvas && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        // 1. 优先复用 BarcodeDetector（iOS 17+ / Android Chromium 有则用）
        if (detectorRef.current) {
          try {
            const codes = await detectorRef.current.detect(video);
            if (codes && codes.length > 0) {
              const rawValues = codes.map((c) => c.rawValue).filter(Boolean) as string[];
              if (rawValues.length > 0) {
                detected = true;
                handleSuccess(rawValues);
                return;
              }
            }
          } catch {
            // fallback
          }
        }

        // 2. 备用 jsQR 解析
        try {
          const vw = video.videoWidth || 640;
          const vh = video.videoHeight || 480;
          const maxDim = ios ? 480 : 640;
          const scale = Math.min(1, maxDim / Math.max(vw, vh));
          const cw = Math.round(vw * scale);
          const ch = Math.round(vh * scale);

          canvas.width = cw;
          canvas.height = ch;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (ctx) {
            ctx.drawImage(video, 0, 0, cw, ch);
            const imgData = ctx.getImageData(0, 0, cw, ch);
            const code = jsQR(imgData.data, cw, ch, { inversionAttempts: "attemptBoth" });
            if (code && code.data && code.data.trim()) {
              detected = true;
              handleSuccess([code.data.trim()]);
              return;
            }

            // 3. 隔若干帧再走 rqrr，避免每帧打 IPC
            frames += 1;
            if (frames % 12 === 0) {
              const blob = await new Promise<Blob | null>((resolve) => {
                canvas.toBlob((b) => resolve(b), "image/jpeg", 0.85);
              });
              if (blob) {
                const bytes = new Uint8Array(await blob.arrayBuffer());
                const texts = await api.decodeQrFromImage(Array.from(bytes));
                if (texts && texts.length > 0) {
                  detected = true;
                  handleSuccess(texts);
                  return;
                }
              }
            }
          }
        } catch {
          // ignore frame error
        }
      }

      if (!cancelled && !detected) {
        timer = window.setTimeout(scanFrame, ios ? 160 : 120);
      }
    };

    timer = window.setTimeout(scanFrame, 300);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pageshow", onVis);
      stopStream();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="qr-scanner-overlay" role="dialog" aria-modal="true">
      {/* 离屏 Canvas */}
      <canvas ref={canvasRef} style={{ display: "none" }} />

      {/* 实时视频流 */}
      <video
        ref={videoRef}
        className="qr-scanner-video"
        playsInline
        autoPlay
        muted
        // iOS WKWebView 必须同时带 webkit-playsinline，否则会强制全屏中断扫码循环
        {...{ "webkit-playsinline": "true" }}
      />

      {/* 顶部操作条 */}
      <header className="qr-scanner-topbar">
        <button
          type="button"
          className="qr-scanner-btn-circle"
          onClick={() => {
            stopStream();
            onClose();
          }}
          aria-label={i18n.t("qrscan.close")}
        >
          <X size={20} />
        </button>
        <span className="qr-scanner-title">{dialogTitle}</span>
        <div style={{ width: 40 }} />
      </header>

      {/* 取景扫描蒙层与扫描框 */}
      {!cameraError && (
        <div className="qr-scanner-mask">
          <div className="qr-scanner-box">
            {/* 四个高亮角标 */}
            <div className="qr-scanner-corner tl" />
            <div className="qr-scanner-corner tr" />
            <div className="qr-scanner-corner bl" />
            <div className="qr-scanner-corner br" />

            {/* 激光扫描线 */}
            <div className="qr-scanner-laser" />
          </div>
        </div>
      )}

      {/* 相机权限或设备故障提示卡片 */}
      {cameraError && (
        <div className="qr-scanner-error-card">
          <div className="qr-scanner-error-icon">
            <CameraOff size={36} />
          </div>
          <div className="qr-scanner-error-title">{i18n.t("qrscan.cannotOpen")}</div>
          <div className="qr-scanner-error-desc">{cameraError}</div>
          <div className="qr-scanner-error-actions">
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => void startCamera()}
            >
              <RefreshCw size={14} /> {i18n.t("qrscan.retry")}
            </button>
            {permissionDenied && mobile && (
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => api.openAppPermissionSettings().catch(() => {})}
              >
                {i18n.t("qrscan.openSettings")}
              </button>
            )}
            <button
              type="button"
              className="btn primary sm"
              onClick={handlePickGallery}
            >
              <ImageIcon size={14} /> {i18n.t("qrscan.pickGallery")}
            </button>
          </div>
        </div>
      )}

      {/* 底部功能栏 */}
      <footer className="qr-scanner-foot">
        <div className="qr-scanner-hint">
          {loadingCamera ? i18n.t("qrscan.starting") : dialogHint}
        </div>

        <div className="qr-scanner-actions">
          {cameras.length > 1 && (
            <button
              type="button"
              className="qr-scanner-action-btn"
              onClick={() => {
                const idx = cameras.findIndex((c) => c.deviceId === deviceId);
                const next = cameras[(idx + 1 + cameras.length) % cameras.length];
                if (next) void startCamera(next.deviceId);
              }}
            >
              <SwitchCamera size={22} />
              <span>{i18n.t("qrscan.switchCamera")}</span>
            </button>
          )}
          {torchAvailable && (
            <button
              type="button"
              className={"qr-scanner-action-btn" + (torchOn ? " on" : "")}
              onClick={toggleTorch}
            >
              {torchOn ? <Zap size={22} /> : <ZapOff size={22} />}
              <span>{torchOn ? i18n.t("qrscan.torchOn") : i18n.t("qrscan.torchOff")}</span>
            </button>
          )}

          <button
            type="button"
            className="qr-scanner-action-btn"
            onClick={handlePickGallery}
          >
            <ImageIcon size={22} />
            <span>{i18n.t("qrscan.gallery")}</span>
          </button>
        </div>
      </footer>
    </div>
  );
};

/**
 * 唤起全屏类似微信的实时扫码界面。
 * 镜头自动检测二维码，一经识别立即震动回调，无需用户手动按快门拍照。
 */
export function scanQrWithCamera(options?: {
  title?: string;
  hint?: string;
}): Promise<string[] | null> {
  return new Promise((resolve) => {
    const container = document.createElement("div");
    container.id = "qr-scanner-mount-" + Date.now();
    document.body.appendChild(container);
    const root = createRoot(container);

    const cleanup = () => {
      setTimeout(() => {
        root.unmount();
        container.remove();
      }, 50);
    };

    const handleClose = () => {
      cleanup();
      resolve(null);
    };

    const handleScan = (texts: string[]) => {
      cleanup();
      resolve(texts);
    };

    root.render(
      <QrScannerDialog
        open={true}
        title={options?.title || i18n.t("qrscan.title")}
        hint={options?.hint || i18n.t("qrscan.hint")}
        onScan={handleScan}
        onClose={handleClose}
      />,
    );
  });
}
