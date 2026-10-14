import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  adoptGeneratedTotp,
  msUntilNextUnixSecond,
  packTotpLiveCode,
  syncTotpLiveCodes,
  totpRemainSeconds,
  totpTimeStep,
} from "./totpTime.ts";

describe("totpRemainSeconds", () => {
  test("剩余秒对齐 Unix epoch 的 30 秒步长", () => {
    assert.equal(totpRemainSeconds(30, 0), 30);
    assert.equal(totpRemainSeconds(30, 1_000), 29);
    assert.equal(totpRemainSeconds(30, 29_000), 1);
    assert.equal(totpRemainSeconds(30, 29_999), 1);
    assert.equal(totpRemainSeconds(30, 30_000), 30);
    assert.equal(totpRemainSeconds(30, 30_001), 30);
    // RFC 6238 时间点：59 与 1111111109 都落在步长的最后一秒
    assert.equal(totpRemainSeconds(30, 59_000), 1);
    assert.equal(totpTimeStep(30, 59_000), 1);
    assert.equal(totpRemainSeconds(30, 1_111_111_109_000), 1);
    assert.equal(totpTimeStep(30, 1_111_111_109_000), Math.floor(1_111_111_109 / 30));
  });

  test("非法步长退回 30 秒", () => {
    assert.equal(totpRemainSeconds(0, 31_000), totpRemainSeconds(30, 31_000));
    assert.equal(totpRemainSeconds(-5, 31_000), totpRemainSeconds(30, 31_000));
  });
});

describe("syncTotpLiveCodes", () => {
  test("按真实 Unix 时间重算，而不是从挂载起每拍减 1", () => {
    const prev = { a: packTotpLiveCode("111111", 30, 10_000) };
    assert.equal(prev.a.remain, 20);
    const { next, refreshIds } = syncTotpLiveCodes(prev, 15_000);
    assert.equal(next.a.remain, 15);
    assert.equal(next.a.code, "111111");
    assert.equal(next.a.step, prev.a.step);
    assert.deepEqual(refreshIds, []);
  });

  test("步长边界才要求换码，剩余秒跳回满周期", () => {
    const prev = { a: packTotpLiveCode("111111", 30, 29_000) };
    assert.equal(prev.a.remain, 1);
    const { next, refreshIds } = syncTotpLiveCodes(prev, 30_000);
    assert.equal(next.a.remain, 30);
    assert.equal(next.a.code, "111111");
    assert.equal(next.a.step, prev.a.step);
    assert.deepEqual(refreshIds, ["a"]);
  });
});

describe("adoptGeneratedTotp", () => {
  test("生成调用跨过步长边界时重取，码和剩余秒落在新步长", async () => {
    const times = [29_500, 30_200, 30_300, 30_400];
    let i = 0;
    const real = Date.now;
    Date.now = () => times[Math.min(i++, times.length - 1)];
    try {
      let calls = 0;
      const packed = await adoptGeneratedTotp(async () => {
        calls += 1;
        return { code: calls === 1 ? "old" : "new", period: 30 };
      });
      assert.equal(calls, 2);
      assert.equal(packed.code, "new");
      assert.equal(packed.step, totpTimeStep(30, 30_400));
      assert.equal(packed.remain, totpRemainSeconds(30, 30_400));
    } finally {
      Date.now = real;
    }
  });
});

describe("msUntilNextUnixSecond", () => {
  test("定时器落在下一个整秒", () => {
    assert.equal(msUntilNextUnixSecond(10_200), 800);
    assert.equal(msUntilNextUnixSecond(11_000), 1000);
  });
});
