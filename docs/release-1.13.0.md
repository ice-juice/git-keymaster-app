# 1.13.0 发布记录

日期：2026-11-16。范围：用户确认发布全部现有功能更新，包含安全加固、文件寄存柜 V2、首次使用引导、笔记即时编辑及 SSH 使用期限修复。

## 本机检查

- `npm run build`：通过。
- `npm run test:unit`：178 项通过。
- `services/file-locker-worker` 的 `npm run check`：两套 TypeScript 检查、35 项测试通过。
- `cargo test --locked -- --test-threads=1`：497 项通过，0 失败，1 项显式运行的原生测试忽略；包括 RSA-4096、Windows 剪贴板与 GitHub 清单探测。
- SSH 原生回归 `native_reload_removes_old_expiry_and_preserves_signing` 此前显式运行通过：隔离 agent 上验证两条加载路径清除旧期限、保持签名和显式卸载。
- 本机真实 SSH 复测：基线之后 153.2 分钟，原 agent PID 3380、原身份仍在，GitHub 认证及远端 HEAD 读取成功。本次检查未加载密钥；无法独立排除用户期间手动重载身份。15/30 分钟定时复测曾被执行策略阻止，不能计作通过。
- 发布不变量源码检查及自检、发布说明自检、更新清单签名自检、资源合并自检均通过。
- 现有警告：Rust 的 `collect_blob_hashes` 未使用导入；前端较大 chunk 与无效动态分包提示。

## 发布规则与边界

先推送 `dev` 并确认对应提交的跨平台 Test 成功，再快进 `release`，推送 `v1.13.0` 标签触发 Release packages。构建失败时先处理失败原因，不能把本机 Windows 检查当作跨平台通过。

应用源码、测试、项目设计和验证文档纳入版本；本机 `.xiaojiu` 会话预览、依赖目录、构建产物、保险库及凭据不纳入提交。

旧设备升级、同步格式及恢复方式见 [升级与恢复指南](security-fixes/升级与恢复指南.md)。真实 Apple 生物识别硬件、多设备云服务和断电耐久性等仍保留原验收边界，不将本机测试表述为全部生产环境认证。
