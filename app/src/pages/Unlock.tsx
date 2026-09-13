import { resolvePlatform } from "../platform/resolve";
import { UnlockDesktop } from "./Unlock.desktop";
import { UnlockMobile } from "./Unlock.mobile";

export function Unlock() {
  return resolvePlatform() === "mobile" ? <UnlockMobile /> : <UnlockDesktop />;
}
