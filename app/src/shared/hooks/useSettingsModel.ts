import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  api,
  errMessage,
  type BiometricStatus,
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
};

export function scrollToSettingAnchor(anchor: string) {
  const el = document.getElementById(`setting-${anchor}`);
  el?.scrollIntoView({ behavior: "smooth", block: "center" });
}

export function closeActionLabel(action: "tray" | "quit" | null | undefined): string {
  if (action === "tray") return "自动最小化到托盘";
  if (action === "quit") return "直接退出程序";
  return "弹出二次确认";
}

export function levelBadge(level: SecurityLevel): { kind: string; label: string } {
  if (level === "risk") return { kind: "danger", label: "有风险" };
  if (level === "caution") return { kind: "warn", label: "需留意" };
  return { kind: "good", label: "安全" };
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

  useEffect(() => {
    setGraceDays(String(status?.graceDays ?? 0));
  }, [status?.graceDays]);

  useEffect(() => {
    api.getRevealSettings().then((s) => {
      setRevealGrace(String(s.revealGraceMinutes));
      setClipSec(String(s.clipboardClearSeconds));
      setHistLimit(String(s.accountHistoryLimit));
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
    if (newPw.length < 8) return setErr("新密码至少 8 位");
    if (newPw !== newPw2) return setErr("两次输入的新密码不一致");
    setBusy(true);
    try {
      await api.changePassword(oldPw, newPw);
      setMsg("访问密码已更新");
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

  async function toggleLaunch(enabled: boolean) {
    setErr("");
    setBusy(true);
    try {
      await api.setLaunchAtLogin(enabled);
      setMsg(enabled ? "已打开开机自启动" : "已关闭开机自启动");
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
    if (!Number.isFinite(n) || n < 0 || n > 30) return setErr("免验证天数请填写 0 到 30");
    setBusy(true);
    try {
      await api.setGraceDays(Math.floor(n));
      setMsg(n === 0 ? "已关闭免验证，下次启动需要访问密码" : `已设置 ${Math.floor(n)} 天内开机免验证`);
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
      setMsg("已保存免密查看时效");
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
      setMsg("已保存剪贴板清空时间");
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
      setMsg("已保存历史条数上限");
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
      await api.biometricEnable(password);
      setBioPw("");
      setBio(await api.biometricStatus());
      setMsg("已开启指纹/生物识别解锁");
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
      setMsg("已关闭指纹/生物识别解锁");
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
      setMsg("已恢复为每次关闭都询问");
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
    disableBio,
    toggleBioReveal,
    toggleBioSecret,
    toggleLaunch,
    clearCloseAction,
  };
}

export type SettingsModel = ReturnType<typeof useSettingsModel>;
