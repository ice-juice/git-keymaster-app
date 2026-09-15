import { resolvePlatform } from "../platform/resolve";
import { SettingsDesktop } from "./Settings.desktop";
import { SettingsMobile } from "./Settings.mobile";

export function Settings() {
  return resolvePlatform() === "mobile" ? <SettingsMobile /> : <SettingsDesktop />;
}
