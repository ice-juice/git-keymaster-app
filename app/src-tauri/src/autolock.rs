//! 空闲自动锁定与休眠/锁屏锁定的**实际执行者**。
//!
//! `auto_lock_minutes` 与 `lock_on_sleep` 长期只是配置项与自查清单里的展示项，
//! 没有任何代码真的去锁——用户以为离座有保护，实际没有。这个模块把两项落地。
//!
//! 判定来源：
//! - 空闲：前端把用户操作节流上报到 `last_activity`，这里比时长。
//! - 休眠：挂起期间挂钟会前跳而定时器不走，所以「挂钟跨度远大于本次 tick」即视为睡过。
//! - 锁屏：Windows 上锁屏后拿不到输入桌面句柄，据此判定；其余平台暂不支持（见
//!   `security::item_lock_on_sleep` 里如实标注的能力边界）。

use crate::commands::{recover_lock, AppState};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Emitter, Manager};

/// 巡检间隔。取 10s：够快让「15 分钟」不至于漂太多，又不至于空转耗电。
const TICK: Duration = Duration::from_secs(10);

/// 挂钟前跳超过这个值就认定机器睡过一觉，而不是单纯的调度延迟。
const SLEEP_JUMP_SLACK: Duration = Duration::from_secs(60);

/// 已经因锁屏锁过一次后，不要每个 tick 重复锁 + 重复发事件。
static LOCKED_BY_SCREEN: AtomicBool = AtomicBool::new(false);

/// 锁定原因，随事件发给前端，让界面能给出「为什么被锁」的提示。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockReason {
    Idle,
    Sleep,
    ScreenLock,
}

impl LockReason {
    pub fn as_str(self) -> &'static str {
        match self {
            LockReason::Idle => "idle",
            LockReason::Sleep => "sleep",
            LockReason::ScreenLock => "screenLock",
        }
    }
}

/// 记录一次用户活动。解锁成功与前端心跳都会调到这里。
pub fn touch(state: &AppState) {
    *recover_lock(&state.last_activity) = Instant::now();
}

/// 是否应当因空闲而锁定。抽成纯函数，便于测试边界而不必真的等 15 分钟。
pub fn idle_should_lock(auto_lock_minutes: u32, idle: Duration) -> bool {
    if auto_lock_minutes == 0 {
        return false;
    }
    idle >= Duration::from_secs(u64::from(auto_lock_minutes) * 60)
}

/// 挂钟跨度是否说明机器挂起过。
pub fn wall_jump_means_sleep(elapsed_wall: Duration, tick: Duration) -> bool {
    elapsed_wall > tick + SLEEP_JUMP_SLACK
}

/// 保险库锁被别的命令占着时，巡检线程会在锁上干等。
/// 这段等待会让下一次挂钟差看起来像休眠，不能据此锁定。
pub fn sleep_detected(vault_busy: bool, elapsed_wall: Duration, tick: Duration) -> bool {
    !vault_busy && wall_jump_means_sleep(elapsed_wall, tick)
}

