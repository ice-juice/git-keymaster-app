import { resolvePlatform } from "../platform/resolve";
import { NotesDesktop } from "./Notes.desktop";
import { NotesMobile } from "./Notes.mobile";

export function NotesPage() {
  return resolvePlatform() === "mobile" ? <NotesMobile /> : <NotesDesktop />;
}
