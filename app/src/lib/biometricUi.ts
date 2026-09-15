import type { BiometricStatus } from "./ipc";
import { i18n } from "./i18n";

export type BioMethod = "password" | "fingerprint" | "auto";

export function normalizeBioMethod(raw?: string | null): BioMethod {
  if (raw === "fingerprint" || raw === "password" || raw === "auto") return raw;
  return "password";
}

export function bioNoun(bio: BiometricStatus | null | undefined): string {
  const kind = bio?.kind || "";
  if (kind === "touch-id" || kind === "fingerprint") return i18n.t("bio.fingerprint");
  if (kind === "windows-hello") return i18n.t("bio.hello");
  if (kind === "face-id") return i18n.t("bio.face");
  const method = normalizeBioMethod(bio?.enrolledMethod || bio?.preferredMethod || kind);
  if (method === "fingerprint") return i18n.t("bio.fingerprint");
  if (bio?.fingerprintAvailable) return i18n.t("bio.fingerprint");
  return i18n.t("bio.generic");
}

export function bioVerb(bio: BiometricStatus | null | undefined): string {
  const noun = bioNoun(bio);
  if (bio?.kind === "windows-hello") return i18n.t("bio.useHello");
  if (bio?.kind === "face-id") return i18n.t("bio.useFace");
  return i18n.t("bio.useNoun", { name: noun });
}
