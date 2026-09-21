import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { BuiltinIconInfo } from "../lib/ipc";
import { ICON_PRESET_COLORS, colorIconRef, isLetterIcon, parseIconColor } from "../shared/iconColor";
import { IconMark } from "./IconMark";

export function IconColorButton({
  icon,
  builtins,
  label,
  size = 40,
  radius = 8,
  onPick,
}: {
  icon?: string | null;
  builtins: BuiltinIconInfo[];
  label?: string;
  size?: number;
  radius?: number;
  onPick: (hex: string) => void;
}) {
  const { t } = useTranslation();
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<{ top: number; left: number } | null>(null);
  const canColor = isLetterIcon(icon);
  const selected = parseIconColor(icon);

  function place() {
    const el = btnRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const width = 188;
    const height = 78;
    let left = rect.left;
    let top = rect.bottom + 6;
    if (left + width > window.innerWidth - 8) left = window.innerWidth - 8 - width;
    if (left < 8) left = 8;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - 6 - height);
    setBox({ top, left });
  }

  useEffect(() => {
    if (!open) return;
    function onPointer(ev: MouseEvent) {
      const target = ev.target as Node;
      if (btnRef.current?.contains(target) || popRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onScroll() {
      setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={"icon-color-trigger" + (canColor ? "" : " is-static") + (open ? " is-open" : "")}
        title={canColor ? t("accounts.iconColorPick") : undefined}
        aria-expanded={canColor ? open : undefined}
        onClick={() => {
          if (!canColor) return;
          if (open) {
            setOpen(false);
            return;
          }
          place();
          setOpen(true);
        }}
      >
        <IconMark icon={icon} builtins={builtins} label={label} size={size} radius={radius} />
      </button>
      {open && canColor && box &&
        createPortal(
          <div
            ref={popRef}
            className="icon-color-pop"
            role="listbox"
            aria-label={t("accounts.iconColor")}
            style={{ top: box.top, left: box.left }}
          >
            {ICON_PRESET_COLORS.map((hex) => (
              <button
                key={hex}
                type="button"
                className={"icon-color-swatch" + (selected === hex ? " on" : "")}
                style={{ background: hex }}
                aria-label={hex}
                aria-pressed={selected === hex}
                onClick={() => {
                  onPick(hex);
                  setOpen(false);
                }}
              />
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

export function IconUploadStack({
  icon,
  builtins,
  label,
  size = 40,
  onPickColor,
  onUpload,
}: {
  icon?: string | null;
  builtins: BuiltinIconInfo[];
  label?: string;
  size?: number;
  onPickColor: (hex: string) => void;
  onUpload: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="platform-icon-stack" style={{ width: size }}>
      <IconColorButton
        icon={icon}
        builtins={builtins}
        label={label}
        size={size}
        radius={0}
        onPick={onPickColor}
      />
      <button type="button" className="platform-icon-upload" onClick={onUpload}>
        {t("accounts.upload")}
      </button>
    </div>
  );
}

export function letterIconChoice(icon: string | undefined, nextBuiltin: string): string | undefined {
  if (nextBuiltin) return nextBuiltin;
  const kept = parseIconColor(icon);
  return kept ? colorIconRef(kept) : undefined;
}
