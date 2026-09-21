import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { generatePassword, passwordPools, unbiasedInt } from "./password.ts";

describe("unbiasedInt", () => {
  test("stays in range", () => {
    for (let i = 0; i < 200; i++) {
      const n = unbiasedInt(10);
      assert.ok(n >= 0 && n < 10);
    }
  });

  test("distribution is roughly uniform", () => {
    const buckets = new Array<number>(7).fill(0);
    const samples = 7000;
    for (let i = 0; i < samples; i++) buckets[unbiasedInt(7)]++;
    const expected = samples / 7;
    for (const count of buckets) {
      const delta = Math.abs(count - expected);
      assert.ok(delta < expected * 0.2, `bucket ${count} drifted from ${expected}`);
    }
  });
});

describe("generatePassword", () => {
  test("honors length and selected sets", () => {
    const opts = {
      length: 20,
      lower: true,
      upper: true,
      digits: true,
      symbols: false,
      excludeAmbiguous: true,
    };
    const pw = generatePassword(opts);
    assert.equal(pw.length, 20);
    assert.match(pw, /[a-z]/);
    assert.match(pw, /[A-Z]/);
    assert.match(pw, /[0-9]/);
    assert.doesNotMatch(pw, /[^a-zA-Z0-9]/);
    assert.doesNotMatch(pw, /[IlO01]/);
  });

  test("never emits characters outside the pool", () => {
    const opts = {
      length: 32,
      lower: false,
      upper: false,
      digits: true,
      symbols: true,
      excludeAmbiguous: false,
    };
    const allowed = new Set(passwordPools(opts).join(""));
    const pw = generatePassword(opts);
    assert.equal(pw.length, 32);
    for (const ch of pw) assert.ok(allowed.has(ch), `unexpected ${ch}`);
  });

  test("rejects empty charset", () => {
    assert.throws(() =>
      generatePassword({
        length: 12,
        lower: false,
        upper: false,
        digits: false,
        symbols: false,
        excludeAmbiguous: true,
      }),
    );
  });
});
