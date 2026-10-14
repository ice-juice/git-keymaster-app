import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { md5, sha1Hex, sha256Hex } from "./hash.ts";

describe("md5", () => {
  test("RFC 1321 / common vectors", () => {
    assert.equal(md5(""), "d41d8cd98f00b204e9800998ecf8427e");
    assert.equal(md5("a"), "0cc175b9c0f1b6a831c399e269772661");
    assert.equal(md5("abc"), "900150983cd24fb0d6963f7d28e17f72");
    assert.equal(md5("message digest"), "f96b697d7cb7938d525a2f31aaf161d0");
    assert.equal(md5("abcdefghijklmnopqrstuvwxyz"), "c3fcd3d76192e4007dfb496cca67e13b");
  });

  test("encodes UTF-8 before hashing", () => {
    assert.equal(md5("你好"), "7eca689f0d3389d9dea66ae112e5cfd7");
  });
});

describe("sha1Hex", () => {
  test("abc vector", async () => {
    assert.equal(await sha1Hex("abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
  });
});

describe("sha256Hex", () => {
  test("empty and abc vectors", async () => {
    assert.equal(
      await sha256Hex(""),
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    assert.equal(
      await sha256Hex("abc"),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
