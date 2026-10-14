/** RFC 6238 / 谷歌验证器：剩余秒 = period - (unix 秒 % period)，整除时为满周期。 */

export type TotpLiveCode = {
  code: string;
  remain: number;
  period: number;
  /** floor(unix 秒 / period)。码只在这个计数变化时轮换。 */
  step: number;
};

export function totpPeriod(period: number): number {
  return period > 0 ? period : 30;
}

export function totpRemainSeconds(period: number, nowMs = Date.now()): number {
  const safe = totpPeriod(period);
  const elapsed = Math.floor(nowMs / 1000) % safe;
  return elapsed === 0 ? safe : safe - elapsed;
}

export function totpTimeStep(period: number, nowMs = Date.now()): number {
  const safe = totpPeriod(period);
  return Math.floor(Math.floor(nowMs / 1000) / safe);
}

/** 距离下一个 Unix 整秒的毫秒数。已在整秒上则等到下一秒，避免 0 延迟空转。 */
export function msUntilNextUnixSecond(nowMs: number): number {
  const mod = nowMs % 1000;
  return mod === 0 ? 1000 : 1000 - mod;
}

export function packTotpLiveCode(code: string, period: number, nowMs: number): TotpLiveCode {
  const safe = totpPeriod(period);
  return {
    code,
    period: safe,
    remain: totpRemainSeconds(safe, nowMs),
    step: totpTimeStep(safe, nowMs),
  };
}

/**
 * 用生成前后的本地 Unix 时间确认验证码落在同一步。
 * 调用跨过步长边界时重取；仍跨过则把 step 记成上一拍，让时钟下一秒再取。
 */
export async function adoptGeneratedTotp(
  fetchCode: () => Promise<{ code: string; period: number }>,
): Promise<TotpLiveCode> {
  let last: { code: string; period: number } | null = null;
  let lastAfter = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = Date.now();
    const got = await fetchCode();
    const after = Date.now();
    last = got;
    lastAfter = after;
    const period = totpPeriod(got.period);
    if (totpTimeStep(period, before) === totpTimeStep(period, after)) {
      return packTotpLiveCode(got.code, period, after);
    }
  }
  const period = totpPeriod(last!.period);
  const packed = packTotpLiveCode(last!.code, period, lastAfter);
  return { ...packed, step: packed.step - 1 };
}

/** 按当前 Unix 时间重算剩余秒。步长变了就列出要重取的 id，先不改已显示的码。 */
export function syncTotpLiveCodes(
  prev: Record<string, TotpLiveCode>,
  nowMs: number,
): { next: Record<string, TotpLiveCode>; refreshIds: string[] } {
  const refreshIds: string[] = [];
  let changed = false;
  const next: Record<string, TotpLiveCode> = {};
  for (const id of Object.keys(prev)) {
    const item = prev[id];
    const period = totpPeriod(item.period);
    const step = totpTimeStep(period, nowMs);
    const remain = totpRemainSeconds(period, nowMs);
    if (step !== item.step) refreshIds.push(id);
    if (remain !== item.remain || period !== item.period) {
      next[id] = { ...item, remain, period };
      changed = true;
    } else {
      next[id] = item;
    }
  }
  return { next: changed ? next : prev, refreshIds };
}

/** 对齐到 Unix 整秒刷新已揭开的验证码。read/write 必须同步更新同一份快照。 */
export function startTotpLiveClock(opts: {
  read: () => Record<string, TotpLiveCode>;
  write: (next: Record<string, TotpLiveCode>) => void;
  refresh: (id: string) => Promise<{ code: string; period: number }>;
  onTick?: (nowMs: number) => void;
}): () => void {
  const inflight = new Set<string>();
  let timer = 0;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    const stamp = Date.now();
    opts.onTick?.(stamp);
    const prev = opts.read();
    const { next, refreshIds } = syncTotpLiveCodes(prev, stamp);
    if (next !== prev) opts.write(next);
    for (const id of refreshIds) {
      if (inflight.has(id)) continue;
      inflight.add(id);
      adoptGeneratedTotp(() => opts.refresh(id))
        .then((packed) => {
          if (stopped) return;
          const cur = opts.read();
          if (!cur[id]) return;
          opts.write({ ...cur, [id]: packed });
        })
        .catch(() => {
          if (stopped) return;
          const cur = opts.read();
          if (!cur[id]) return;
          const { [id]: _drop, ...rest } = cur;
          opts.write(rest);
        })
        .finally(() => inflight.delete(id));
    }
    timer = window.setTimeout(tick, msUntilNextUnixSecond(Date.now()));
  };

  timer = window.setTimeout(tick, msUntilNextUnixSecond(Date.now()));
  return () => {
    stopped = true;
    window.clearTimeout(timer);
  };
}
