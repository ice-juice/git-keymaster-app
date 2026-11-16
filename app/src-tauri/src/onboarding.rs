//! Device-local onboarding. Drafts never change live preferences.
use crate::app_config::AppConfig;
use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    NotStarted,
    InProgress,
    Completed,
    Skipped,
    Legacy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub theme: String,
    pub startup_animation: bool,
    pub unlock_animation: bool,
    pub unlock_style: String,
    pub screen_protection: bool,
    pub auto_lock_minutes: u32,
    pub lock_on_sleep: bool,
    pub clipboard_clear_seconds: u32,
    pub reveal_grace_minutes: u32,
    pub mask_accounts: bool,
    pub clipboard_watch: bool,
    pub launch_at_login: bool,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            theme: "light".into(),
            startup_animation: true,
            unlock_animation: true,
            unlock_style: "minimal".into(),
            screen_protection: true,
            auto_lock_minutes: 5,
            lock_on_sleep: true,
            clipboard_clear_seconds: 20,
            reveal_grace_minutes: 1,
            mask_accounts: true,
            clipboard_watch: false,
            launch_at_login: false,
        }
    }
}

impl Preferences {
    pub fn validate(&self) -> Result<()> {
        if !["light", "dark", "navy"].contains(&self.theme.as_str())
            || !["minimal", "classic", "cyber"].contains(&self.unlock_style.as_str())
            || self.auto_lock_minutes > 1440
            || self.reveal_grace_minutes > 30
            || (self.clipboard_clear_seconds != 0
                && !(5..=120).contains(&self.clipboard_clear_seconds))
        {
            return Err(AppError::Invalid("Invalid onboarding preferences".into()));
        }
        Ok(())
    }

    pub fn with_current_security(mut self, cfg: &AppConfig) -> Self {
        self.screen_protection = !cfg.allow_screenshots;
        self.auto_lock_minutes = cfg.auto_lock_minutes;
        self.lock_on_sleep = cfg.lock_on_sleep;
        self.clipboard_clear_seconds = cfg.clipboard_clear_seconds;
        self.reveal_grace_minutes = cfg.reveal_grace_minutes;
        self.clipboard_watch = cfg.clipboard_watch;
        self.launch_at_login = cfg.launch_at_login;
        self
    }

