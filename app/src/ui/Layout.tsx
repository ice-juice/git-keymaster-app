import { useEffect, useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  LayoutDashboard,
  KeyRound,
  FileCog,
  Cpu,
  FolderGit2,
  Download,
  Cloud,
  Settings as SettingsIcon,
  Lock,
  Timer,
  UserRound,
  FileLock2,
  NotebookPen,
} from "lucide-react";
import { api } from "../lib/ipc";
import { useApp } from "../store";
import { UpdateToast } from "./UpdateToast";

export function Layout({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { status, lock, writesLocked, startupNote } = useApp();
  const [idCount, setIdCount] = useState<number | null>(null);
  const [keyCount, setKeyCount] = useState<number | null>(null);
  const [repoCount, setRepoCount] = useState<number | null>(null);
  const [totpCount, setTotpCount] = useState<number | null>(null);
  const [accountCount, setAccountCount] = useState<number | null>(null);
  const [fileCount, setFileCount] = useState<number | null>(null);
  const [noteCount, setNoteCount] = useState<number | null>(null);

  useEffect(() => {
    let unmounted = false;
    (async () => {
      try {
        const [counts, totp, accounts, files, notes] = await Promise.all([
          api.workspaceNavCounts(),
          api.totpList(),
          api.accountList(),
          api.fileList(),
          api.noteList(),
        ]);
        if (!unmounted) {
          setIdCount(counts.identities);
          setKeyCount(counts.keys);
          setRepoCount(counts.repos);
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
  }, [status?.unlocked, writesLocked]);

  const NAV = [
    { to: "/", label: t("nav.overview"), icon: LayoutDashboard, end: true, badge: idCount },
    { to: "/keys", label: t("nav.keys"), icon: KeyRound, badge: keyCount },
    { to: "/config", label: t("nav.config"), icon: FileCog },
    { to: "/agent", label: t("nav.agent"), icon: Cpu },
    { to: "/repos", label: t("nav.repos"), icon: FolderGit2, badge: repoCount },
    { to: "/clone", label: t("nav.clone"), icon: Download },
    { to: "/totp", label: t("nav.totp"), icon: Timer, badge: totpCount },
    { to: "/accounts", label: t("nav.accounts"), icon: UserRound, badge: accountCount },
    { to: "/files", label: t("nav.files"), icon: FileLock2, badge: fileCount },
    { to: "/notes", label: t("nav.notes"), icon: NotebookPen, badge: noteCount },
    { to: "/sync", label: t("nav.sync"), icon: Cloud },
  ];

  return (
    <div className="window">
      <div className="body">
        <aside className="sidebar">
          <div className="nav-group">{t("nav.group")}</div>
          {NAV.map((n) => {
            const Icon = n.icon;
            return (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}
              >
                <div className="nav-item-left">
                  <span className="ic">
                    <Icon size={15} />
                  </span>
                  <span>{n.label}</span>
                </div>
                {typeof n.badge === "number" && n.badge > 0 && (
                  <span className="nav-badge">{n.badge}</span>
                )}
              </NavLink>
            );
          })}
          <div className="grow" />
          <div className="side-foot">
            <NavLink
              to="/settings"
              className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}
              style={{ marginBottom: 2 }}
            >
              <div className="nav-item-left">
                <span className="ic">
                  <SettingsIcon size={15} />
                </span>
                <span>{t("nav.settings")}</span>
              </div>
            </NavLink>
            <button type="button" className="nav-item" onClick={() => lock()}>
              <div className="nav-item-left">
                <span className="ic">
                  <Lock size={15} />
                </span>
                <span>{t("nav.lockNow")}</span>
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
