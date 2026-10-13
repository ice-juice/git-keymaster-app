import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { ChevronLeft, ChevronRight, ImagePlus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, errMessage } from "../lib/ipc";
import { resolvePlatform } from "../platform/resolve";
import {
  clampPan,
  gestureAfterDrag,
  isFitted,
  MIN_ZOOM,
  panLimit,
  pinchScale,
  toggleZoom,
  wheelAction,
  zoomAtPoint,
} from "./accountImageView";

export const ACCOUNT_IMAGE_LIMIT = 12;

export function AccountImageGallery({
  hashes,
  startIndex = 0,
  onClose,
}: {
  hashes: string[];
  startIndex?: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(() =>
    Math.min(Math.max(startIndex, 0), Math.max(hashes.length - 1, 0)),
  );
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [drag, setDrag] = useState(0);
  const [scale, setScale] = useState(MIN_ZOOM);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef({ scale: MIN_ZOOM, panX: 0, panY: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const pinchRef = useRef<{ dist: number; scale: number; panX: number; panY: number } | null>(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  const count = hashes.length;
  const hash = hashes[index];
  viewRef.current = { scale, panX: pan.x, panY: pan.y };

  useEffect(() => {
    let cancelled = false;
    for (const item of hashes) {
      void api
        .noteAssetGet(item)
        .then((url) => {
          if (!cancelled) setUrls((prev) => (prev[item] ? prev : { ...prev, [item]: url }));
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [hashes]);

  function resetView() {
    setScale(MIN_ZOOM);
    setPan({ x: 0, y: 0 });
    setDrag(0);
  }

  function go(delta: number) {
    setIndex((current) => Math.min(count - 1, Math.max(0, current + delta)));
  }

  useEffect(() => {
    resetView();
    const selected = stripRef.current?.querySelector<HTMLButtonElement>(".account-image-thumb.is-on");
    selected?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  }, [index]);

  function limits() {
    const stage = stageRef.current;
    const img = imgRef.current;
    const current = viewRef.current.scale;
    if (!stage || !img) return { maxX: 0, maxY: 0 };
    return {
      maxX: panLimit(img.offsetWidth, stage.clientWidth, current),
      maxY: panLimit(img.offsetHeight, stage.clientHeight, current),
    };
  }

  function applyZoom(nextScale: number, originX: number, originY: number) {
    const current = viewRef.current;
    const zoomed = zoomAtPoint({
      scale: current.scale,
      panX: current.panX,
      panY: current.panY,
      nextScale,
      originX,
      originY,
    });
    const bounded = isFitted(zoomed.scale)
      ? { x: 0, y: 0 }
      : {
          x: clampPan(zoomed.panX, panLimit(imgRef.current?.offsetWidth || 0, stageRef.current?.clientWidth || 0, zoomed.scale)),
          y: clampPan(zoomed.panY, panLimit(imgRef.current?.offsetHeight || 0, stageRef.current?.clientHeight || 0, zoomed.scale)),
        };
    setScale(zoomed.scale);
    setPan(bounded);
  }

  function originFromClient(clientX: number, clientY: number) {
    const stage = stageRef.current?.getBoundingClientRect();
    if (!stage) return { x: 0, y: 0 };
    return { x: clientX - (stage.left + stage.width / 2), y: clientY - (stage.top + stage.height / 2) };
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        if (isFitted(viewRef.current.scale)) go(e.key === "ArrowLeft" ? -1 : 1);
        else {
          const box = limits();
          const step = e.key === "ArrowLeft" ? 40 : -40;
          setPan((prev) => ({ x: clampPan(prev.x + step, box.maxX), y: prev.y }));
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, count]);

  useEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const action = wheelAction(viewRef.current.scale, e.deltaX, e.deltaY, e.ctrlKey);
      if (action.type === "next" || action.type === "prev") {
        go(action.type === "next" ? 1 : -1);
        return;
      }
      if (action.type === "pan") {
        const box = limits();
        setPan((prev) => ({
          x: clampPan(prev.x + action.dx, box.maxX),
          y: clampPan(prev.y + action.dy, box.maxY),
        }));
        return;
      }
      const origin = originFromClient(e.clientX, e.clientY);
      applyZoom(viewRef.current.scale * action.factor, origin.x, origin.y);
    }
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [hash]);

  if (!hash) return null;

  return createPortal(
    <div className={"account-image-view" + (count > 1 ? " has-thumbs" : "")} onClick={onClose}>
      <button
        type="button"
        className="account-image-view-close"
        aria-label={t("common.close")}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <X size={18} />
        <span>{t("common.close")}</span>
      </button>
      {count > 1 ? (
        <button
          type="button"
          className="account-image-nav is-prev"
          aria-label={t("accounts.imagesPrev")}
          disabled={index <= 0}
          onClick={(e) => {
            e.stopPropagation();
            go(-1);
          }}
        >
          <ChevronLeft size={22} />
        </button>
      ) : null}
      <div
        ref={stageRef}
        className={"account-image-view-stage" + (isFitted(scale) ? "" : " is-zoomed")}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => {
          e.stopPropagation();
          const origin = originFromClient(e.clientX, e.clientY);
          if (isFitted(viewRef.current.scale)) applyZoom(toggleZoom(viewRef.current.scale), origin.x, origin.y);
          else resetView();
        }}
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          e.currentTarget.setPointerCapture(e.pointerId);
          if (pointers.current.size >= 2) {
            const [a, b] = [...pointers.current.values()];
            pinchRef.current = {
              dist: Math.hypot(a.x - b.x, a.y - b.y),
              scale: viewRef.current.scale,
              panX: viewRef.current.panX,
              panY: viewRef.current.panY,
            };
            dragRef.current = null;
            return;
          }
          dragRef.current = { x: e.clientX, y: e.clientY, panX: viewRef.current.panX, panY: viewRef.current.panY };
        }}
        onPointerMove={(e) => {
          if (!pointers.current.has(e.pointerId)) return;
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          const pts = [...pointers.current.values()];
          if (pts.length >= 2 && pinchRef.current) {
            const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
            const midX = (pts[0].x + pts[1].x) / 2;
            const midY = (pts[0].y + pts[1].y) / 2;
            const origin = originFromClient(midX, midY);
            const next = pinchScale(pinchRef.current.scale, pinchRef.current.dist, dist);
            const zoomed = zoomAtPoint({
              scale: pinchRef.current.scale,
              panX: pinchRef.current.panX,
              panY: pinchRef.current.panY,
              nextScale: next,
              originX: origin.x,
              originY: origin.y,
            });
            const maxX = panLimit(imgRef.current?.offsetWidth || 0, stageRef.current?.clientWidth || 0, zoomed.scale);
            const maxY = panLimit(imgRef.current?.offsetHeight || 0, stageRef.current?.clientHeight || 0, zoomed.scale);
            setScale(zoomed.scale);
            setPan(isFitted(zoomed.scale) ? { x: 0, y: 0 } : { x: clampPan(zoomed.panX, maxX), y: clampPan(zoomed.panY, maxY) });
            return;
          }
          const start = dragRef.current;
          if (!start || pinchRef.current) return;
          const dx = e.clientX - start.x;
          const dy = e.clientY - start.y;
          if (isFitted(viewRef.current.scale)) setDrag(dx);
          else {
            const box = limits();
            setPan({
              x: clampPan(start.panX + dx, box.maxX),
              y: clampPan(start.panY + dy, box.maxY),
            });
          }
        }}
        onPointerUp={(e) => {
          pointers.current.delete(e.pointerId);
          if (pointers.current.size >= 1) return;
          const start = dragRef.current;
          const wasPinch = pinchRef.current != null;
          dragRef.current = null;
          pinchRef.current = null;
          setDrag(0);
          if (wasPinch || !start) return;
          const dx = e.clientX - start.x;
          const dy = e.clientY - start.y;
          const now = performance.now();
          const tap = Math.hypot(dx, dy) < 12;
          if (tap && lastTap.current && now - lastTap.current.t < 280 && Math.hypot(e.clientX - lastTap.current.x, e.clientY - lastTap.current.y) < 28) {
            lastTap.current = null;
            const origin = originFromClient(e.clientX, e.clientY);
            if (isFitted(viewRef.current.scale)) applyZoom(toggleZoom(viewRef.current.scale), origin.x, origin.y);
            else resetView();
            return;
          }
          if (tap) lastTap.current = { t: now, x: e.clientX, y: e.clientY };
          const action = gestureAfterDrag(viewRef.current.scale, dx, dy);
          if (action === "next" || action === "prev") go(action === "next" ? 1 : -1);
        }}
        onPointerCancel={() => {
          pointers.current.clear();
          dragRef.current = null;
          pinchRef.current = null;
          setDrag(0);
        }}
      >
        {urls[hash] ? (
          <img
            ref={imgRef}
            src={urls[hash]}
            alt=""
            draggable={false}
            style={{
              transform: `translate(${pan.x + (isFitted(scale) ? drag : 0)}px, ${pan.y}px) scale(${scale})`,
            }}
          />
        ) : (
          <span className="account-image-pending" />
        )}
      </div>
      {count > 1 ? (
        <button
          type="button"
          className="account-image-nav is-next"
          aria-label={t("accounts.imagesNext")}
          disabled={index >= count - 1}
          onClick={(e) => {
            e.stopPropagation();
            go(1);
          }}
        >
          <ChevronRight size={22} />
        </button>
      ) : null}
      {count > 1 ? (
        <div className="account-image-film" onClick={(e) => e.stopPropagation()}>
          <div className="account-image-count">{t("accounts.imagesCount", { n: index + 1, total: count })}</div>
          <div className="account-image-thumbs" ref={stripRef}>
            {hashes.map((item, i) => (
              <button
                key={`${item}-${i}`}
                type="button"
                className={"account-image-thumb" + (i === index ? " is-on" : "")}
                aria-label={t("accounts.imagesJump", { n: i + 1 })}
                aria-current={i === index ? "true" : undefined}
                onClick={() => setIndex(i)}
              >
                {urls[item] ? <img src={urls[item]} alt="" /> : <span className="account-image-pending" />}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

export function AccountImages({
  hashes,
  disabled,
  onChange,
  onError,
}: {
  hashes: string[];
  disabled?: boolean;
  onChange: (hashes: string[]) => void;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [uploading, setUploading] = useState(0);
  const full = hashes.length >= ACCOUNT_IMAGE_LIMIT;

  const hashKey = hashes.join("\n");
  useEffect(() => {
    let cancelled = false;
    for (const hash of hashKey ? hashKey.split("\n") : []) {
      void api
        .noteAssetGet(hash)
        .then((url) => {
          if (!cancelled) setUrls((prev) => (prev[hash] ? prev : { ...prev, [hash]: url }));
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [hashKey]);

  async function storeOne(args: { path?: string; bytes?: number[] }) {
    const { hash } = await api.accountImageAdd(args);
    return hash;
  }

  async function addMany(items: Array<{ path?: string; bytes?: number[] }>) {
    if (!items.length || disabled) return;
    const room = ACCOUNT_IMAGE_LIMIT - hashes.length;
    const batch = items.slice(0, Math.max(room, 0));
    if (!batch.length) {
      onError(t("accounts.imagesLimit", { n: ACCOUNT_IMAGE_LIMIT }));
      return;
    }
    if (batch.length < items.length) onError(t("accounts.imagesLimit", { n: ACCOUNT_IMAGE_LIMIT }));
    setUploading((n) => n + batch.length);
    const added: string[] = [];
    try {
      for (const item of batch) {
        try {
          const hash = await storeOne(item);
          if (!hashes.includes(hash) && !added.includes(hash)) added.push(hash);
        } catch (e) {
          onError(errMessage(e) || t("accounts.imagesFailed"));
        }
      }
      if (added.length) onChange([...hashes, ...added].slice(0, ACCOUNT_IMAGE_LIMIT));
    } finally {
      setUploading((n) => Math.max(0, n - batch.length));
    }
  }

  async function pickDesktop() {
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [{ name: t("common.imageFilter"), extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
    });
    const paths = typeof selected === "string" ? [selected] : selected || [];
    await addMany(paths.map((path) => ({ path })));
  }

  async function onFiles(files: FileList | null) {
    const list = Array.from(files || []);
    if (inputRef.current) inputRef.current.value = "";
    const items = await Promise.all(
      list.map(async (file) => ({ bytes: Array.from(new Uint8Array(await file.arrayBuffer())) })),
    );
    await addMany(items);
  }

  return (
    <div className="field account-images">
      <div className="account-images-head">
        <label className="field-label">{t("accounts.images")}</label>
        <span className="hint">
          {hashes.length}/{ACCOUNT_IMAGE_LIMIT}
        </span>
      </div>
      <div className="hint">{t("accounts.imagesTip")}</div>
      <div className="account-image-grid">
        {hashes.map((hash) => (
          <div key={hash} className="account-image-tile">
            <button
              type="button"
              className="account-image-open"
              title={t("accounts.imagesView")}
              onClick={() => setViewerIndex(hashes.indexOf(hash))}
            >
              {urls[hash] ? <img src={urls[hash]} alt="" /> : <span className="account-image-pending" />}
            </button>
            <button
              type="button"
              className="account-image-remove"
              title={t("accounts.imagesRemove")}
              aria-label={t("accounts.imagesRemove")}
              disabled={disabled}
              onClick={() => onChange(hashes.filter((item) => item !== hash))}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="account-image-add"
          disabled={disabled || full || uploading > 0}
          onClick={() => {
            if (resolvePlatform() === "mobile") inputRef.current?.click();
            else void pickDesktop();
          }}
        >
          <ImagePlus size={18} />
          <span>{t("accounts.imagesAdd")}</span>
        </button>
      </div>
      {uploading > 0 ? <div className="hint">{t("accounts.imagesUploading")}</div> : null}
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
        multiple
        hidden
        onChange={(e) => void onFiles(e.target.files)}
      />
      {viewerIndex != null ? (
        <AccountImageGallery hashes={hashes} startIndex={viewerIndex} onClose={() => setViewerIndex(null)} />
      ) : null}
    </div>
  );
}
