import { createRoot, type Root } from "react-dom/client";
import { api, errCode } from "./ipc";
import { ReauthDialog } from "../ui/ReauthDialog";
import { createSensitiveEpoch } from "../shared/sensitiveEpoch";
import { i18n } from "./i18n";

const boundary = createSensitiveEpoch();
type Request = {
  epoch: number;
  execute: (password: string) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};
let queue: Request[] = [];
let dialog: { root: Root; host: HTMLElement } | null = null;
let submitting = false;
let dialogGeneration = 0;
const pendingImages = new Map<string, Promise<string>>();

function revoked() {
  return new Error(i18n.t("reauth.sessionChanged", { defaultValue: i18n.resolvedLanguage?.startsWith("zh") ? "操作已取消或会话已改变，请重新验证。" : "The operation was cancelled or the session changed. Please verify again." }));
}

function closeDialog() {
  const old = dialog;
  dialog = null;
  if (old) queueMicrotask(() => { old.root.unmount(); old.host.remove(); });
}

function cancelRequests() {
  dialogGeneration += 1;
  const cancelled = queue;
  queue = [];
  for (const item of cancelled) item.reject(revoked());
  closeDialog();
}

/** Called before manual lock and on lock/workspace/status transitions. */
export function invalidateSensitiveAssets() {
  boundary.invalidate();
  pendingImages.clear();
  cancelRequests();
}

export const subscribeSensitiveAssetsInvalidated = boundary.subscribe;

function showDialog() {
  if (dialog) return;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  dialog = { root, host };
  const generation = ++dialogGeneration;
  root.render(<ReauthDialog onCancel={cancelRequests} onConfirm={async (password) => {
    if (submitting) return;
    submitting = true;
    try {
      // Password exists only for this submission; it is never put in a cache,
      // storage, event payload or long-lived authorization token.
      while (queue.length && generation === dialogGeneration) {
        const item = queue[0];
        if (!boundary.isCurrent(item.epoch)) {
          queue.shift(); item.reject(revoked()); continue;
        }
        try {
          const result = await item.execute(password);
          if (!boundary.isCurrent(item.epoch)) throw revoked();
          if (queue[0] === item) queue.shift();
          item.resolve(result);
        } catch (error) {
          if (errCode(error) === "BAD_PASSWORD" || errCode(error) === "NEED_REAUTH") throw error;
          if (queue[0] === item) queue.shift();
          item.reject(error);
        }
      }
      if (dialog?.root === root) closeDialog();
    } finally {
      submitting = false;
    }
  }} />);
}

export async function withSensitiveAuthorization<T>(execute: (password?: string) => Promise<T>): Promise<T> {
  const epoch = boundary.snapshot();
  try {
    const result = await execute();
    if (!boundary.isCurrent(epoch)) throw revoked();
    return result;
  } catch (error) {
    if (!boundary.isCurrent(epoch) || errCode(error) !== "NEED_REAUTH") throw error;
    return new Promise<T>((resolve, reject) => {
      queue.push({ epoch, execute, resolve: (value) => resolve(value as T), reject });
      showDialog();
    });
  }
}

/** Deduplicate in-flight reads only: resolved plaintext is not globally cached. */
export function readSensitiveAsset(hash: string): Promise<string> {
  const key = `${boundary.snapshot()}:${hash}`;
  const pending = pendingImages.get(key);
  if (pending) return pending;
  const request = withSensitiveAuthorization((password) => api.noteAssetGet(hash, password));
  pendingImages.set(key, request);
  void request.finally(() => {
    if (pendingImages.get(key) === request) pendingImages.delete(key);
  }).catch(() => {});
  return request;
}
