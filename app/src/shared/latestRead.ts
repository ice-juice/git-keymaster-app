/**
 * 把多次读取收成「只采用最后一次」。
 *
 * 进行中的那次若在返回前又来了新请求，这次结果丢掉，立刻再读。
 * 用来挡住解锁前后两笔 `vault_status`：先发出的锁定结果不能在指纹成功之后把界面打回去。
 */
export function createLatestReader<T>() {
  let queued = false;
  let chain: Promise<void> = Promise.resolve();

  return function latest(read: () => Promise<T>, apply: (value: T) => void): Promise<void> {
    queued = true;
    const run = chain.then(async () => {
      while (queued) {
        queued = false;
        try {
          const value = await read();
          if (queued) continue;
          apply(value);
        } catch (err) {
          if (queued) continue;
          throw err;
        }
      }
    });
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
