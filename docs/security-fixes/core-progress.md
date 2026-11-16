# 核心安全修复进度

范围：R01、R02、R03、R12 凭据/单文件写入、主密码重认证一致性，以及 Apple ACL、KDF 上限、秘密零化和恢复后重设密码。仅使用合成测试数据；没有调用真实生物识别、读取用户凭据或执行清空。

## 已实施，等待主 agent 统一 Rust 验证

- R01：新增 `biometric/apple.rs`，iOS/macOS KEK 只写 ThisDeviceOnly 且 biometryCurrentSet 访问控制的系统 Keychain；macOS 使用 Data Protection Keychain。入库后读取实际 ACL 项验证绑定，任何签名/entitlement/系统拒绝均失败，不退回沙箱文件/普通钥匙串。删除旧 ios.rs/macos.rs 不安全实现；旧绑定版本被拒绝，按确切 key_ref 清理旧材料，用户保留访问密码/恢复码并需重新启用指纹。Apple 真机/签名兼容性尚未实测。
- R02：Vault 克隆共享 `Arc<Mutex<Option<MasterKey>>>`；锁定撤销所有克隆中的同一 MK，重新解锁创建新槽，旧任务不能重新激活。去掉后台独立 sync_key；锁定后不再构造可解密同步库。密码/指纹/DPAPI 异步解锁均校验 session epoch，系统认证跨锁返回不得重新授权。切换库先撤销旧库。store 缓存/事务配合由同步组实施。
- R03：恢复密钥改成 prepare/commit/cancel 两阶段。prepare 每次验证访问密码；token 绑定会话/工作空间、有效期 5 分钟；只保存确认摘要和加密信封；确认用户保存的完整恢复码后才持久化替换。锁定、改密清 pending。主 agent 正在接前端。
- R12：密码/恢复信封写入失败恢复原内存 header；atomic_write 采用排他临时文件、文件 sync_all、rename，失败不直接截断覆盖正本；保留一个 `.prev`，Unix 同步父目录。DPAPI/生物识别清理同步删除 `.prev`，避免撤销后保留本地凭据副本。跨文件事务由同步组实施。
- 统一新访问密码策略：命令边界至少 8 字符、4096 字节上限、拒绝常见口令；历史弱密码仍可解锁。主密码验证不 trim。其余新库入口由主 agent / 同步组调用公共校验函数。
- 新增 `reset_access_password_with_recovery`：验证当前恢复信封，再设置新密码信封；失败回滚；清免验证会话/授权并生成新会话。此流程仍沿用 MK，不宣称能撤销被盗历史副本。
- KEK、解封 MK 临时 Vec、biometric raw、DPAPI 明文和输出缓冲区增加零化；Apple 不缓存 KEK。
- KDF 参数先验证再派生，iters 上限 64（历史标定上限）；不悄悄篡改已存头部的参数。异常 KDF 仍能走恢复码路径。
- factory reset：增加新鲜密码或恢复码验证；补 blobs/icons 和事务目录清理；删除失败不报告成功；只卸载本库管理的 SSH key，保留其他程序的 agent 内容。

## 验证记录

- 已通过：所有修改的 Rust 源码经 rustfmt 语法解析；定向 `git diff --check` 无 whitespace 错误。
- 已新增行为回归：共享密钥撤销/旧任务不复活、恢复码准备不提前生效、存储失败时凭据/磁盘不分叉、恶意迭代数被拒绝。
- 主 agent 第一轮后端日志已记录核心行为回归通过：共享 MK 撤销、恢复码 prepare/commit、凭据落盘故障回滚、恢复码重设密码等均 `ok`。整轮为 477 通过 / 1 失败（store 读取 `.prev` 恢复的兼容回归，已交同步组修复），不是整轮全绿。第三轮 SSH/ACL 新增测试需后续增量验证。未运行真实库或真实生物识别凭据测试。

## 第二轮交叉复核

