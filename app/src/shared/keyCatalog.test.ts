import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  algorithmMatches,
  classifyKeyUse,
  describeKeyUse,
  groupMatches,
  gitHostingBlocksKeyDelete,
  identityNamesLosingKey,
  isRsaPubExportable,
  isServerLoginIdentity,
  keyFileStemForAlgo,
  keyVisible,
  matchesKeySearch,
  opensshPubDownloadName,
  opensshPubFileBody,
  opensshPublicComment,
  rsaPemDownloadName,
  rsaPubDownloadName,
  type KeyUseCopy,
  type KeyUseIdentity,
} from "./keyCatalog.ts";

const zh: KeyUseCopy = {
  git: "Git 托管",
  server: "服务器登录",
  unattached: "未挂接",
  exportOnly: "仅导出公钥",
};

const en: KeyUseCopy = {
  git: "Git hosting",
  server: "Server login",
  unattached: "Unattached",
  exportOnly: "Public key only",
};

function id(partial: Partial<KeyUseIdentity> & Pick<KeyUseIdentity, "keyId" | "platform">): KeyUseIdentity {
  return {
    user: "git",
    realHost: "",
    hostAlias: "",
    ...partial,
  };
}

describe("classifyKeyUse", () => {
  test("git platforms stay on git hosting when the user is git", () => {
    for (const platform of ["github", "gitlab", "gitee", "gitea"] as const) {
      const found = classifyKeyUse("k", [
        id({ keyId: "k", platform, user: "git", realHost: platform === "gitea" ? "git.example.com" : `${platform}.com` }),
      ]);
      assert.equal(found.git, true);
      assert.equal(found.server, false);
      assert.equal(found.unattached, false);
      assert.deepEqual(found.platforms, [platform]);
    }
  });

  test("platform other is a server login even on a code host", () => {
    const found = classifyKeyUse("k", [id({ keyId: "k", platform: "Other", user: "git", realHost: "github.com" })]);
    assert.equal(found.git, false);
    assert.equal(found.server, true);
    assert.equal(found.unattached, false);
  });

  test("non-git user on a non-code host is a server login", () => {
    const found = classifyKeyUse("k", [id({ keyId: "k", platform: "github", user: "root", realHost: "git.example.com" })]);
    assert.equal(found.git, true);
    assert.equal(found.server, true);
  });

  test("non-git user on github.com is not a server login", () => {
    const found = classifyKeyUse("k", [id({ keyId: "k", platform: "github", user: "root", realHost: "ssh.github.com" })]);
    assert.equal(found.git, true);
    assert.equal(found.server, false);
  });

  test("no referencing identity is unattached", () => {
    const found = classifyKeyUse("k", [id({ keyId: "other", platform: "github", realHost: "github.com" })]);
    assert.equal(found.unattached, true);
    assert.equal(found.git, false);
    assert.equal(found.server, false);
  });

  test("git and server identities together are multi-purpose", () => {
    const found = classifyKeyUse("k", [
      id({ keyId: "k", platform: "gitlab", realHost: "gitlab.com" }),
      id({ keyId: "k", platform: "other", user: "ubuntu", realHost: "10.0.0.8" }),
    ]);
    assert.equal(found.git, true);
    assert.equal(found.server, true);
    assert.deepEqual(found.platforms, ["gitlab"]);
  });

  test("user Git is treated as the git user", () => {
    assert.equal(
      isServerLoginIdentity(id({ keyId: "k", platform: "gitea", user: "Git", realHost: "git.internal" })),
      false,
    );
  });
});

