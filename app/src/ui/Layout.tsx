import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api } from "../lib/ipc";
import { useApp } from "../store";
import { UpdateToast } from "./UpdateToast";
import { NavIcon3D, type Nav3DIconName } from "./NavIcon3D";
import { migrateLegacyQrHistory } from "../shared/qrHistory";
import { afterNextPaint } from "../shared/yieldToPaint";

interface NavItemDef {
  to: string;
  label: string;
  icon: Nav3DIconName;
  end?: boolean;
  badge?: number | null;
  isCustomActive?: (pathname: string) => boolean;
}

export function Layout({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const location = useLocation();
  const { status, lock, writesLocked, startupNote, dataVersion } = useApp();
  const [idCount, setIdCount] = useState<number | null>(null);
  const [keyCount, setKeyCount] = useState<number | null>(null);
  const [repoCount, setRepoCount] = useState<number | null>(null);
  const [totpCount, setTotpCount] = useState<number | null>(null);
  const [accountCount, setAccountCount] = useState<number | null>(null);
  const [fileCount, setFileCount] = useState<number | null>(null);
  const [noteCount, setNoteCount] = useState<number | null>(null);

  useEffect(() => {
    void migrateLegacyQrHistory().catch(() => {
      /* 迁入失败时保留本地记录，下次进入再试 */
    });
  }, []);

  useEffect(() => {
    let unmounted = false;
    void (async () => {
      // 先让解锁后的壳画出来，再分两拍读计数。一次把五份冷文件的 JSON 倒进主线程会卡住。
      await afterNextPaint();
      if (unmounted) return;
      try {
        const counts = await api.workspaceNavCounts();
        if (unmounted) return;
        setIdCount(counts.identities);
        setKeyCount(counts.keys);
        setRepoCount(counts.repos);
        await afterNextPaint();
        if (unmounted) return;
        const [totp, accounts, files, notes] = await Promise.all([
          api.totpList(),
          api.accountList(),
          api.fileList(),
          api.noteList(),
        ]);
        if (!unmounted) {
          setTotpCount(totp.entries.length);
          setAccountCount(accounts.entries.length);
          setFileCount(files.entries.length);
          setNoteCount(notes.entries.length);
        }
      } catch {
        /* 忽略 */
      }
    })();
    return () => {
      unmounted = true;
    };
  }, [status?.unlocked, writesLocked, dataVersion]);

  const GIT_NAV: NavItemDef[] = [
    { to: "/", label: t("nav.overview"), icon: "home", end: true, badge: idCount },
    { to: "/keys", label: t("nav.keys"), icon: "key", badge: keyCount },
    {
      to: "/repos",
      label: t("nav.repos"),
      icon: "repos",
      badge: repoCount,
      isCustomActive: (p) => p.startsWith("/repos") || p.startsWith("/clone"),
    },
    { to: "/config", label: t("nav.config"), icon: "config" },
    { to: "/agent", label: t("nav.agent"), icon: "agent" },
  ];

  const VAULT_NAV: NavItemDef[] = [
    { to: "/totp", label: t("nav.totp"), icon: "totp", badge: totpCount },
    { to: "/accounts", label: t("nav.accounts"), icon: "accounts", badge: accountCount },
    { to: "/notes", label: t("nav.notes"), icon: "notes", badge: noteCount },
    { to: "/files", label: t("nav.files"), icon: "files", badge: fileCount },
  ];

  const TOOL_NAV: NavItemDef[] = [{ to: "/tools", label: t("nav.tools"), icon: "tools" }];

  function renderNavItem(n: NavItemDef) {
    const customActive = n.isCustomActive ? n.isCustomActive(location.pathname) : undefined;
    return (
      <NavLink
        key={n.to}
        to={n.to}
        end={n.end}
        className={({ isActive }) =>
          "nav-item" + ((customActive !== undefined ? customActive : isActive) ? " active" : "")
        }
      >
        <div className="nav-item-left">
          <NavIcon3D name={n.icon} size={18} />
          <span>{n.label}</span>
        </div>
        {typeof n.badge === "number" && n.badge > 0 && (
          <span className="nav-badge">{n.badge}</span>
        )}
      </NavLink>
    );
  }

  return (
    <div className="window">
      <div className="body">
        <aside className="sidebar">
          <div className="nav-group">{t("nav.groupGit")}</div>
          {GIT_NAV.map(renderNavItem)}

          <div className="nav-group" style={{ marginTop: 6 }}>
            {t("nav.groupVault")}
          </div>
          {VAULT_NAV.map(renderNavItem)}

          <div className="nav-group" style={{ marginTop: 6 }}>
            {t("nav.groupTools")}
          </div>
          {TOOL_NAV.map(renderNavItem)}

          <div className="grow" />
          <div className="side-foot">
            <NavLink
              to="/sync"
              className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}
              style={{ marginBottom: 2 }}
            >
              <div className="nav-item-left">
                <NavIcon3D name="sync" size={18} />
                <span>{t("nav.sync")}</span>
              </div>
            </NavLink>
            <NavLink
              to="/settings"
              className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}
              style={{ marginBottom: 2 }}
            >
              <div className="nav-item-left">
                <NavIcon3D name="settings" size={18} />
                <span>{t("nav.settings")}</span>
              </div>
            </NavLink>
            <button type="button" className="nav-item" onClick={() => lock()}>
              <div className="nav-item-left">
                <NavIcon3D name="lock" size={18} />
                <span style={{ color: "#f87171" }}>{t("nav.lockNow")}</span>
              </div>
            </button>
          </div>
        </aside>

        <main className="main">
          <div className="content">
            {writesLocked && (
              <div className="startup-lock-bar" role="status">
                <strong>{t("startup.syncing")}</strong>
                <span>{startupNote || t("startup.syncingNoteDesktop")}</span>
              </div>
            )}
            {children}
          </div>
        </main>
      </div>
      <UpdateToast />
    </div>
  );
}
