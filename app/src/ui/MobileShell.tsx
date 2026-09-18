import { type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  Cloud,
  Search,
  Settings as SettingsIcon,
  Lock,
  ShieldCheck,
  UserRound,
  ChevronLeft,
  FileLock2,
  NotebookPen,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { AppLogo } from "./AppLogo";
import { useApp } from "../store";
import { useAppName } from "../lib/config";
import { isMobileTabRoot } from "../shared/mobileBack";
import { dispatchMobileHierarchyBack, useMobileHierarchyBack } from "../shared/useMobileHierarchyBack";
import { openCommandPalette } from "./commandPaletteBus";

/**
 * 移动端外壳：顶部精简标题 + 内容区 + 底部 Tab。
 *
 * 与桌面 `Layout` 的差别不只是"侧栏挪到底部"：
 * - 不显示工作空间路径（移动端路径固定在沙箱内，用户无从选择也无需知道）；
 * - 不显示窗口控制按钮；
 * - SSH 配置 / Agent / 仓库 / 克隆四个桌面专属页面不进导航。
 * - 同步 / 设置走顶栏图标；底栏是总览、2FA、账密、备忘录、文件库。
 */

export function MobileShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { lock, writesLocked, startupNote, status } = useApp();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const APP_NAME = useAppName();
  const isSubpage = !isMobileTabRoot(pathname);
  useMobileHierarchyBack();

  const TABS = [
    { to: "/", label: t("mobileNav.overview"), icon: LayoutDashboard, end: true },
    { to: "/totp", label: t("mobileNav.totp"), icon: ShieldCheck },
    { to: "/accounts", label: t("mobileNav.accounts"), icon: UserRound },
    { to: "/notes", label: t("mobileNav.notes"), icon: NotebookPen },
    { to: "/files", label: t("mobileNav.files"), icon: FileLock2 },
  ];

  const PAGE_TITLE: Record<string, string> = {
    "/": t("nav.overview"),
    "/totp": t("nav.totp"),
    "/accounts": t("nav.accounts"),
    "/files": t("nav.files"),
    "/notes": t("nav.notes"),
    "/sync": t("nav.sync"),
    "/settings": t("nav.settings"),
  };

  const pageTitle = PAGE_TITLE[pathname] || APP_NAME;

  return (
    <div className="m-shell">
      <header className="m-topbar">
        {isSubpage ? (
          <button
            type="button"
            className="m-icon-btn"
            aria-label={t("common.back")}
            onClick={() => {
              dispatchMobileHierarchyBack(pathname, navigate, !!status?.unlocked, !!status?.mobileBackgroundRun);
            }}
          >
            <ChevronLeft size={22} />
          </button>
        ) : (
          <AppLogo size={22} />
        )}
        <div className="m-topbar-copy">
          <div className="m-topbar-brand">{APP_NAME}</div>
          <div className="m-topbar-page">{pageTitle}</div>
        </div>
        <div className="m-topbar-spacer" />
        <div className="m-topbar-actions">
          <button
            type="button"
            className="m-icon-btn"
            aria-label={t("palette.open")}
            title={t("palette.open")}
            onClick={() => openCommandPalette()}
          >
            <Search size={18} />
          </button>
          <NavLink
            to="/sync"
            replace
            className={({ isActive }) => "m-icon-btn" + (isActive ? " is-on" : "")}
            aria-label={t("nav.sync")}
            title={t("nav.sync")}
          >
            <Cloud size={18} />
          </NavLink>
          <NavLink
            to="/settings"
            replace
            className={({ isActive }) => "m-icon-btn" + (isActive ? " is-on" : "")}
            aria-label={t("nav.settings")}
            title={t("nav.settings")}
          >
            <SettingsIcon size={18} />
          </NavLink>
          <button
            type="button"
            className="m-icon-btn"
            aria-label={t("nav.lockNow")}
            title={t("nav.lockNow")}
            onClick={() => lock()}
          >
            <Lock size={18} />
          </button>
        </div>
      </header>

      <main className="m-content">
        {writesLocked && (
          <div className="startup-lock-bar" role="status">
            <strong>{t("startup.syncing")}</strong>
            <span>{startupNote || t("startup.syncingNote")}</span>
          </div>
        )}
        {children}
      </main>

      <nav className="m-tabbar">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          return (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.end}
              replace
              className={({ isActive }) => "m-tab" + (isActive ? " active" : "")}
            >
              <Icon size={20} />
              <span>{tab.label}</span>
            </NavLink>
          );
        })}
      </nav>
    </div>
  );
}
