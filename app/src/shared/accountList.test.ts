import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  activeAccountTag,
  appendAccountTags,
  collectAccountTags,
  compareAccountsInPlatform,
  primaryAccountTag,
  tagsForPlatform,
  tagsInAccounts,
  toggleAccountTag,
  visibleAccountsForTag,
} from "./accountList.ts";

describe("primaryAccountTag", () => {
  test("uses first non-empty tag", () => {
    assert.equal(primaryAccountTag(["  ", "work", "home"]), "work");
    assert.equal(primaryAccountTag([]), "");
  });
});

describe("compareAccountsInPlatform", () => {
  const item = (partial: Partial<Parameters<typeof compareAccountsInPlatform>[0]>) => ({
    username: "u",
    pinned: false,
    tags: [],
    lastUsedAt: "",
    sortOrder: 0,
    ...partial,
  });

  test("keeps pinned first even with different tags", () => {
    const pinned = item({ username: "z", pinned: true, tags: ["later"] });
    const tagged = item({ username: "a", tags: ["alpha"] });
    assert.ok(compareAccountsInPlatform(pinned, tagged) < 0);
  });

  test("clusters the same tag and puts untagged last", () => {
    const work = item({ username: "b", tags: ["work"] });
    const home = item({ username: "a", tags: ["home"] });
    const none = item({ username: "c" });
    const list = [none, work, home].sort(compareAccountsInPlatform);
    assert.deepEqual(
      list.map((e) => e.username),
      ["a", "b", "c"],
    );
  });
});

describe("collectAccountTags", () => {
  test("scopes tags to the current group", () => {
    const tags = collectAccountTags(
      [
        { tags: ["work"], group: "家庭" },
        { tags: ["cloud"], group: "工作" },
        { tags: ["work"], group: "工作" },
      ],
      "工作",
    );
    assert.deepEqual(tags, ["cloud", "work"]);
  });
});

describe("tagsInAccounts", () => {
  test("collects unique tags from one platform list", () => {
    assert.deepEqual(
      tagsInAccounts([{ tags: ["home", "work"] }, { tags: ["home"] }, { tags: [] }]),
      ["home", "work"],
    );
  });
});

describe("visibleAccountsForTag", () => {
  test("keeps the full list when no tag is selected", () => {
    const list = [{ username: "a", tags: ["work"] }, { username: "b" }];
    assert.equal(visibleAccountsForTag(list, null).length, 2);
  });

  test("filters to the selected tag inside one platform", () => {
    const list = [
      { username: "a", tags: ["老婆"] },
      { username: "b", tags: ["work"] },
      { username: "c", tags: ["老婆"] },
    ];
    assert.deepEqual(
      visibleAccountsForTag(list, "老婆").map((e) => e.username),
      ["a", "c"],
    );
  });

  test("drops a stale selected tag", () => {
    assert.equal(activeAccountTag(["work"], "gone"), null);
    assert.equal(activeAccountTag(["work"], "work"), "work");
  });
});

describe("toggleAccountTag", () => {
  test("adds a new tag and removes an existing one", () => {
    assert.deepEqual(toggleAccountTag(["老婆"], "work"), ["老婆", "work"]);
    assert.deepEqual(toggleAccountTag(["老婆", "work"], "老婆"), ["work"]);
  });
});

describe("tagsForPlatform", () => {
  const entries = [
    { platform: "GitHub", tags: ["mine", "shared"] },
    { platform: "  GitHub  ", tags: ["team"] },
    { platform: "GitLab", tags: ["mine"] },
    { platform: "   ", tags: ["ghost"] },
    { platform: "", tags: ["empty"] },
  ];

  test("keeps the account being edited and drops other platforms", () => {
    assert.deepEqual(tagsForPlatform(entries, "GitHub"), ["mine", "shared", "team"]);
  });

  test("matches trimmed platform names without caring about case", () => {
    assert.deepEqual(tagsForPlatform(entries, " github "), ["mine", "shared", "team"]);
  });

  test("is empty when the platform is blank or not in the vault", () => {
    assert.deepEqual(tagsForPlatform(entries, ""), []);
    assert.deepEqual(tagsForPlatform(entries, "   "), []);
    assert.deepEqual(tagsForPlatform(entries, "Notion"), []);
  });

  test("uses the same family key as platform grouping", () => {
    const family = (name: string) => {
      const trimmed = name.trim().toLowerCase();
      if (!trimmed) return "";
      if (trimmed === "github" || trimmed === "gh") return "builtin:github";
      return trimmed;
    };
    assert.deepEqual(
      tagsForPlatform(
        [
          { platform: "GitHub", tags: ["work"] },
          { platform: "gh", tags: ["oss"] },
          { platform: "GitLab", tags: ["home"] },
        ],
        " github ",
        family,
      ),
      ["oss", "work"],
    );
    assert.deepEqual(tagsForPlatform([{ platform: "gh", tags: ["oss"] }], "Notion", family), []);
  });

  test("stays empty when the family key itself is blank", () => {
    assert.deepEqual(
      tagsForPlatform([{ platform: "GitHub", tags: ["work"] }], "GitHub", () => ""),
      [],
    );
  });
});

describe("appendAccountTags", () => {
  test("commits words and skips blanks or duplicates", () => {
    assert.deepEqual(appendAccountTags(["老婆"], " work  work "), ["老婆", "work"]);
    assert.deepEqual(appendAccountTags(["work"], "   "), ["work"]);
    assert.deepEqual(appendAccountTags(undefined, " home  work "), ["home", "work"]);
  });
});
