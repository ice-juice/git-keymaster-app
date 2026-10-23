/** 密钥用途分组与检索。分组从身份现算，不写进钥匙的互斥类型。 */

export interface KeyUseIdentity {
  keyId: string | null;
  platform: string;
  user: string;
  realHost: string;
  hostAlias?: string;
}

export interface KeyUseClassification {
  git: boolean;
  server: boolean;
  unattached: boolean;
  /** 命中 Git 托管的平台 id，小写，按出现顺序去重。 */
  platforms: string[];
}

export type KeyGroupFilter = "all" | "git" | "server" | "unattached";
export type KeyAlgoFilter = "all" | "rsa" | "ed25519";

export interface KeyUseCopy {
  git: string;
  server: string;
  unattached: string;
  exportOnly: string;
}

export interface KeyUseDescription {
  groupBadges: string[];
  platformBadges: string[];
  /** 未挂接且用户选过意向时才有，例如「未挂接 · 服务器登录」。 */
  subtitle: string;
  searchLabels: string[];
}

export interface KeySearchFields {
  name: string;
  fingerprint: string;
  algorithm: string;
  comment: string;
  labels: string[];
}

const GIT_PLATFORMS = new Set(["github", "gitlab", "gitee", "gitea"]);
const CODE_HOSTS = ["github.com", "gitlab.com", "gitee.com", "gitea.com"];

export function platformLabel(platform: string): string {
  switch (platform.trim().toLowerCase()) {
    case "github":
      return "GitHub";
    case "gitlab":
      return "GitLab";
    case "gitee":
      return "Gitee";
    case "gitea":
      return "Gitea";
    default:
      return platform.trim();
  }
}

export function isCodeHost(host: string): boolean {
  const value = host.trim().toLowerCase().replace(/\.$/, "");
  if (!value) return false;
  return CODE_HOSTS.some((suffix) => value === suffix || value.endsWith(`.${suffix}`));
}

function identityHost(id: KeyUseIdentity): string {
  const real = id.realHost.trim();
  if (real) return real;
  return (id.hostAlias ?? "").trim();
}

export function isGitHostingPlatform(platform: string): boolean {
  return GIT_PLATFORMS.has(platform.trim().toLowerCase());
}

export function isGitHostingIdentity(id: Pick<KeyUseIdentity, "platform">): boolean {
  return isGitHostingPlatform(id.platform);
}

/** 任一条 Git 托管身份的 keyId 指向该钥匙时，不允许删除。 */
export function gitHostingBlocksKeyDelete(
  keyId: string,
  identities: ReadonlyArray<Pick<KeyUseIdentity, "keyId" | "platform">>,
): boolean {
  return identities.some((id) => id.keyId === keyId && isGitHostingPlatform(id.platform));
}

