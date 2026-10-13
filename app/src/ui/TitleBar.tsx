import { useEffect, useId, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Copy, Square, X, Sun, Moon, Palette, ShieldCheck, ShieldOff, Lock, Unlock } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, type RevealSettings } from "../lib/ipc";
import { AppLogo } from "./AppLogo";
import { useApp } from "../store";
import { useAppName } from "../lib/config";

function TitleState({
  className,
  label,
  tip,
  icon,
}: {
  className: string;
  label: string;
  tip: string;
  icon: ReactNode;
}) {
  const tipId = useId();
  return (
    <div className={"tb-state " + className} tabIndex={0} aria-describedby={tipId} data-tauri-drag-region>
      <span className="tb-state-icon" aria-hidden>
        {icon}
      </span>
      <span>{label}</span>
      <div className="tb-tip" id={tipId} role="tooltip">
        {tip}
      </div>
    </div>
  );
}

const appWindow = (() => {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
})();

/**
 * 自绘标题栏：横贯整个窗口顶部，与侧边栏、主区无缝融合。
 * 左段承接侧边栏（品牌），右段承接主区（工作空间路径 / 主题 / 状态 / 窗口按钮）。
 * 非按钮区域标记为拖拽域，可拖动窗口、双击最大化。
 */
export function TitleBar() {
  const { t } = useTranslation();
  const { status, theme, toggleTheme } = useApp();
  const APP_NAME = useAppName();
  const themeLabel =
    theme === "light" ? t("theme.light") : theme === "dark" ? t("theme.dark") : t("theme.navy");
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!appWindow) return;
    let unlisten: (() => void) | undefined;
    appWindow.isMaximized().then(setMaximized).catch(() => {});
    appWindow
      .onResized(() => {
        appWindow.isMaximized().then(setMaximized).catch(() => {});
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => unlisten?.();
  }, []);

  const unlocked = !!status?.unlocked;
  const [reveal, setReveal] = useState<RevealSettings | null>(null);

  useEffect(() => {
    if (!unlocked) {
      setReveal(null);
      return;
    }
    let cancelled = false;
    const pull = () => {
      void api.getRevealSettings().then((next) => {
        if (!cancelled) setReveal(next);
      }).catch(() => {});
    };
    pull();
    const timer = window.setInterval(pull, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [unlocked]);

  const graceFresh = (reveal?.revealGraceRemainingSecs ?? 0) > 0;

  return (
    <div className="titlebar">
      {/* 左段：品牌，宽度对齐侧边栏 */}
      <div className="tb-brand" data-tauri-drag-region>
        <AppLogo size={26} />
        {/* 只渲染 APP_NAME（useAppName / brand.mjs）。不要去读运行时产品名。 */}
        <div className="tb-title">{APP_NAME}</div>
      </div>

      {/* 右段：路径 + 操作 + 窗口控制 */}
      <div className="tb-main" data-tauri-drag-region>
        <div className="tb-ws" data-tauri-drag-region>
          <span className="tb-ws-label">{t("titlebar.workspace")}</span>
          <span className="tb-ws-path" title={status?.workspacePath ?? ""}>
            {status?.workspacePath ?? t("common.emDash")}
          </span>
        </div>

        <div className="tb-spacer" data-tauri-drag-region />

        <button
          type="button"
          className="tb-chip"
          title={t("theme.current", { name: themeLabel })}
          onClick={toggleTheme}
        >
          {theme === "light" ? <Sun size={13} /> : theme === "dark" ? <Moon size={13} /> : <Palette size={13} />}
          <span>{themeLabel}</span>
        </button>

        {status?.initialized && unlocked && (
          <TitleState
            className={"tb-grace" + (graceFresh ? " is-fresh" : " is-stale")}
            label={graceFresh ? t("titlebar.graceFresh") : t("titlebar.graceStale")}
            tip={
              graceFresh
                ? t("titlebar.graceFreshTip", { n: reveal?.revealGraceRemainingSecs ?? 0 })
                : t("titlebar.graceStaleTip")
            }
            icon={graceFresh ? <Unlock size={12} /> : <Lock size={12} />}
          />
        )}

        {status?.initialized && (
          <TitleState
            className={"tb-status" + (unlocked ? " on" : "")}
            label={unlocked ? t("titlebar.unlocked") : t("titlebar.locked")}
            tip={unlocked ? t("titlebar.unlockedTip") : t("titlebar.lockedTip")}
            icon={unlocked ? <ShieldCheck size={12} /> : <ShieldOff size={12} />}
          />
        )}

        {/* 窗口控制按钮 */}
        <div className="tb-winbtns">
          <button
            type="button"
            className="tb-winbtn"
            aria-label={t("titlebar.minimize")}
            title={t("titlebar.minimize")}
            onClick={() => appWindow?.minimize()}
          >
            <Minus size={15} />
          </button>
          <button
            type="button"
            className="tb-winbtn"
            aria-label={maximized ? t("titlebar.restore") : t("titlebar.maximize")}
            title={maximized ? t("titlebar.restore") : t("titlebar.maximize")}
            onClick={() => appWindow?.toggleMaximize()}
          >
            {maximized ? <Copy size={12} /> : <Square size={12} />}
          </button>
          <button
            type="button"
            className="tb-winbtn danger"
            aria-label={t("titlebar.close")}
            title={t("titlebar.close")}
            onClick={() => appWindow?.close()}
          >
            <X size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
