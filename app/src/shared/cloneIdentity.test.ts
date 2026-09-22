import assert from "node:assert/strict";
import test from "node:test";
import type { Identity, Inference } from "../lib/ipc.ts";
import {
  identitiesForManualAlias,
  previewCloneUrl,
  resolveActiveIdentity,
  selectableIdentities,
  showIdentityPicker,
} from "./cloneIdentity.ts";

function identity(partial: Pick<Identity, "id" | "name" | "hostAlias" | "realHost">): Identity {
  return {
    platform: "github",
    user: "git",
    email: null,
    gitUserName: null,
    keyId: null,
    owners: [],
    strictMode: false,
    ...partial,
  };
}

function inference(partial: Partial<Inference> = {}): Inference {
  return {
    rewrittenUrl: null,
    repoPath: "pppscn/SmsForwarder",
    host: "github.com",
    isAlias: false,
    recommended: null,
    candidates: [],
    needsProbe: true,
    ...partial,
  };
}

const work = identity({ id: "work", name: "工作号", hostAlias: "github-work", realHost: "github.com" });
const personal = identity({ id: "personal", name: "个人号", hostAlias: "github-me", realHost: "github.com" });
const gitlab = identity({ id: "gl", name: "GitLab", hostAlias: "gitlab-me", realHost: "gitlab.com" });

test("third-party github repo offers only github identities", () => {
  const options = selectableIdentities(inference(), [work, personal, gitlab], "手动");
  assert.deepEqual(
    options.map((c) => c.identityId),
    ["work", "personal"],
  );
  assert.equal(showIdentityPicker(inference(), options), true);
  assert.equal(resolveActiveIdentity(options, "", null), null);
  const picked = resolveActiveIdentity(options, "personal", null);
  assert.equal(picked?.hostAlias, "github-me");
  assert.equal(previewCloneUrl(inference(), picked), "git@github-me:pppscn/SmsForwarder.git");
});

test("unknown host falls back to every identity", () => {
  const inf = inference({ host: "git.example.com", repoPath: "acme/widget" });
  const options = selectableIdentities(inf, [work, gitlab], "手动");
  assert.deepEqual(
    options.map((c) => c.hostAlias),
    ["github-work", "gitlab-me"],
  );
  assert.deepEqual(
    identitiesForManualAlias(inf, [work, gitlab]).map((id) => id.id),
    ["work", "gl"],
  );
});

test("a single matching identity is selected and still shown", () => {
  const options = selectableIdentities(inference(), [work, gitlab], "手动");
  assert.equal(options.length, 1);
  assert.equal(resolveActiveIdentity(options, "", null)?.identityId, "work");
  assert.equal(showIdentityPicker(inference(), options), true);
});

test("an existing recommendation is kept and not replaced by the manual list", () => {
  const recommended = {
    identityId: "work",
    identityName: "工作号",
    hostAlias: "github-work",
    confidence: "certain" as const,
    basis: "归属标识",
  };
  const inf = inference({
    recommended,
    candidates: [recommended],
    needsProbe: false,
    rewrittenUrl: "git@github-work:pppscn/SmsForwarder.git",
  });
  const options = selectableIdentities(inf, [work, personal], "手动");
  assert.equal(options.length, 1);
  assert.equal(showIdentityPicker(inf, options), false);
  assert.equal(previewCloneUrl(inf, options[0]), "git@github-work:pppscn/SmsForwarder.git");
});
