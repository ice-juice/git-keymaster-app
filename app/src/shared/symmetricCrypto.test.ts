import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { symDecrypt, symEncrypt } from "./symmetricCrypto.ts";

const PLAIN = "御钥师 local-tools 2026";
const KEY = "test-pass-phrase";

describe("symmetricCrypto roundtrip", () => {
  for (const algo of ["aes", "des", "3des", "rc4", "rabbit"] as const) {
    test(`${algo} encrypt/decrypt`, async () => {
      const enc = await symEncrypt(algo, PLAIN, KEY);
      assert.notEqual(enc, PLAIN);
      const dec = await symDecrypt(algo, enc, KEY);
      assert.equal(dec, PLAIN);
    });
  }

  test("wrong key fails aes", async () => {
    const enc = await symEncrypt("aes", PLAIN, KEY);
    await assert.rejects(() => symDecrypt("aes", enc, "other-key"));
  });
});
