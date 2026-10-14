import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createLatestReader } from "./latestRead.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("vault status read coalescing", () => {
  test("先发出的锁定结果后返回时，保留后一次的解锁状态", async () => {
    const latest = createLatestReader<{ unlocked: boolean }>();
    let current: { unlocked: boolean } | null = null;
    const pending: Array<(value: { unlocked: boolean }) => void> = [];
    const fetch = () =>
      new Promise<{ unlocked: boolean }>((resolve) => {
        pending.push(resolve);
      });

    const first = latest(fetch, (value) => {
      current = value;
    });
    await Promise.resolve();
    assert.equal(pending.length, 1);
    const second = latest(fetch, (value) => {
      current = value;
    });
    assert.equal(pending.length, 1);

    pending.shift()?.({ unlocked: false });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(pending.length, 1, "进行中的锁定结果必须丢掉并再读一次");

    pending.shift()?.({ unlocked: true });
    await first;
    await second;
    assert.deepEqual(current, { unlocked: true });
  });

  test("没有更新的请求时，锁定结果仍然生效", async () => {
    const latest = createLatestReader<{ unlocked: boolean }>();
    let current: { unlocked: boolean } | null = null;
    const gate = deferred<{ unlocked: boolean }>();
    const done = latest(
      () => gate.promise,
      (value) => {
        current = value;
      },
    );
    gate.resolve({ unlocked: false });
    await done;
    assert.deepEqual(current, { unlocked: false });
  });
});
