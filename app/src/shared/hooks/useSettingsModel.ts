import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  api,
  errMessage,
  type BiometricStatus,
  type ScreenCaptureCapability,
  type SecurityLevel,
  type SecurityFinding,
} from "../../lib/ipc";
import { useApp } from "../../store";

export type SettingsTab = "general" | "security" | "workspace" | "about" | "danger";

export const SETTING_ANCHOR_TAB: Record<string, SettingsTab> = {
  "workspace-path": "workspace",
  "auto-lock": "workspace",
  "lock-on-sleep": "workspace",
  "reveal-grace": "security",
  "clipboard-clear": "security",
  "allow-screenshots": "security",
};

export function scrollToSettingAnchor(anchor: string) {
  const el = document.getElementById(`setting-${anchor}`);
  el?.scrollIntoView({ behavior: "smooth", block: "center" });
}

export function closeActionLabel(action: "tray" | "quit" | null | undefined, t: (key: string) => string): string {
  if (action === "tray") return t("settings.closeTray");
  if (action === "quit") return t("settings.closeQuit");
  return t("settings.closeAsk");
}

export function levelBadge(level: SecurityLevel, t: (key: string) => string): { kind: string; label: string } {
  if (level === "risk") return { kind: "danger", label: t("security.risk") };
  if (level === "caution") return { kind: "warn", label: t("security.caution") };
  return { kind: "good", label: t("security.safe") };
}

export function findingCallout(severity: SecurityFinding["severity"]): string {
  if (severity === "warn") return "warn";
  if (severity === "info") return "info";
  return "good";
}

export function formatExpiry(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch {
    return iso;
  }
}

