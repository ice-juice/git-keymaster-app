import { create } from "zustand";
import { api, type VaultStatus } from "./lib/ipc";
import { type ThemeMode, getSavedTheme, applyTheme } from "./lib/theme";
import {
  getUnlockAnimEnabled,
  setUnlockAnimEnabledStored,
  getUnlockAnimStyle,
  setUnlockAnimStyleStored,
  type UnlockAnimStyle,
} from "./lib/prefs";
import { forgetAgentStatus } from "./lib/agentCache";
import { clearAllDrafts } from "./shared/noteDrafts";

interface AppStore {
  status: VaultStatus | null;
  loading: boolean;
  statusError: boolean;
  theme: ThemeMode;
  writesLocked: boolean;
  startupNote: string;
  dataVersion: number;
  unlockAnimEnabled: boolean;
  unlockAnimStyle: UnlockAnimStyle;
  playUnlockAnim: boolean;
  animPreviewStyle?: UnlockAnimStyle;
  animPlayId: number;
  setTheme: (t: ThemeMode) => void;
  toggleTheme: () => void;
  setWritesLock: (locked: boolean, note?: string | null) => void;
  bumpData: () => void;
  setUnlockAnimEnabled: (on: boolean) => void;
  setUnlockAnimStyle: (style: UnlockAnimStyle) => void;
  startUnlockAnim: (style?: UnlockAnimStyle) => void;
  endUnlockAnim: () => void;
  refresh: () => Promise<void>;
  lock: () => Promise<void>;
}

const initialTheme = getSavedTheme();
applyTheme(initialTheme);

export const useApp = create<AppStore>((set, get) => ({
  status: null,
  loading: true,
  statusError: false,
  theme: initialTheme,
  writesLocked: false,
  startupNote: "",
  dataVersion: 0,
  unlockAnimEnabled: getUnlockAnimEnabled(),
  unlockAnimStyle: getUnlockAnimStyle(),
  playUnlockAnim: false,
  animPreviewStyle: undefined,
  animPlayId: 0,
  setWritesLock: (locked, note) => {
    set({ writesLocked: locked, startupNote: note ?? "" });
  },
  bumpData: () => set((s) => ({ dataVersion: s.dataVersion + 1 })),
  setUnlockAnimEnabled: (on: boolean) => {
    setUnlockAnimEnabledStored(on);
    set({ unlockAnimEnabled: on });
  },
  setUnlockAnimStyle: (style: UnlockAnimStyle) => {
    setUnlockAnimStyleStored(style);
    set({ unlockAnimStyle: style });
  },
  startUnlockAnim: (style?: UnlockAnimStyle) =>
    set((s) => ({
      playUnlockAnim: true,
      animPreviewStyle: style,
      animPlayId: s.animPlayId + 1,
    })),
  endUnlockAnim: () => set({ playUnlockAnim: false, animPreviewStyle: undefined }),
  setTheme: (t: ThemeMode) => {
    applyTheme(t);
    set({ theme: t });
  },
  toggleTheme: () => {
    const cur = get().theme;
    const next: ThemeMode = cur === "light" ? "dark" : cur === "dark" ? "navy" : "light";
    applyTheme(next);
    set({ theme: next });
  },
  refresh: async () => {
    try {
      const status = await api.vaultStatus();
      set({
        status,
        loading: false,
        statusError: false,
        writesLocked: !!status.writesLocked,
        startupNote: status.startupNote ?? "",
      });
    } catch {
      // 读状态失败不能当成「未初始化」，否则会误进引导页。
      set({ loading: false, statusError: true });
    }
  },
  lock: async () => {
    await api.vaultLock();
    forgetAgentStatus();
    // 内存里的备忘录草稿也要丢，否则重新解锁还能读到上一个人没保存的正文。
    clearAllDrafts();
    const status = await api.vaultStatus();
    set({ status, writesLocked: false, startupNote: "", playUnlockAnim: false });
  },
}));
