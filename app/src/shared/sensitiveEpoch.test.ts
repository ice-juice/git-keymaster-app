import { it } from "node:test";
import assert from "node:assert/strict";
import { createSensitiveEpoch } from "./sensitiveEpoch.ts";

it("lock revokes pending plaintext work even after a subsequent unlock", async () => {
  const boundary = createSensitiveEpoch();
  const request = boundary.snapshot();
  let visible = "old image";
  boundary.subscribe(() => { visible = ""; });
  const result = Promise.resolve("late plaintext");
  boundary.invalidate();
  boundary.invalidate();
  const value = await result;
  if (boundary.isCurrent(request)) visible = value;
  assert.equal(visible, "");
  assert.equal(boundary.isCurrent(boundary.snapshot()), true);
});
