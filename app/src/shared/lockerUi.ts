export const LOCKER_FILE_LIMIT = 100 * 1024 * 1024;
export type LockerTtlChoice =
  | "1h"
  | "24h"
  | "7d"
  | "30d"
  | "forever"
  | "custom";
export type LockerPullChoice = "1" | "3" | "custom" | "unlimited";
export type LockerRuleError = "hours" | "pulls";

export function normalizeLockerCode(value: string): string {
  return value
    .replace(/[０-９]/g, (char) =>
      String.fromCharCode(char.charCodeAt(0) - 0xfee0),
    )
    .replace(/\s/g, "");
}

export function isLockerCode(value: string): boolean {
  return /^\d{6}$/.test(normalizeLockerCode(value));
}

export function validLockerShareLink(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      /(?:^|\/)d\/[A-Za-z0-9]{10}$/.test(url.pathname) &&
      url.hash.length > 1
    );
  } catch {
    return false;
  }
}

export function buildLockerRules(
  ttl: LockerTtlChoice,
  hours: string,
  pulls: LockerPullChoice,
  customPulls: string,
):
  | {
      ok: true;
      ttlSecs?: number;
      permanent: boolean;
      maxPulls?: number;
      unlimitedPulls: boolean;
    }
  | { ok: false; field: LockerRuleError } {
  const numericHours = Number(hours);
  const numericPulls = Number(customPulls);
  if (
    ttl === "custom" &&
    (!/^\d+$/.test(hours.trim()) ||
      !Number.isSafeInteger(numericHours) ||
      numericHours < 1 ||
      numericHours > 878400)
  )
    return { ok: false, field: "hours" };
  if (
    pulls === "custom" &&
    (!/^\d+$/.test(customPulls.trim()) ||
      !Number.isSafeInteger(numericPulls) ||
      numericPulls < 1 ||
      numericPulls > 1000000)
  )
    return { ok: false, field: "pulls" };
  return {
    ok: true,
    permanent: ttl === "forever",
    ttlSecs:
      ttl === "forever"
        ? undefined
        : ttl === "custom"
          ? numericHours * 3600
          : (
              {
                "1h": 3600,
                "24h": 86400,
                "7d": 604800,
                "30d": 2592000,
              } as const
            )[ttl],
    unlimitedPulls: pulls === "unlimited",
    maxPulls:
      pulls === "unlimited"
        ? undefined
        : pulls === "custom"
          ? numericPulls
          : Number(pulls),
  };
}

export function lockerFilename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || "file";
}

export function lockerAccessEnded(
  entry: {
    accessStatus?: string;
    expireAt?: string | null;
    pullsLeft?: number | null;
    inFlightClaims?: number;
    cleanupStatus?: string;
  },
  now = Date.now(),
): boolean {
  if (entry.expireAt && Date.parse(entry.expireAt) <= now) return true;
  if (
    entry.cleanupStatus === "cleaned" ||
    entry.accessStatus === "expired" ||
    entry.accessStatus === "deleted"
  )
    return true;
  if (entry.inFlightClaims && entry.inFlightClaims > 0) return false;
  if (entry.accessStatus) return entry.accessStatus !== "active";
  return (
    entry.pullsLeft != null && entry.pullsLeft <= 0 && !entry.inFlightClaims
  );
}