describe("describeKeyUse", () => {
  test("unattached intent is a tag and is included in that use filter", () => {
    const classification = classifyKeyUse("k", []);
    const described = describeKeyUse(classification, "server", zh);
    assert.deepEqual(described.groupBadges, ["未挂接", "服务器登录"]);
    assert.equal(described.subtitle, "");
    assert.deepEqual(described.searchLabels, ["未挂接", "服务器登录"]);
    assert.equal(groupMatches(classification, "unattached", "server"), true);
    assert.equal(groupMatches(classification, "server", "server"), true);
    assert.equal(groupMatches(classification, "server"), false);
    assert.equal(groupMatches(classification, "git", "server"), false);
  });

  test("an attached key keeps identity groups when its own tag differs", () => {
    const classification = classifyKeyUse("k", [id({ keyId: "k", platform: "github", realHost: "github.com" })]);
    assert.equal(groupMatches(classification, "git", "server"), true);
    assert.equal(groupMatches(classification, "server", "server"), false);
    assert.equal(groupMatches(classification, "unattached", "git"), false);
  });

  test("attached keys ignore intent and list both tags", () => {
    const classification = classifyKeyUse("k", [
      id({ keyId: "k", platform: "github", realHost: "github.com" }),
      id({ keyId: "k", platform: "other", user: "admin", realHost: "bastion.example" }),
    ]);
    const described = describeKeyUse(classification, "export", en);
    assert.deepEqual(described.groupBadges, ["Git hosting", "Server login"]);
    assert.deepEqual(described.platformBadges, ["GitHub"]);
    assert.equal(described.subtitle, "");
    assert.equal(groupMatches(classification, "git"), true);
    assert.equal(groupMatches(classification, "server"), true);
  });
});

describe("key search", () => {
  const fields = {
    name: "id_rsa_lab",
    fingerprint: "SHA256:AbC",
    algorithm: "rsa",
    comment: "lab workstation",
    labels: ["未挂接", "服务器登录"],
  };

  test("matches name, fingerprint, algorithm, comment, and localized labels", () => {
    assert.equal(matchesKeySearch(fields, "LAB"), true);
    assert.equal(matchesKeySearch(fields, "abc"), true);
    assert.equal(matchesKeySearch(fields, "RSA"), true);
    assert.equal(matchesKeySearch(fields, "WorkStation"), true);
    assert.equal(matchesKeySearch(fields, "服务器"), true);
    assert.equal(matchesKeySearch(fields, "missing"), false);
    assert.equal(matchesKeySearch(fields, "  "), true);
  });

  test("english group copy is what the current UI can match", () => {
    assert.equal(
      matchesKeySearch({ ...fields, labels: ["Unattached", "Server login", "GitHub"] }, "server login"),
      true,
    );
    assert.equal(matchesKeySearch({ ...fields, labels: ["Git hosting", "GitLab"] }, "gitlab"), true);
  });

  test("group, algorithm, and query stack", () => {
    const classification = classifyKeyUse("k", [id({ keyId: "k", platform: "github", realHost: "github.com" })]);
    const described = describeKeyUse(classification, "", zh);
    const item = {
      classification,
      algorithm: "ed25519",
      fields: {
        name: "id_ed25519_work",
        fingerprint: "SHA256:zzz",
        algorithm: "ed25519",
        comment: opensshPublicComment("ssh-ed25519 AAAA work@host"),
        labels: described.searchLabels,
      },
      query: "github",
      group: "git" as const,
      algo: "ed25519" as const,
    };
    assert.equal(keyVisible(item), true);
    assert.equal(keyVisible({ ...item, algo: "rsa" }), false);
    assert.equal(keyVisible({ ...item, group: "unattached" }), false);
    assert.equal(keyVisible({ ...item, query: "nope" }), false);
    assert.equal(algorithmMatches("Ed25519", "ed25519"), true);
    assert.equal(algorithmMatches("rsa", "ed25519"), false);
  });
});

