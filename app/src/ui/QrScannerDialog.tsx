import { useEffect, useRef, useState, type FC } from "react";
import { createRoot } from "react-dom/client";
import { X, Zap, ZapOff, Image as ImageIcon, CameraOff, RefreshCw } from "lucide-react";
import jsQR from "jsqr";
import { pickQrFromGallery } from "../lib/qrCapture";
import { api } from "../lib/ipc";
import { i18n, displayNameForLocale } from "../lib/i18n";

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
  const startCamera = async () => {
    stopStream();
    setCameraError(null);
    setPermissionDenied(false);
    setLoadingCamera(true);

    try {
      const perm = await api.requestCameraPermission();
      if (!perm.granted) {
        setPermissionDenied(true);
        setLoadingCamera(false);
        setCameraError(
          perm.permanentlyDenied
            ? i18n.t("qrscan.permDeniedSettings", { name: brand })
            : i18n.t("qrscan.permNeeded"),
        );
        return;
      }

      const constraints: MediaStreamConstraints = {
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }

      // 检查手电筒 (Torch) 支持
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        const capabilities = (videoTrack as any).getCapabilities?.();
        if (capabilities && "torch" in capabilities) {
          setTorchAvailable(true);
        }
      }

      setLoadingCamera(false);
    } catch (err: any) {
      setLoadingCamera(false);
      const name = err?.name || "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        setPermissionDenied(true);
        setCameraError(i18n.t("qrscan.permDeniedPhone", { name: brand }));
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

    startCamera();

    const scanFrame = async () => {
      if (cancelled || detected) return;

      const video = videoRef.current;
      const canvas = canvasRef.current;

      if (video && canvas && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        // 1. 优先尝试硬件加速 BarcodeDetector（Android Chromium 83+ 原生内置）
        if ("BarcodeDetector" in window) {
          try {
            const detector = new (window as any).BarcodeDetector({ formats: ["qr_code"] });
            const codes = await detector.detect(video);
            if (codes && codes.length > 0) {
              const rawValues = codes.map((c: any) => c.rawValue).filter(Boolean);
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
          // 缩放到 640px 保证毫秒级 CPU 解码
          const maxDim = 640;
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
          }
        } catch {
          // ignore frame error
        }
      }

      if (!cancelled && !detected) {
        timer = window.setTimeout(scanFrame, 120);
      }
    };

    timer = window.setTimeout(scanFrame, 300);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
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
              onClick={startCamera}
            >
              <RefreshCw size={14} /> {i18n.t("qrscan.retry")}
            </button>
            {permissionDenied && (
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
