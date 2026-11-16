# SSH 身份反复过期修复（2026-11-16）

## 原因与行为

此前安全修复在 stdin 和临时文件两条加载路径中都加入了 `ssh-add -t 900`，导致身份加载 15 分钟后从 agent 自动删除。用户在 IDE 或终端中开发不会延长该期限，后续 Git 操作因此出现 `Permission denied (publickey)`，必须重新解锁保险库并加载身份。

已移除两处强制期限，恢复跟随 agent 生命周期的 SSH 授权。保险库自动锁定、最小化和退出仍清除保险库内存秘密，但不撤销已经交给独立 ssh-agent 的签名身份。手动卸载、清空 agent、agent 重启和电脑重启仍会结束该授权。私钥文件权限加固及加密存储保持不变。

升级不能直接修改 agent 内已有的期限；需要在修复版本中重新加载一次身份，OpenSSH 会替换旧的到期约束。不会为了去除期限导出用户明文私钥，也不重启或清空用户正在使用的 agent。

## 验证

- 新增显式运行的 Windows 原生回归测试，使用独立随机套接字及临时生成的测试密钥，不访问真实保险库、不操作用户 agent。
- 两条加载路径分别先加载 1 秒期限身份，再通过生产代码重新加载，等待旧期限经过后验证身份仍存在且能够签名，最后验证手动卸载有效。
- 临时文件路径同时校验 ssh-add 未报告新的 lifetime 约束。本测试不等价于实际等待 15 分钟；固定 900 秒参数的移除另通过代码检查确认。
- 本机真实 GitHub SSH 认证返回 `Hi ice-juice! You've successfully authenticated`；`git ls-remote --exit-code origin HEAD` 成功。此操作只读取远端，没有推送代码。
- `cargo test --locked agent::tests -- --test-threads=1`：19 项通过，1 项原生测试按设计需显式运行。
- `cargo test --locked agent::tests::native_reload_removes_old_expiry_and_preserves_signing -- --ignored --exact --nocapture`：原生回归通过（两条路径、真实签名及卸载）。
- `npm run build`：通过。Rust 编译有现存的 `collect_blob_hashes` 未使用导入警告；前端有现存的分包体积与动态导入提示。
- Windows release 桌面程序构建通过，`app/src-tauri/target/release/git-keymaster.exe` 已更新到本机桌面快捷方式指向的 `C:/Users/hgc18/AppData/Local/GitKeymaster/git-keymaster.exe`，两者 SHA256 一致：`64A9A254CAEDD0A441ABEFE8BD00ABB6BBD640933D9F48F5DAC4DBC817FBDFB8`。
- 更新前的程序备份至 `C:/Users/hgc18/AppData/Local/GitKeymasterDev/backups/ssh-agent-lifetime-20261116-093103/git-keymaster.exe`，备份与原文件 SHA256 一致：`B52F095FC17750B7DE52B0B858CEB78FB91A1C2FE329C79BF3CB935F7D5DC239`。
- 已发起修复后的本机程序启动。原开发版 `target/debug/app.exe` 仍在运行，修复版显示“御钥师 已在运行”切换确认，等待用户保存编辑后切换；未强制终止旧实例。真实保险库密码由用户在应用中输入；等待用户在修复版重新加载身份后，才能确认旧身份期限已在真实 agent 中替换。没有更改用户的保险库自动锁定或免验证设置。
