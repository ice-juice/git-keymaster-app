//! Serialized encrypted-file transactions. A durable redo record is the commit point.
//! Readers complete committed recovery before observing any metadata.
use crate::error::{AppError, Result};
use crate::vault::Vault;
use serde::{Deserialize, Serialize};
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

static IO_LOCK: Mutex<()> = Mutex::new(());
thread_local! {
    static DEPTH: Cell<usize> = const { Cell::new(0) };
    static PENDING: RefCell<Option<Pending>> = const { RefCell::new(None) };
}
struct Pending {
    root: PathBuf,
    writes: BTreeMap<PathBuf, Option<Vec<u8>>>,
    rollback_only: bool,
}
pub(super) struct Access {
    _guard: Option<MutexGuard<'static, ()>>,
}
impl Drop for Access {
    fn drop(&mut self) {
        DEPTH.with(|d| d.set(d.get() - 1));
    }
}
pub(super) fn access(root: &Path) -> Result<Access> {
    let outer = DEPTH.with(|d| d.get() == 0);
    let guard = outer.then(|| IO_LOCK.lock().unwrap_or_else(|e| e.into_inner()));
    DEPTH.with(|d| d.set(d.get() + 1));
    let access = Access { _guard: guard };
    if outer {
        recover(root)?;
    }
    Ok(access)
}

