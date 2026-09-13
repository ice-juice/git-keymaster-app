import { resolvePlatform } from "../platform/resolve";
import { TotpDesktop } from "./Totp.desktop";
import { TotpMobile } from "./Totp.mobile";

export function TotpPage() {
  return resolvePlatform() === "mobile" ? <TotpMobile /> : <TotpDesktop />;
}
