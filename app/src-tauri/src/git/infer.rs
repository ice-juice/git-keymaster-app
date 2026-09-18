//! 身份推断：按置信度从高到低判断某仓库地址应使用哪个身份（§3.9）。
//!
//! 纯本地查表（归属标识/主机/账号名/历史）；API 与 `git ls-remote` 兜底
//! 在命令层触发，此处只做可离线判定的部分。

use crate::git::owners::{self, MatchKind};
use crate::git::url::ParsedRepo;
use crate::model::Identity;
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Confidence {
    Certain,
    VeryHigh,
    MediumHigh,
    Low,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub identity_id: String,
    pub identity_name: String,
    pub host_alias: String,
    pub confidence: Confidence,
    /// 推断依据（中文，明写出来供用户核对）。
    pub basis: String,
    /// 实测结果分类（有则前端按 i18n 展示，避免一律写「不可达」）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub probe_kind: Option<ProbeKind>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Inference {
    /// 改写后的别名地址（有推荐项时）。
    pub rewritten_url: Option<String>,
    pub recommended: Option<Candidate>,
    pub candidates: Vec<Candidate>,
    /// 是否需要联网/实测兜底（本地无高置信结论）。
    pub needs_probe: bool,
}

/// 本地推断。`history` 为 owner(小写) → identity_id 的历史克隆记录。
pub fn infer(
    parsed: &ParsedRepo,
    identities: &[Identity],
    history: &HashMap<String, String>,
) -> Inference {
    let owner_lc = parsed.owner.to_lowercase();
    let mut candidates: Vec<Candidate> = Vec::new();

    // 若地址已是别名形式，优先校验该别名是否有效。
    if parsed.is_alias {
        if let Some(host) = &parsed.host {
            if let Some(id) = identities.iter().find(|i| i.host_alias.eq_ignore_ascii_case(host)) {
                let cand = mk(id, Confidence::Certain, format!("地址已是别名 `{host}`，对应身份"));
                return finalize(parsed, Some(cand.clone()), vec![cand]);
            }
        }
    }

    // 1) 归属标识精确 / 2) 通配。
    for id in identities {
        match owners::best_match(&id.owners, &owner_lc) {
            MatchKind::Exact => candidates.push(mk(
                id,
                Confidence::Certain,
                format!("owner `{}` 精确匹配身份 *{}* 的归属标识", parsed.owner, id.name),
            )),
            MatchKind::Wildcard => candidates.push(mk(
                id,
                Confidence::VeryHigh,
                format!("owner `{}` 命中身份 *{}* 的通配归属规则", parsed.owner, id.name),
            )),
            MatchKind::None => {}
        }
    }

    // 3) 主机唯一匹配（仅当地址带真实主机、且只有一个身份配了它）。
    if candidates.is_empty() {
        if let Some(host) = &parsed.host {
            if !parsed.is_alias {
                let hits: Vec<&Identity> = identities
                    .iter()
                    .filter(|i| i.real_host.eq_ignore_ascii_case(host))
                    .collect();
                if hits.len() == 1 {
                    candidates.push(mk(
                        hits[0],
                        Confidence::Certain,
                        format!("主机 `{host}` 唯一对应该身份"),
                    ));
                }
            }
        }
    }

    // 4) owner 首段等于账号名。
    if candidates.is_empty() {
        let first_seg = owner_lc.split('/').next().unwrap_or(&owner_lc);
        for id in identities {
            if id.name.eq_ignore_ascii_case(first_seg) {
                candidates.push(mk(
                    id,
                    Confidence::VeryHigh,
                    format!("owner `{}` 等于身份 *{}* 的实测账号名", parsed.owner, id.name),
                ));
            }
        }
    }

    // 5) 历史记录。
    if candidates.is_empty() {
        if let Some(id_ref) = history.get(&owner_lc) {
            if let Some(id) = identities.iter().find(|i| &i.id == id_ref) {
                candidates.push(mk(
                    id,
                    Confidence::MediumHigh,
                    format!("以前用身份 *{}* 克隆过 owner `{}`", id.name, parsed.owner),
                ));
            }
        }
    }

    // 排序：置信度高在前。
    candidates.sort_by_key(|c| conf_rank(c.confidence));

    let recommended = candidates.first().cloned();
    finalize(parsed, recommended, candidates)
}