    fn apply_to(&self, cfg: &mut AppConfig) {
        cfg.allow_screenshots = !self.screen_protection;
        cfg.auto_lock_minutes = self.auto_lock_minutes;
        cfg.lock_on_sleep = self.lock_on_sleep;
        cfg.clipboard_clear_seconds = self.clipboard_clear_seconds;
        cfg.reveal_grace_minutes = self.reveal_grace_minutes;
        cfg.clipboard_watch = self.clipboard_watch;
        cfg.launch_at_login = self.launch_at_login;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub request_id: String,
    pub preferences: Preferences,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub version: u32,
    pub status: Status,
    pub revision: u64,
    pub step: u8,
    pub draft: Option<Preferences>,
    pub pending: Option<Pending>,
    pub last_request_id: Option<String>,
    pub last_error: Option<String>,
    pub ui_pending: bool,
    pub offer_biometrics: bool,
}

impl Record {
    /// Used only when deserializing a pre-onboarding configuration.
    pub fn legacy() -> Self {
        Self {
            version: 1,
            status: Status::Legacy,
            revision: 0,
            step: 0,
            draft: None,
            pending: None,
            last_request_id: None,
            last_error: None,
            ui_pending: false,
            offer_biometrics: false,
        }
    }
    pub fn fresh() -> Self {
        Self {
            status: Status::NotStarted,
            draft: Some(Preferences::default()),
            offer_biometrics: true,
            ..Self::legacy()
        }
    }
}

pub fn check_revision(cfg: &AppConfig, revision: u64) -> Result<()> {
    if cfg.load_error.is_some() {
        return Err(AppError::Other(
            "Local configuration could not be read; original file preserved".into(),
        ));
    }
    if cfg.onboarding.version != 1 {
        return Err(AppError::Invalid("Unsupported onboarding version".into()));
    }
    if cfg.onboarding.revision != revision {
        return Err(AppError::Invalid(
            "Onboarding changed; reload before continuing".into(),
        ));
    }
    Ok(())
}

pub fn save_draft(
    cfg: &mut AppConfig,
    preferences: Preferences,
    step: u8,
    revision: u64,
    persist: impl Fn(&AppConfig) -> Result<()>,
) -> Result<()> {
    check_revision(cfg, revision)?;
    preferences.validate()?;
    if step > 2
        || cfg.onboarding.pending.is_some()
        || cfg.onboarding.ui_pending
        || !matches!(
            cfg.onboarding.status,
            Status::NotStarted | Status::InProgress
        )
    {
        return Err(AppError::Busy);
    }
    let mut next = cfg.clone();
    next.onboarding.draft = Some(preferences);
    next.onboarding.step = step;
    next.onboarding.status = Status::InProgress;
    next.onboarding.revision += 1;
    persist(&next)?;
    *cfg = next;
    Ok(())
}

/// Persist an immutable intent before touching OS settings. Unknown results are
/// resolved by reading this record; only an explicit retry resumes that intent.
pub fn commit(
    cfg: &mut AppConfig,
    request_id: &str,
    revision: u64,
    persist: impl Fn(&AppConfig) -> Result<()>,
    apply: impl Fn(&Preferences) -> Result<()>,
) -> Result<()> {
    if cfg.load_error.is_some() {
        return Err(AppError::Other("Local configuration is unavailable".into()));
    }
    if cfg.onboarding.version != 1 {
        return Err(AppError::Invalid("Unsupported onboarding version".into()));
    }
    if request_id.len() > 64 || uuid::Uuid::parse_str(request_id).is_err() {
        return Err(AppError::Invalid("Invalid onboarding operation ID".into()));
    }
    if cfg.onboarding.last_request_id.as_deref() == Some(request_id) {
        return Ok(());
    }
    if let Some(pending) = &cfg.onboarding.pending {
        if pending.request_id != request_id {
            return Err(AppError::Busy);
        }
    } else {
        check_revision(cfg, revision)?;
        if !matches!(
            cfg.onboarding.status,
            Status::NotStarted | Status::InProgress
        ) {
            return Err(AppError::Busy);
        }
        let preferences = cfg
            .onboarding
            .draft
            .clone()
            .ok_or_else(|| AppError::Invalid("Missing onboarding draft".into()))?;
        preferences.validate()?;
        let mut intent = cfg.clone();
        intent.onboarding.pending = Some(Pending {
            request_id: request_id.into(),
            preferences,
        });
        intent.onboarding.last_error = None;
        intent.onboarding.revision += 1;
        persist(&intent)?;
        *cfg = intent;
    }
    let preferences = cfg.onboarding.pending.as_ref().unwrap().preferences.clone();
    if let Err(error) = apply(&preferences) {
        cfg.onboarding.last_error = Some(error.to_string());
        let _ = persist(cfg); // The durable intent already exists even if this error update fails.
        return Err(error);
    }
    let mut next = cfg.clone();
    preferences.apply_to(&mut next);
    next.onboarding.status = Status::Completed;
    next.onboarding.draft = Some(preferences);
    next.onboarding.pending = None;
    next.onboarding.last_request_id = Some(request_id.into());
    next.onboarding.last_error = None;
    next.onboarding.ui_pending = true;
    next.onboarding.revision += 1;
    persist(&next)?;
    *cfg = next;
    Ok(())
}

pub fn skip(
    cfg: &mut AppConfig,
    revision: u64,
    persist: impl Fn(&AppConfig) -> Result<()>,
) -> Result<()> {
    check_revision(cfg, revision)?;
    if cfg.onboarding.pending.is_some() || cfg.onboarding.ui_pending {
        return Err(AppError::Busy);
    }
    let mut next = cfg.clone();
    next.onboarding.status = Status::Skipped;
    next.onboarding.draft = None;
    next.onboarding.revision += 1;
    persist(&next)?;
    *cfg = next;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    const ID: &str = "12c1b30b-6af4-47d1-876a-e9f58bad5200";
    #[test]
    fn recommendation_is_not_live_and_skip_preserves_settings() {
        let mut cfg = AppConfig::default();
        assert!(cfg.allow_screenshots);
        save_draft(&mut cfg, Preferences::default(), 2, 0, |_| Ok(())).unwrap();
        assert!(cfg.allow_screenshots);
        assert_eq!(cfg.auto_lock_minutes, 15);
        skip(&mut cfg, 1, |_| Ok(())).unwrap();
        assert!(cfg.allow_screenshots);
        assert_eq!(cfg.auto_lock_minutes, 15);
    }
    #[test]
    fn commit_is_idempotent_and_applies_inverse_capture_setting() {
        let mut cfg = AppConfig::default();
        let calls = Cell::new(0);
        for _ in 0..2 {
            commit(
                &mut cfg,
                ID,
                0,
                |_| Ok(()),
                |_| {
                    calls.set(calls.get() + 1);
                    Ok(())
                },
            )
            .unwrap();
        }
        assert_eq!(calls.get(), 1);
        assert!(!cfg.allow_screenshots);
        assert_eq!(cfg.auto_lock_minutes, 5);
        assert!(cfg.onboarding.ui_pending);
    }
    #[test]
    fn failed_intent_write_never_touches_os() {
        let mut cfg = AppConfig::default();
        assert!(commit(
            &mut cfg,
            ID,
            0,
            |_| Err(AppError::Io("disk full".into())),
            |_| panic!("must not apply")
        )
        .is_err());
        assert!(cfg.onboarding.pending.is_none());
        assert!(cfg.allow_screenshots);
    }
    #[test]
    fn failed_effect_preserves_intent_and_rejects_replacement_or_skip() {
        let mut cfg = AppConfig::default();
        assert!(commit(
            &mut cfg,
            ID,
            0,
            |_| Ok(()),
            |_| Err(AppError::Io("OS denied".into()))
        )
        .is_err());
        assert!(cfg.onboarding.pending.is_some());
        let revision = cfg.onboarding.revision;
        assert!(skip(&mut cfg, revision, |_| Ok(())).is_err());
        assert!(save_draft(&mut cfg, Preferences::default(), 0, revision, |_| Ok(())).is_err());
        assert!(commit(
            &mut cfg,
            "22c1b30b-6af4-47d1-876a-e9f58bad5200",
            revision,
            |_| Ok(()),
            |_| Ok(())
        )
        .is_err());
        commit(&mut cfg, ID, 0, |_| Ok(()), |_| Ok(())).unwrap();
        assert_eq!(cfg.onboarding.status, Status::Completed);
    }
    #[test]
    fn final_write_failure_is_recoverable_after_restart() {
        let mut cfg = AppConfig::default();
        assert!(commit(
            &mut cfg,
            ID,
            0,
            |c| if c.onboarding.status == Status::Completed {
                Err(AppError::Io("disk full".into()))
            } else {
                Ok(())
            },
            |_| Ok(())
        )
        .is_err());
        let mut reloaded: AppConfig =
            serde_json::from_str(&serde_json::to_string(&cfg).unwrap()).unwrap();
        assert!(reloaded.onboarding.pending.is_some());
        commit(&mut reloaded, ID, 0, |_| Ok(()), |_| Ok(())).unwrap();
        assert_eq!(reloaded.onboarding.status, Status::Completed);
    }
    #[test]
    fn unchecked_capture_and_stale_drafts() {
        let mut cfg = AppConfig::default();
        let p = Preferences {
            screen_protection: false,
            ..Preferences::default()
        };
        save_draft(&mut cfg, p, 1, 0, |_| Ok(())).unwrap();
        assert!(save_draft(&mut cfg, Preferences::default(), 2, 0, |_| Ok(())).is_err());
        commit(&mut cfg, ID, 1, |_| Ok(()), |_| Ok(())).unwrap();
        assert!(cfg.allow_screenshots);
    }
}
