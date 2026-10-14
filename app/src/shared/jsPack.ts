/** 简单可逆 JS 包装：eval(atob(...))，不访问外网。 */

import { base64DecodeUtf8, base64EncodeUtf8 } from "./base64Util.ts";

const WRAP_RE = /^\s*eval\s*\(\s*atob\s*\(\s*(['"])([\s\S]*?)\1\s*\)\s*\)\s*;?\s*$/;

export function packJsSource(source: string): string {
  const b64 = base64EncodeUtf8(source);
  return `eval(atob(${JSON.stringify(b64)}))`;
}

export function unpackJsSource(wrapped: string): string {
  const m = wrapped.match(WRAP_RE);
  if (!m) throw new Error("invalid_js_pack");
  return base64DecodeUtf8(m[2]!);
}
