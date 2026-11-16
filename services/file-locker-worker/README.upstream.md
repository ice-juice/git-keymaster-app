# 文件寄存柜分享 Worker

这是给**你自己**部署的 Cloudflare Worker 模板。御钥师不运营中心服务。对方打开的是你的短域名。

这份实现已经和御钥师 App 对齐，依据是 `app/src-tauri/src/locker/worker.rs` 与 `locker/mod.rs`。不要改 App 去迁就这里；两边的签名串、取件码哈希和登记 JSON 必须逐字节一致。

下面每一步都标明在哪里做。

| 标记 | 意思 |
|---|---|
| **本机** | 在这台电脑的 PowerShell 里执行。先进入本目录 `D:\coding_program\file-locker-worker` |
| **浏览器** | `wrangler login` 会自己打开 Cloudflare 登录页，你只要在网页上点允许 |
| **Cloudflare 网页** | 打开 https://dash.cloudflare.com 。只有绑自己的短域名时才需要进网页 |

密钥不要写进 `wrangler.toml`，也不要提交 `.dev.vars`。

## 0. 本机准备

**本机。** 需要 Node.js 22 或更高，以及一个 Cloudflare 账号。

```powershell
node -v
cd D:\coding_program\file-locker-worker
npm install
```

`node -v` 成功时打印 `v22` 或更高。`npm install` 成功时最后一行类似 `added … packages`，并且本目录出现 `node_modules`。这一步只改本机，不会在 Cloudflare 上创建任何东西。

## 1. 登录 Cloudflare

**本机，随后是浏览器。**

```powershell
npx wrangler login
```

终端会打开浏览器。在网页上登录 Cloudflare，点允许，回到终端。成功时出现 `Successfully logged in`。

```powershell
npx wrangler whoami
```

成功时能看到账号邮箱和一行 `Account ID`。后面的 `wrangler` 命令都打到这个账号。

## 2. 创建 D1 数据库

**本机。** 命令会在 Cloudflare 上建库，不用自己进网页点创建。

先看 `wrangler.toml` 里的 `database_id`。如果已经是一串真正的 UUID，不是全 0，说明库已经建过，跳到第 3 步。

```powershell
npx wrangler d1 create file-locker
```

成功时有 `Successfully created DB 'file-locker'`，以及 `database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"`。名称已存在就不要再建，到 Cloudflare 网页「存储和数据库 → D1 → file-locker」复制 Database ID。

**本机。** 把这串 id 填进 `wrangler.toml` 的 `database_id`。不要改 `database_name`，它必须仍是 `file-locker`。

## 3. 把表结构建到线上 D1

**本机。** `--remote` 表示改的是 Cloudflare 上的库，不是你电脑里的临时库。

```powershell
npx wrangler d1 migrations apply file-locker --remote
```

成功时列出 `0001_locker.sql`，并出现 `Successfully applied 1 migration`。已经应用过会写 `No migrations to apply`，这也算成功。

核对表是否真的在：

```powershell
npx wrangler d1 execute file-locker --remote --command "SELECT name FROM sqlite_master WHERE type='table' AND name='locker';"
```

成功时结果里有一行 `locker`。没有这行就不要继续部署。

## 4. 绑定云同步那只 R2 桶

**本机。** 寄存文件上传到御钥师「云同步」里配置的那只桶，对象键是 `你的前缀/locker/...`。Worker 登记和下载也读这只桶。不要另建一只空的 `file-locker` 桶，否则生成分享会返回 `missing_object`。

1. 打开御钥师「云同步」，抄下存储桶名称，例如 `my-sync`。
2. 用编辑器打开 `wrangler.toml`，把 `bucket_name = "file-locker"` 改成那个名称。`binding` 保持 `LOCKER_BUCKET` 不变。
3. 确认桶已经在这个 Cloudflare 账号里：

```powershell
npx wrangler r2 bucket list
```

成功时列表里能看到云同步那个桶名。看不到再创建同名桶：

```powershell
npx wrangler r2 bucket create 云同步里的桶名
```

改完 `wrangler.toml` 后必须重新执行第 6 步的 `npx wrangler deploy`，绑定才会换过去。

## 5. 设置共享密钥

**本机。** 先生成一串至少 16 个字符的随机密钥。Windows 上用 Node，不必装 OpenSSL：

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

成功时只打印一行。这就是以后填进御钥师的共享密钥。把它存进密码管理器。不要写进 `wrangler.toml`，不要提交到 git。

然后把同一串交给 Cloudflare。这条命令会停下来等你粘贴：

```powershell
npx wrangler secret put LOCKER_HMAC_SECRET
```

