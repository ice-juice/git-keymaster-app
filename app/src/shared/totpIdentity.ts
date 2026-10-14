export type TotpIdentityFields = {
  issuer?: string | null;
  account?: string | null;
  note?: string | null;
};

export type TotpRowIdentity = {
  title: string;
  subtitle: string;
  note: string;
  iconLabel: string;
};

function clean(value?: string | null): string {
  return (value || "").trim();
}

function sameText(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
}

/**
 * 短、无分隔符、带数字，且是大写或大小写混写的串。
 * 像 Base32/Base64 密钥尾巴（例如 3kBt），不当账号名。
 * 全小写留给 user1 这类短用户名。
 */
export function looksLikeSecretFragment(value: string): boolean {
  const text = value.trim();
  if (text.length < 4 || text.length > 8) return false;
  if (!/^[A-Za-z0-9+/=]+$/.test(text)) return false;
  if (!/\d/.test(text) || /^\d+$/.test(text)) return false;
  const hasLower = /[a-z]/.test(text);
  const hasUpper = /[A-Z]/.test(text);
  if (hasLower && !hasUpper) return false;
  return hasLower || hasUpper;
}

/** 面板类 otpauth 把「账号--主机」写进 account。拆开，避免整段被当成账号名。 */
export function parseTotpAccountLabel(account: string): { name: string; detail: string } {
  const raw = account.trim();
  if (!raw) return { name: "", detail: "" };
  const dash = raw.indexOf("--");
  if (dash > 0) {
    const name = raw.slice(0, dash).trim();
    const detail = raw.slice(dash + 2).replaceAll("--", " · ").trim();
    if (name && detail && !looksLikeSecretFragment(name)) return { name, detail };
    return { name: "", detail };
  }
  if (looksLikeSecretFragment(raw)) return { name: "", detail: "" };
  return { name: raw, detail: "" };
}

function usableLabel(raw: string, issuer: string): { name: string; detail: string } | null {
  if (!raw) return null;
  const parsed = parseTotpAccountLabel(raw);
  if (!parsed.name) return null;
  if (issuer && sameText(parsed.name, issuer)) return null;
  return parsed;
}

function displayRemark(note: string, title: string, subtitle: string): string {
  if (!note || sameText(note, title) || sameText(note, subtitle)) return "";
  if (looksLikeSecretFragment(note)) return "";
  const parsed = parseTotpAccountLabel(note);
  if (parsed.name && parsed.detail) {
    if (sameText(parsed.name, title)) {
      return sameText(parsed.detail, subtitle) ? "" : parsed.detail;
    }
    const pretty = `${parsed.name} · ${parsed.detail}`;
    return sameText(pretty, title) || sameText(pretty, subtitle) ? "" : pretty;
  }
  return note;
}

/**
 * 未聚合：主标题是平台 issuer，副标题是原始 account，平台名留在列表上。
 * 按平台聚合：组头已经是平台名，行内改显示账号。
 * account 若是密钥片段，或和平台名相同，则改用备注；`--` 拼接拆成账号 + 主机。
 */
export function totpRowIdentity(entry: TotpIdentityFields, grouped: boolean): TotpRowIdentity {
  const issuer = clean(entry.issuer);
  const account = clean(entry.account);
  const note = clean(entry.note);
  if (!grouped) {
    return {
      title: issuer,
      subtitle: account,
      note,
      iconLabel: issuer || account,
    };
  }
  const fromAccount = usableLabel(account, issuer);
  const chosen = fromAccount || usableLabel(note, issuer);
  const title = chosen?.name || "";
  const subtitle = chosen?.detail && !sameText(chosen.detail, title) ? chosen.detail : "";
  return {
    title,
    subtitle,
    note: fromAccount ? displayRemark(note, title, subtitle) : "",
    iconLabel: title,
  };
}
