import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { api, type ScreenCaptureSettings } from "../../lib/ipc";
import { showAppToast } from "../../ui/Toast";

const DEFAULT: ScreenCaptureSettings = {
  allowScreenshots: false,
  capability: "exclude",
};

/** iOS 后台预览遮罩 + 系统截屏提示。其它平台只听后端事件。 */
export function useScreenCaptureGuard() {
  const { t } = useTranslation();
  const [cover, setCover] = useState(false);

  useEffect(() => {
    let allow = false;
    let overlay = false;
    let cancelled = false;

    function syncCover() {
      if (cancelled) return;
      const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
      setCover(overlay && !allow && hidden);
    }

    function apply(s: ScreenCaptureSettings) {
      allow = !!s.allowScreenshots;
      overlay = s.capability === "overlay";
      syncCover();
    }

    api.getScreenCaptureSettings().then(apply).catch(() => apply(DEFAULT));

    const onVis = () => syncCover();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", onVis);
    window.addEventListener("pageshow", onVis);

    let offChanged: (() => void) | undefined;
    let offShot: (() => void) | undefined;
    listen<ScreenCaptureSettings>("screen-capture-changed", (ev) => {
      if (ev.payload) apply(ev.payload);
    })
      .then((fn) => {
        offChanged = fn;
      })
      .catch(() => {});
    listen("screen-captured", () => {
      showAppToast(t("settings.screenshotTaken"));
    })
      .then((fn) => {
        offShot = fn;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", onVis);
      window.removeEventListener("pageshow", onVis);
      offChanged?.();
      offShot?.();
    };
  }, [t]);

  return cover;
}