- 与同步组确认锁顺序：store IO 锁 → 单类缓存锁 → 短持 MK 锁；锁定释放 MK 锁后才失效缓存，未发现此链的反向等待。同步组补缓存命中/解密结束后的失效检查，锁定后返回错误而不是只禁止缓存。
- 新增 reset_busy：清空开始阻止新的写入/克隆/解锁/切库提交，递增 epoch 拒绝正在等待认证的旧解锁结果；撤销 MK 后，清理持有与 store 相同的独占 IO 锁，先等待已提交事务恢复，再清除明确拥有的目录。
- 新增行为测试：密码首尾空格重认证、锁定态不接受遗留 grace、恢复码重设密码失败不修改/成功撤销旧句柄、清空只删 blobs/icons/已知事务目录并保留用户目录及非 UUID 伪前缀目录。
- Windows 临时文件在空文件阶段先收 ACL，成功后才写负载；失败关闭。Unix 用 create_new+0600。单文件保留的 `.prev` 是原加密内容/信封，不是明文；免验证会话及生物识别撤销同时删除其 `.prev`。旧密码/恢复码仍能解旧信封属于既有副本不可撤回边界，不能把重包信封声称成主密钥撤销。
- Apple FFI 对照了 Apple 官方 Security 开源 `SecAccessControl.h` / `SecItem.h`：biometryCurrentSet 为 `1 << 3`，flags 为 CFOptionFlags；WhenPasscodeSetThisDeviceOnly 不随设备备份迁移；macOS Data Protection Keychain 从 10.15 起可用。已通知主 agent 检查最低系统版本。CF create/copy 结果均由 RAII CFRelease 管理；入库 CFData 无复制借用零化缓冲区，缓冲区存活长于字典；系统返回 CFData 不做非法可变指针擦写，释放由系统管理，不承诺可擦除操作系统内部所有副本。
- Apple 交叉类型检查通过：安装 Rust `aarch64-apple-darwin` / `aarch64-apple-ios` std target，临时最小 crate 直接引用项目真实 `biometric/apple.rs` 和真实 `objc2-local-authentication 0.3.2`，两条 `cargo check --target ...` 均退出 0。临时 crate 仅替代本项目错误/配置外围接口，不替代 ObjC 类型。未修改项目 Cargo.lock。此检查不包含 Apple SDK 链接、签名或真机认证，不能据此称系统 ACL 已验收。

## 平台边界

Windows 构建不能证明 Apple Security.framework 的设备签名、entitlement、生物识别录入变化与取消交互已验收。新实现选择失败关闭，必须在 macOS/iOS 正式签名测试应用中验证后才宣布平台验收完成。

## 第三轮：SSH 共享密钥与 Windows ACL 复核

- 接管 `commands/write.rs` 补 R17 混合模式：严格身份选 `.pub` 但部署时不删除同 key 的私钥；元数据提交后，仅有引用且全部严格的 key 才按稳定 keyId 路径和内容匹配清理。存在任意非严格消费者，或未绑定的工具生成 key，均保留私钥部署。
- reconcile 不再把共享 `KeyRecord.deployed_path` 当成每个身份的安全策略，分别计算 strict/non-strict 路径；元数据目录路径只作聚合提示。
- 创建/编辑/删除身份、保存工具生成 key、向导暂存使用 store 事务。SSH config 是外部投影，保留原始备份，事务提交前失败恢复原始配置；已提交 redo 需继续恢复时不做反向回滚。与主 agent 协调把快照/事务/回滚放在同一独占 IO 锁内。
- 新增定向回归：同 key 严格/非严格身份不相互破坏、最后非严格引用提交删除后才清理、未绑定 key 保留、元数据故障恢复 SSH 原文。同名不同 key 隔离沿用主 agent 已补测试。
- Windows ACL 原生实现复核完成：按进程 TokenUser SID 建立 protected DACL，替换全部显式 ACE，句柄/LocalFree 释放路径正确。新增仅临时合成文件的测试，先造 Everyone/Users 显式 ACE，收权后验证 DACL protected 且只余一条 allow ACE。
- 主 agent 第二轮日志已确认上述三个 SSH 行为测试和 Windows 显式 ACE 替换测试全部 `ok`；核心撤销/凭据回滚/恢复密码测试同样 `ok`。第二轮其余测试仍由主 agent 收敛；编译后补的外层独占 IO 锁需要再做定向增量验证。

## 主 agent 最终集成结果

本组相关用例已纳入Windows Rust第三轮493项通过的回归；迁移末次内容校验补丁另经2项定向通过。前端178项、生产构建、Android Rust检查、Android Kotlin编译均通过。具体运行范围、过滤项及Apple/真机边界以[总进度](进度.md)为准，以上早期“待验证”记录保留为过程历史。
