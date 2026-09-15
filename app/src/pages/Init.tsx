import { resolvePlatform } from "../platform/resolve";
import { InitDesktop } from "./Init.desktop";
import { InitMobile } from "./Init.mobile";

export function InitWizard() {
  return resolvePlatform() === "mobile" ? <InitMobile /> : <InitDesktop />;
}
