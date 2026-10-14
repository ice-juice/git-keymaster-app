import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { looksLikeSecretFragment, parseTotpAccountLabel, totpRowIdentity } from "./totpIdentity.ts";

describe("looksLikeSecretFragment", () => {
  test("rejects short mixed-case or uppercase token with a digit", () => {
    assert.equal(looksLikeSecretFragment("3kBt"), true);
    assert.equal(looksLikeSecretFragment("3KBT"), true);
  });

  test("keeps short usernames and normal account labels", () => {
    assert.equal(looksLikeSecretFragment("user1"), false);
    assert.equal(looksLikeSecretFragment("admin"), false);
    assert.equal(looksLikeSecretFragment("新"), false);
    assert.equal(looksLikeSecretFragment("you@mail.com"), false);
  });
});

describe("parseTotpAccountLabel", () => {
  test("splits a panel label on the first double hyphen", () => {
    assert.deepEqual(parseTotpAccountLabel("merchant--54.183.31.173"), {
      name: "merchant",
      detail: "54.183.31.173",
    });
    assert.deepEqual(parseTotpAccountLabel("service服务器--13.56.5.9"), {
      name: "service服务器",
      detail: "13.56.5.9",
    });
  });

  test("does not treat a secret fragment as a name", () => {
    assert.deepEqual(parseTotpAccountLabel("3kBt"), { name: "", detail: "" });
  });
});

describe("totpRowIdentity", () => {
  test("ungrouped list keeps the platform name as the title", () => {
    const row = totpRowIdentity(
      { issuer: "宝塔面板", account: "merchant--54.183.31.173", note: "备用" },
      false,
    );
    assert.equal(row.title, "宝塔面板");
    assert.equal(row.subtitle, "merchant--54.183.31.173");
    assert.equal(row.note, "备用");
    assert.equal(row.iconLabel, "宝塔面板");
  });

  test("grouped row shows the account, not the platform", () => {
    const row = totpRowIdentity(
      { issuer: "宝塔面板", account: "you@mail.com", note: "公司号" },
      true,
    );
    assert.equal(row.title, "you@mail.com");
    assert.equal(row.subtitle, "");
    assert.equal(row.note, "公司号");
    assert.equal(row.iconLabel, "you@mail.com");
    assert.equal(row.title.includes("宝塔"), false);
  });

  test("grouped row splits a double-hyphen label into name and host", () => {
    const row = totpRowIdentity(
      { issuer: "宝塔面板", account: "manage--54.176.34.149" },
      true,
    );
    assert.equal(row.title, "manage");
    assert.equal(row.subtitle, "54.176.34.149");
    assert.equal(row.iconLabel, "manage");
    assert.equal(`${row.title}${row.subtitle}${row.note}`.includes("--"), false);
  });

  test("grouped row prefers the remark when account is a secret fragment", () => {
    const row = totpRowIdentity({ issuer: "宝塔面板", account: "3kBt", note: "备用机" }, true);
    assert.equal(row.title, "备用机");
    assert.equal(row.subtitle, "");
    assert.equal(row.note, "");
    assert.equal(row.iconLabel, "备用机");
    assert.equal(`${row.title}${row.subtitle}${row.note}${row.iconLabel}`.includes("3kBt"), false);
  });

  test("grouped row does not repeat the platform when account is only the issuer", () => {
    const row = totpRowIdentity(
      { issuer: "宝塔面板", account: "宝塔面板", note: "sandbox--54.183.232.100" },
      true,
    );
    assert.equal(row.title, "sandbox");
    assert.equal(row.subtitle, "54.183.232.100");
  });

  test("grouped row keeps a real short account and prettifies a dashed remark", () => {
    const row = totpRowIdentity(
      { issuer: "宝塔面板", account: "新", note: "merchant--54.183.31.173" },
      true,
    );
    assert.equal(row.title, "新");
    assert.equal(row.subtitle, "");
    assert.equal(row.note, "merchant · 54.183.31.173");
    assert.equal(row.note.includes("--"), false);
  });

  test("grouped secret fragment without a remark leaves the title empty", () => {
    const row = totpRowIdentity({ issuer: "宝塔面板", account: "3kBt" }, true);
    assert.equal(row.title, "");
    assert.equal(row.subtitle, "");
    assert.equal(row.iconLabel, "");
  });
});
