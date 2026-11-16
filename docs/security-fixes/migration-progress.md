# 独立新主密钥迁移

日期：2026-11-15。落实审查附加项“泄露后重建MK”，不在原库原地重加密。

## 实现

- 独立`commands/security_migration.rs`和`ui/SecurityMigration.tsx`；root负责IPC注册和设置入口。
- `prepare`要求当前访问密码新鲜认证、新的不同访问密码、原库之外不存在的绝对目标目录。UUID兄弟暂存目录中，用随机一次性加密备份口令导出/导入，全新Vault随机生成MK与恢复码。
- 保留完整元数据、密码历史、附件/私钥/图标，逐类解密比对。寄存柜内容密钥重新包裹到新MK，远程寄存文件本体不包含在迁移中。验证完成后锁定目标，通过不覆盖发布目录操作交付副本；失败仅清理本次新建UUID staging，原库不更改。
- 待确认状态仅保留路径/ID/token、源会话epoch与源文件摘要、新恢复码hash和过期时间，不保留MK或新密码。源在准备期间锁定或切换后不返回新恢复码，错误仅说明保留副本路径和用新密码打开方式。
- 用户输入已保存的新恢复码才可激活；再次验证source session、源数据摘要及目标ID，独立恢复码解锁目标。准备之后源有新编辑则拒绝切换，避免丢掉新内容。
- 源与目标摘要均覆盖`vault.json`、`data`、`keys`、`icons`、`blobs`完整清单及内容，64KiB流式读取；准备后任一侧附件/元数据变化均拒绝切换，不只依赖header ID。激活异步前端使用generation guard，锁定/切库后不回填旧成功或错误状态。
- 激活先取得存储互斥，再对config/vault/pending使用try_lock；忙则不更改配置。提交前核对pending仍是同一token，配置成功保存时消费，取消或新prepare不会激活旧token。
- 切换后旧内存密钥撤销，旧云同步配置/自动同步、免验证会话、生物识别绑定、查看宽限和缓存清理；不执行云端写入或SSH部署。取消仅取消切换，生成的独立副本保留。
- UI明确新恢复码保存、目标路径、备份范围、旧库保留、旧云历史和已泄露第三方凭据不能撤销，仍需用户另外轮换第三方密码/SSH密钥/令牌。

## 验证状态

- app TypeScript检查通过。
- Rust新增`fresh_key_copy_preserves_content_and_guards_activation`：临时库验证新旧子密钥不同、内容一致、旧密码不能解新库、错误确认不切换、源epoch/内容变化拒绝、取消/替换token拒绝、成功消费token、原库仍存在且能解锁；不调用真实AppConfig保存、系统凭据或云服务。
- Rust新增`publish_never_replaces_an_existing_empty_directory`：已存在空目标也拒绝覆盖。
- 最后补充源/目标blob变化均拒绝切换的合成断言，待root增量migration定向回归。
- Rust执行交root统一cargo，未在本子任务自行启动编译。
- 没有真实用户保险库迁移、系统生物识别清理或云端操作。Linux/macOS无覆盖rename路径仍需对应平台CI编译/测试；本地Windows不能代替跨平台验证。

## 主 agent 最终集成结果

本组相关用例已纳入Windows Rust第三轮493项通过的回归；迁移末次内容校验补丁另经2项定向通过。前端178项、生产构建、Android Rust检查、Android Kotlin编译均通过。具体运行范围、过滤项及Apple/真机边界以[总进度](进度.md)为准，以上早期“待验证”记录保留为过程历史。