/// Drain storage activity before a revoked workspace is removed. The caller must
/// revoke its session first and must not acquire AppState locks inside this closure.
pub fn with_exclusive_workspace<T>(root: &Path, f: impl FnOnce() -> Result<T>) -> Result<T> {
    let _access = access(root)?;
    f()
}
fn relative(root: &Path, path: &Path) -> Result<PathBuf> {
    let rel = path
        .strip_prefix(root)
        .map_err(|_| AppError::Invalid("事务路径越出工作空间".into()))?;
    if rel.as_os_str().is_empty() || rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(AppError::Invalid("事务路径无效".into()));
    }
    let mut cursor = root.to_owned();
    for part in rel.components() {
        cursor.push(part.as_os_str());
        if std::fs::symlink_metadata(&cursor).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(AppError::Invalid("事务路径不能包含符号链接".into()));
        }
    }
    Ok(rel.to_owned())
}
pub(super) fn read(root: &Path, path: &Path) -> Result<Option<Vec<u8>>> {
    let _access = access(root)?;
    let rel = relative(root, path)?;
    if let Some(value) = PENDING.with(|p| {
        p.borrow()
            .as_ref()
            .filter(|p| p.root == root)
            .and_then(|p| p.writes.get(&rel).cloned())
    }) {
        return Ok(value);
    }
    match std::fs::read(path) {
        Ok(raw) => Ok(Some(raw)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}
pub(super) fn write(root: &Path, path: &Path, bytes: &[u8]) -> Result<()> {
    let _access = access(root)?;
    let rel = relative(root, path)?;
    let staged = PENDING.with(|p| {
        let mut p = p.borrow_mut();
        if let Some(p) = p.as_mut().filter(|p| p.root == root) {
            p.writes.insert(rel, Some(bytes.to_vec()));
            true
        } else {
            false
        }
    });
    if staged {
        Ok(())
    } else {
        crate::vault::atomic_write(path, bytes)
    }
}
pub(super) fn delete(root: &Path, path: &Path) -> Result<()> {
    let _access = access(root)?;
    let rel = relative(root, path)?;
    let staged = PENDING.with(|p| {
        let mut p = p.borrow_mut();
        if let Some(p) = p.as_mut().filter(|p| p.root == root) {
            p.writes.insert(rel, None);
            true
        } else {
            false
        }
    });
    if !staged && path.exists() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}
struct PendingReset;
impl Drop for PendingReset {
    fn drop(&mut self) {
        PENDING.with(|p| {
            p.borrow_mut().take();
        });
        super::invalidate_plaintext_cache();
    }
}
struct NestedFailure(bool);
impl Drop for NestedFailure {
    fn drop(&mut self) {
        if self.0 {
            PENDING.with(|p| {
                if let Some(p) = p.borrow_mut().as_mut() {
                    p.rollback_only = true;
                }
            });
        }
    }
}

pub fn transaction<T>(vault: &Vault, f: impl FnOnce() -> Result<T>) -> Result<T> {
    let _access = access(vault.root())?;
    if !vault.is_unlocked() {
        return Err(AppError::Locked);
    }
    let nested = PENDING.with(|p| p.borrow().as_ref().map(|p| p.root.clone()));
    if let Some(root) = nested {
        if root != vault.root() {
            return Err(AppError::Invalid("不支持跨工作空间嵌套事务".into()));
        }
        let mut guard = NestedFailure(true);
        let result = f();
        guard.0 = result.is_err();
        return result;
    }
    PENDING.with(|p| {
        *p.borrow_mut() = Some(Pending {
            root: vault.root().to_owned(),
            writes: BTreeMap::new(),
            rollback_only: false,
        })
    });
    let _reset = PendingReset;
    let outcome = f();
    let pending = PENDING
        .with(|p| p.borrow_mut().take())
        .expect("transaction owns pending writes");
    super::invalidate_plaintext_cache();
    let result = outcome?;
    if pending.rollback_only {
        return Err(AppError::Invalid("嵌套事务失败，整次变更已取消".into()));
    }
    if !vault.is_unlocked() {
        return Err(AppError::Locked);
    }
    commit(&pending)?;
    Ok(result)
}

#[derive(Serialize, Deserialize)]
struct Entry {
    path: PathBuf,
    file: Option<String>,
}
fn journal_dir(root: &Path) -> PathBuf {
    root.join(".store-transaction")
}
fn sync_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut f = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    Ok(())
}
fn sync_dir(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        std::fs::File::open(path)?.sync_all()?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
fn commit(p: &Pending) -> Result<()> {
    if p.writes.is_empty() {
        return Ok(());
    }
    let dir = journal_dir(&p.root);
    std::fs::create_dir_all(&dir)?;
    let mut entries = Vec::new();
    for (i, (path, value)) in p.writes.iter().enumerate() {
        let file = if let Some(bytes) = value {
            let name = format!("{i}.sealed");
            sync_write(&dir.join(&name), bytes)?;
            Some(name)
        } else {
            None
        };
        entries.push(Entry {
            path: path.clone(),
            file,
        });
    }
    sync_write(&dir.join("journal.json"), &serde_json::to_vec(&entries)?)?;
    sync_dir(&dir)?;
    sync_write(&dir.join("COMMITTED"), b"v1")?;
    sync_dir(&dir)?;
    sync_dir(&p.root)?;
    // This is already committed: preserve the journal and report an explicit recovery state,
    // rather than a normal retryable mutation failure.
    recover(&p.root).map_err(|e| {
        AppError::Other(format!(
            "事务已提交，正在等待磁盘恢复；请勿重复操作。重新打开保险库后将继续恢复：{e}"
        ))
    })
}
fn recover(root: &Path) -> Result<()> {
    let dir = journal_dir(root);
    if !dir.exists() {
        return Ok(());
    }
    if !dir.join("COMMITTED").is_file() {
        std::fs::remove_dir_all(&dir)?;
        return Ok(());
    }
    let entries: Vec<Entry> = serde_json::from_slice(&std::fs::read(dir.join("journal.json"))?)?;
    for entry in entries {
        relative(root, &root.join(&entry.path))?;
        if entry.path.starts_with(".store-transaction") {
            return Err(AppError::Invalid("事务日志路径无效".into()));
        }
        let target = root.join(entry.path);
        if let Some(file) = entry.file {
            if file.contains(['/', '\\']) || !file.ends_with(".sealed") {
                return Err(AppError::Invalid("事务日志文件无效".into()));
            }
            let bytes = std::fs::read(dir.join(file))?;
            crate::vault::atomic_write(&target, &bytes)?;
        } else if target.exists() {
            std::fs::remove_file(&target)?;
        }
    }
    // Rename the completed journal before deletion so interrupted cleanup cannot create
    // a committed journal with missing redo data.
    let done = root.join(format!(".store-done-{}", uuid::Uuid::new_v4()));
    std::fs::rename(&dir, &done)?;
    sync_dir(root)?;
    let _ = std::fs::remove_dir_all(done);
    super::invalidate_plaintext_cache();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("gkm-txn-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }
    #[test]
    fn interrupted_committed_install_recovers_before_reads() {
        let root = root();
        let dir = journal_dir(&root);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(root.join("a"), b"old-a").unwrap();
        std::fs::write(root.join("b"), b"old-b").unwrap();
        sync_write(&dir.join("0.sealed"), b"new-a").unwrap();
        sync_write(&dir.join("1.sealed"), b"new-b").unwrap();
        let entries = vec![
            Entry {
                path: "a".into(),
                file: Some("0.sealed".into()),
            },
            Entry {
                path: "b".into(),
                file: Some("1.sealed".into()),
            },
        ];
        sync_write(
            &dir.join("journal.json"),
            &serde_json::to_vec(&entries).unwrap(),
        )
        .unwrap();
        sync_write(&dir.join("COMMITTED"), b"v1").unwrap();
        std::fs::write(root.join("a"), b"new-a").unwrap();
        assert_eq!(read(&root, &root.join("b")).unwrap().unwrap(), b"new-b");
        assert_eq!(std::fs::read(root.join("a")).unwrap(), b"new-a");
        assert!(!dir.exists());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn uncommitted_stage_is_discarded_without_changing_live_files() {
        let root = root();
        let dir = journal_dir(&root);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(root.join("a"), b"old").unwrap();
        sync_write(&dir.join("0.sealed"), b"new").unwrap();
        assert_eq!(read(&root, &root.join("a")).unwrap().unwrap(), b"old");
        assert!(!dir.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn swallowed_nested_failure_cannot_commit_partial_writes() {
        let root = root();
        let (v, _) = Vault::init(
            &root,
            "transaction-password",
            crate::vault::header::KdfParams::new(crate::vault::kdf::MEM_FLOOR_KIB, 2, 1),
        )
        .unwrap();
        let outcome = transaction(&v, || {
            let nested: Result<()> = transaction(&v, || {
                write(&root, &root.join("data/test.enc"), b"ciphertext")?;
                Err(AppError::Crypto)
            });
            assert!(nested.is_err());
            Ok(())
        });
        assert!(outcome.is_err());
        assert!(!root.join("data/test.enc").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn caught_nested_panic_also_marks_transaction_rollback_only() {
        let root = root();
        let (v, _) = Vault::init(
            &root,
            "transaction-password",
            crate::vault::header::KdfParams::new(crate::vault::kdf::MEM_FLOOR_KIB, 2, 1),
        )
        .unwrap();
        let result = transaction(&v, || {
            let caught = std::panic::catch_unwind(|| {
                let _: Result<()> = transaction(&v, || {
                    write(&root, &root.join("data/test.enc"), b"partial")?;
                    panic!("synthetic failure");
                });
            });
            assert!(caught.is_err());
            Ok(())
        });
        assert!(result.is_err());
        assert!(!root.join("data/test.enc").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
