import type { BiometricStatus } from "./ipc";

export type BioMethod = "password" | "fingerprint" | "auto";

export function normalizeBioMethod(raw?: string | null): BioMethod {
  if (raw === "fingerprint" || raw === "password" || raw === "auto") return raw;
  return "password";
}

export function bioNoun(bio: BiometricStatus | null | undefined): string {
  const kind = bio?.kind || "";
  if (kind === "touch-id" || kind === "fingerprint") return "指纹";
  if (kind === "windows-hello") return "Windows Hello";
  if (kind === "face-id") return "面容 ID";
  const method = normalizeBioMethod(bio?.enrolledMethod || bio?.preferredMethod || kind);
  if (method === "fingerprint") return "指纹";
  if (bio?.fingerprintAvailable) return "指纹";
  return "生物识别";
}

export function bioVerb(bio: BiometricStatus | null | undefined): string {
  const noun = bioNoun(bio);
  if (noun === "Windows Hello") return "使用 Windows Hello";
  if (noun === "面容 ID") return "使用面容 ID";
  return `使用${noun}`;
}