describe("openssh public files", () => {
  test("comment is the tail of the openssh line", () => {
    assert.equal(opensshPublicComment("ssh-ed25519 AAAA user@host"), "user@host");
    assert.equal(opensshPublicComment("ssh-rsa AAAA my workstation"), "my workstation");
    assert.equal(opensshPublicComment("ssh-ed25519 AAAA"), "");
  });

  test("pub body keeps the line and one trailing newline", () => {
    assert.equal(opensshPubFileBody("ssh-rsa AAAA comment"), "ssh-rsa AAAA comment\n");
    assert.equal(opensshPubFileBody("ssh-rsa AAAA comment\n\n"), "ssh-rsa AAAA comment\n");
  });

  test("rsa download name prefixes only when needed and strips illegal characters", () => {
    assert.equal(rsaPubDownloadName("id_rsa_work"), "id_rsa_work.pub");
    assert.equal(rsaPubDownloadName("ID_RSA_work"), "ID_RSA_work.pub");
    assert.equal(rsaPubDownloadName("work"), "id_rsa_work.pub");
    assert.equal(rsaPubDownloadName("a/b:c"), "id_rsa_a_b_c.pub");
    assert.equal(rsaPubDownloadName("my-server"), "id_rsa_my-server.pub");
    assert.equal(rsaPubDownloadName("  "), "id_rsa.pub");
    assert.equal(rsaPemDownloadName("work"), "id_rsa_work.pem");
    assert.equal(rsaPemDownloadName("id_rsa_work"), "id_rsa_work.pem");
    assert.equal(opensshPubDownloadName("ed25519", "work"), "id_ed25519_work.pub");
    assert.equal(opensshPubDownloadName("rsa", "work"), "id_rsa_work.pub");
    assert.equal(isRsaPubExportable("RSA", "ssh-rsa AAAA"), true);
    assert.equal(isRsaPubExportable("ed25519", "ssh-ed25519 AAAA"), false);
    assert.equal(isRsaPubExportable("rsa", "  "), false);
  });

  test("save stem matches the rust naming rule", () => {
    assert.equal(keyFileStemForAlgo("rsa", ""), "id_rsa");
    assert.equal(keyFileStemForAlgo("ed25519", "   "), "id_ed25519");
    assert.equal(keyFileStemForAlgo("rsa", "work"), "id_rsa_work");
    assert.equal(keyFileStemForAlgo("ed25519", "work"), "id_ed25519_work");
    assert.equal(keyFileStemForAlgo("rsa", "id_rsa_work"), "id_rsa_work");
    assert.equal(keyFileStemForAlgo("RSA", "ID_RSA_work"), "ID_RSA_work");
    assert.equal(keyFileStemForAlgo("rsa", "a/b:c"), "id_rsa_a_b_c");
    assert.equal(keyFileStemForAlgo("ed25519", "mgcp-afk"), "id_ed25519_mgcp_afk");
    assert.equal(keyFileStemForAlgo("rsa", ".."), "id_rsa");
    assert.equal(keyFileStemForAlgo("rsa", "钥匙"), "id_rsa_钥匙");
  });
});

describe("key delete rules", () => {
  test("git hosting reference blocks delete", () => {
    for (const platform of ["github", "GitHub", "gitlab", "Gitee", "gitea"]) {
      assert.equal(
        gitHostingBlocksKeyDelete("k", [{ keyId: "k", platform }]),
        true,
        platform,
      );
    }
    assert.equal(gitHostingBlocksKeyDelete("k", [{ keyId: "other", platform: "github" }]), false);
    assert.equal(gitHostingBlocksKeyDelete("k", [{ keyId: "k", platform: "other" }]), false);
    assert.equal(gitHostingBlocksKeyDelete("k", [{ keyId: null, platform: "github" }]), false);
  });

  test("confirm names include only non-git identities that use the key", () => {
    const names = identityNamesLosingKey("k", [
      { keyId: "k", platform: "github", name: "GitHub 工作" },
      { keyId: "k", platform: "other", name: "机房登录" },
      { keyId: "k", platform: "custom", name: "  备份机  " },
      { keyId: "k", platform: "other", name: "   " },
      { keyId: "other", platform: "other", name: "旁路" },
    ]);
    assert.deepEqual(names, ["机房登录", "备份机"]);
    assert.deepEqual(identityNamesLosingKey("free", [{ keyId: null, platform: "other", name: "空" }]), []);
  });
});