出现 `Enter a secret value:` 后，粘贴刚才那一行，回车。成功时出现 `Success! Uploaded secret LOCKER_HMAC_SECRET`。

```powershell
npx wrangler secret list
```

成功时列表里有 `LOCKER_HMAC_SECRET`。这里只显示名字，不显示密钥内容。

## 6. 部署 Worker

**本机。**

```powershell
npx wrangler deploy
```

成功时最后有一行 `https://file-locker.<你的子域>.workers.dev`，以及 `Current Version ID`，并且提到 cron `* * * * *`。这个定时任务每分钟扫一次，删掉过期或次数用尽的对象。部署成功就表示定时任务已经挂上，不用在网页里再点一次。

记下这个 `workers.dev` 地址。还没绑自己的域名时，御钥师可以先填它。

**本机验证线上是否真的在应答。** 把地址换成上一步打印的那个。

```powershell
curl.exe https://file-locker.<你的子域>.workers.dev/
```

成功时正文是：

```json
{"service":"file-locker","ok":true}
```

再看未登记的链接会不会崩：

```powershell
curl.exe -i https://file-locker.<你的子域>.workers.dev/d/aaaaaaaaaa
```

成功时状态码是 `404`，正文是一段「链接不存在」的页面，不是 `500`，也不是 `Worker threw an exception`。

未带签名就登记，应该被拒绝：

```powershell
curl.exe -i -X POST https://file-locker.<你的子域>.workers.dev/register -H "content-type: application/json" -d "{}"
```

成功时状态码是 `401`。

这三下都对，Worker、D1 绑定和密钥才算接上。`401` 只说明门禁在，还不能说明御钥师已经能分享。

## 7. 绑定自己的短域名

这一步才需要 **Cloudflare 网页**。没有自己的域名可以跳过，御钥师先用第 6 步的 `workers.dev` 地址。

1. 打开 https://dash.cloudflare.com → **Workers 和 Pages** → **file-locker**。
2. **设置 → 域和路由 → 添加 → 自定义域**。
3. 填 `locker.你的域名`，保存。

域名的 DNS 已经由这个 Cloudflare 账号托管时，保存后它会自己加记录。DNS 在别处时，网页会给出一条 CNAME，要到域名注册商那里把 `locker` 指到它写的目标。

成功时，这一页的自定义域状态变成有效，不是「正在初始化」一直转圈。然后在本机：

```powershell
curl.exe https://locker.你的域名/
```

成功时同样是 `{"service":"file-locker","ok":true}`。

## 8. 填回御钥师

**在御钥师窗口里操作，不是终端，也不是 Cloudflare 网页。**

打开「文件寄存柜」，点右上角 **配置**。

| 项 | 填什么 |
|---|---|
| Worker 地址 | 第 7 步的 `https://locker.你的域名`，或还没绑域名时用第 6 步的 `https://file-locker.<子域>.workers.dev`。不要末尾斜杠 |
| 共享密钥 | 第 5 步生成并粘贴进 `wrangler secret put` 的那一整行。不要首尾空格 |

点保存。没配这两项时，寄存和自取仍然可用，只是不能生成分享链接。

**在御钥师里做一次真分享，才算端到端成功：**

1. 寄存一个很小的文件，时长短一点，次数设为 1。
2. 点生成分享。成功时出现链接和二维码，没有「连接分享服务失败」或 HTTP 401。
3. 用浏览器打开该链接（井号后面的内容要保留），输入 6 位取件码。成功时开始下载，下载后的文件能打开。
4. 因为次数是 1，再打开同一链接应提示链接已失效。

## 本地试跑

只在改 Worker 代码时用。分享给别人必须走上面的线上部署，`wrangler dev` 的地址外网打不开。

**本机：**

```powershell
Copy-Item .dev.vars.example .dev.vars
```

用编辑器把 `.dev.vars` 里的 `LOCKER_HMAC_SECRET=` 改成一串至少 16 个字符的值。这个文件已在 `.gitignore` 里。本地密钥和线上密钥可以不同。御钥师要连线上 Worker 时，填的是线上那一串，不是 `.dev.vars`。

```powershell
npx wrangler d1 migrations apply file-locker --local
npm run dev
```

成功时终端出现 `Ready on http://127.0.0.1:8787`。另开一个窗口：

```powershell
curl.exe http://127.0.0.1:8787/
```

成功时同样是 `{"service":"file-locker","ok":true}`。

本地不会每分钟跑 Cron。过期清扫由 `npm test` 覆盖；线上由部署后的 cron 触发。

```powershell
npm test
```

成功时最后是 `fail 0`。

## 鉴权（登记和吊销）

