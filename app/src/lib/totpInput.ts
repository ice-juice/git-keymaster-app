import { i18n } from "./i18n";

/** 识别用户粘贴的是 otpauth 链接还是 Base32 密钥（二者只需填一种）。 */

export type TotpSecretKind = "empty" | "otpauth" | "base32" | "migration" | "unknown";

export interface DetectedTotpInput {
  kind: TotpSecretKind;
  raw: string;
  secret?: string;
  issuer?: string;
  account?: string;
  algorithm?: string;
  digits?: number;
  period?: number;
  message: string;
}

export function detectTotpInput(raw: string): DetectedTotpInput {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { kind: "empty", raw, message: i18n.t("totp.detectEmpty") };
  }

  const migrationStart = trimmed.toLowerCase().indexOf("otpauth-migration://");
  if (migrationStart >= 0) {
    return {
      kind: "migration",
      raw,
      message: i18n.t("totp.detectMigrationMsg"),
    };
  }

  const uriStart = trimmed.toLowerCase().indexOf("otpauth://");
  if (uriStart >= 0) {
    const uri = trimmed.slice(uriStart).split(/\s/)[0];
    return parseOtpauthClient(uri, raw);
  }

  const maybeLabeled = trimmed.replace(/^secret\s*=\s*/i, "").trim();
  const compact = maybeLabeled.replace(/[\s\-]/g, "").toUpperCase();
  if (/^[A-Z2-7]+=*$/.test(compact) && compact.replace(/=+$/, "").length >= 8) {
    return {
      kind: "base32",
      raw,
      secret: compact,
      message: i18n.t("totp.detectBase32Msg"),
    };
  }

  return {
    kind: "unknown",
    raw,
    message: i18n.t("totp.detectUnknownMsg"),
  };
}

function parseOtpauthClient(uri: string, raw: string): DetectedTotpInput {
  if (!uri.toLowerCase().startsWith("otpauth://totp/")) {
    return { kind: "unknown", raw, message: i18n.t("totp.detectOtpauthOnly") };
  }
  try {
    const u = new URL(uri);
    const secretRaw = u.searchParams.get("secret") || "";
    const compact = secretRaw.replace(/[\s\-]/g, "").toUpperCase();
    if (!compact) {
      return { kind: "unknown", raw, message: i18n.t("totp.detectNoSecret") };
    }
    const label = decodeURIComponent((u.pathname || "").replace(/^\//, ""));
    let labelIssuer = "";
    let account = label;
    const colon = label.indexOf(":");
    if (colon >= 0) {
      labelIssuer = label.slice(0, colon).trim();
      account = label.slice(colon + 1).trim();
    }
    const issuer = (u.searchParams.get("issuer") || labelIssuer).trim() || i18n.t("totp.unnamed");
    const algorithm = (u.searchParams.get("algorithm") || "SHA1").toUpperCase();
    const digits = clamp(Number(u.searchParams.get("digits") || 6), 6, 8);
    const period = Math.max(1, Number(u.searchParams.get("period") || 30) || 30);
    return {
      kind: "otpauth",
      raw,
      secret: compact,
      issuer,
      account: account || "default",
      algorithm,
      digits,
      period,
      message: i18n.t("totp.detectOtpauthMsg", { issuer, account: account || i18n.t("totp.accountFallback") }),
    };
  } catch {
    return { kind: "unknown", raw, message: i18n.t("totp.detectInvalid") };
  }
}

function clamp(n: number, min: number, max: number) {
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}
