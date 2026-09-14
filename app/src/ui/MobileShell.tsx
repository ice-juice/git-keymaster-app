import { type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  Cloud,
  Settings as SettingsIcon,
  Lock,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { AppLogo } from "./AppLogo";
import { useApp } from "../store";
import { APP_NAME } from "../lib/config";

/**
 * 移动端外壳：顶部精简标题 + 内容区 + 底部 Tab。
 *
 * 与桌面 `Layout` 的差别不只是"侧栏挪到底部"：
 * - 不显示工作空间路径（移动端路径固定在沙箱内，用户无从选择也无需知道）；
 * - 不显示窗口控制按钮；
 * - SSH 配置 / Agent / 仓库 / 克隆四个桌面专属页面不进导航。
 */

const TABS = [
  { to: "/", label: "总览", icon: LayoutDashboard, end: true },
  { to: "/totp", label: "2FA", icon: ShieldCheck },
  { to: "/accounts", label: "账密", icon: UserRound },
  { to: "/sync", label: "同步", icon: Cloud },
  { to: "/settings", label: "设置", icon: SettingsIcon },
];

const PAGE_TITLE: Record<string, string> = {
  "/": "身份",
  "/totp": "2FA",
  "/accounts": "账密",
  "/sync": "同步",
  "/settings": "设置",
};

export function MobileShell({ children }: { children: ReactNode }) {
  const { lock, writesLocked, startupNote } = useApp();
  const { pathname } = useLocation();
  const pageTitle = PAGE_TITLE[pathname] || APP_NAME;

  return (
    <div className="m-shell">
      <header className="m-topbar">
        <AppLogo size={22} />
        <div className="m-topbar-copy">
          <div className="m-topbar-brand">{APP_NAME}</div>
          <div className="m-topbar-page">{pageTitle}</div>
        </div>
        <div className="m-topbar-spacer" />
        <button
          type="button"
          className="m-icon-btn"
          aria-label="立即锁定"
          onClick={() => lock()}
        >
          <Lock size={18} />
        </button>
      </header>

      <main className="m-content">
        {writesLocked && (
          <div className="startup-lock-bar" role="status">
            <strong>同步中</strong>
            <span>{startupNote || "正在从云端同步，可浏览，暂不可修改。"}</span>
          </div>
        )}
        {children}
      </main>

      <nav className="m-tabbar">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.end}
              className={({ isActive }) => "m-tab" + (isActive ? " active" : "")}
            >
              <Icon size={20} />
              <span>{t.label}</span>
            </NavLink>
          );
        })}
      </nav>
    </div>
  );
}
