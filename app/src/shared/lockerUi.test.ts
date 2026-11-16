import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildLockerRules,
  isLockerCode,
  normalizeLockerCode,
  validLockerShareLink,
  lockerAccessEnded,
} from "./lockerUi.ts";

test("locker accepts formatted numeric codes but not pasted arbitrary digits", () => {
  assert.equal(normalizeLockerCode("１２３ ４５６"), "123456");
  assert(isLockerCode("123 456"));
  assert(!isLockerCode("code123456"));
  assert(!isLockerCode("12345"));
});
test("locker rejects a share URL missing its fragment or carrying credentials", () => {
  assert(validLockerShareLink("https://example.com/d/abcdef1234#key"));
  assert(
    validLockerShareLink("https://example.com/proxy/locker/d/abcdef1234#key"),
  );
  assert(!validLockerShareLink("https://example.com/d/abcdef1234?key=abc#key"));
  assert(!validLockerShareLink("https://example.com/d/abcdef1234"));
  assert(
    !validLockerShareLink("https://user:pass@example.com/d/abcdef1234#key"),
  );
  assert(!validLockerShareLink("javascript:alert(1)"));
});
test("locker does not silently coerce invalid rule inputs", () => {
  for (const input of [
    "",
    "0",
    "-1",
    "1.5",
    "NaN",
    "Infinity",
    "1e3",
    "9007199254740992",
  ]) {
    assert.deepEqual(buildLockerRules("custom", input, "1", "3"), {
      ok: false,
      field: "hours",
    });
    assert.deepEqual(buildLockerRules("24h", "6", "custom", input), {
      ok: false,
      field: "pulls",
    });
  }
  assert.deepEqual(buildLockerRules("24h", "6", "1", "3"), {
    ok: true,
    permanent: false,
    ttlSecs: 86400,
    unlimitedPulls: false,
    maxPulls: 1,
  });
});
test("ended filter separates expired objects pending cleanup from active entries", () => {
  assert(lockerAccessEnded({ accessStatus: "expired", pullsLeft: 1 }));
  assert(lockerAccessEnded({ expireAt: "2020-01-01T00:00:00Z" }));
  assert(!lockerAccessEnded({ accessStatus: "active", pullsLeft: null }));
  assert(
    !lockerAccessEnded({
      accessStatus: "active",
      pullsLeft: 0,
      inFlightClaims: 1,
    }),
  );
  assert(
    !lockerAccessEnded({
      accessStatus: "exhausted",
      pullsLeft: 0,
      inFlightClaims: 1,
    }),
  );
  assert(
    lockerAccessEnded({
      accessStatus: "expired",
      pullsLeft: 0,
      inFlightClaims: 1,
    }),
  );
});
