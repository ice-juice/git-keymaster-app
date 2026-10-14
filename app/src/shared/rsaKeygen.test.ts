import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { generateRsaPem } from "./rsaKeygen.ts";

describe("generateRsaPem", () => {
  test("exports SPKI / PKCS8 PEM for 2048-bit keys", async () => {
    const pair = await generateRsaPem(2048);
    assert.equal(pair.modulusLength, 2048);
    assert.match(pair.publicPem, /^-----BEGIN PUBLIC KEY-----\n/);
    assert.match(pair.publicPem, /\n-----END PUBLIC KEY-----$/);
    assert.match(pair.privatePem, /^-----BEGIN PRIVATE KEY-----\n/);
    assert.match(pair.privatePem, /\n-----END PRIVATE KEY-----$/);
    assert.notEqual(pair.publicPem, pair.privatePem);
    assert.ok(pair.publicPem.split("\n").every((line) => line.length <= 64 || line.startsWith("-----")));
  });
});
