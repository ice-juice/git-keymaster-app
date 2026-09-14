/**
 * 品牌名与标识符的唯一来源。显示名跟语言走；路径 / 文件名 / 主程序保持 ASCII。
 * 改名字只改这里，再跑 `node scripts/check-release-invariants.mjs --test`。
 */
export const ZH_DISPLAY_NAME = "御钥师";
export const EN_DISPLAY_NAME = "Git Keymaster";
export const MAIN_BINARY = "git-keymaster";
export const WIN_INSTALL_DIR = "GitKeymaster";
/// Windows 卸载项 / 安装路径注册表的稳定身份。必须是 ASCII，不能跟「御钥师」/ Git Keymaster 走，
/// 否则中英文安装包会写成两套卸载键，自动更新后开始菜单里并排出两个程序。
export const WIN_UNINSTALL_ID = WIN_INSTALL_DIR;
export const INSTALLER_STEM = "Git.Keymaster";

export function isEnglishLang(lang) {
  const s = String(lang ?? "zh").trim().toLowerCase();
  return s === "en" || s.startsWith("en-") || s === "en-us";
}

export function displayNameFor(lang) {
  return isEnglishLang(lang) ? EN_DISPLAY_NAME : ZH_DISPLAY_NAME;
}
