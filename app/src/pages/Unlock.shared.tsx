import { useEffect, useRef, useState } from "react";
import { Fingerprint, KeyRound, Sun, Moon, Palette } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, errCode, errMessage, type BiometricStatus } from "../lib/ipc";
import { bioNoun, bioVerb } from "../lib/biometricUi";
import { resolvePlatform } from "../platform/resolve";
import { useApp } from "../store";
import { AppLogo } from "../ui/AppLogo";

type Gate = "bio" | "password" | "recovery";

export function UnlockView() {
  const { t } = useTranslation();
  const { refresh, theme, toggleTheme, unlockAnimEnabled, startUnlockAnim } = useApp();
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState("");
  const [bio, setBio] = useState<BiometricStatus | null>(null);
  const [gate, setGate] = useState<Gate>("password");
  const userPickedGate = useRef(false);
  const autoStarted = useRef(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const fieldClusterRef = useRef<HTMLDivElement>(null);
  const mobile = resolvePlatform() === "mobile";

  function markIme(on: boolean) {
    stageRef.current?.classList.toggle("is-ime", on);
  }

  function revealUnlockField() {
    if (!mobile) return;
    markIme(true);
    window.requestAnimationFrame(() => {
      fieldClusterRef.current?.scrollIntoView({ block: "end", inline: "nearest" });
    });
  }

  const fingerprintReady = !!(bio?.enabled && bio.available);
  const bioName = bioNoun(bio);
  const macKeychainHint =
    !mobile && /Mac/.test(navigator.userAgent) && !/iPhone|iPad|iPod/.test(navigator.userAgent);

  useEffect(() => {
    api
      .biometricStatus()
      .then((s) => {
        setBio(s);
        if (s.enabled && s.available && !userPickedGate.current) {
          setGate("bio");
        }
      })
      .catch(() => setBio(null));
  }, []);

  async function afterUnlock() {
    if (unlockAnimEnabled) {
      startUnlockAnim();
    }
    await refresh();
  }

  async function unlockByFingerprint() {
    setErr("");
    setBusy(true);
    try {
      await api.vaultUnlockBiometric();
      await afterUnlock();
    } catch (e) {
      if (errCode(e) !== "BIOMETRIC_CANCELLED") {
        setErr(errMessage(e));
      }
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (gate !== "bio" || !fingerprintReady || autoStarted.current) return;
    if (resolvePlatform() !== "mobile") return;
    autoStarted.current = true;
    void unlockByFingerprint();
  }, [gate, fingerprintReady]);

  async function unlock() {
    setErr("");
    setBusy(true);
    try {
      if (gate === "recovery") {
        await api.vaultUnlockRecovery(recovery);
      } else {
        await api.vaultUnlock(pw);
      }
      await afterUnlock();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function switchGate(next: Gate) {
    if (busy) return;
    userPickedGate.current = true;
    setErr("");
    setGate(next);
  }

  const subtitle =
    gate === "recovery"
      ? t("unlock.subtitleRecovery")
      : gate === "bio"
        ? t("unlock.subtitleBio", { name: bioName })
        : fingerprintReady
          ? t("unlock.subtitlePasswordOrBio", { name: bioName })
          : t("unlock.subtitlePassword");

  return (
    <div className="unlock-stage" ref={stageRef}>
      <div className="unlock-card">
        <AppLogo size={46} style={{ margin: "0 auto 10px" }} />
        <div className="title-lg">{t("unlock.title")}</div>
        <div className="muted" style={{ marginBottom: 18 }}>
          {subtitle}
        </div>

        {gate === "bio" && (
          <div className="unlock-bio">
            <button
              type="button"
              className={`unlock-bio-pad${busy ? " is-busy" : ""}`}
              disabled={busy}
              onClick={unlockByFingerprint}
              aria-label={bioVerb(bio)}
            >
              <Fingerprint size={36} />
            </button>
            <div className="unlock-bio-hint">
              {busy
                ? t(macKeychainHint ? "unlock.busyBioMac" : "unlock.busyBio")
                : t(macKeychainHint ? "unlock.hintBioMac" : "unlock.hintBio")}
            </div>
          </div>
        )}

        {gate !== "bio" && (
          <div className="unlock-field-cluster" ref={fieldClusterRef}>
            {gate === "password" && (
              <input
                className="input"
                type="password"
                placeholder={t("unlock.passwordPh")}
                value={pw}
                autoFocus
                onFocus={revealUnlockField}
                onBlur={() => window.setTimeout(() => {
                  if (!stageRef.current?.contains(document.activeElement)) markIme(false);
                }, 80)}
                onChange={(e) => setPw(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && unlock()}
              />
            )}
            {gate === "recovery" && (
              <textarea
                className="input mono"
                placeholder={t("unlock.recoveryPh")}
                value={recovery}
                autoFocus
                onFocus={revealUnlockField}
                onBlur={() => window.setTimeout(() => {
                  if (!stageRef.current?.contains(document.activeElement)) markIme(false);
                }, 80)}
                onChange={(e) => setRecovery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && e.ctrlKey && unlock()}
              />
            )}
            {err && <div className="err-text">{err}</div>}
            <button type="button" className="btn primary lg" style={{ width: "100%", marginTop: 16 }} disabled={busy} onClick={unlock}>
              {busy ? t("unlock.unlocking") : gate === "recovery" ? t("unlock.useRecovery") : t("unlock.unlock")}
            </button>
          </div>
        )}

        <div className="unlock-alts">
          {gate === "bio" && (
            <button type="button" className="unlock-switch" disabled={busy} onClick={() => switchGate("password")}>
              <KeyRound size={12} />
              {t("unlock.usePassword")}
            </button>
          )}
          {gate === "password" && fingerprintReady && (
            <button type="button" className="unlock-switch" disabled={busy} onClick={() => switchGate("bio")}>
              <Fingerprint size={12} />
              {bioVerb(bio)}
            </button>
          )}
          {gate !== "recovery" ? (
            <button type="button" className="unlock-switch" disabled={busy} onClick={() => switchGate("recovery")}>
              {t("unlock.forgotRecovery")}
            </button>
          ) : (
            <button
              type="button"
              className="unlock-switch"
              disabled={busy}
              onClick={() => switchGate(fingerprintReady ? "bio" : "password")}
            >
              {fingerprintReady ? t("unlock.backToBio", { name: bioName }) : t("unlock.useAccessPassword")}
            </button>
          )}
        </div>

        <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
          <button
            type="button"
            className="btn ghost sm"
            onClick={toggleTheme}
            style={{ display: "inline-flex", gap: 5, color: "var(--text-mute)", fontSize: 11 }}
          >
            {theme === "light" ? <Sun size={12} /> : theme === "dark" ? <Moon size={12} /> : <Palette size={12} />}
            <span>
              {t("theme.skin", {
                name:
                  theme === "light"
                    ? t("theme.lightFull")
                    : theme === "dark"
                      ? t("theme.darkFull")
                      : t("theme.navyFull"),
              })}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
