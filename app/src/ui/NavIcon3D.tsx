import { useId, type ReactElement } from "react";

export type Nav3DIconName =
  | "home"
  | "key"
  | "repos"
  | "config"
  | "agent"
  | "totp"
  | "accounts"
  | "notes"
  | "files"
  | "sync"
  | "settings"
  | "lock";

interface NavIcon3DProps {
  name: Nav3DIconName;
  size?: number;
  className?: string;
}

export function NavIcon3D({ name, size = 18, className = "" }: NavIcon3DProps): ReactElement {
  const rawId = useId().replace(/:/g, "_");

  const style = {
    width: size,
    height: size,
  };

  switch (name) {
    case "home": {
      const roofTop = `homeRoofTop_${rawId}`;
      const roofShadow = `homeRoofShadow_${rawId}`;
      const wallFront = `homeWallFront_${rawId}`;
      const door = `homeDoor_${rawId}`;
      return (
        <span className={`nav-icon-3d ${className}`} style={style} aria-hidden="true">
          <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id={roofTop} x1="2" y1="3" x2="22" y2="12" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#818cf8" />
                <stop offset="100%" stopColor="#4f46e5" />
              </linearGradient>
              <linearGradient id={roofShadow} x1="12" y1="2" x2="22" y2="10" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#3730a3" />
                <stop offset="100%" stopColor="#312e81" />
              </linearGradient>
              <linearGradient id={wallFront} x1="5" y1="9" x2="19" y2="21" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#e0e7ff" />
                <stop offset="100%" stopColor="#a5b4fc" />
              </linearGradient>
              <linearGradient id={door} x1="10" y1="13" x2="14" y2="21" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#38bdf8" />
                <stop offset="100%" stopColor="#0284c7" />
              </linearGradient>
            </defs>
            <path d="M4 11L12 4.5L20 11V20C20 20.6 19.5 21 18.9 21H5.1C4.5 21 4 20.6 4 20V11Z" fill={`url(#${wallFront})`} />
            <path d="M12 4.5L20 11V21H18.5V11.5L12 6.2V4.5Z" fill="#818cf8" opacity="0.6" />
            <path d="M12 2L1.8 10.2C1.4 10.5 1.6 11.2 2.1 11.2H4.2L12 4.8L19.8 11.2H21.9C22.4 11.2 22.6 10.5 22.2 10.2L12 2Z" fill={`url(#${roofTop})`} />
            <path d="M12 3.5L21.5 11H19.8L12 4.8V3.5Z" fill={`url(#${roofShadow})`} />
            <path d="M9.5 21V15.5C9.5 14.1 10.6 13 12 13C13.4 13 14.5 14.1 14.5 15.5V21H9.5Z" fill={`url(#${door})`} />
            <rect x="8.5" y="20.5" width="7" height="1.2" rx="0.6" fill="#6366f1" />
          </svg>
        </span>
      );
    }

    case "key": {
      const goldHead = `keyGoldHead_${rawId}`;
      const goldShaft = `keyGoldShaft_${rawId}`;
      const goldDepth = `keyGoldDepth_${rawId}`;
      return (
        <span className={`nav-icon-3d ${className}`} style={style} aria-hidden="true">
          <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id={goldHead} x1="3" y1="3" x2="13" y2="13" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#fef08a" />
                <stop offset="40%" stopColor="#facc15" />
                <stop offset="100%" stopColor="#ca8a04" />
              </linearGradient>
              <linearGradient id={goldShaft} x1="9" y1="9" x2="22" y2="22" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#fde047" />
                <stop offset="50%" stopColor="#eab308" />
                <stop offset="100%" stopColor="#a16207" />
              </linearGradient>
              <linearGradient id={goldDepth} x1="10" y1="12" x2="22" y2="24" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#854d0e" />
                <stop offset="100%" stopColor="#713f12" />
              </linearGradient>
            </defs>
            <circle cx="8" cy="9" r="6.2" fill={`url(#${goldDepth})`} transform="translate(1, 1)" />
            <path d="M12.5 10.5L20.5 18.5V21.5H17.5V19.5H15.5V17.5L14 16L12.5 14.5" stroke={`url(#${goldDepth})`} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="8" cy="8" r="6" fill={`url(#${goldHead})`} />
            <circle cx="8" cy="8" r="2.8" fill="#1e293b" />
            <circle cx="8" cy="8" r="2.8" stroke="#fef08a" strokeWidth="0.8" opacity="0.6" />
            <path d="M12 9.5L19.5 17V20H17V18H15V16L13.5 14.5L12 13" stroke={`url(#${goldShaft})`} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M4.5 5.5C5.5 4.5 7 4 8.5 4.2" stroke="#ffffff" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </span>
      );
    }

    case "repos": {
      const folderBack = `folderBack_${rawId}`;
      const folderFront = `folderFront_${rawId}`;
      const folderPaper = `folderPaper_${rawId}`;
      return (
        <span className={`nav-icon-3d ${className}`} style={style} aria-hidden="true">
          <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id={folderBack} x1="2" y1="4" x2="22" y2="18" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#0284c7" />
                <stop offset="100%" stopColor="#0369a1" />
              </linearGradient>
              <linearGradient id={folderFront} x1="2" y1="10" x2="22" y2="22" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#38bdf8" />
                <stop offset="100%" stopColor="#0ea5e9" />
              </linearGradient>
              <linearGradient id={folderPaper} x1="6" y1="6" x2="18" y2="14" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#ffffff" />
                <stop offset="100%" stopColor="#e2e8f0" />
              </linearGradient>
            </defs>
            <path d="M2 5.5C2 4.4 2.9 3.5 4 3.5H9.2C9.8 3.5 10.4 3.8 10.8 4.2L12.5 6H20C21.1 6 22 6.9 22 8V16C22 17.1 21.1 18 20 18H4C2.9 18 2 17.1 2 16V5.5Z" fill={`url(#${folderBack})`} />
            <rect x="5" y="6" width="14" height="8" rx="1.5" fill={`url(#${folderPaper})`} transform="rotate(-3 12 10)" />
            <path d="M1.5 10C1.5 9 2.3 8.2 3.3 8.2H20.7C21.7 8.2 22.5 9 22.5 10L21.2 19.5C21.1 20.3 20.4 21 19.5 21H4.5C3.6 21 2.9 20.3 2.8 19.5L1.5 10Z" fill={`url(#${folderFront})`} />
            <path d="M2.5 9.2H21.5" stroke="#bae6fd" strokeWidth="0.9" strokeLinecap="round" />
            <circle cx="10" cy="15" r="1.5" fill="#ffffff" />
            <circle cx="15" cy="13.5" r="1.2" fill="#ffffff" />
            <path d="M10 15L13 13.5H15" stroke="#ffffff" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </span>
      );
    }

    case "config": {
      const gearFace = `gearFace_${rawId}`;
      const gearDepth = `gearDepth_${rawId}`;
      return (
        <span className={`nav-icon-3d ${className}`} style={style} aria-hidden="true">
          <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id={gearFace} x1="4" y1="4" x2="20" y2="20" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#cbd5e1" />
                <stop offset="50%" stopColor="#94a3b8" />
                <stop offset="100%" stopColor="#64748b" />
              </linearGradient>
              <linearGradient id={gearDepth} x1="4" y1="8" x2="20" y2="24" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#475569" />
                <stop offset="100%" stopColor="#1e293b" />
              </linearGradient>
            </defs>
            <path d="M13.5 2.5H10.5L9.8 4.7C9.2 4.9 8.7 5.2 8.2 5.6L6.1 4.7L4 6.8L4.9 8.9C4.5 9.4 4.2 9.9 4 10.5L1.8 11.2V14.2L4 14.9C4.2 15.5 4.5 16 4.9 16.5L4 18.6L6.1 20.7L8.2 19.8C8.7 20.2 9.2 20.5 9.8 20.7L10.5 22.9H13.5L14.2 20.7C14.8 20.5 15.3 20.2 15.8 19.8L17.9 20.7L20 18.6L19.1 16.5C19.5 16 19.8 15.5 20 14.9L22.2 14.2V11.2L20 10.5C19.8 9.9 19.5 9.4 19.1 8.9L20 6.8L17.9 4.7L15.8 5.6C15.3 5.2 14.8 4.9 14.2 4.7L13.5 2.5Z" fill={`url(#${gearDepth})`} transform="translate(0, 1.5)" />
            <path d="M13.5 2H10.5L9.8 4.2C9.2 4.4 8.7 4.7 8.2 5.1L6.1 4.2L4 6.3L4.9 8.4C4.5 8.9 4.2 9.4 4 10L1.8 10.7V13.7L4 14.4C4.2 15 4.5 15.5 4.9 16L4 18.1L6.1 20.2L8.2 19.3C8.7 19.7 9.2 20 9.8 20.2L10.5 22.4H13.5L14.2 20.2C14.8 20 15.3 19.7 15.8 19.3L17.9 20.2L20 18.1L19.1 16C19.5 15.5 19.8 15 20 14.4L22.2 13.7V10.7L20 10C19.8 9.4 19.5 8.9 19.1 8.4L20 6.3L17.9 4.2L15.8 5.1C15.3 4.7 14.8 4.4 14.2 4.2L13.5 2Z" fill={`url(#${gearFace})`} />
            <circle cx="12" cy="12.2" r="4.2" fill="#0f172a" />
            <circle cx="12" cy="12.2" r="4.2" stroke="#f1f5f9" strokeWidth="0.8" opacity="0.7" />
            <circle cx="12" cy="12.2" r="2.2" fill="#38bdf8" />
          </svg>
        </span>
      );
    }

    case "agent": {
      const botHead = `botHead_${rawId}`;
      const botVisor = `botVisor_${rawId}`;
      return (
        <span className={`nav-icon-3d ${className}`} style={style} aria-hidden="true">
          <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id={botHead} x1="3" y1="5" x2="21" y2="21" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#38bdf8" />
                <stop offset="50%" stopColor="#0284c7" />
                <stop offset="100%" stopColor="#1e3a8a" />
              </linearGradient>
              <linearGradient id={botVisor} x1="6" y1="10" x2="18" y2="15" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#0f172a" />
                <stop offset="100%" stopColor="#1e1b4b" />
              </linearGradient>
            </defs>
            <line x1="12" y1="5" x2="12" y2="2" stroke="#38bdf8" strokeWidth="2" strokeLinecap="round" />
            <circle cx="12" cy="2" r="1.8" fill="#a7f3d0" stroke="#059669" strokeWidth="0.8" />
            <rect x="2" y="10" width="2" height="6" rx="1" fill="#0284c7" />
            <rect x="20" y="10" width="2" height="6" rx="1" fill="#0284c7" />
            <rect x="4" y="6" width="16" height="15" rx="5" fill="#0f172a" transform="translate(0, 1.2)" />
            <rect x="4" y="5" width="16" height="15" rx="5" fill={`url(#${botHead})`} />
            <path d="M7 6.5C8.5 6 15.5 6 17 6.5" stroke="#bae6fd" strokeWidth="1.2" strokeLinecap="round" />
            <rect x="6.5" y="9.5" width="11" height="5.5" rx="2.5" fill={`url(#${botVisor})`} />
            <circle cx="9.5" cy="12.2" r="1.3" fill="#34d399" />
            <circle cx="14.5" cy="12.2" r="1.3" fill="#34d399" />
            <rect x="9.5" y="17" width="5" height="1.2" rx="0.6" fill="#bae6fd" opacity="0.8" />
          </svg>
        </span>
      );
    }

    case "totp": {
      const timerRing = `timerRing_${rawId}`;
      const timerFace = `timerFace_${rawId}`;
      return (
        <span className={`nav-icon-3d ${className}`} style={style} aria-hidden="true">
          <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id={timerRing} x1="2" y1="4" x2="22" y2="22" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#34d399" />
                <stop offset="40%" stopColor="#10b981" />
                <stop offset="100%" stopColor="#047857" />
              </linearGradient>
              <linearGradient id={timerFace} x1="5" y1="7" x2="19" y2="21" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#ecfdf5" />
                <stop offset="100%" stopColor="#d1fae5" />
              </linearGradient>
            </defs>
            <rect x="10.5" y="1" width="3" height="3" rx="1" fill="#10b981" />
            <circle cx="12" cy="13.5" r="8.5" fill="#064e3b" />
            <circle cx="12" cy="13" r="8.5" fill={`url(#${timerRing})`} />
            <circle cx="12" cy="13" r="6.2" fill={`url(#${timerFace})`} />
            <circle cx="12" cy="8.2" r="0.7" fill="#047857" />
            <circle cx="16.8" cy="13" r="0.7" fill="#047857" />
            <circle cx="12" cy="17.8" r="0.7" fill="#047857" />
            <circle cx="7.2" cy="13" r="0.7" fill="#047857" />
            <path d="M12 13L15 9.5" stroke="#ef4444" strokeWidth="1.6" strokeLinecap="round" />
            <circle cx="12" cy="13" r="1.4" fill="#1e293b" />
            <path d="M8 9.5C9.2 8 13.5 7.5 15.5 8.5" stroke="#ffffff" strokeWidth="1" strokeLinecap="round" />
          </svg>
        </span>
      );
    }

    case "accounts": {
      const userGrad = `userGrad_${rawId}`;
      const headHighlight = `headHighlight_${rawId}`;
      return (
        <span className={`nav-icon-3d ${className}`} style={style} aria-hidden="true">
          <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id={userGrad} x1="4" y1="2" x2="20" y2="22" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#c084fc" />
                <stop offset="50%" stopColor="#a855f7" />
                <stop offset="100%" stopColor="#7e22ce" />
              </linearGradient>
              <linearGradient id={headHighlight} x1="10" y1="3" x2="14" y2="9" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#f3e8ff" />
                <stop offset="100%" stopColor="#c084fc" />
              </linearGradient>
            </defs>
            <path d="M4 20C4 16.5 7.5 14.5 12 14.5C16.5 14.5 20 16.5 20 20V21.5H4V20Z" fill="#581c87" transform="translate(0, 1)" />
            <path d="M4 19.5C4 16 7.5 14 12 14C16.5 14 20 16 20 19.5V21H4V19.5Z" fill={`url(#${userGrad})`} />
            <path d="M5.5 19C7 16 10 14.8 12 14.8C14 14.8 17 16 18.5 19" stroke="#e9d5ff" strokeWidth="0.9" strokeLinecap="round" />
            <circle cx="12" cy="8.5" r="4.5" fill="#581c87" transform="translate(0, 0.8)" />
            <circle cx="12" cy="8" r="4.5" fill={`url(#${userGrad})`} />
            <circle cx="10.5" cy="6.2" r="1.5" fill={`url(#${headHighlight})`} />
          </svg>
        </span>
      );
    }

    case "notes": {
      const noteCover = `noteCover_${rawId}`;
      const pencilGrad = `pencilGrad_${rawId}`;
      return (
        <span className={`nav-icon-3d ${className}`} style={style} aria-hidden="true">
          <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id={noteCover} x1="3" y1="2" x2="20" y2="22" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#fbbf24" />
                <stop offset="60%" stopColor="#f59e0b" />
                <stop offset="100%" stopColor="#d97706" />
              </linearGradient>
              <linearGradient id={pencilGrad} x1="15" y1="11" x2="23" y2="3" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#38bdf8" />
                <stop offset="100%" stopColor="#0284c7" />
              </linearGradient>
            </defs>
            <rect x="4" y="3" width="14" height="18" rx="2.5" fill="#92400e" transform="translate(0, 1.2)" />
            <rect x="4" y="2.5" width="14" height="18" rx="2.5" fill={`url(#${noteCover})`} />
            <path d="M4 5C4 3.6 4.6 2.5 6 2.5V20.5C4.6 20.5 4 19.4 4 18V5Z" fill="#b45309" />
            <rect x="8" y="7" width="7" height="1.5" rx="0.75" fill="#fef3c7" />
            <rect x="8" y="10.5" width="6" height="1.5" rx="0.75" fill="#fef3c7" />
            <rect x="8" y="14" width="4.5" height="1.5" rx="0.75" fill="#fef3c7" />
            <path d="M19.5 2.5L21.5 4.5L14 12L12 12.5L12.5 10.5L19.5 2.5Z" fill={`url(#${pencilGrad})`} stroke="#0369a1" strokeWidth="0.6" />
            <polygon points="12,12.5 13.2,12.2 12.2,11.2" fill="#fde047" />
            <polygon points="12,12.5 12.4,12.4 12.3,12.1" fill="#0f172a" />
          </svg>
        </span>
      );
    }

    case "files": {
      const vaultBody = `vaultBody_${rawId}`;
      const drawerFront = `drawerFront_${rawId}`;
      return (
        <span className={`nav-icon-3d ${className}`} style={style} aria-hidden="true">
          <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id={vaultBody} x1="3" y1="2" x2="21" y2="22" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#475569" />
                <stop offset="50%" stopColor="#334155" />
                <stop offset="100%" stopColor="#1e293b" />
              </linearGradient>
              <linearGradient id={drawerFront} x1="5" y1="4" x2="19" y2="12" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#64748b" />
                <stop offset="100%" stopColor="#475569" />
              </linearGradient>
            </defs>
            <rect x="4.5" y="21" width="3" height="1.5" rx="0.5" fill="#0f172a" />
            <rect x="16.5" y="21" width="3" height="1.5" rx="0.5" fill="#0f172a" />
            <rect x="3.5" y="2" width="17" height="19" rx="3" fill={`url(#${vaultBody})`} />
            <rect x="4.5" y="3" width="15" height="17" rx="2" stroke="#94a3b8" strokeWidth="0.8" opacity="0.4" />
            <rect x="5.5" y="4" width="13" height="6.5" rx="1.5" fill={`url(#${drawerFront})`} />
            <rect x="9.5" y="6.8" width="5" height="1.4" rx="0.7" fill="#cbd5e1" />
            <rect x="5.5" y="12" width="13" height="6.5" rx="1.5" fill={`url(#${drawerFront})`} />
            <rect x="9.5" y="14.8" width="5" height="1.4" rx="0.7" fill="#cbd5e1" />
            <circle cx="15.8" cy="15.5" r="0.9" fill="#38bdf8" />
          </svg>
        </span>
      );
    }

    case "sync": {
      const cloudGrad = `cloudGrad_${rawId}`;
      const cloudShadow = `cloudShadow_${rawId}`;
      return (
        <span className={`nav-icon-3d ${className}`} style={style} aria-hidden="true">
          <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id={cloudGrad} x1="3" y1="5" x2="21" y2="19" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#7dd3fc" />
                <stop offset="40%" stopColor="#38bdf8" />
                <stop offset="100%" stopColor="#0284c7" />
              </linearGradient>
              <linearGradient id={cloudShadow} x1="12" y1="12" x2="20" y2="21" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#0369a1" />
                <stop offset="100%" stopColor="#075985" />
              </linearGradient>
            </defs>
            <path d="M7 18C4.5 18 2.5 16 2.5 13.5C2.5 11.2 4.1 9.3 6.3 9C7.1 6.3 9.6 4.3 12.5 4.3C15.9 4.3 18.7 6.8 19.1 10.1C20.8 10.5 22 12.1 22 14C22 16.2 20.2 18 18 18H7Z" fill={`url(#${cloudShadow})`} transform="translate(0, 1.5)" />
            <path d="M7 17.5C4.5 17.5 2.5 15.5 2.5 13C2.5 10.7 4.1 8.8 6.3 8.5C7.1 5.8 9.6 3.8 12.5 3.8C15.9 3.8 18.7 6.3 19.1 9.6C20.8 10 22 11.6 22 13.5C22 15.7 20.2 17.5 18 17.5H7Z" fill={`url(#${cloudGrad})`} />
            <path d="M9.5 5.5C10.5 4.8 13.5 4.8 15 5.5" stroke="#ffffff" strokeWidth="1.3" strokeLinecap="round" />
            <path d="M10 11C10.5 9.8 12.2 9.2 13.5 9.8L12.5 10.5" stroke="#ffffff" strokeWidth="1.3" strokeLinecap="round" />
            <path d="M14 14C13.5 15.2 11.8 15.8 10.5 15.2L11.5 14.5" stroke="#ffffff" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </span>
      );
    }

    case "settings": {
      const wrenchGrad = `wrenchGrad_${rawId}`;
      const toolHandle = `toolHandle_${rawId}`;
      return (
        <span className={`nav-icon-3d ${className}`} style={style} aria-hidden="true">
          <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id={wrenchGrad} x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#cbd5e1" />
                <stop offset="50%" stopColor="#94a3b8" />
                <stop offset="100%" stopColor="#475569" />
              </linearGradient>
              <linearGradient id={toolHandle} x1="12" y1="12" x2="21" y2="21" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#f97316" />
                <stop offset="100%" stopColor="#c2410c" />
              </linearGradient>
            </defs>
            <path d="M14.5 4L16.5 2L19.5 5L17.5 7L21 16L18 19L9 15.5L7 17.5L4 14.5L6 12.5L2.5 3.5L5.5 0.5L14.5 4Z" fill="#1e293b" opacity="0.3" transform="translate(1, 1)" />
            <path d="M5.5 3.5C4 4.5 3 6.5 3.5 8.5C3.8 9.7 4.6 10.8 5.7 11.5L15 20.8C15.6 21.4 16.5 21.4 17.1 20.8L19.8 18.1C20.4 17.5 20.4 16.6 19.8 16L10.5 6.7C10.2 5.5 9.2 4.2 7.8 3.6C6.5 3 5 3.5 5.5 3.5Z" fill={`url(#${wrenchGrad})`} />
            <line x1="4.5" y1="19.5" x2="12" y2="12" stroke="#e2e8f0" strokeWidth="2.2" strokeLinecap="round" />
            <rect x="2.5" y="16.5" width="7" height="3" rx="1.5" fill={`url(#${toolHandle})`} transform="rotate(-45 6 18)" />
          </svg>
        </span>
      );
    }

    case "lock": {
      const lockShackle = `lockShackle_${rawId}`;
      const lockBody = `lockBody_${rawId}`;
      return (
        <span className={`nav-icon-3d ${className}`} style={style} aria-hidden="true">
          <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id={lockShackle} x1="6" y1="2" x2="18" y2="11" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#ffffff" />
                <stop offset="40%" stopColor="#cbd5e1" />
                <stop offset="100%" stopColor="#64748b" />
              </linearGradient>
              <linearGradient id={lockBody} x1="4" y1="9" x2="20" y2="22" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#f87171" />
                <stop offset="40%" stopColor="#ef4444" />
                <stop offset="100%" stopColor="#b91c1c" />
              </linearGradient>
            </defs>
            <path d="M7 10V6.5C7 3.7 9.2 1.5 12 1.5C14.8 1.5 17 3.7 17 6.5V10" stroke={`url(#${lockShackle})`} strokeWidth="2.8" strokeLinecap="round" />
            <rect x="4.5" y="9.5" width="15" height="12" rx="3.5" fill="#7f1d1d" transform="translate(0, 1.2)" />
            <rect x="4.5" y="9" width="15" height="12" rx="3.5" fill={`url(#${lockBody})`} />
            <path d="M7 10.5H17" stroke="#fecaca" strokeWidth="0.9" strokeLinecap="round" />
            <circle cx="12" cy="14" r="1.3" fill="#450a0a" />
            <polygon points="11.4,14 12.6,14 12.3,17.2 11.7,17.2" fill="#450a0a" />
          </svg>
        </span>
      );
    }
  }
}
