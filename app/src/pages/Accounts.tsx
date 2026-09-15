import { resolvePlatform } from "../platform/resolve";
import { AccountsDesktop } from "./Accounts.desktop";
import { AccountsMobile } from "./Accounts.mobile";

export function AccountsPage() {
  return resolvePlatform() === "mobile" ? <AccountsMobile /> : <AccountsDesktop />;
}
