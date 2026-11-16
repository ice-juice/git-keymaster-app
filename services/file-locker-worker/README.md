# 文件寄存柜服务 v2

此目录是御钥师仓库内维护的 Worker 源码。来源见 [UPSTREAM.md](UPSTREAM.md)，原始 v1 文档保存在 [README.upstream.md](README.upstream.md)，其中旧的领取/吊销语义不适用于 v2。

线协议与错误码见 [locker-v2-contract.md](../../docs/locker-v2-contract.md)。主要变化：

- 私人文件与公开分享入口分离；停止分享不会删除对象。
- D1 原子预留有限次数，原操作可查询、取消未交付预留、恢复交付与确认。
- 开始交付后不自动退款；默认 15 分钟恢复窗，至多 3 次内容请求。
- 最后名额被占用时保留原会话，直到确认/超时后再清理；删除另有显式接口。
- 新增独立 v2 表，旧分享需显式迁移并读取服务端真实剩余次数。
- 浏览器端查询不消耗次数；内容密钥只从 fragment 在浏览器内读取；成功文案不声称能证明操作系统已落盘。

## 本地构建与验证

```powershell
npm ci
npm run check
node ../../scripts/embed-locker-worker.mjs
```

`check` 执行类型检查、历史 HMAC/帧兼容测试及使用真实本地 workerd / D1 / R2 的 v2 集成测试。测试使用隔离临时存储，不读取云配置，不部署服务。

`npm run test:browser` 额外运行 Chromium → workerd → D1/R2 → 实际分块加密文件的浏览器链路。默认复用本机 `%LOCALAPPDATA%/GitKeymasterDev/design-tools/node_modules/playwright-core` 与 Chrome；其他机器通过 `PLAYWRIGHT_MODULE` 和 `CHROME_PATH` 指定路径。覆盖下载内容哈希、ACK 响应丢失、预留响应丢失后的刷新恢复和窄屏布局。

## 部署集成

Tauri 构建将 `src/index.ts`、`0001_locker.sql`、`0002_locker_v2.sql` 和兼容日期嵌入应用。`0001` 仅在旧表不存在时创建；`0002` 可安全重复执行以修复中断部署。健康检查确认所有 v2 表/必要列存在后才报告 v2 就绪。未通过验证的旧 Worker 不能承接新次数语义。

`wrangler.toml` 中只保留示例资源标识。真实部署由应用的连接/部署向导或管理员明确执行。本次开发验收没有部署任何云服务。

`src/handle.ts` 及 `test/api.test.ts` 保留上游 v1 基线，便于核对签名/格式；生产入口只导入 `handle-v2.ts`，所有旧网络写入/领取路径返回 426，不会执行旧的立即删除逻辑。
