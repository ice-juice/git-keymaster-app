import type { CSSProperties } from "react";
import { X } from "lucide-react";
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
  onRemove,
  removeLabel,
}: {
  tag: string;
  selected?: boolean;
  hashed?: boolean;
  onClick?: () => void;
  onRemove?: () => void;
  removeLabel?: string;
}) {
  const label = hashed ? `#${tag}` : tag;
  const style = tagStyle(tag, selected);
  const remove = onRemove ? (
    <button
      type="button"
      className="account-tag-x"
      aria-label={removeLabel}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.stopPropagation();
        onRemove();
      }}
    >
      <X size={12} strokeWidth={2.5} />
    </button>
  ) : null;
  if (onClick && !onRemove) {
    return (
      <button type="button" className={"note-tag account-tag" + (selected ? " on" : "")} style={style} onClick={onClick}>
        {label}
      </button>
    );
  }
  return (
    <span className={(onRemove ? "account-tag account-tag-chip" : "badge account-tag") + (selected ? " on" : "")} style={style}>
      {label}
      {remove}
    </span>
  );
}