/** 删除后会卸下这把钥匙的非 Git 托管身份名称。Git 托管身份不在此列。 */
export function identityNamesLosingKey(
  keyId: string,
  identities: ReadonlyArray<{ keyId: string | null; platform: string; name: string }>,
): string[] {
  const names: string[] = [];
  for (const id of identities) {
    if (id.keyId !== keyId || isGitHostingPlatform(id.platform)) continue;
    const name = id.name.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** 登录机器：platform 为 other，或 SSH 用户不是 git 且主机不是代码托管站。 */
export function isServerLoginIdentity(id: KeyUseIdentity): boolean {
  if (id.platform.trim().toLowerCase() === "other") return true;
  const user = id.user.trim().toLowerCase();
  return user !== "git" && !isCodeHost(identityHost(id));
}

export function classifyKeyUse(keyId: string, identities: KeyUseIdentity[]): KeyUseClassification {
  const attached = identities.filter((id) => id.keyId === keyId);
  if (attached.length === 0) {
    return { git: false, server: false, unattached: true, platforms: [] };
  }
  const platforms: string[] = [];
  for (const id of attached) {
    if (!isGitHostingIdentity(id)) continue;
    const platform = id.platform.trim().toLowerCase();
    if (!platforms.includes(platform)) platforms.push(platform);
  }
  return {
    git: platforms.length > 0,
    server: attached.some(isServerLoginIdentity),
    unattached: false,
    platforms,
  };
}

export function describeKeyUse(
  classification: KeyUseClassification,
  intent: string,
  copy: KeyUseCopy,
): KeyUseDescription {
  if (classification.unattached) {
    const extra = intentLabel(intent, copy);
    return {
      groupBadges: extra ? [copy.unattached, extra] : [copy.unattached],
      platformBadges: [],
      subtitle: "",
      searchLabels: extra ? [copy.unattached, extra] : [copy.unattached],
    };
  }
  const groupBadges: string[] = [];
  if (classification.git) groupBadges.push(copy.git);
  if (classification.server) groupBadges.push(copy.server);
  const platformBadges = classification.platforms.map(platformLabel);
  return {
    groupBadges,
    platformBadges,
    subtitle: "",
    searchLabels: [...groupBadges, ...platformBadges],
  };
}

export function intentLabel(intent: string, copy: KeyUseCopy): string {
  switch (intent.trim().toLowerCase()) {
    case "git":
      return copy.git;
    case "server":
      return copy.server;
    case "export":
      return copy.exportOnly;
    default:
      return "";
  }
}

export function groupMatches(
  classification: KeyUseClassification,
  filter: KeyGroupFilter,
  intent = "",
): boolean {
  if (filter === "all") return true;
  if (filter === "unattached") return classification.unattached;
  const normalized = intent.trim().toLowerCase();
  if (filter === "git") return classification.git || (classification.unattached && normalized === "git");
  return classification.server || (classification.unattached && normalized === "server");
}

export function algorithmMatches(algorithm: string, filter: KeyAlgoFilter): boolean {
  if (filter === "all") return true;
  return algorithm.trim().toLowerCase() === filter;
}

export function opensshPublicComment(publicOpenssh: string): string {
  const line = publicOpenssh
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith("#"));
  if (!line) return "";
  const first = line.indexOf(" ");
  if (first < 0) return "";
  const second = line.indexOf(" ", first + 1);
  if (second < 0) return "";
  return line.slice(second + 1).trim();
}

export function matchesKeySearch(fields: KeySearchFields, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const hay = [fields.name, fields.fingerprint, fields.algorithm, fields.comment, ...fields.labels]
    .join("\n")
    .toLowerCase();
  return hay.includes(needle);
}

export function keyVisible(opts: {
  classification: KeyUseClassification;
  intent?: string;
  algorithm: string;
  fields: KeySearchFields;
  query: string;
  group: KeyGroupFilter;
  algo: KeyAlgoFilter;
}): boolean {
  return (
    groupMatches(opts.classification, opts.group, opts.intent ?? "") &&
    algorithmMatches(opts.algorithm, opts.algo) &&
    matchesKeySearch(opts.fields, opts.query)
  );
}

export function isRsaPubExportable(algorithm: string, publicOpenssh: string): boolean {
  return algorithm.trim().toLowerCase() === "rsa" && publicOpenssh.trim().length > 0;
}

/** 与 Rust `key_file_stem_for_algo` 对齐：空名称用算法默认干，非字母数字换成 `_`。 */
export function keyFileStemForAlgo(algo: string, name: string): string {
  const prefix = algo.trim().toLowerCase() === "rsa" ? "id_rsa" : "id_ed25519";
  const mapped = Array.from(name)
    .map((ch) => (isUnicodeAlnum(ch) ? ch : "_"))
    .join("")
    .trim();
  const cleaned = trimEdge(trimEdge(mapped, "."), "_").trim();
  if (!cleaned) return prefix;
  if (cleaned.slice(0, prefix.length).toLowerCase() === prefix) return cleaned;
  return `${prefix}_${cleaned}`;
}

function isUnicodeAlnum(ch: string): boolean {
  return /^[\p{L}\p{N}]$/u.test(ch);
}

function trimEdge(value: string, char: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === char) start += 1;
  while (end > start && value[end - 1] === char) end -= 1;
  return value.slice(start, end);
}

/** 密钥管理导出 RSA .pub：只替换文件名非法字符，已以 id_rsa 开头则不再加前缀。 */
export function rsaPubDownloadName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .trim();
  if (!cleaned) return "id_rsa.pub";
  if (cleaned.slice(0, "id_rsa".length).toLowerCase() === "id_rsa") return `${cleaned}.pub`;
  return `id_rsa_${cleaned}.pub`;
}

export function opensshPubFileBody(publicOpenssh: string): string {
  return `${publicOpenssh.replace(/\r\n/g, "\n").replace(/\n+$/g, "")}\n`;
}

export function opensshPubDownloadName(algorithm: string, name: string): string {
  if (algorithm.trim().toLowerCase() === "rsa") return rsaPubDownloadName(name);
  return `${keyFileStemForAlgo(algorithm, name)}.pub`;
}

export function rsaPemDownloadName(name: string): string {
  return rsaPubDownloadName(name).replace(/\.pub$/i, ".pem");
}
