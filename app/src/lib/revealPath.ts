import { api } from "./ipc";
import { isMobilePlatform } from "../platform/resolve";

/**
 * 保存对话框返回、并且系统文件管理器能定位的本机文件路径。
 * 移动端分享 / 下载、content URI 没有这种目录，不要引导去打开。
 */
export function canRevealSavedPath(path: string | null | undefined): path is string {
  const raw = typeof path === "string" ? path.trim() : "";
  if (!raw) return false;
  if (/^(content|blob|https?):/i.test(raw)) return false;
  if (isMobilePlatform()) return false;
  return true;
}

/** 打开该文件所在目录。Windows 由后端 `explorer /select` 选中文件。 */
export function revealSavedPath(path: string): Promise<void> {
  return api.revealPath(path.trim());
}
