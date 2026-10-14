import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  AUTO_SYNC_PRESETS,
  DEFAULT_AUTO_SYNC_MINUTES,
  autoSyncMinutesFromOption,
  autoSyncSelectValue,
} from "./autoSyncPresets.ts";

describe("auto sync period options", () => {
  test("keeps the existing preset minutes and label keys", () => {
    assert.deepEqual(
      AUTO_SYNC_PRESETS.map((preset) => preset.minutes),
      [0, 1, 5, 15, 30, 60, 120],
    );
    assert.deepEqual(
      AUTO_SYNC_PRESETS.map((preset) => preset.labelKey),
      [
        "syncPage.intervalOff",
        "syncPage.interval1",
        "syncPage.interval5",
        "syncPage.interval15",
        "syncPage.interval30",
        "syncPage.interval60",
        "syncPage.interval120",
      ],
    );
    assert.equal(DEFAULT_AUTO_SYNC_MINUTES, 30);
    assert.equal(
      AUTO_SYNC_PRESETS.find((preset) => preset.minutes === 30)?.labelKey,
      "syncPage.interval30",
    );
  });

  test("select value round-trips each preset, including off and the 30 minute default", () => {
    assert.equal(autoSyncSelectValue(undefined), "30");
    assert.equal(autoSyncSelectValue(null), "30");
    for (const preset of AUTO_SYNC_PRESETS) {
      assert.equal(autoSyncSelectValue(preset.minutes), String(preset.minutes));
      assert.equal(autoSyncMinutesFromOption(String(preset.minutes)), preset.minutes);
    }
    assert.equal(autoSyncMinutesFromOption("0"), 0);
    assert.equal(autoSyncMinutesFromOption("7"), null);
    assert.equal(autoSyncMinutesFromOption("30.5"), null);
    assert.equal(autoSyncMinutesFromOption(""), null);
  });
});
