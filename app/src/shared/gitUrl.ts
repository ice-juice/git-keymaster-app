/** 只认 Git 仓库地址。不匹配立即丢弃，调用方不得保留原始剪贴板。 */

const GIT_URL_RE =
  /^(?:https?:\/\/|git@|ssh:\/\/(?:git@)?)[^\s]+\/[A-Za-z0-9._~+,-]+(?:\/[A-Za-z0-9._~+/-]+)*?(?:\.git)?\/?$/i;
const HOST_PATH_RE =
  /^(?:github\.com|gitlab\.com|gitee\.com)\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/i;
const GH_CLI_RE = /^gh repo clone [A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/i;
const SCP_ALIAS_RE = /^git@[A-Za-z0-9._-]+:[A-Za-z0-9_./-]+\.git$/i;

export function extractGitRepoUrl(text: string): string | null {
  const first = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!first || first.length > 400) return null;
  if (GH_CLI_RE.test(first) || SCP_ALIAS_RE.test(first) || HOST_PATH_RE.test(first) || GIT_URL_RE.test(first)) {
    return first;
  }
  return null;
}

export function repoLabelFromUrl(url: string): string {
  const cleaned = url.trim().replace(/\.git$/i, "").replace(/[\\/]+$/, "");
  const parts = cleaned.split(/[/:]/).filter(Boolean);
  if (parts.length >= 2) return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  return parts[parts.length - 1] || url;
}
