import { useEffect, useRef } from "react";
import { KeyRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { prefersReducedMotion } from "../lib/prefs";

export function StartupAnimation({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  }, [onDone]);
  useEffect(() => {
    if (prefersReducedMotion()) {
      done.current();
      return;
    }
    const timer = setTimeout(() => done.current(), 700);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Enter") done.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  return (
    <div className="startup-animation" aria-label={t("onboarding.startup")}>
      <KeyRound size={48} aria-hidden="true" />
      <button type="button" onClick={onDone}>
        {t("onboarding.skipAnimation")}
      </button>
    </div>
  );
}
