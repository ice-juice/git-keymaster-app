import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowDownToLine, ArrowUpToLine, ChevronDown, ChevronUp, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { GroupMove } from "./groupOrder";

export function GroupReorderButtons({
  canUp,
  canDown,
  onMove,
  onEdit,
  onDelete,
  disabled,
}: {
  canUp: boolean;
  canDown: boolean;
  onMove: (action: GroupMove) => void;
  onEdit?: () => void;
  onDelete?: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<{ top: number; left: number } | null>(null);

  const moves = !disabled && (canUp || canDown);
  const actions: { key: string; label: string; icon: ReactNode; danger?: boolean; disabled?: boolean; run: () => void }[] = [];
  if (onEdit) {
    actions.push({ key: "edit", label: t("group.edit"), icon: <Pencil size={14} />, run: onEdit });
  }
  if (onDelete) {
    actions.push({ key: "delete", label: t("group.delete"), icon: <Trash2 size={14} />, danger: true, run: onDelete });
  }
  if (moves) {
    actions.push(
      { key: "up", label: t("group.moveUp"), icon: <ChevronUp size={14} />, disabled: !canUp, run: () => onMove("up") },
      { key: "down", label: t("group.moveDown"), icon: <ChevronDown size={14} />, disabled: !canDown, run: () => onMove("down") },
      { key: "top", label: t("group.moveTop"), icon: <ArrowUpToLine size={14} />, disabled: !canUp, run: () => onMove("top") },
      { key: "bottom", label: t("group.moveBottom"), icon: <ArrowDownToLine size={14} />, disabled: !canDown, run: () => onMove("bottom") },
    );
  }
  const visible = actions.filter((item) => !item.disabled);
  const moveStart = visible.findIndex((item) => item.key === "up" || item.key === "down" || item.key === "top" || item.key === "bottom");

  function place() {
    const el = btnRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const width = 156;
    const height = 8 + visible.length * 34 + (moveStart > 0 ? 9 : 0);
    let left = rect.right - width;
    let top = rect.bottom + 4;
    if (left < 8) left = 8;
    if (left + width > window.innerWidth - 8) left = window.innerWidth - 8 - width;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - 4 - height);
    setBox({ top, left });
  }

  useEffect(() => {
    if (!open) return;
    function onPointer(ev: MouseEvent) {
      const target = ev.target as Node;
      if (btnRef.current?.contains(target) || popRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key !== "Escape") return;
      ev.stopPropagation();
      setOpen(false);
    }
    function onScroll() {
      setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  if (visible.length === 0) return null;

  return (
    <div className="group-reorder" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      <button
        ref={btnRef}
        type="button"
        className={"group-reorder-btn" + (open ? " is-open" : "")}
        title={t("group.more")}
        aria-label={t("group.more")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (open) {
            setOpen(false);
            return;
          }
          place();
          setOpen(true);
        }}
      >
        <MoreHorizontal size={15} />
      </button>
      {open && box
        ? createPortal(
            <div ref={popRef} className="group-row-menu" role="menu" style={{ top: box.top, left: box.left }}>
              {visible.map((item, index) => (
                <div key={item.key}>
                  {index === moveStart && moveStart > 0 ? <div className="group-row-menu-sep" /> : null}
                  <button
                    type="button"
                    role="menuitem"
                    className={"group-row-menu-item" + (item.danger ? " is-danger" : "")}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setOpen(false);
                      item.run();
                    }}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </button>
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
