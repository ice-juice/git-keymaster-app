import { resolvePlatform } from "../platform/resolve";
import { FilesDesktop } from "./Files.desktop";
import { FilesMobile } from "./Files.mobile";

export function FilesPage() {
  return resolvePlatform() === "mobile" ? <FilesMobile /> : <FilesDesktop />;
}