`POST /register` 和 `DELETE /register/<slug>` 用共享密钥做 HMAC-SHA256。密钥是共享密钥的 UTF-8 字节。签名是小写 hex。

规范串，没有额外前缀：

```text
{unix秒时间戳}
{nonce小写hex}
{METHOD}
{path}
{body的SHA-256小写hex}
```

- `METHOD` 是大写，App 传 `POST` 或 `DELETE`。
- `path` 只含 URL 路径，例如 `/register`、`/register/<slug>`。不含主机名，不含 query。
- nonce 是 16 字节随机数的小写 hex，共 32 个字符。
- DELETE 的 body 为空，哈希的是空字节串。
- 请求头：`X-Locker-Timestamp`、`X-Locker-Nonce`、`X-Locker-Signature`。
- 时间戳和 Worker 时钟相差超过 300 秒则拒绝。

slug 已存在时返回 HTTP 409，App 会换一个 slug 再登记。

## 取件码哈希

与共享密钥无关。HMAC-SHA256 的密钥是公开字节 `gam-locker-code-v1`（App 里的 `LABEL_LOCKER_CODE`），消息是 6 位数字的 UTF-8，输出小写 hex。不要加 `locker-pickup-v1` 之类的前缀。

`482193` 的哈希：

```text
8e9eaf8aca0e5ca697acf681978ca4699ff7d3606647b5f6d8bcf5549574a3ca
```

下载页把用户输入的 6 位码 POST 到 `/api/<slug>`，Worker 用同一算法和 D1 里的 `code_hash` 比对。日志不记取件码明文，也不记内容密钥。

## 登记 JSON

`POST /register` 的字段是 snake_case：

```json
{
  "slug": "aB3dE6gH9k",
  "object_key": "你的同步前缀/locker/对象名hmac",
  "code_hash": "64位小写hex",
  "size": 1234,
  "expire_at": "2026-10-17T00:00:00Z",
  "max_pulls": 1,
  "pulls_left": 1
}
```

`expire_at`、`max_pulls`、`pulls_left` 可以是 `null`，表示永久或不限次数。`object_key` 是桶里的完整对象键，带上你在云同步里配置的前缀，后面是 `locker/<hmac>`。登记前对象必须已经在绑定的 R2 桶里，且字节数等于 `size`。单文件密文上限 100 MB。

`slug` 必须是 App 生成的 10 字符 base62，Worker 不自增编号。

## 取件

`POST /api/<slug>`，JSON `{"code":"482193"}`。校验未过期、未锁定、剩余次数大于 0、哈希匹配后，原子递减，再流式返回密文。

响应头：

- `X-Locker-Pulls-Left`：剩余次数。不限次数时不送这个头。
- `X-Locker-Burned`：`1` 表示这次之后已经焚毁。

归零则删除 R2 对象并删掉 D1 行。连续错误 5 次锁定 15 分钟（HTTP 423）。累计错误 20 次把分享标为吊销，`GET /d/<slug>` 和 `POST /api/<slug>` 返回 404；这时 R2 对象还在，等过期、次数归零，或 App 调用 `DELETE /register/<slug>` 再删。

## 下载页和密文帧

`GET /d/<slug>` 由这个 Worker 直接返回极简页面，不必再单独建 Pages。页面从 `location.hash` 读取内容密钥，不会把 hash 发给服务器。

v1 不做 HKDF。解密密钥就是 fragment 里的 32 字节 CK。

帧格式与文件保险库 `store/blob.rs` 的 `GKB1` 一致：

```text
magic(4 = "GKB1") || version(1 = 1) || chunk_size(u32 小端)
重复：nonce(24) || XChaCha20-Poly1305(明文块, AAD = 块序号 u64 小端)
```

密文自带 16 字节 tag。除最后一块外，每块明文长度等于 `chunk_size`。`chunk_size` 在 1 到 8 MiB 之间，App 使用 1 MiB。

浏览器 WebCrypto 没有 XChaCha20-Poly1305，下载页在本地用 `@noble/ciphers` 解密，密钥不离开浏览器。

fragment 写法：`#<ck>`，ck 为 32 字节的无填充 base64url，或 64 位十六进制。可选文件名：`#<ck>.<文件名的 base64url>`，文件名也不会发给服务器。

## 目录

```text
wrangler.toml
migrations/0001_locker.sql
src/index.ts          Worker 入口
src/handle.ts         路由、D1、R2、Cron
src/auth.ts           与 App 一致的 HMAC
src/frame.ts          GKB1 解密
src/download-client.ts
src/page.ts
test/                 node:test
```

D1 表 `locker` 的主键是 `slug`。另外有 `fail_streak` 和 `locked_until`，用来记住连续错误和 15 分钟锁定。