/// 工作站当前是否处于锁屏/安全桌面。`None` 表示本平台无法判断。
pub fn workstation_locked() -> Option<bool> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::StationsAndDesktops::{CloseDesktop, OpenInputDesktop};
        // 锁屏时输入桌面是 Winlogon 的安全桌面，普通权限打不开。
        // SAFETY: 仅查询句柄；拿到就立刻关闭，不做任何桌面切换。
        let handle = unsafe {
            OpenInputDesktop(0, 0, 0x0001 /* DESKTOP_READOBJECTS */)
        };
        if handle.is_null() {
            return Some(true);
        }
        unsafe {
            CloseDesktop(handle);
        }
        Some(false)
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// 启动后台巡检线程。进程退出时随之结束，无需显式停止。
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_wall = SystemTime::now();
        let mut was_unlocked = false;
        loop {
            std::thread::sleep(TICK);

            let now_wall = SystemTime::now();
            let elapsed_wall = now_wall.duration_since(last_wall).unwrap_or_else(|_| TICK);

            let state = app.state::<AppState>();
            // git clone 会占着保险库一两分钟。这里若阻塞，下一次挂钟差会被当成休眠。
            let vault_guard = match state.vault.try_lock() {
                Ok(guard) => guard,
                Err(std::sync::TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
                Err(std::sync::TryLockError::WouldBlock) => {
                    last_wall = now_wall;
                    continue;
                }
            };
            last_wall = now_wall;
            // 已经锁着就什么都不用做，但锁屏标记要在解锁后复位。
            let unlocked = vault_guard.as_ref().is_some_and(|v| v.is_unlocked());
            drop(vault_guard);
            if !unlocked {
                LOCKED_BY_SCREEN.store(false, Ordering::SeqCst);
                was_unlocked = false;
                continue;
            }
            // 锁定期间累积的"空闲"不算数，否则刚解锁就会被立刻锁回去。
            if !was_unlocked {
                was_unlocked = true;
                touch(&state);
                continue;
            }

            let (auto_lock_minutes, lock_on_sleep) = {
                let cfg = recover_lock(&state.config);
                (cfg.auto_lock_minutes, cfg.lock_on_sleep)
            };

            let idle = recover_lock(&state.last_activity).elapsed();

            let reason = if lock_on_sleep && sleep_detected(false, elapsed_wall, TICK) {
                Some(LockReason::Sleep)
            } else if lock_on_sleep && workstation_locked() == Some(true) {
                if LOCKED_BY_SCREEN.swap(true, Ordering::SeqCst) {
                    None
                } else {
                    Some(LockReason::ScreenLock)
                }
            } else if idle_should_lock(auto_lock_minutes, idle) {
                Some(LockReason::Idle)
            } else {
                if workstation_locked() == Some(false) {
                    LOCKED_BY_SCREEN.store(false, Ordering::SeqCst);
                }
                None
            };

            let Some(reason) = reason else { continue };

            crate::commands::vault::lock_in_memory(&state);
            log::info!("已自动锁定保险库，原因：{}", reason.as_str());
            let _ = app.emit("vault-auto-locked", reason.as_str());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_minutes_never_idle_locks() {
        assert!(!idle_should_lock(0, Duration::from_secs(86_400)));
    }

    #[test]
    fn idle_locks_only_at_or_past_threshold() {
        assert!(!idle_should_lock(15, Duration::from_secs(14 * 60 + 59)));
        assert!(idle_should_lock(15, Duration::from_secs(15 * 60)));
        assert!(idle_should_lock(15, Duration::from_secs(20 * 60)));
    }

    #[test]
    fn ordinary_scheduling_delay_is_not_sleep() {
        // tick 正常抖动几秒不能被当成休眠，否则会频繁误锁。
        assert!(!wall_jump_means_sleep(TICK + Duration::from_secs(5), TICK));
        assert!(!wall_jump_means_sleep(TICK + SLEEP_JUMP_SLACK, TICK));
    }

    #[test]
    fn long_wall_jump_is_sleep() {
        assert!(wall_jump_means_sleep(Duration::from_secs(3600), TICK));
    }

    #[test]
    fn vault_wait_is_not_sleep() {
        let waited = Duration::from_secs(130);
        assert!(wall_jump_means_sleep(waited, TICK));
        assert!(!sleep_detected(true, waited, TICK));
        assert!(sleep_detected(false, waited, TICK));
    }

    /// 只要求「不 panic 且语义自洽」：CI 跑在无交互会话里，返回值不可预设。
    #[test]
    fn workstation_query_is_well_formed() {
        match workstation_locked() {
            Some(_) => assert!(cfg!(windows), "只有 Windows 应给出确定结论"),
            None => assert!(!cfg!(windows), "Windows 必须能给出结论"),
        }
    }
}
