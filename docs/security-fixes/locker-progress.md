# 寄存柜安全修复进度

日期：2026-11-15。承接当前其他任务已经完成的 V2 claims/stop-share 实现，保留其代码。无真实云端部署、用户数据或用户浏览器操作。

| 项目 | 状态 | 验证 |
| --- | --- | --- |
| R08 一次性失败丢失 | V2现有机制验证通过 | 同一claim最多3次恢复、失败保留对象到恢复期限、ACK后回收；Miniflare真实D1/R2测试通过。对结果未知不新建领取、不再扣新名额 |
| R09 文件截断 | 已修复，Worker和浏览器验证通过 | 新分享fragment绑定完整明文size、文件名、服务base和slug；HMAC-SHA256采用CK派生独立用途key；Rust/TS固定向量一致；浏览器/原生必须核对总明文长度 |
| R10 停止分享删除本体 | V2现有机制验证通过 | stop-share只关新公开入口，保存对象与owner访问，已开始claim能恢复；Miniflare测试与丢预留响应后停止分享/刷新浏览器恢复通过 |

R09格式：`#v2.<CK base64url>.<明文size十进制>.<文件名base64url>.<MAC base64url>`。MAC输入为 `gam-locker-share-v2\n<canonicalBase>\n<slug>\n<size>\n<nameBase64>`；MAC key为 HMAC-SHA256(CK, `gam-locker-share-auth-key-v2`)。使用现有Rust HMAC依赖和浏览器WebCrypto，未新增依赖，未改变GKB1密文格式。

旧无完整性fragment安全拒绝：提示发送者重新复制分享链接，可使用原有寄存文件生成新链接，不要求重新加密/上传。历史领取journal若只保存估算长度也拒绝未验证保存，避免恢复路径绕过。既有文件已成功保存/确认的幂等状态不更改。

已执行：

- `npm run check`：Worker双tsc通过，35/35测试通过。包含固定向量、size/name/base/slug篡改、旧fragment、整块/仅头截断拒绝；以及现有V2原子名额、失败恢复、停止分享、ACK丢失、迁移等。
- `npm run test:browser`：真实headless Chromium + 本机Miniflare/D1/R2通过；正常解密文件内容一致、ACK丢失不重传、丢预留响应后停止分享+刷新仍同操作恢复、390px布局、旧/篡改fragment在领取前拒绝、伪造长度的仅头响应不触发下载和ACK。
- Rust端修改与固定向量/解析测试交root统一cargo验证，未在本组另起全量cargo。

产物：浏览器证据写至 `docs/design/locker-redesign/implementation/browser-service-check.json`；完成后执行根目录 `node scripts/embed-locker-worker.mjs` 同步内嵌Worker。

限制：HMAC fragment不抵御能够读取完整含CK链接的主动攻击者，也不抵御提供恶意下载JavaScript的受损站点；本修复针对无CK的存储截断/替换及意外损坏，不扩大端到端加密承诺。没有真实云部署验收。

## 主 agent 最终集成结果

本组相关用例已纳入Windows Rust第三轮493项通过的回归；迁移末次内容校验补丁另经2项定向通过。前端178项、生产构建、Android Rust检查、Android Kotlin编译均通过。具体运行范围、过滤项及Apple/真机边界以[总进度](进度.md)为准，以上早期“待验证”记录保留为过程历史。
