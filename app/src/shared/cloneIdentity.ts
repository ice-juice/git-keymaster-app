import type { Candidate, Identity, Inference } from "../lib/ipc";

/** 把仓库路径改写成某个身份的 SSH 别名地址。 */
export function aliasCloneUrl(hostAlias: string, repoPath: string): string {
  return `git@${hostAlias}:${repoPath}.git`;
}

/**
 * 认不出归属时，优先列出和地址主机相同的身份。
 * 一个都对不上（自建主机、或地址本身已是未知别名）时退回全部身份。
 */
export function identitiesForManualAlias(
  inf: Pick<Inference, "host" | "isAlias">,
  identities: Identity[],
): Identity[] {
  const host = inf.host?.trim().toLowerCase();
  if (!host) return identities;
  const matched = identities.filter((id) =>
    inf.isAlias ? id.hostAlias.toLowerCase() === host : id.realHost.toLowerCase() === host,
  );
  return matched.length > 0 ? matched : identities;
}

export function manualCandidates(identities: Identity[], basis: string): Candidate[] {
  return identities.map((id) => ({
    identityId: id.id,
    identityName: id.name,
    hostAlias: id.hostAlias,
    confidence: "low",
    basis,
  }));
}

/** 推断有候选就用候选；否则让用户从同主机身份里亲手选别名。 */
export function selectableIdentities(inf: Inference, identities: Identity[], manualBasis: string): Candidate[] {
  if (inf.candidates.length > 0) return inf.candidates;
  if (inf.recommended) return [inf.recommended];
  return manualCandidates(identitiesForManualAlias(inf, identities), manualBasis);
}

/**
 * 已选中的优先。没有推荐且不止一个选项时不替用户默认，避免克隆到错误别名。
 * 只有一个选项时直接用它。
 */
export function resolveActiveIdentity(
  options: Candidate[],
  pickedId: string,
  recommended: Candidate | null,
): Candidate | null {
  return (
    options.find((c) => c.identityId === pickedId) ??
    recommended ??
    (options.length === 1 ? options[0] : null)
  );
}

export function previewCloneUrl(inf: Inference, active: Candidate | null): string | null {
  if (!active) return inf.rewrittenUrl;
  if (inf.recommended?.identityId === active.identityId && inf.rewrittenUrl) return inf.rewrittenUrl;
  if (inf.repoPath) return aliasCloneUrl(active.hostAlias, inf.repoPath);
  return inf.rewrittenUrl;
}

export function showIdentityPicker(inf: Inference, options: Candidate[]): boolean {
  return options.length > 1 || (!inf.recommended && options.length > 0);
}
