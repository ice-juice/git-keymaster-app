import type { CSSProperties } from "react";
import { tagColor } from "../shared/tagColor";

function tagStyle(tag: string, selected?: boolean): CSSProperties {
  const color = tagColor(tag);
  if (selected) {
    return { color: "#fff", background: color.fg, borderColor: color.fg };
  }
  return { color: color.fg, background: color.bg, borderColor: color.border };
}

export function AccountTag({
  tag,
  selected,
  hashed,
  onClick,
}: {
  tag: string;
  selected?: boolean;
  hashed?: boolean;
  onClick?: () => void;
}) {
  const label = hashed ? `#${tag}` : tag;
  const style = tagStyle(tag, selected);
  if (onClick) {
    return (
      <button type="button" className={"note-tag account-tag" + (selected ? " on" : "")} style={style} onClick={onClick}>
        {label}
      </button>
    );
  }
  return (
    <span className="badge account-tag" style={style}>
      {label}
    </span>
  );
}
