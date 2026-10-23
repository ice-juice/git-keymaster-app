import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";

export type KeyExportFormat = "pub" | "pem";

export function KeyExportMenu({
  rsa,
  disabled,
  onExport,
}: {
  rsa: boolean;
  disabled?: boolean;
  onExport: (format: KeyExportFormat) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function pick(format: KeyExportFormat) {
    setOpen(false);
    onExport(format);
  }

  return (
    <div className="key-export" ref={root}>
      <button
        type="button"
        className="btn sm"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{t("keys.export")}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && (
        <div className="key-export-menu" role="menu" aria-label={t("keys.export")}>
          <button type="button" role="menuitem" onClick={() => pick("pub")}>
            {t("keys.exportPub")}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!rsa}
            title={rsa ? t("keys.exportPemHint") : t("keys.exportPemRsaOnly")}
            onClick={() => rsa && pick("pem")}
          >
            {t("keys.exportPem")}
          </button>
        </div>
      )}
    </div>
  );
}
