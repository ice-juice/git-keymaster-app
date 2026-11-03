//! 构建期把同级 `file-locker-worker` 打成单文件脚本嵌进 assets。
//! 同级仓库不在、或本机没有 Node 时，沿用已经提交的产物，保证能编译。

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
    let worker = repo_root.join("../file-locker-worker");

    println!("cargo:rerun-if-changed={}", script.display());
    println!("cargo:rerun-if-changed={}", worker.join("src").display());
    println!(
        "cargo:rerun-if-changed={}",
        worker.join("migrations/0001_locker.sql").display()
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
                Ok(s) => {
                    if assets_ready(&assets) {
                        println!(
                            "cargo:warning=embed-locker-worker 退出 {}，沿用已提交产物",
                            s
                        );
                    } else {
                        panic!("embed-locker-worker 失败且 assets 不完整（exit {s}）");
                    }
                }
                Err(e) => {
                    if assets_ready(&assets) {
                        println!("cargo:warning=无法运行 Node 嵌入 Worker（{e}），沿用已提交产物");
                    } else {
                        panic!("无法运行 Node 嵌入 Worker（{e}），且 assets 不完整");
                    }
                }
            }
        } else if !assets_ready(&assets) {
            panic!("未找到 Node，且 app/src-tauri/assets 缺少 file-locker 产物");
        }
    }

    if !assets_ready(&assets) {
        panic!(
            "缺少内嵌分享 Worker 产物。请把同级仓库 file-locker-worker 放在旁边后重新构建，或恢复已提交的 app/src-tauri/assets。"
        );
    }
}

fn assets_ready(assets: &Path) -> bool {
    assets.join("file-locker.js").is_file()
        && assets.join("0001_locker.sql").is_file()
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