fn finalize(parsed: &ParsedRepo, recommended: Option<Candidate>, candidates: Vec<Candidate>) -> Inference {
    let rewritten_url = recommended
        .as_ref()
        .map(|c| crate::git::url::rewrite_to_alias(&c.host_alias, &parsed.repo_path));
    let needs_probe = recommended.is_none();
    Inference {
        rewritten_url,
        recommended,
        candidates,
        needs_probe,
    }
}

/// 实测失败原因（命令层根据 git/ssh stderr 填写）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeFailClass {
    RepoMissing,
    KeyMissing,
    NoAccess,
    NetworkSsh,
}

/// 给 UI 用的实测分类（camelCase 与前端 i18n key 对齐）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProbeKind {
    SshOk,
    PublicOwner,
    PublicNoClaim,
    RepoMissing,
    KeyMissing,
    NoAccess,
    NetworkSsh,
}

/// `git ls-remote` 实测结果（命令层填写，此处只做排序与和本地推断合并）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeHit {
    pub identity_id: String,
    pub ssh_ok: bool,
    pub fail: ProbeFailClass,
}

/// 选出要实测的身份：别名精确命中优先，否则同主机，再否则全部。
pub fn identities_for_probe<'a>(parsed: &ParsedRepo, identities: &'a [Identity]) -> Vec<&'a Identity> {
    if parsed.is_alias {
        if let Some(host) = &parsed.host {
            let hits: Vec<&Identity> = identities
                .iter()
                .filter(|i| i.host_alias.eq_ignore_ascii_case(host))
                .collect();
            if !hits.is_empty() {
                return hits;
            }
        }
    }
    if let Some(host) = &parsed.host {
        let hits: Vec<&Identity> = identities
            .iter()
            .filter(|i| i.real_host.eq_ignore_ascii_case(host))
            .collect();
        if !hits.is_empty() {
            return hits;
        }
    }
    identities.iter().collect()
}

/// owner 命中归属标识，或首段等于身份名。
pub fn identity_matches_owner(id: &Identity, owner: &str) -> bool {
    let owner_lc = owner.trim().to_lowercase();
    match owners::best_match(&id.owners, &owner_lc) {
        MatchKind::Exact | MatchKind::Wildcard => true,
        MatchKind::None => {
            let first = owner_lc.split('/').next().unwrap_or(&owner_lc);
            id.name.eq_ignore_ascii_case(first)
        }
    }
}

/// 根据 `git ls-remote` 退出码与 stderr 区分失败原因（警告文本本身不构成失败）。
pub fn classify_ls_remote(code: i32, stderr: &str) -> ProbeFailClass {
    if code == 0 {
        return ProbeFailClass::NetworkSsh;
    }
    let lower = stderr.to_lowercase();
    if lower.contains("repository not found")
        || lower.contains("project you were looking for could not be found")
        || lower.contains("the requested url returned error: 404")
        || (lower.contains("not found") && lower.contains("repositor"))
    {
        return ProbeFailClass::RepoMissing;
    }
    if lower.contains("the requested url returned error: 403")
        || (lower.contains("authentication failed") && !lower.contains("publickey"))
    {
        return ProbeFailClass::NoAccess;
    }
    if lower.contains("permission denied")
        || lower.contains("publickey")
        || lower.contains("could not read from remote repository")
    {
        return ProbeFailClass::KeyMissing;
    }
    ProbeFailClass::NetworkSsh
}

fn fail_label(fail: ProbeFailClass) -> (ProbeKind, &'static str) {
    match fail {
        ProbeFailClass::RepoMissing => (ProbeKind::RepoMissing, "仓库不存在，或当前身份不可见"),
        ProbeFailClass::KeyMissing => (ProbeKind::KeyMissing, "SSH 密钥未加载或公钥未登记，无法实测权限"),
        ProbeFailClass::NoAccess => (ProbeKind::NoAccess, "该身份无权限访问此仓库"),
        ProbeFailClass::NetworkSsh => (ProbeKind::NetworkSsh, "网络或 SSH 配置问题，未能实测"),
    }
}

