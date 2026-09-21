// 应用级 UI 偏好（纯本地，无需后端）——与 theme.ts 同风格。

import { clampMaskKeep, DEFAULT_MASK_KEEP } from "../shared/maskAccount";

const UNLOCK_ANIM_KEY = "gam.unlockAnim";
const UNLOCK_ANIM_STYLE_KEY = "gam.unlockAnimStyle";
const NOTES_AUTO_SAVE_KEY = "gam.notesAutoSave";
const MASK_ACCOUNT_KEY = "gam.maskAccountMiddle";
const MASK_ACCOUNT_KEEP_KEY = "gam.maskAccountKeep";
const PREFS_EVENT = "gam-prefs-changed";

function emitPrefsChanged() {
  try {
    window.dispatchEvent(new Event(PREFS_EVENT));
  } catch {
    /* ignore */
  }
}

export function subscribePrefs(onChange: () => void): () => void {
  window.addEventListener(PREFS_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(PREFS_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export type UnlockAnimStyle = "cyber" | "classic" | "minimal";

export const UNLOCK_ANIM_STYLES: { id: UnlockAnimStyle; icon: string }[] = [
  { id: "cyber", icon: "⚡" },
  { id: "classic", icon: "🗝️" },
  { id: "minimal", icon: "💻" },
];

/** 解锁开门动画是否开启，默认开启。 */
export function getUnlockAnimEnabled(): boolean {
  return localStorage.getItem(UNLOCK_ANIM_KEY) !== "off";
}

export function setUnlockAnimEnabledStored(on: boolean): void {
  localStorage.setItem(UNLOCK_ANIM_KEY, on ? "on" : "off");
}

/** 获取解锁动画风格，默认赛博全息。 */
export function getUnlockAnimStyle(): UnlockAnimStyle {
  const s = localStorage.getItem(UNLOCK_ANIM_STYLE_KEY);
  if (s === "classic" || s === "minimal" || s === "cyber") return s;
  return "cyber";
}

export function setUnlockAnimStyleStored(style: UnlockAnimStyle): void {
  localStorage.setItem(UNLOCK_ANIM_STYLE_KEY, style);
}

/** 备忘录离开编辑区时自动保存，默认开启。 */
export function getNotesAutoSave(): boolean {
  return localStorage.getItem(NOTES_AUTO_SAVE_KEY) !== "off";
}

export function setNotesAutoSaveStored(on: boolean): void {
  localStorage.setItem(NOTES_AUTO_SAVE_KEY, on ? "on" : "off");
  emitPrefsChanged();
}

/** 账密列表默认掩码账号中间，默认开启。 */
export function getMaskAccountMiddle(): boolean {
  return localStorage.getItem(MASK_ACCOUNT_KEY) !== "off";
}

export function setMaskAccountMiddleStored(on: boolean): void {
  localStorage.setItem(MASK_ACCOUNT_KEY, on ? "on" : "off");
  emitPrefsChanged();
}

/** 掩码时头尾各保留的字符数，默认 3。 */
export function getMaskAccountKeep(): number {
  const raw = localStorage.getItem(MASK_ACCOUNT_KEEP_KEY);
  if (raw == null || raw === "") return DEFAULT_MASK_KEEP;
  const n = Number(raw);
  return Number.isFinite(n) ? clampMaskKeep(n) : DEFAULT_MASK_KEEP;
}

export function setMaskAccountKeepStored(n: number): void {
  localStorage.setItem(MASK_ACCOUNT_KEEP_KEY, String(clampMaskKeep(n)));
  emitPrefsChanged();
}

/** 系统是否开启了「减少动态效果」。开启时应跳过过场动画。 */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
