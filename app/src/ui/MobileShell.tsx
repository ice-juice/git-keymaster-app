import { type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  Cloud,
  Settings as SettingsIcon,
  Lock,
  ShieldCheck,
  UserRound,
  ChevronLeft,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { AppLogo } from "./AppLogo";
import { useApp } from "../store";
import { useAppName } from "../lib/config";
import { dispatchMobileHierarchyBack, useMobileHierarchyBack } from "../shared/useMobileHierarchyBack";

/**
 * 移动端外壳：顶部精简标题 + 内容区 + 底部 Tab。
 *
 * 与桌面 `Layout` 的差别不只是"侧栏挪到底部"：
 * - 不显示工作空间路径（移动端路径固定在沙箱内，用户无从选择也无需知道）；
 * - 不显示窗口控制按钮；
 * - SSH 配置 / Agent / 仓库 / 克隆四个桌面专属页面不进导航。
 */

export function MobileShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { lock, writesLocked, startupNote, status } = useApp();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const APP_NAME = useAppName();
  const isSubpage = pathname !== "/";
  useMobileHierarchyBack();

  const TABS = [
    { to: "/", label: t("mobileNav.overview"), icon: LayoutDashboard, end: true },
    { to: "/totp", label: t("mobileNav.totp"), icon: ShieldCheck },
    { to: "/accounts", label: t("mobileNav.accounts"), icon: UserRound },
    { to: "/sync", label: t("mobileNav.sync"), icon: Cloud },
    { to: "/settings", label: t("mobileNav.settings"), icon: SettingsIcon },
  ];

  const PAGE_TITLE: Record<string, string> = {
    "/": t("page.overview"),
    "/totp": t("page.totp"),
    "/accounts": t("page.accounts"),
    "/files": t("page.files"),
    "/notes": t("page.notes"),
    "/sync": t("page.sync"),
    "/settings": t("page.settings"),
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
        <button
          type="button"
          className="m-icon-btn"
          aria-label={t("nav.lockNow")}
          onClick={() => lock()}
        >
          <Lock size={18} />
        </button>
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