/// 合并本地推断与实测：SSH 可达升 Certain；公开仓 + owner 匹配时，SSH 失败不得标成不可达。
pub fn apply_probe_hits(
    parsed: &ParsedRepo,
    identities: &[Identity],
    history: &HashMap<String, String>,
    hits: &[ProbeHit],
    public_https_ok: bool,
) -> Inference {
    let local = infer(parsed, identities, history);
    let mut candidates = Vec::new();
    for hit in hits {
        let Some(id) = identities.iter().find(|i| i.id == hit.identity_id) else {
            continue;
        };
        let owns = identity_matches_owner(id, &parsed.owner);
        let local_cand = local.candidates.iter().find(|c| c.identity_id == id.id);
        if hit.ssh_ok {
            candidates.push(mk_probe(
                id,
                Confidence::Certain,
                "git ls-remote 实测可达".into(),
                ProbeKind::SshOk,
            ));
            continue;
        }
        if public_https_ok && owns {
            let conf = match local_cand.map(|c| c.confidence) {
                Some(Confidence::Low) | None => Confidence::VeryHigh,
                Some(other) => other,
            };
            candidates.push(mk_probe(
                id,
                conf,
                format!(
                    "公开仓库且 owner `{}` 匹配身份 *{}*；SSH 探测未成功，未当作不可达",
                    parsed.owner, id.name
                ),
                ProbeKind::PublicOwner,
            ));
            continue;
        }
        if public_https_ok {
            candidates.push(mk_probe(
                id,
                Confidence::Low,
                "仓库公开可达，该身份无归属依据".into(),
                ProbeKind::PublicNoClaim,
            ));
            continue;
        }
        let (kind, basis) = fail_label(hit.fail);
        if let Some(lc) = local_cand {
            if matches!(
                lc.confidence,
                Confidence::Certain | Confidence::VeryHigh | Confidence::MediumHigh
            ) {
                candidates.push(mk_probe(
                    id,
                    lc.confidence,
                    format!("{}；本地依据：{}", basis, lc.basis),
                    kind,
                ));
                continue;
            }
        }
        candidates.push(mk_probe(id, Confidence::Low, basis.into(), kind));
    }
    candidates.sort_by(|a, b| {
        conf_rank(a.confidence).cmp(&conf_rank(b.confidence)).then_with(|| {
            let ao = identities
                .iter()
                .find(|i| i.id == a.identity_id)
                .is_some_and(|id| identity_matches_owner(id, &parsed.owner));
            let bo = identities
                .iter()
                .find(|i| i.id == b.identity_id)
                .is_some_and(|id| identity_matches_owner(id, &parsed.owner));
            bo.cmp(&ao)
        })
    });
    let recommended = candidates
        .iter()
        .find(|c| {
            matches!(
                c.confidence,
                Confidence::Certain | Confidence::VeryHigh | Confidence::MediumHigh
            )
        })
        .cloned();
    finalize(parsed, recommended, candidates)
}

fn mk(id: &Identity, confidence: Confidence, basis: String) -> Candidate {
    Candidate {
        identity_id: id.id.clone(),
        identity_name: id.name.clone(),
        host_alias: id.host_alias.clone(),
        confidence,
        basis,
        probe_kind: None,
    }
}

fn mk_probe(id: &Identity, confidence: Confidence, basis: String, probe_kind: ProbeKind) -> Candidate {
    Candidate {
        identity_id: id.id.clone(),
        identity_name: id.name.clone(),
        host_alias: id.host_alias.clone(),
        confidence,
        basis,
        probe_kind: Some(probe_kind),
    }
}

