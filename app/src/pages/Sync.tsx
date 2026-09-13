import { resolvePlatform } from "../platform/resolve";
import { SyncDesktop } from "./Sync.desktop";
import { SyncMobile } from "./Sync.mobile";

export function SyncPage() {
  return resolvePlatform() === "mobile" ? <SyncMobile /> : <SyncDesktop />;
}
