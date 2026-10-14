/** 定时同步周期。0 为关闭。文案走 syncPage.interval*，数值原样交给 set_auto_sync_minutes。 */
export const AUTO_SYNC_PRESETS: { labelKey: string; minutes: number }[] = [
  { labelKey: "syncPage.intervalOff", minutes: 0 },
  { labelKey: "syncPage.interval1", minutes: 1 },
  { labelKey: "syncPage.interval5", minutes: 5 },
  { labelKey: "syncPage.interval15", minutes: 15 },
  { labelKey: "syncPage.interval30", minutes: 30 },
  { labelKey: "syncPage.interval60", minutes: 60 },
  { labelKey: "syncPage.interval120", minutes: 120 },
];

export const DEFAULT_AUTO_SYNC_MINUTES = 30;

/** 下拉当前值。尚未读到设置时显示默认 30 分钟，与原先按钮高亮一致。 */
export function autoSyncSelectValue(minutes: number | null | undefined): string {
  return String(minutes ?? DEFAULT_AUTO_SYNC_MINUTES);
}

/** 只接受预设档位，避免下拉回写时改掉周期集合。空串不能当成关闭。 */
export function autoSyncMinutesFromOption(value: string): number | null {
  if (!/^(0|[1-9]\d*)$/.test(value)) return null;
  const minutes = Number(value);
  return AUTO_SYNC_PRESETS.some((preset) => preset.minutes === minutes) ? minutes : null;
}