fn conf_rank(c: Confidence) -> u8 {
    match c {
        Confidence::Certain => 0,
        Confidence::VeryHigh => 1,
        Confidence::MediumHigh => 2,
        Confidence::Low => 3,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::url::parse_repo_url;

    fn id(name: &str, alias: &str, host: &str, owners: &[&str]) -> Identity {
        Identity {
            id: format!("id-{name}"),
            name: name.into(),
            platform: "github".into(),
            host_alias: alias.into(),
            real_host: host.into(),
            user: "git".into(),
            email: None,
            git_user_name: None,
            key_id: None,
            owners: owners.iter().map(|s| s.to_string()).collect(),
            strict_mode: false,
            updated_at: String::new(),
        }
    }

    #[test]
    fn exact_owner_match_wins_and_rewrites() {
        let ids = vec![
            id("techn4950", "github-techn", "github.com", &["vortaq-trad", "mgcp-afk"]),
            id("juice520", "github.com", "github.com", &[]),
        ];
        let parsed = parse_repo_url("https://github.com/vortaq-trad/vq-officail.git").unwrap();
        let inf = infer(&parsed, &ids, &HashMap::new());
        let rec = inf.recommended.unwrap();
        assert_eq!(rec.identity_name, "techn4950");
        assert_eq!(rec.confidence, Confidence::Certain);
        assert_eq!(
            inf.rewritten_url.as_deref(),
            Some("git@github-techn:vortaq-trad/vq-officail.git")
        );
        assert!(!inf.needs_probe);
    }

    #[test]
    fn wildcard_match() {
        let ids = vec![id("techn4950", "github-techn", "github.com", &["vortaq-*"])];
        let parsed = parse_repo_url("https://github.com/vortaq-newteam/x.git").unwrap();
        let inf = infer(&parsed, &ids, &HashMap::new());
        assert_eq!(inf.recommended.unwrap().confidence, Confidence::VeryHigh);
    }

    #[test]
    fn host_unique_match_for_self_hosted() {
        let ids = vec![
            id("boxadmin", "git-box", "ssh.boxexchanger.net", &[]),
            id("juice520", "github.com", "github.com", &[]),
        ];
        let parsed = parse_repo_url("git@ssh.boxexchanger.net:bx4/vchangr-com/web.git").unwrap();
        let inf = infer(&parsed, &ids, &HashMap::new());
        let rec = inf.recommended.unwrap();
        assert_eq!(rec.identity_name, "boxadmin");
        assert_eq!(rec.confidence, Confidence::Certain);
        assert_eq!(
            inf.rewritten_url.as_deref(),
            Some("git@git-box:bx4/vchangr-com/web.git")
        );
    }

    #[test]
    fn owner_equals_account_name() {
        // 真实多账号：两把都在 github.com，主机不唯一，需靠账号名区分。
        let ids = vec![
            id("octocat", "github-octo", "github.com", &[]),
            id("someoneelse", "github-else", "github.com", &[]),
        ];
        let parsed = parse_repo_url("https://github.com/octocat/hello.git").unwrap();
        let inf = infer(&parsed, &ids, &HashMap::new());
        let rec = inf.recommended.unwrap();
        assert_eq!(rec.identity_name, "octocat");
        assert_eq!(rec.confidence, Confidence::VeryHigh);
        assert!(!inf.needs_probe);
    }

    #[test]
    fn owner_equals_identity_name_is_very_high_without_probe() {
        let ids = vec![
            id("ice-juice", "github-ice-juice", "github.com", &[]),
            id("mgcp", "github-mgfk", "github.com", &[]),
        ];
        let parsed = parse_repo_url("git@github.com:ice-juice/git-keymaster-app.git").unwrap();
        let inf = infer(&parsed, &ids, &HashMap::new());
        let rec = inf.recommended.unwrap();
        assert_eq!(rec.identity_name, "ice-juice");
        assert_eq!(rec.confidence, Confidence::VeryHigh);
        assert!(!inf.needs_probe);
        assert!(inf.candidates.iter().all(|c| c.basis != "实测不可达"));
    }

    #[test]
    fn history_fallback() {
        let ids = vec![
            id("techn4950", "github-techn", "github.com", &[]),
            id("other", "github-other", "github.com", &[]),
        ];
        let mut history = HashMap::new();
        history.insert("someorg".to_string(), "id-techn4950".to_string());
        let parsed = parse_repo_url("https://github.com/someorg/repo.git").unwrap();
        let inf = infer(&parsed, &ids, &history);
        let rec = inf.recommended.unwrap();
        assert_eq!(rec.identity_name, "techn4950");
        assert_eq!(rec.confidence, Confidence::MediumHigh);
    }

    #[test]
    fn no_match_needs_probe() {
        let ids = vec![
            id("techn4950", "github-techn", "github.com", &["vortaq-*"]),
            id("other", "github-other", "github.com", &[]),
        ];
        let parsed = parse_repo_url("https://github.com/unknownorg/repo.git").unwrap();
        let inf = infer(&parsed, &ids, &HashMap::new());
        assert!(inf.recommended.is_none());
        assert!(inf.needs_probe);
        assert!(inf.rewritten_url.is_none());
    }

    #[test]
    fn single_identity_host_unique_still_recommends() {
        // 只有一个 github.com 身份时，主机唯一即可给出确定推荐（符合置信度链）。
        let ids = vec![id("solo", "github-solo", "github.com", &[])];
        let parsed = parse_repo_url("https://github.com/anyowner/repo.git").unwrap();
        let inf = infer(&parsed, &ids, &HashMap::new());
        let rec = inf.recommended.unwrap();
        assert_eq!(rec.identity_name, "solo");
        assert_eq!(rec.confidence, Confidence::Certain);
    }

    #[test]
    fn already_alias_is_validated() {
        let ids = vec![id("techn4950", "github-techn", "github.com", &[])];
        let parsed = parse_repo_url("git@github-techn:owner/repo.git").unwrap();
        let inf = infer(&parsed, &ids, &HashMap::new());
        assert_eq!(inf.recommended.unwrap().identity_name, "techn4950");
    }

    #[test]
    fn exact_precise_beats_wildcard_from_other_identity() {
        let ids = vec![
            id("a", "gh-a", "github.com", &["vortaq-*"]),
            id("b", "gh-b", "github.com", &["vortaq-trad"]),
        ];
        let parsed = parse_repo_url("https://github.com/vortaq-trad/x.git").unwrap();
        let inf = infer(&parsed, &ids, &HashMap::new());
        // 精确匹配的 b 应排在前。
        assert_eq!(inf.recommended.unwrap().identity_name, "b");
    }

    #[test]
    fn probe_unique_reachable_recommends_and_rewrites() {
        let ids = vec![
            id("techn4950", "github-techn", "github.com", &[]),
            id("other", "github-other", "github.com", &[]),
        ];
        let parsed = parse_repo_url("https://github.com/unknownorg/repo.git").unwrap();
        let inf = apply_probe_hits(
            &parsed,
            &ids,
            &HashMap::new(),
            &[
                ProbeHit {
                    identity_id: "id-techn4950".into(),
                    ssh_ok: true,
                    fail: ProbeFailClass::NetworkSsh,
                },
                ProbeHit {
                    identity_id: "id-other".into(),
                    ssh_ok: false,
                    fail: ProbeFailClass::KeyMissing,
                },
            ],
            false,
        );
        let rec = inf.recommended.unwrap();
        assert_eq!(rec.identity_name, "techn4950");
        assert_eq!(rec.confidence, Confidence::Certain);
        assert_eq!(rec.basis, "git ls-remote 实测可达");
        assert_eq!(
            inf.rewritten_url.as_deref(),
            Some("git@github-techn:unknownorg/repo.git")
        );
        assert!(!inf.needs_probe);
        assert_eq!(inf.candidates[0].identity_name, "techn4950");
        assert_eq!(inf.candidates[1].identity_name, "other");
        assert_ne!(inf.candidates[1].basis, "实测不可达");
        assert_eq!(inf.candidates[1].probe_kind, Some(ProbeKind::KeyMissing));
    }

    #[test]
    fn probe_none_reachable_still_needs_probe() {
        let ids = vec![
            id("techn4950", "github-techn", "github.com", &[]),
            id("other", "github-other", "github.com", &[]),
        ];
        let parsed = parse_repo_url("https://github.com/unknownorg/repo.git").unwrap();
        let inf = apply_probe_hits(
            &parsed,
            &ids,
            &HashMap::new(),
            &[
                ProbeHit {
                    identity_id: "id-techn4950".into(),
                    ssh_ok: false,
                    fail: ProbeFailClass::KeyMissing,
                },
                ProbeHit {
                    identity_id: "id-other".into(),
                    ssh_ok: false,
                    fail: ProbeFailClass::NetworkSsh,
                },
            ],
            false,
        );
        assert!(inf.recommended.is_none());
        assert!(inf.needs_probe);
        assert!(inf.rewritten_url.is_none());
        assert!(inf.candidates.iter().all(|c| c.basis != "实测不可达"));
        assert!(inf.candidates.iter().any(|c| c.probe_kind == Some(ProbeKind::KeyMissing)));
        assert!(inf.candidates.iter().any(|c| c.probe_kind == Some(ProbeKind::NetworkSsh)));
    }

    #[test]
    fn probe_multiple_reachable_keeps_first_certain() {
        let ids = vec![
            id("alpha", "gh-a", "github.com", &[]),
            id("beta", "gh-b", "github.com", &[]),
        ];
        let parsed = parse_repo_url("https://github.com/shared/repo.git").unwrap();
        let inf = apply_probe_hits(
            &parsed,
            &ids,
            &HashMap::new(),
            &[
                ProbeHit {
                    identity_id: "id-alpha".into(),
                    ssh_ok: true,
                    fail: ProbeFailClass::NetworkSsh,
                },
                ProbeHit {
                    identity_id: "id-beta".into(),
                    ssh_ok: true,
                    fail: ProbeFailClass::NetworkSsh,
                },
            ],
            false,
        );
        assert_eq!(inf.recommended.unwrap().identity_name, "alpha");
        assert_eq!(inf.candidates.len(), 2);
        assert!(inf.candidates.iter().all(|c| c.confidence == Confidence::Certain));
        assert!(!inf.needs_probe);
    }

    #[test]
    fn identities_for_probe_prefers_alias_then_host() {
        let ids = vec![
            id("techn4950", "github-techn", "github.com", &[]),
            id("other", "github-other", "github.com", &[]),
            id("box", "git-box", "ssh.boxexchanger.net", &[]),
        ];
        let alias = parse_repo_url("git@github-techn:owner/repo.git").unwrap();
        let alias_hits = identities_for_probe(&alias, &ids);
        assert_eq!(alias_hits.len(), 1);
        assert_eq!(alias_hits[0].name, "techn4950");

        let host = parse_repo_url("https://github.com/owner/repo.git").unwrap();
        let host_hits = identities_for_probe(&host, &ids);
        assert_eq!(host_hits.len(), 2);
        assert!(host_hits.iter().all(|i| i.real_host == "github.com"));
    }

    #[test]
    fn probe_ssh_fail_public_owner_not_unreachable() {
        let ids = vec![
            id("ice-juice", "github-ice-juice", "github.com", &[]),
            id("mgcp", "github-mgfk", "github.com", &[]),
        ];
        let parsed = parse_repo_url("git@github.com:ice-juice/git-keymaster-app.git").unwrap();
        let inf = apply_probe_hits(
            &parsed,
            &ids,
            &HashMap::new(),
            &[
                ProbeHit {
                    identity_id: "id-ice-juice".into(),
                    ssh_ok: false,
                    fail: ProbeFailClass::KeyMissing,
                },
                ProbeHit {
                    identity_id: "id-mgcp".into(),
                    ssh_ok: false,
                    fail: ProbeFailClass::KeyMissing,
                },
            ],
            true,
        );
        let rec = inf.recommended.expect("owner 匹配的公开仓不应丢掉推荐");
        assert_eq!(rec.identity_name, "ice-juice");
        assert_eq!(rec.confidence, Confidence::VeryHigh);
        assert!(!inf.needs_probe);
        assert_ne!(rec.basis, "实测不可达");
        assert_eq!(rec.probe_kind, Some(ProbeKind::PublicOwner));
        let other = inf.candidates.iter().find(|c| c.identity_name == "mgcp").unwrap();
        assert_eq!(other.confidence, Confidence::Low);
        assert_eq!(other.probe_kind, Some(ProbeKind::PublicNoClaim));
        assert!(!inf.candidates.iter().any(|c| c.basis == "实测不可达"));
    }

    #[test]
    fn classify_ls_remote_distinguishes_failures() {
        assert_eq!(
            classify_ls_remote(128, "git@github.com: Permission denied (publickey)."),
            ProbeFailClass::KeyMissing
        );
        assert_eq!(
            classify_ls_remote(128, "ERROR: Repository not found.\nfatal: Could not read from remote repository."),
            ProbeFailClass::RepoMissing
        );
        assert_eq!(
            classify_ls_remote(-1, ""),
            ProbeFailClass::NetworkSsh
        );
        assert_eq!(
            classify_ls_remote(128, "ssh: Could not resolve hostname github-ice-juice"),
            ProbeFailClass::NetworkSsh
        );
        assert_eq!(
            classify_ls_remote(128, "Host key verification failed."),
            ProbeFailClass::NetworkSsh
        );
    }
}
