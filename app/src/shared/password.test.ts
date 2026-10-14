import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { generatePassword, passwordPools, passwordRootTooLong, unbiasedInt } from "./password.ts";

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

const digitsOnly = {
  length: 15,
  lower: false,
  upper: false,
  digits: true,
  symbols: false,
  excludeAmbiguous: false,
};

describe("password root", () => {
  test("blank root matches a fully random password", () => {
    for (const root of [undefined, "", "   ", "\n\t"]) {
      const pw = generatePassword({ ...digitsOnly, length: 12, root, rootPosition: "mid" });
      assert.equal(pw.length, 12);
      assert.match(pw, /^[0-9]+$/);
    }
  });

  test("keeps the root text and places it at the start, end, or middle", () => {
    const root = "Hello!";
    const head = generatePassword({ ...digitsOnly, root, rootPosition: "head" });
    assert.equal(head.length, 15);
    assert.equal(head.slice(0, root.length), root);
    assert.match(head.slice(root.length), /^[0-9]{9}$/);

    const implied = generatePassword({ ...digitsOnly, root });
    assert.equal(implied.slice(0, root.length), root);

    const tail = generatePassword({ ...digitsOnly, root, rootPosition: "tail" });
    assert.equal(tail.slice(-root.length), root);
    assert.match(tail.slice(0, 9), /^[0-9]{9}$/);

    const mid = generatePassword({ ...digitsOnly, root, rootPosition: "mid" });
    assert.equal(mid.slice(5, 11), root);
    assert.match(mid.slice(0, 5), /^[0-9]{5}$/);
    assert.match(mid.slice(11), /^[0-9]{4}$/);

    const even = generatePassword({ ...digitsOnly, length: 16, root, rootPosition: "mid" });
    assert.equal(even.length, 16);
    assert.equal(even.slice(5, 11), root);
    assert.match(even.slice(0, 5), /^[0-9]{5}$/);
    assert.match(even.slice(11), /^[0-9]{5}$/);
  });

  test("keeps spaces around a non-blank root", () => {
    const pw = generatePassword({ ...digitsOnly, length: 10, root: " a ", rootPosition: "head" });
    assert.equal(pw.length, 10);
    assert.equal(pw.slice(0, 3), " a ");
    assert.match(pw.slice(3), /^[0-9]+$/);
  });

  test("does not truncate a root that fills or exceeds the length", () => {
    const root = "Hello!Hello!";
    for (const rootPosition of ["head", "tail", "mid"] as const) {
      assert.equal(generatePassword({ ...digitsOnly, length: 8, root, rootPosition }), root);
      assert.equal(generatePassword({ ...digitsOnly, length: root.length, root, rootPosition }), root);
    }
    const longer = `/${"a".repeat(139)}`;
    assert.equal(generatePassword({ ...digitsOnly, length: 64, root: longer, rootPosition: "tail" }), longer);
    assert.equal(
      generatePassword({
        length: 8,
        lower: false,
        upper: false,
        digits: false,
        symbols: false,
        excludeAmbiguous: true,
        root,
        rootPosition: "head",
      }),
      root,
    );
    assert.throws(() =>
      generatePassword({
        length: 12,
        lower: false,
        upper: false,
        digits: false,
        symbols: false,
        excludeAmbiguous: true,
        root: "Hi",
        rootPosition: "tail",
      }),
    );
  });

  test("random part still follows the selected sets", () => {
    const pw = generatePassword({
      length: 24,
      lower: true,
      upper: true,
      digits: true,
      symbols: false,
      excludeAmbiguous: true,
      root: "/*",
      rootPosition: "tail",
    });
    const randomPart = pw.slice(0, -2);
    assert.equal(pw.slice(-2), "/*");
    assert.equal(randomPart.length, 22);
    assert.match(randomPart, /[a-z]/);
    assert.match(randomPart, /[A-Z]/);
    assert.match(randomPart, /[0-9]/);
    assert.doesNotMatch(randomPart, /[^a-zA-Z0-9]/);
    assert.doesNotMatch(randomPart, /[IlO01]/);
  });

  test("too-long hint applies only when the root uses the whole length", () => {
    assert.equal(passwordRootTooLong({ length: 16, root: "hello" }), false);
    assert.equal(passwordRootTooLong({ length: 16, root: "   " }), false);
    assert.equal(passwordRootTooLong({ length: 5, root: "hello" }), true);
    assert.equal(passwordRootTooLong({ length: 4, root: "hello" }), true);
  });
});
