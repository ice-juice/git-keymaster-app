use crate::commands::{recover_lock, AppState};
use crate::error::{AppError, Result};
use crate::onboarding::{self, Preferences, Record, Status};
use crate::{autostart, screen_protect};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub record: Record,
    pub allow_screenshots: bool,
    pub capability: screen_protect::ScreenCaptureCapability,
    pub capture_limited: bool,
    pub launch_at_login_supported: bool,
    pub screen_lock_detectable: bool,
    pub config_error: bool,
}

fn view(cfg: &crate::app_config::AppConfig) -> View {
    let mut record = cfg.onboarding.clone();
    if matches!(
        screen_protect::capability(),
        screen_protect::ScreenCaptureCapability::Unsupported
    ) && record.pending.is_none()
    {
        if let Some(draft) = record.draft.as_mut() {
            draft.screen_protection = false;
        }
    }
    View {
        record,
        allow_screenshots: cfg.allow_screenshots,
        capability: screen_protect::capability(),
        capture_limited: cfg!(target_os = "macos"),
        launch_at_login_supported: autostart::is_supported(),
        screen_lock_detectable: crate::autolock::workstation_locked().is_some(),
        config_error: cfg.load_error.is_some(),
    }
}

#[tauri::command]
pub fn onboarding_get(app: AppHandle, state: State<AppState>) -> View {
    let mut cfg = recover_lock(&state.config);
    let reload = cfg.load_error.is_some();
    if reload {
        *cfg = crate::app_config::AppConfig::load();
    }
    // A discovered existing workspace is not a fresh install (notably mobile recovery).
    if cfg.workspace_path.is_some() && cfg.onboarding.status == Status::NotStarted {
        let mut next = cfg.clone();
        next.onboarding = Record::legacy();
        next.allow_screenshots = false;
        if next.save().is_ok() {
            *cfg = next;
            screen_protect::apply(&app, false);
        }
    }
    if reload && cfg.load_error.is_none() {
        screen_protect::apply(&app, cfg.allow_screenshots);
        let settings = super::screen::ScreenCaptureSettings {
            allow_screenshots: cfg.allow_screenshots,
            capability: screen_protect::capability(),
        };
        let _ = app.emit("screen-capture-changed", settings);
    }
    view(&cfg)
}

fn validate_platform(p: &Preferences) -> Result<()> {
    p.validate()?;
    if p.screen_protection
        && matches!(
            screen_protect::capability(),
            screen_protect::ScreenCaptureCapability::Unsupported
        )
    {
        return Err(AppError::Unsupported("screen capture protection"));
    }
    if p.launch_at_login && !autostart::is_supported() {
        return Err(AppError::Unsupported("launch at login"));
    }
    Ok(())
}

#[tauri::command]
pub fn onboarding_save_draft(
    state: State<AppState>,
    preferences: Preferences,
    step: u8,
    revision: u64,
) -> Result<View> {
    validate_platform(&preferences)?;
    let mut cfg = recover_lock(&state.config);
    onboarding::save_draft(&mut cfg, preferences, step, revision, |c| c.save())?;
    Ok(view(&cfg))
}

#[tauri::command]
pub fn onboarding_commit(
    app: AppHandle,
    state: State<AppState>,
    request_id: String,
    revision: u64,
) -> Result<View> {
    let mut cfg = recover_lock(&state.config);
    onboarding::commit(
        &mut cfg,
        &request_id,
        revision,
        |c| c.save(),
        |p| {
            validate_platform(p)?;
            // Repeating a recovered operation does not repeat an already-completed OS write.
            if autostart::is_supported() && autostart::is_enabled() != p.launch_at_login {
                autostart::set_enabled(p.launch_at_login)?;
                if autostart::is_enabled() != p.launch_at_login {
                    return Err(AppError::Other(
                        "Login startup setting did not take effect".into(),
                    ));
                }
            }
            screen_protect::apply_checked(&app, !p.screen_protection).map_err(AppError::Other)
        },
    )?;
    let result = view(&cfg);
    drop(cfg);
    crate::commands::clear_reveal_grace(&state);
    let _ = app.emit(
        "screen-capture-changed",
        super::screen::get_screen_capture_settings(state),
    );
    Ok(result)
}

#[tauri::command]
pub fn onboarding_ack_ui(state: State<AppState>, request_id: String) -> Result<View> {
    let mut cfg = recover_lock(&state.config);
    if cfg.onboarding.last_request_id.as_deref() != Some(&request_id)
        || cfg.onboarding.pending.is_some()
    {
        return Err(AppError::Busy);
    }
    if cfg.onboarding.ui_pending {
        let mut next = cfg.clone();
        next.onboarding.ui_pending = false;
        next.onboarding.revision += 1;
        next.save()?;
        *cfg = next;
    }
    Ok(view(&cfg))
}

#[tauri::command]
pub fn onboarding_skip(state: State<AppState>, revision: u64) -> Result<View> {
    let mut cfg = recover_lock(&state.config);
    onboarding::skip(&mut cfg, revision, |c| c.save())?;
    Ok(view(&cfg))
}

#[tauri::command]
pub fn onboarding_reopen(
    state: State<AppState>,
    preferences: Preferences,
    revision: u64,
) -> Result<View> {
    let mut cfg = recover_lock(&state.config);
    onboarding::check_revision(&cfg, revision)?;
    if cfg.onboarding.pending.is_some() || cfg.onboarding.ui_pending {
        return Err(AppError::Busy);
    }
    let mut next = cfg.clone();
    let mut draft = preferences.with_current_security(&cfg);
    draft.launch_at_login = autostart::is_enabled();
    if matches!(
        screen_protect::capability(),
        screen_protect::ScreenCaptureCapability::Unsupported
    ) {
        draft.screen_protection = false;
    }
    validate_platform(&draft)?;
    next.onboarding.status = Status::InProgress;
    next.onboarding.draft = Some(draft);
    next.onboarding.step = 0;
    next.onboarding.last_request_id = None;
    next.onboarding.last_error = None;
    next.onboarding.revision += 1;
    next.save()?;
    *cfg = next;
    Ok(view(&cfg))
}

#[tauri::command]
pub fn onboarding_dismiss_biometrics(state: State<AppState>) -> Result<()> {
    let mut cfg = recover_lock(&state.config);
    let mut next = cfg.clone();
    next.onboarding.offer_biometrics = false;
    next.save()?;
    *cfg = next;
    Ok(())
}
