export function json(status: number, body: unknown, extra?: Record<string, string>): Response {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  return new Response(JSON.stringify(body), { status, headers });
}

export function html(status: number, markup: string): Response {
  const headers = new Headers();
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-robots-tag", "noindex");
  headers.set(
    "content-security-policy",
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  return new Response(markup, { status, headers });
}

export const unauthorized = () => json(401, { error: "unauthorized" });
export const badCode = () => json(401, { error: "bad_code" });
export const notFound = () => json(404, { error: "not_found" });
export const expired = () => json(410, { error: "expired" });
export const conflict = () => json(409, { error: "conflict" });
export const invalid = () => json(400, { error: "invalid" });
export const tooLarge = () => json(413, { error: "too_large" });
export const misconfigured = () => json(500, { error: "misconfigured" });
export const internal = () => json(500, { error: "internal" });

export function locked(retryAfterSec: number): Response {
  const sec = Math.max(1, retryAfterSec);
  return json(423, { error: "locked", retryAfter: sec }, { "retry-after": String(sec) });
}
