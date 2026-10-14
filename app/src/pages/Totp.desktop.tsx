import { useEffect, useRef, useState, type ReactNode } from "react";
import { Camera, ChevronDown, ImagePlus, Plus, Scan } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PageHead, SecurityNote } from "../ui/common";
import { can } from "../platform/capabilities";
import { useTotpModel, type TotpModel } from "../shared/hooks/useTotpModel";
import { TotpContextMenu, TotpDialogs, TotpEmpty, TotpEntries, TotpFilters, TotpFoldToggle, TotpViewSwitcher } from "./Totp.shared";
import { useItemFocus } from "../shared/hooks/useItemFocus";

function TotpDesktopAddMenu({ m }: { m: TotpModel }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(ev: MouseEvent) {
      if (!rootRef.current?.contains(ev.target as Node)) setOpen(false);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const items = [
    can("cameraQrScan") && {
      key: "camera",
      label: t("pages.scanCamera"),
      hint: t("totp.scanImportHint"),
      icon: <Camera size={16} />,
      disabled: m.busy,
      onClick: () => void m.scanCamera(),
    },
    can("screenQrScan") && {
      key: "screen",
      label: t("pages.scanScreen"),
      hint: t("totp.scanScreenHint"),
      icon: <Scan size={16} />,
      disabled: m.busy,
      onClick: () => void m.scanScreen(),
    },
    {
      key: "image",
      label: t("pages.importImage"),
      hint: t("totp.importImageHintDesktop"),
      icon: <ImagePlus size={16} />,
      disabled: m.busy,
      onClick: () => void m.importImage(),
    },
    {
      key: "manual",
      label: t("totp.manualAdd"),
      hint: t("totp.manualAddHint"),
      icon: <Plus size={16} />,
      disabled: m.writesLocked,
      onClick: () => m.setEditor({}),
    },
  ].filter(Boolean) as {
    key: string;
    label: string;
    hint: string;
    icon: ReactNode;
    disabled?: boolean;
    onClick: () => void;
  }[];

  return (
    <div className="totp-add-menu" ref={rootRef}>
      <button
        type="button"
        className="btn primary sm"
        disabled={m.busy}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        <Plus size={13} /> {t("pages.add")}
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="totp-add-menu-pop" role="menu">
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className="totp-add-menu-item"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
            >
              <span className="totp-add-menu-icon">{item.icon}</span>
              <span className="totp-add-menu-copy">
                <span className="totp-add-menu-label">{item.label}</span>
                <span className="totp-add-menu-hint">{item.hint}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function TotpDesktop() {
  const { t } = useTranslation();
  const m = useTotpModel();
  useItemFocus(true, () => {
    m.setGroup("全部");
    m.setQ("");
  });

  return (
    <div className="stack-lg">
      <PageHead
        title={t("pages.totpTitle")}
        desc={t("pages.totpDesc")}
        note={
          <SecurityNote>
            <span>
              <strong>{t("totp.securityTitle")}</strong>
              {t("totp.securityBody")}
              {m.revealCfg.clip > 0 ? t("totp.securityClear", { n: m.revealCfg.clip }) : ""}
            </span>
            <div className="security-banner-pills">
              <span className="sec-pill purple">{t("totp.pillCipher")}</span>
              {m.revealCfg.grace > 0 && <span className="sec-pill cyan">{t("totp.pillGrace", { n: m.revealCfg.grace })}</span>}
              <span className="sec-pill purple">{t("totp.pillE2ee")}</span>
            </div>
          </SecurityNote>
        }
        actions={
          <>
            <TotpViewSwitcher view={m.view} setViewMode={m.setViewMode} />
            {m.view === "platform" && <TotpFoldToggle m={m} />}
            <TotpDesktopAddMenu m={m} />
          </>
        }
      />

      <TotpFilters m={m} />
      {m.filtered.length === 0 ? <TotpEmpty m={m} /> : <TotpEntries m={m} />}
      <TotpDialogs m={m} includeScanHits />
      <TotpContextMenu m={m} />
    </div>
  );
}
