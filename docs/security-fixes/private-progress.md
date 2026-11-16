# 隐私内容与 UI 修复进度

范围：R04、R13（账号）、R14、R15、R16、R12（账号/TOTP事务接入）。保留其他任务的未提交修改，不操作真实库/凭据/剪贴板。

| 项目 | 当前状态 | 说明 |
| --- | --- | --- |
| R04 共享 blob 读取 | 已实现，TS检查通过，待Rust执行 | 任意 hash 图片读取、Markdown内嵌导出统一走后端重认证；前端共享认证弹窗合并并发请求，不以可编辑引用当授权；后端认证后校验session epoch |
| R13 密码原样保存 | 已实现，等待 Rust 验证 | 前端/后端取消密码 trim，空字符串仍拒绝，合法前后空白保留 |
| R14 PDF 无限循环 | 已实现，3项定向测试通过 | 不支持/未闭合图片语法按文本回退并推进；与epoch用例合计3项 |
| R15 Android 剪贴板 | 已实现，待平台编译/真机 | 系统敏感标记、原生定时、归属token、销毁和恢复过期清理；锁定接原生清理；秘密复制失败不静默降级WebView |
| R16 明文图片缓存 | 已实现，定向epoch测试通过 | 删除模块级明文Map，只去重进行中请求；锁定/切库拒绝旧结果并清组件引用 |
| R12 账号/TOTP事务 | 已接入store事务API，待Rust验证 | 新增/修改/删除、分组、最近使用、密码历史回滚/清空整体读改写进入事务；GC只在提交成功后执行 |

已执行：`node --experimental-strip-types --test src/shared/notePdf.test.ts src/shared/sensitiveEpoch.test.ts`，3/3通过；`npx tsc --noEmit -p tsconfig.app.json`通过；所改前端文件定向oxlint退出0，有原有React类warning。新增Rust回归`commands::notes::tests::arbitrary_hash_read_requires_reauth_and_rejects_non_images`，覆盖无授权、错误密码、非图片、正确密码、0分钟窗口、锁定，使用独立临时库，待root统一执行。未宣称Android真机或Rust全量测试通过。

并发复核：认证队列使用dialog generation，取消/锁定后旧提交不会消耗新弹窗队列；0分钟窗口将本次输入逐请求传给后端，不依赖宽限期且不缓存密码。导出内嵌图片和PDF读取都经过同一重认证；导出写文件时也需仍解锁。新增测试位于src/shared/*.test.ts，已被现有npm test:unit脚本覆盖。

共享接口：root已接ipc中的可选password参数、store锁定和状态变化的`invalidateSensitiveAssets()`。本组提供`lib/secureAssets.tsx`，不导入store，避免循环依赖。

后续按root授权补齐同步密码冲突保留：`model::merge_secrets_with_meta`保留选中密码，将落选密码及双方历史去重并入历史；相同时间戳确定性选择，重复同步不重复历史；同步保留阶段不使用普通编辑历史上限裁掉冲突。合法空白密码不再被合并判断当作缺失。新增两个Rust测试覆盖双向收敛、幂等、双方历史和空白保留，待root统一执行。TOTP冲突由sync组在提交前明确拒绝并提示双端备份/人工统一，避免无历史的种子被静默覆盖。

ReauthDialog后续加同步ref提交门闩、防Enter重复、取消清输入、结构化错误展示；secureAssets取消错误已本地化。最后一次app TypeScript检查通过。

## Android编译与授权回填复核

- 仅进程级加载`scripts/dev-env.ps1`，执行Gradle `:app:compileArm64DebugKotlin -x rustBuildArm64Debug --console=plain --no-daemon`：第一次 **BUILD SUCCESSFUL**（1m13s）。发现本组销毁回调使用弃用重载，切换`onDestroy(activity: AppCompatActivity)`后再次 **BUILD SUCCESSFUL**（42s），ClipboardPlugin已无编译warning，剩余warning来自既有更新插件/生成WebView及Gradle/SDK。未连接设备、安装APK或操作剪贴板，未修改签名/系统设置。
- 新增`src/shared/secureAssets.test.ts`，直接转译执行真实`secureAssets.tsx`，仅mock IPC/DOM/React渲染边界：不同hash不串结果、只去重进行中读取、成功明文不全局缓存、锁定后旧结果拒绝、0分钟宽限多请求共用一次输入、取消中的旧认证不把旧密码用于新队列。**4/4通过**，已由`test:unit` glob覆盖。
- 后端R04已有临时库实际hash读取测试，未认证的普通文件与图片hash均拒绝；正确密码也不能把非图片包装成图片；0分钟窗口不复用授权。图片解密接口和md_inline导出均在取得vault锁后核对session epoch。

## 主 agent 最终集成结果

本组相关用例已纳入Windows Rust第三轮493项通过的回归；迁移末次内容校验补丁另经2项定向通过。前端178项、生产构建、Android Rust检查、Android Kotlin编译均通过。具体运行范围、过滤项及Apple/真机边界以[总进度](进度.md)为准，以上早期“待验证”记录保留为过程历史。
