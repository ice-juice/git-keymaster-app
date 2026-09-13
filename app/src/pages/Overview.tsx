import { resolvePlatform } from "../platform/resolve";
import { OverviewDesktop } from "./Overview.desktop";
import { OverviewMobile } from "./Overview.mobile";

export function Overview() {
  return resolvePlatform() === "mobile" ? <OverviewMobile /> : <OverviewDesktop />;
}
