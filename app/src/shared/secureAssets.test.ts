import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createSensitiveEpoch } from "./sensitiveEpoch.ts";

type Dialog = { onCancel(): void; onConfirm(password: string): Promise<void> };
type Assets = {
  readSensitiveAsset(hash: string): Promise<string>;
  invalidateSensitiveAssets(): void;
};
function harness(read: (hash: string, password?: string) => Promise<string>) {
  const dialogs: Dialog[] = [];
  const source = readFileSync(new URL("../lib/secureAssets.tsx", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const exports = {};
  vm.runInNewContext(code, {
    exports, queueMicrotask,
    document: { createElement: () => ({ remove() {} }), body: { append() {} } },
    require(name: string) {
      if (name === "react/jsx-runtime") return { jsx: (_: unknown, props: Dialog) => props };
      if (name === "react-dom/client") return { createRoot: () => ({ render: (props: Dialog) => dialogs.push(props), unmount() {} }) };
      if (name === "./ipc") return { api: { noteAssetGet: read }, errCode: (e: { code?: string }) => e?.code };
      if (name === "../ui/ReauthDialog") return { ReauthDialog: {} };
      if (name === "../shared/sensitiveEpoch") return { createSensitiveEpoch };
      if (name === "./i18n") return { i18n: { t: () => "session revoked" } };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return { assets: exports as Assets, dialogs };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test("actual asset reader deduplicates only matching in-flight hashes and never caches resolved plaintext", async () => {
  const pending = new Map<string, (value: string) => void>();
  const calls: string[] = [];
  const { assets } = harness(hash => { calls.push(hash); return new Promise(resolve => pending.set(hash, resolve)); });
  const a = assets.readSensitiveAsset("hash-a");
  assert.equal(assets.readSensitiveAsset("hash-a"), a);
  const b = assets.readSensitiveAsset("hash-b");
  assert.notEqual(a, b);
  pending.get("hash-a")!("image-a"); pending.get("hash-b")!("image-b");
  assert.deepEqual(await Promise.all([a, b]), ["image-a", "image-b"]);
  await flush();
  const again = assets.readSensitiveAsset("hash-a");
  pending.get("hash-a")!("fresh-image-a");
  assert.equal(await again, "fresh-image-a");
  assert.deepEqual(calls, ["hash-a", "hash-b", "hash-a"]);
});

test("actual pending asset completion cannot return plaintext after lock and re-unlock", async () => {
  let finish!: (value: string) => void;
  const { assets } = harness(() => new Promise(resolve => { finish = resolve; }));
  const read = assets.readSensitiveAsset("protected-file-image");
  const rejected = assert.rejects(read, /session revoked/);
  assets.invalidateSensitiveAssets();
  assets.invalidateSensitiveAssets();
  finish("late data URL");
  await rejected;
});

test("zero-grace concurrent images use one dialog and each backend request receives fresh submitted password", async () => {
  const authenticated: string[] = [];
  const { assets, dialogs } = harness(async (hash, password) => {
    if (password === undefined) throw { code: "NEED_REAUTH" };
    assert.equal(password, " password with spaces ");
    authenticated.push(hash);
    return `image-${hash}`;
  });
  const a = assets.readSensitiveAsset("a"), b = assets.readSensitiveAsset("b");
  await flush();
  assert.equal(dialogs.length, 1);
  await dialogs[0].onConfirm(" password with spaces ");
  assert.deepEqual(await Promise.all([a, b]), ["image-a", "image-b"]);
  assert.deepEqual(authenticated, ["a", "b"]);
});

test("cancelled in-flight authentication never uses its password for a new dialog", async () => {
  let oldFinish!: (value: string) => void;
  const authCalls: string[] = [];
  const { assets, dialogs } = harness(async (hash, password) => {
    if (password === undefined) throw { code: "NEED_REAUTH" };
    authCalls.push(`${hash}:${password}`);
    if (hash === "old") return new Promise(resolve => { oldFinish = resolve; });
    return "new image";
  });
  const old = assets.readSensitiveAsset("old");
  const rejected = assert.rejects(old, /session revoked/);
  await flush();
  const submitting = dialogs[0].onConfirm("old-password");
  dialogs[0].onCancel();
  const next = assets.readSensitiveAsset("new");
  await flush();
  assert.equal(dialogs.length, 2);
  oldFinish("old plaintext");
  await submitting; await rejected;
  assert.deepEqual(authCalls, ["old:old-password"]);
  await dialogs[1].onConfirm("new-password");
  assert.equal(await next, "new image");
  assert.deepEqual(authCalls, ["old:old-password", "new:new-password"]);
});
