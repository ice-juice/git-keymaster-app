import { decryptBlob } from "./frame.ts";
import { parseFragment } from "./fragment.ts";

type Metadata = { version: string; cipherSize: number; expireAt: string | null; pullsLeft: number | null; status: string };
type Claim = { operationId: string; token?: string; version: string; state?: string; recoveryUntil?: string; attempts?: number; cleanupStatus?: string; pullsLeft?: number | null; cipherSize?: number };
const MAX_BYTES = 100 * 1024 * 1024 + 64 * 1024;
const form = document.querySelector<HTMLFormElement>("#pick")!;
const input = document.querySelector<HTMLInputElement>("#code")!;
const error = document.querySelector<HTMLElement>("#error")!;
const status = document.querySelector<HTMLElement>("#status")!;
const query = document.querySelector<HTMLButtonElement>("#go")!;
const receive = document.querySelector<HTMLButtonElement>("#receive")!;
const cancel = document.querySelector<HTMLButtonElement>("#cancel")!;
const saveAgain = document.querySelector<HTMLButtonElement>("#save-again")!;
const details = document.querySelector<HTMLElement>("#details")!;
const slug = document.body.dataset.slug || "";
const shareBase = location.origin + location.pathname.slice(0, location.pathname.lastIndexOf("/d/"));
let metadata: Metadata | null = null;
let claim: Claim | null = null;
let busy = false;
let savedUrl = "";
let savedName = "download.bin";
const storageKey = `locker.claim.v2.${slug}`;
try {
  const raw = JSON.parse(sessionStorage.getItem(storageKey) || "null") as Claim | null;
  if (raw && /^[A-Za-z0-9_-]{8,80}$/.test(raw.operationId) && typeof raw.version === "string" && (!raw.token || /^[a-f0-9]{64}$/.test(raw.token))) claim = raw;
} catch { /* Keep operation state in this page if sessionStorage is unavailable. */ }
function persist() { try { if (claim) sessionStorage.setItem(storageKey, JSON.stringify(claim)); else sessionStorage.removeItem(storageKey); } catch { /* no disk fallback for capabilities */ } }
function explain(code: string): string {
  return ({ bad_code: "取件码不正确。", locked: "尝试过多，请等待 15 分钟后再试。", not_found: "分享入口不存在或已停止，请联系发送方。", expired: "文件已到期，不能开始新的领取。", no_allowance: "没有可用领取名额，可能正在被其他人领取。", version_conflict: "文件信息已变化，请重新查询。", operation_conflict: "领取操作不匹配，不能自动创建另一笔领取。", session_expired: "本次恢复窗口已结束，请联系发送方确认。", attempts_exhausted: "本次领取的恢复次数已用完，请联系发送方。", protocol_upgrade_required: "发送方需要升级取件服务后重新分享。", storage_unavailable: "连接暂时异常。请继续本次操作，不要新建领取。", delivery_started: "内容已经开始交付，不能退回领取名额。", invalid: "请检查取件码和分享链接。", missing_fragment: "链接缺少或未通过完整性验证，请发送方重新复制分享链接（保留 # 后的完整信息）。", decrypt_failed: "内容未能通过解密校验。请核对完整链接，可继续本次领取。" } as Record<string, string>)[code] || "操作结果暂时无法确认，请继续本次操作。";
}
async function request(path: string, body: object, binary = false) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "omit", cache: "no-store", redirect: "error" });
  if (!res.ok) { const b = await res.json().catch(() => ({})) as { error?: string }; throw new Error(b.error || "storage_unavailable"); }
  if (binary) return res;
  return res.json();
}
async function readCiphertext(response: Response): Promise<Uint8Array> {
  const announced = Number(response.headers.get("content-length"));
  if (announced > MAX_BYTES || !response.body) throw new Error("size_mismatch");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const next = await reader.read(); if (next.done) break;
    size += next.value.length;
    if (size > MAX_BYTES) { await reader.cancel(); throw new Error("size_mismatch"); }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
function normalizedCode() { return input.value.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 65248)).replace(/\s/g, ""); }
function lock(value: boolean) { busy = value; query.disabled = value || !!claim; receive.disabled = value; input.disabled = value || !!claim?.token; cancel.disabled = value; }
function saveBlob() { const a = document.createElement("a"); a.href = savedUrl; a.download = savedName; a.click(); }
function sizeLabel(size: number) { return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KiB` : `${(size / 1024 / 1024).toFixed(2)} MiB`; }
async function renderClaim() {
  if (!claim) return;
  details.hidden = false;
  receive.textContent = claim.state === "delivered" ? "确认领取结果" : "继续本次领取";
  cancel.hidden = ![undefined, "reserved"].includes(claim.state);
  query.disabled = true; input.disabled = !!claim.token;
  receive.disabled = busy || claim.state === "expired" || claim.state === "cancelled";
  if (claim.state === "delivered") receive.hidden = true;
  const fragment = await parseFragment(location.hash, shareBase, slug);
  if (fragment) { document.querySelector("#file-name")!.textContent = fragment.filename; fragment.key.fill(0); }
  if (claim.pullsLeft !== undefined) document.querySelector("#rules")!.textContent = `${claim.state === "delivered" ? "本次领取已完成" : "继续本次领取不会再扣名额"} · ${claim.pullsLeft === null ? "不限次领取" : `可供新领取 ${claim.pullsLeft} 个名额`}`;
  status.textContent = claim.state === "delivered" ? "已确认内容交付。浏览器保存位置请在下载记录中检查。" : "已有领取操作。继续会使用同一名额，不会创建新的领取。";
}
function clearBeforeDelivery() { claim = null; persist(); metadata = null; details.hidden = true; lock(false); cancel.hidden = true; }
form?.addEventListener("submit", async ev => {
  ev.preventDefault(); if (busy || claim) return;
  error.textContent = "";
  lock(true);
  const fragment = await parseFragment(location.hash, shareBase, slug); if (!fragment) { error.textContent = explain("missing_fragment"); lock(false); return; }
  fragment.key.fill(0);
  const code = normalizedCode(); if (!/^\d{6}$/.test(code)) { error.textContent = "请输入 6 位数字取件码。"; lock(false); return; }
  lock(true);
  try {
    metadata = await request(`/v2/shares/${slug}/lookup`, { code }) as Metadata;
    document.querySelector("#file-name")!.textContent = fragment.filename;
    document.querySelector("#rules")!.textContent = `${metadata.expireAt ? `截止 ${new Date(metadata.expireAt).toLocaleString()}` : "未设截止时间"} · ${metadata.pullsLeft == null ? "不限次领取" : `剩余 ${metadata.pullsLeft} 个名额`} · 密文 ${sizeLabel(metadata.cipherSize)}`;
    details.hidden = false; status.textContent = "取件信息已验证。";
  } catch (e) { metadata = null; details.hidden = true; error.textContent = explain((e as Error).message); }
  finally { lock(false); if (metadata?.pullsLeft === 0) receive.disabled = true; }
});
input?.addEventListener("input", () => { if (!claim) { metadata = null; details.hidden = true; error.textContent = ""; status.textContent = ""; } });
receive?.addEventListener("click", async () => {
  if (busy || (!metadata && !claim)) return;
  lock(true);
  const fragment = await parseFragment(location.hash, shareBase, slug); if (!fragment) { error.textContent = explain("missing_fragment"); lock(false); return; }
  lock(true); error.textContent = "";
  try {
    if (!claim) { claim = { operationId: crypto.randomUUID(), version: metadata!.version }; persist(); }
    if (!claim.token) {
      if (!/^\d{6}$/.test(normalizedCode())) throw new Error("invalid");
      claim = await request(`/v2/shares/${slug}/claims`, { operationId: claim.operationId, expectedVersion: claim.version, code: normalizedCode() }) as Claim;
      persist();
    } else { claim = await request(`/v2/claims/${claim.operationId}/status`, { token: claim.token }) as Claim; persist(); }
    if (claim.state === "delivered") { status.textContent = "已确认内容交付。请在浏览器下载记录中检查保存结果。"; return; }
    if (claim.state === "cancelled" || claim.state === "expired") { error.textContent = explain("session_expired"); receive.disabled = true; return; }
    if (savedUrl) {
      // A lost ACK does not require another content delivery. Retain the saved
      // Blob locally and retry only the original acknowledgement.
      claim = await request(`/v2/claims/${claim.operationId}/ack`, { token: claim.token }) as Claim; persist();
      receive.hidden = true; cancel.hidden = true; return;
    }
    status.textContent = "正在领取并解密…";
    // Treat the outcome as potentially delivered until a status read proves
    // otherwise; a lost network response must not offer an unsafe refund.
    claim.state = "delivering"; persist();
    const response = await request(`/v2/claims/${claim.operationId}/content`, { token: claim.token }, true) as Response;
    const bytes = await readCiphertext(response);
    let plain: Uint8Array;
    try { plain = decryptBlob(bytes, fragment.key, fragment.plainSize); } catch { throw new Error("decrypt_failed"); }
    if (savedUrl) URL.revokeObjectURL(savedUrl);
    const buffer = new ArrayBuffer(plain.byteLength); new Uint8Array(buffer).set(plain); plain.fill(0);
    savedUrl = URL.createObjectURL(new Blob([buffer], { type: "application/octet-stream" })); savedName = fragment.filename;
    saveBlob(); saveAgain.hidden = false;
    status.textContent = "解密完成，已发起保存。请在浏览器下载记录中确认实际保存结果。";
    claim = await request(`/v2/claims/${claim.operationId}/ack`, { token: claim.token }) as Claim; persist();
    receive.hidden = true; cancel.hidden = true;
  } catch (e) {
    error.textContent = explain((e as Error).message);
    if (claim?.token) {
      try { claim = await request(`/v2/claims/${claim.operationId}/status`, { token: claim.token }) as Claim; persist(); }
      catch { /* unknown remains attached to this original operation */ }
    }
    if (claim?.state === "delivered" && savedUrl) { receive.hidden = true; cancel.hidden = true; error.textContent = ""; }
    renderClaim();
  }
  finally { fragment.key.fill(0); lock(false); if (claim) renderClaim(); }
});
cancel?.addEventListener("click", async () => {
  if (busy || !claim) return;
  lock(true); error.textContent = "";
  try {
    if (!claim.token) claim = await request(`/v2/shares/${slug}/claims`, { operationId: claim.operationId, expectedVersion: claim.version, code: normalizedCode() }) as Claim;
    const result = await request(`/v2/claims/${claim.operationId}/cancel`, { token: claim.token }) as Claim;
    if (result.state === "cancelled") { clearBeforeDelivery(); status.textContent = "预留已取消，未开始内容交付。"; }
  } catch (e) { error.textContent = explain((e as Error).message); }
  finally { lock(false); if (claim) renderClaim(); }
});
saveAgain?.addEventListener("click", () => { if (savedUrl) saveBlob(); });
window.addEventListener("pagehide", () => { if (savedUrl) URL.revokeObjectURL(savedUrl); });
if (claim) renderClaim();
