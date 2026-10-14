import { useEffect, useRef, useState, type FC } from "react";
import { createRoot } from "react-dom/client";
import { X, Zap, ZapOff, Image as ImageIcon, CameraOff, RefreshCw, SwitchCamera } from "lucide-react";
import jsQR from "jsqr";
import { pickQrFromGallery } from "../lib/qrCapture";
import { api } from "../lib/ipc";
import { i18n, displayNameForLocale } from "../lib/i18n";
import { isIOS, isMobilePlatform } from "../lib/platform";
import {
  centerSquareCrop,
  fitMaxSide,
  looksLikeBlankFrame,
  shouldRunPixelFallback,
  takeNewFrameTexts,
  viewfinderSourceCrop,
} from "./qrScanFrame";

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
  /** 光传帧模块密，需要比普通扫码更高的采样分辨率。 */
  highRes?: boolean;
}): Promise<MediaStream> {
  const idealW = opts.highRes ? 1920 : 1280;
  const idealH = opts.highRes ? 1080 : 720;
  const attempts: MediaStreamConstraints[] = [];
  if (opts.deviceId) {
    attempts.push({
      video: { deviceId: { exact: opts.deviceId }, width: { ideal: idealW }, height: { ideal: idealH } },
      audio: false,
    });
  } else if (opts.mobile) {
    // iOS Safari / WKWebView：exact facingMode 经常 OverconstrainedError，只用 ideal。
    attempts.push({
      video: { facingMode: { ideal: "environment" }, width: { ideal: idealW }, height: { ideal: idealH } },
      audio: false,
    });
    if (opts.ios) {
      attempts.push({ video: { facingMode: "environment" }, audio: false });
      attempts.push({ video: true, audio: false });
    }
  } else {
    attempts.push({
      video: { facingMode: { ideal: "user" }, width: { ideal: idealW }, height: { ideal: idealH } },
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
  /** 连续扫描：命中后不关镜头、不调 onScan，只回调 onFrame 并继续循环。 */
  continuous?: boolean;
  /** 连续模式下每帧新文本（相邻重复帧已去重）。返回 ignored 表示这不是当前接收器要的码。 */
  onFrame?: (text: string) => void | "accepted" | "ignored";
  /** 连续扫码时画在镜头界面上的进度。max 为 0 表示还不知道总帧数。 */
  beamProgress?: { value: number; max: number; ratio: number } | null;
}

export const QrScannerDialog: FC<QrScannerDialogProps> = ({
  open,
  title,
  hint,
  onScan,
  onClose,
  continuous = false,
  onFrame,
  beamProgress = null,
}) => {
  const brand = displayNameForLocale(i18n.language);
  const dialogTitle = title ?? i18n.t("qrscan.title");
  const dialogHint = hint ?? i18n.t("qrscan.hint");
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [cameraError, setCameraError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [loadingCamera, setLoadingCamera] = useState(true);
  const [scanDetail, setScanDetail] = useState<"" | "stalled" | "foreign" | "blank">("");
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const mobile = isMobilePlatform();
  const ios = isIOS();
  const detectorRef = useRef<{ detect: (source: CanvasImageSource) => Promise<Array<{ rawValue?: string }>> } | null>(null);
  const continuousRef = useRef(continuous);
  const onFrameRef = useRef(onFrame);
  continuousRef.current = continuous;
  onFrameRef.current = onFrame;

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
        highRes: continuousRef.current,
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
        if (continuousRef.current) {
          try {
            await (videoTrack as any).applyConstraints({ advanced: [{ focusMode: "continuous" }] });
          } catch {
            // 部分机型不支持连续对焦，保持系统默认
          }
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
    let lastFrameText = "";
    let accepted = 0;
    let foreign = 0;
    let blanks = 0;
    let detail: "" | "stalled" | "foreign" | "blank" = "";
    const startedAt = performance.now();
    setScanDetail("");

    type FrameGrabber = { grabFrame: () => Promise<ImageBitmap> };
    const grabCache: { track: MediaStreamTrack | null; grabber: FrameGrabber | null; fails: number } = {
      track: null,
      grabber: null,
      fails: 0,
    };

    const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
      new Promise((resolve, reject) => {
        const id = window.setTimeout(() => reject(new Error("timeout")), ms);
        p.then(
          (value) => {
            window.clearTimeout(id);
            resolve(value);
          },
          (err) => {
            window.clearTimeout(id);
            reject(err);
          },
        );
      });

    const canvasToBlob = (canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> =>
      new Promise((resolve) => {
        let settled = false;
        const finish = (blob: Blob | null) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(id);
          resolve(blob);
        };
        const id = window.setTimeout(() => finish(null), 700);
        try {
          canvas.toBlob((blob) => finish(blob), type, quality);
        } catch {
          finish(null);
        }
      });

    const closeBitmap = (source: CanvasImageSource) => {
      if (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap) source.close();
    };

    const setDetail = (next: typeof detail) => {
      if (detail === next) return;
      detail = next;
      setScanDetail(next);
    };

    const refreshDetail = () => {
      if (!continuousRef.current) return;
      if (accepted > 0) setDetail("");
      else if (blanks >= 4) setDetail("blank");
      else if (foreign > 0) setDetail("foreign");
      else if (performance.now() - startedAt > 4500) setDetail("stalled");
    };

    /** 单次扫码：命中后停镜头。连续光传不走这里。 */
    const applyHit = (texts: string[]): boolean => {
      detected = true;
      handleSuccess(texts);
      return true;
    };

    const deliverContinuous = (texts: string[]): boolean => {
      const taken = takeNewFrameTexts(texts, lastFrameText);
      lastFrameText = taken.last;
      if (taken.fresh.length === 0) return false;
      for (const text of taken.fresh) {
        const mark = onFrameRef.current?.(text);
        if (mark === "ignored") foreign += 1;
        else accepted += 1;
      }
      blanks = 0;
      refreshDetail();
      return true;
    };

    const captureSource = async (video: HTMLVideoElement): Promise<CanvasImageSource> => {
      const track = streamRef.current?.getVideoTracks()[0];
      if (track && grabCache.fails < 2 && "ImageCapture" in window) {
        if (grabCache.track !== track) {
          grabCache.track = track;
          grabCache.grabber = null;
          try {
            const Ctor = (window as unknown as { ImageCapture: new (track: MediaStreamTrack) => FrameGrabber }).ImageCapture;
            grabCache.grabber = new Ctor(track);
          } catch {
            grabCache.grabber = null;
            grabCache.fails = 2;
          }
        }
        if (grabCache.grabber) {
          try {
            return await withTimeout(grabCache.grabber.grabFrame(), 450);
          } catch {
            grabCache.fails += 1;
          }
        }
      }
      return video;
    };

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

    const scanOnce = async (): Promise<boolean> => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return false;
      let hitThisFrame = false;

      if (detectorRef.current) {
        try {
          const codes = await detectorRef.current.detect(video);
          if (codes && codes.length > 0) {
            const rawValues = codes.map((c) => c.rawValue).filter(Boolean) as string[];
            if (rawValues.length > 0) return applyHit(rawValues);
          }
        } catch {
          // fallback
        }
      }

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
        if (!ctx) return false;
        ctx.drawImage(video, 0, 0, cw, ch);
        const imgData = ctx.getImageData(0, 0, cw, ch);
        const code = jsQR(imgData.data, cw, ch, { inversionAttempts: "attemptBoth" });
        if (code && code.data && code.data.trim()) return applyHit([code.data.trim()]);

        frames += 1;
        if (frames % 12 === 0) {
          const blob = await canvasToBlob(canvas, "image/jpeg", 0.85);
          if (blob) {
            const bytes = new Uint8Array(await blob.arrayBuffer());
            const texts = await api.decodeQrFromImage(Array.from(bytes));
            if (texts && texts.length > 0) return applyHit(texts);
          }
        }
      } catch {
        // ignore frame error
      }
      return hitThisFrame;
    };

    const scanContinuous = async () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      const source = await captureSource(video);
      if (cancelled) {
        closeBitmap(source);
        return;
      }
      const size =
        source instanceof HTMLVideoElement
          ? { width: source.videoWidth || 0, height: source.videoHeight || 0 }
          : typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap
            ? { width: source.width, height: source.height }
            : {
                width: (source as { width?: number }).width || video.videoWidth || 0,
                height: (source as { height?: number }).height || video.videoHeight || 0,
              };
      const display = video.getBoundingClientRect();
      const box = boxRef.current?.getBoundingClientRect();
      const region =
        (box ? viewfinderSourceCrop(size.width, size.height, display, box) : null) ??
        centerSquareCrop(size.width, size.height) ?? {
          x: 0,
          y: 0,
          width: size.width,
          height: size.height,
        };
      const fitted = fitMaxSide(region.width, region.height, 960);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx || fitted.width < 2 || fitted.height < 2 || region.width < 2 || region.height < 2) {
        closeBitmap(source);
        return;
      }
      canvas.width = fitted.width;
      canvas.height = fitted.height;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(source, region.x, region.y, region.width, region.height, 0, 0, fitted.width, fitted.height);
      closeBitmap(source);

      const imgData = ctx.getImageData(0, 0, fitted.width, fitted.height);
      if (looksLikeBlankFrame(imgData.data, fitted.width, fitted.height)) {
        blanks += 1;
        refreshDetail();
        return;
      }
      blanks = 0;

      let delivered = false;
      if (detectorRef.current) {
        try {
          const codes = await withTimeout(detectorRef.current.detect(canvas), 350);
          const rawValues = (codes ?? []).map((c) => c.rawValue).filter(Boolean) as string[];
          if (rawValues.length > 0) delivered = deliverContinuous(rawValues);
        } catch {
          // 像素解码兜底
        }
      }
      if (shouldRunPixelFallback(delivered)) {
        try {
          const code = jsQR(imgData.data, fitted.width, fitted.height, {
            inversionAttempts: frames % 3 === 2 ? "attemptBoth" : "dontInvert",
          });
          if (code?.data?.trim()) delivered = deliverContinuous([code.data]);
          if (!delivered) {
            frames += 1;
            if (frames % 4 === 0) {
              const blob = await canvasToBlob(canvas, "image/png");
              if (blob && !cancelled) {
                const bytes = new Uint8Array(await blob.arrayBuffer());
                const texts = await withTimeout(api.decodeQrFromImage(Array.from(bytes)), 800).catch(() => [] as string[]);
                if (texts.length > 0) deliverContinuous(texts);
              }
            }
          } else {
            frames = 0;
          }
        } catch {
          // 继续下一帧
        }
      }
      refreshDetail();
    };

    const scanFrame = async () => {
      if (cancelled || detected) return;
      const started = performance.now();
      const stop = continuousRef.current ? false : await scanOnce();
      if (continuousRef.current) await scanContinuous();
      if (cancelled || detected || stop) return;
      const elapsed = performance.now() - started;
      const minGap = continuousRef.current ? 70 : ios ? 160 : 120;
      timer = window.setTimeout(scanFrame, Math.max(16, minGap - elapsed));
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
          <div className={"qr-scanner-box" + (continuous ? " is-continuous" : "")} ref={boxRef}>
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
        {continuous && beamProgress && !loadingCamera && !cameraError && (
          <div
            className="qr-scanner-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuenow={beamProgress.max > 0 ? beamProgress.value : undefined}
            aria-valuemax={beamProgress.max > 0 ? beamProgress.max : undefined}
            aria-label={dialogHint}
          >
            <i style={{ width: `${Math.round(Math.min(1, Math.max(0, beamProgress.ratio)) * 100)}%` }} />
          </div>
        )}
        <div className="qr-scanner-hint">
          {loadingCamera ? i18n.t("qrscan.starting") : dialogHint}
        </div>
        {continuous && scanDetail === "stalled" && (
          <div className="qr-scanner-hint is-sub">{i18n.t("qrscan.beamStalled")}</div>
        )}
        {continuous && scanDetail === "foreign" && (
          <div className="qr-scanner-hint is-sub">{i18n.t("qrscan.beamNotFrame")}</div>
        )}
        {continuous && scanDetail === "blank" && (
          <div className="qr-scanner-hint is-sub">{i18n.t("qrscan.beamBlank")}</div>
        )}

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
