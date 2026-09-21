import { useEffect, useState } from "react";
import type { BuiltinIconInfo } from "../lib/ipc";
import { customIconUrl } from "../lib/secretsUi";
import { i18n } from "../lib/i18n";
import { builtinIconArt } from "../shared/builtinIconArt";
import { parseIconColor } from "../shared/iconColor";

function glyphInk(hex: string): string {
  const h = hex.replace("#", "");
  if (h.length !== 6) return "#fff";
  const r = Number.parseInt(h.slice(0, 2), 16);
  const g = Number.parseInt(h.slice(2, 4), 16);
  const b = Number.parseInt(h.slice(4, 6), 16);
  const y = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return y > 0.72 ? "#111111" : "#ffffff";
}

function fallbackIcon(): BuiltinIconInfo {
  return { id: "generic", name: i18n.t("common.genericIcon"), color: "#6366f1", glyph: "•" };
}

export function IconMark({
  icon,
  builtins,
  label,
  size = 28,
  color,
  radius = 8,
}: {
  icon?: string | null;
  builtins: BuiltinIconInfo[];
  label?: string;
  size?: number;
  color?: string;
  radius?: number;
}) {
  const [custom, setCustom] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    if (icon?.startsWith("custom:")) {
      customIconUrl(icon)
        .then((u) => {
          if (live) setCustom(u);
        })
        .catch(() => {
          if (live) setCustom(null);
        });
    } else {
      setCustom(null);
    }
    return () => {
      live = false;
    };
  }, [icon]);

  if (custom) {
    return (
      <img
        src={custom}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size, borderRadius: radius, objectFit: "cover", flex: `0 0 ${size}px` }}
      />
    );
  }

  const id = icon?.startsWith("builtin:") ? icon.slice("builtin:".length) : "";
  const art = id ? builtinIconArt[id] : undefined;
  const info = builtins.find((b) => b.id === id) || fallbackIcon();
  const letter = (label || info.glyph || "?").slice(0, 2);
  const tint = color || parseIconColor(icon) || art?.color || info.color;
  if (art && !color && !parseIconColor(icon)) {
    const mark = Math.max(10, Math.round(size * 0.62));
    return (
      <div
        className="icon-mark"
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          background: art.color,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flex: `0 0 ${size}px`,
        }}
      >
        <svg viewBox="0 0 24 24" width={mark} height={mark} aria-hidden="true">
          {art.paths.map((d, index) => (
            <path key={index} d={d} fill={glyphInk(art.color)} />
          ))}
        </svg>
      </div>
    );
  }
  return (
    <div
      className="icon-mark"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: tint,
        color: "#fff",
        fontSize: size < 26 ? 9 : 11,
        fontWeight: 700,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flex: `0 0 ${size}px`,
      }}
    >
      {info.id === "generic" && label ? letter : info.glyph}
    </div>
  );
}