export function useSettingsModel() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const {
    status,
    refresh,
    theme,
    setTheme,
    unlockAnimEnabled,
    setUnlockAnimEnabled,
    unlockAnimStyle,
    setUnlockAnimStyle,
    startUnlockAnim,
  } = useApp();

  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [checklistNonce, setChecklistNonce] = useState(0);
  const pendingAnchor = useRef<string | null>(null);

  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [newPw2, setNewPw2] = useState("");
  const [graceDays, setGraceDays] = useState(String(status?.graceDays ?? 0));
  const [revealGrace, setRevealGrace] = useState("5");
  const [clipSec, setClipSec] = useState("20");
  const [histLimit, setHistLimit] = useState("10");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [newRecovery, setNewRecovery] = useState("");
  const [bio, setBio] = useState<BiometricStatus | null>(null);
  const [bioPw, setBioPw] = useState("");
  const [allowScreenshots, setAllowScreenshots] = useState(false);
  const [screenshotCapability, setScreenshotCapability] =
    useState<ScreenCaptureCapability>("exclude");

  useEffect(() => {
    setGraceDays(String(status?.graceDays ?? 0));
  }, [status?.graceDays]);

  useEffect(() => {
    api.getRevealSettings().then((s) => {
      setRevealGrace(String(s.revealGraceMinutes));
      setClipSec(String(s.clipboardClearSeconds));
      setHistLimit(String(s.accountHistoryLimit));
    }).catch(() => {});
    api.getScreenCaptureSettings().then((s) => {
      setAllowScreenshots(!!s.allowScreenshots);
      setScreenshotCapability(s.capability);
    }).catch(() => {});
    api.biometricStatus().then(setBio).catch(() => setBio(null));
  }, []);

  useEffect(() => {
    const anchor = pendingAnchor.current;
    if (!anchor) return;
    pendingAnchor.current = null;
    const id = window.setTimeout(() => scrollToSettingAnchor(anchor), 0);
    return () => window.clearTimeout(id);
  }, [activeTab]);

  function jumpToSetting(anchor: string) {
    const tab = SETTING_ANCHOR_TAB[anchor] ?? "security";
    pendingAnchor.current = anchor;
    if (tab !== activeTab) {
      setActiveTab(tab);
    } else {
      scrollToSettingAnchor(anchor);
      pendingAnchor.current = null;
    }
  }

  async function changePassword() {
    setErr("");
    setMsg("");
    if (newPw.length < 8) return setErr(t("settings.pwMin"));
    if (newPw !== newPw2) return setErr(t("settings.pwMismatch"));
    setBusy(true);
    try {
      await api.changePassword(oldPw, newPw);
      setMsg(t("settings.pwUpdated"));
      setOldPw("");
      setNewPw("");
      setNewPw2("");
      await refresh();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function rotate() {
    setErr("");
    setMsg("");
    setBusy(true);
    try {
      const r = await api.rotateRecoveryKey();
      setNewRecovery(r.recoveryKey);
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleMobileBackgroundRun(enabled: boolean) {
    setErr("");
    setBusy(true);
    try {
      await api.setMobileBackgroundRun(enabled);
      setMsg(enabled ? t("settings.backgroundRunOn") : t("settings.backgroundRunOff"));
      await refresh();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleLaunch(enabled: boolean) {
    setErr("");
    setBusy(true);
    try {
      await api.setLaunchAtLogin(enabled);
      setMsg(enabled ? t("settings.launchOn") : t("settings.launchOff"));
      await refresh();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveGrace() {
    setErr("");
    const n = Number(graceDays);
    if (!Number.isFinite(n) || n < 0 || n > 30) return setErr(t("settings.graceRange"));
    setBusy(true);
    try {
      await api.setGraceDays(Math.floor(n));
      setMsg(n === 0 ? t("settings.graceOff") : t("settings.graceOn", { days: Math.floor(n) }));
      await refresh();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveRevealGrace(val?: string) {
    const target = val ?? revealGrace;
    setBusy(true);
    try {
      await api.setRevealGraceMinutes(Number(target));
      setMsg(t("settings.revealSaved"));
      setChecklistNonce((n) => n + 1);
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveClipSec(val?: string) {
    const target = val ?? clipSec;
    setBusy(true);
    try {
      await api.setClipboardClearSeconds(Number(target));
      setMsg(t("settings.clipSaved"));
      setChecklistNonce((n) => n + 1);
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveHistLimit(val?: string) {
    const target = val ?? histLimit;
    setBusy(true);
    try {
      await api.setAccountHistoryLimit(Number(target));
      setMsg(t("settings.histSaved"));
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function enableBio(password: string) {
    setBusy(true);
    setErr("");
    try {
      await api.setBiometricMethod("fingerprint");
      await api.biometricEnable(password);
      setBioPw("");
      setBio(await api.biometricStatus());
      setMsg(t("settings.bioOn"));
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function setBioMethod(method: string) {
    setBusy(true);
    setErr("");
    try {
      if (method === "password") {
        if (bio?.enabled) await api.biometricDisable();
        await api.setBiometricMethod("password");
        setBio(await api.biometricStatus());
        setMsg(t("settings.bioPassword"));
        return;
      }
      await api.setBiometricMethod("fingerprint");
      setBio(await api.biometricStatus());
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function disableBio() {
    setBusy(true);
    setErr("");
    try {
      await api.biometricDisable();
      setBio(await api.biometricStatus());
      await api.setBiometricMethod("password");
      setMsg(t("settings.bioOff"));
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleBioReveal(enabled: boolean) {
    setBusy(true);
    try {
      await api.setBiometricRevealEnabled(enabled);
      setBio(await api.biometricStatus());
    } catch (err) {
      setErr(errMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleAllowScreenshots(enabled: boolean) {
    setBusy(true);
    setErr("");
    try {
      const s = await api.setAllowScreenshots(enabled);
      setAllowScreenshots(!!s.allowScreenshots);
      setScreenshotCapability(s.capability);
      setMsg(enabled ? t("settings.screenshotOn") : t("settings.screenshotOff"));
      setChecklistNonce((n) => n + 1);
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleBioSecret(enabled: boolean) {
    setBusy(true);
    try {
      await api.setBiometricRevealSecret(enabled);
      setBio(await api.biometricStatus());
    } catch (err) {
      setErr(errMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function clearCloseAction() {
    setErr("");
    setBusy(true);
    try {
      await api.clearClosePreference();
      setMsg(t("settings.closeReset"));
      await refresh();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return {
    navigate,
    status,
    refresh,
    theme,
    setTheme,
    unlockAnimEnabled,
    setUnlockAnimEnabled,
    unlockAnimStyle,
    setUnlockAnimStyle,
    startUnlockAnim,
    activeTab,
    setActiveTab,
    checklistNonce,
    setChecklistNonce,
    jumpToSetting,
    oldPw,
    setOldPw,
    newPw,
    setNewPw,
    newPw2,
    setNewPw2,
    changePassword,
    graceDays,
    setGraceDays,
    saveGrace,
    revealGrace,
    setRevealGrace,
    saveRevealGrace,
    clipSec,
    setClipSec,
    saveClipSec,
    histLimit,
    setHistLimit,
    saveHistLimit,
    err,
    setErr,
    msg,
    setMsg,
    busy,
    newRecovery,
    setNewRecovery,
    rotate,
    bio,
    setBio,
    bioPw,
    setBioPw,
    enableBio,
    setBioMethod,
    disableBio,
    toggleBioReveal,
    toggleBioSecret,
    allowScreenshots,
    screenshotCapability,
    toggleAllowScreenshots,
    toggleLaunch,
    toggleMobileBackgroundRun,
    clearCloseAction,
  };
}

export type SettingsModel = ReturnType<typeof useSettingsModel>;
