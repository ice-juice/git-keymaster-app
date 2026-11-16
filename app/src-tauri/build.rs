//! Build the maintained services/file-locker-worker source into assets.
//! A failed source build must not silently ship stale protocol code.

use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    embed_locker_worker();
    tauri_build::build();
}

fn embed_locker_worker() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let repo_root = manifest_dir.join("../..");
    let assets = manifest_dir.join("assets");
    let script = repo_root.join("scripts/embed-locker-worker.mjs");
    let worker = repo_root.join("services/file-locker-worker");

    println!("cargo:rerun-if-changed={}", script.display());
    println!("cargo:rerun-if-changed={}", worker.join("src").display());
    println!(
        "cargo:rerun-if-changed={}",
        worker.join("migrations").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        worker.join("wrangler.toml").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        assets.join("file-locker.js").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        assets.join("0001_locker.sql").display()
    );
    println!("cargo:rerun-if-changed={}", assets.join("0002_locker_v2.sql").display());
    println!(
        "cargo:rerun-if-changed={}",
        assets.join("compatibility_date.txt").display()
    );

    let worker_present = worker.join("src/index.ts").is_file();
    if worker_present && script.is_file() {
        if let Some(node) = resolve_node() {
            let status = Command::new(node)
                .arg(&script)
                .current_dir(&repo_root)
                .status();
            match status {
                Ok(s) if s.success() => {}
                Ok(s) => panic!("embed-locker-worker failed (exit {s}); refusing stale protocol assets"),
                Err(e) => panic!("Cannot build embedded Worker: {e}"),
            }
        } else {
            panic!("未找到 Node，无法验证并重建 services/file-locker-worker；拒绝使用可能过期的内嵌产物");
        }
    }

    if !assets_ready(&assets) {
        panic!(
            "缺少内嵌分享 Worker 产物。请恢复 services/file-locker-worker 并安装 Node 后重新构建。"
        );
    }
}

fn assets_ready(assets: &Path) -> bool {
    assets.join("file-locker.js").is_file()
        && assets.join("0001_locker.sql").is_file()
        && assets.join("0002_locker_v2.sql").is_file()
        && assets.join("compatibility_date.txt").is_file()
}

fn resolve_node() -> Option<PathBuf> {
    let names = if cfg!(windows) {
        vec!["node.exe", "node"]
    } else {
        vec!["node"]
    };
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            for name in &names {
                let p = dir.join(name);
                if p.is_file() {
                    return Some(p);
                }
            }
        }
    }
    None
}
