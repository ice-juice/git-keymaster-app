import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Check, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { resolvePlatform } from "../platform/resolve";
import { useOverlayBack } from "../shared/mobileBack";
import { isVirtualGroupKey, moveGroupNames, type GroupMove } from "./groupOrder";
import { GroupReorderButtons } from "./GroupReorderButtons";

export type GroupMenuItem = {
  key: string;
  label: string;
  count?: number;
  color?: string | null;
  sortable?: boolean;
};

export function filterGroupItems(items: GroupMenuItem[], query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => item.label.toLowerCase().includes(q) || item.key.toLowerCase().includes(q));
}

export function GroupMenuList({
  items,
  value,
  onSelect,
  onReorder,
  onEdit,
  onDelete,
  searchPlaceholder,
  emptyLabel,
  forceSearch,
}: {
  items: GroupMenuItem[];
  value: string;
  onSelect: (key: string) => void;
  onReorder?: (orderedKeys: string[]) => void;
  onEdit?: (key: string) => void;
  onDelete?: (key: string) => void;
  searchPlaceholder?: string;
  emptyLabel?: string;
  /** 桌面下拉等场景强制显示搜索框（不受条目数量限制） */
  forceSearch?: boolean;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const mobile = resolvePlatform() === "mobile";
  const showSearch = forceSearch || mobile || items.length > 8;
  const visible = useMemo(() => filterGroupItems(items, query), [items, query]);
  const sortableKeys = useMemo(
    () =>
      items
        .filter((item) => item.sortable !== false && !isVirtualGroupKey(item.key))
        .map((item) => item.key),
    [items],
  );
  const canReorder = !!onReorder && !query.trim() && sortableKeys.length > 1;

  function move(key: string, action: GroupMove) {
    if (!onReorder) return;
    const next = moveGroupNames(sortableKeys, key, action);
    if (next) onReorder(next);
  }

  return (
    <div className="group-menu-body">
      {showSearch && (
        <label className="group-menu-search">
          <Search size={14} aria-hidden />
          <input
            type="search"
            className="input"
            value={query}
            placeholder={searchPlaceholder || t("group.searchPh")}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      )}
      <div className="group-menu-list" role="listbox">
        {visible.length === 0 ? (
          <div className="group-menu-empty">{emptyLabel || t("group.noMatch")}</div>
        ) : (
          visible.map((item) => {
            const on = item.key === value;
            const sortIndex = sortableKeys.indexOf(item.key);
            const showOrder = canReorder && sortIndex >= 0;
            return (
              <div
                key={item.key}
                role="option"
                aria-selected={on}
                className={"group-menu-item" + (on ? " on" : "")}
              >
                <button
                  type="button"
                  className="group-menu-item-pick"
                  title={item.label}
                  onClick={() => onSelect(item.key)}
                >
                  <span className="group-menu-item-main">
                    {item.color ? <span className="group-tab-dot" style={{ background: item.color }} /> : null}
                    <span className="group-menu-item-label">{item.label}</span>
                    {item.count != null && <span className="group-tab-count">{item.count}</span>}
                  </span>
                  {on ? <Check size={15} /> : null}
                </button>
                {sortIndex >= 0 && (onEdit || onDelete || showOrder) ? (
                  <GroupReorderButtons
                    canUp={showOrder && sortIndex > 0}
                    canDown={showOrder && sortIndex < sortableKeys.length - 1}
                    onMove={(action) => move(item.key, action)}
                    onEdit={onEdit ? () => onEdit(item.key) : undefined}
                    onDelete={onDelete ? () => onDelete(item.key) : undefined}
                  />
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

const POP_PAD = 8;
const POP_GAP = 6;

function placeGroupMenu(anchor: DOMRect, popWidth: number, popHeight: number) {
  let left = anchor.right - popWidth;
  if (left < POP_PAD) left = POP_PAD;
  if (left + popWidth > window.innerWidth - POP_PAD) {
    left = Math.max(POP_PAD, window.innerWidth - POP_PAD - popWidth);
  }

  const belowTop = anchor.bottom + POP_GAP;
  const spaceBelow = window.innerHeight - POP_PAD - belowTop;
  const spaceAbove = anchor.top - POP_PAD - POP_GAP;
  let top = belowTop;
  if (popHeight > 0 && popHeight > spaceBelow && spaceAbove > spaceBelow) {
    top = Math.max(POP_PAD, anchor.top - POP_GAP - popHeight);
  } else if (popHeight > 0 && top + popHeight > window.innerHeight - POP_PAD) {
    top = Math.max(POP_PAD, window.innerHeight - POP_PAD - popHeight);
  }
  return { top, left };
}

export function GroupMenuSurface({
  open,
  onClose,
  title,
  anchorRef,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** 桌面下拉的定位锚点。传入后弹层挂到 body，避免被 overflow 裁切。 */
  anchorRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const mobile = resolvePlatform() === "mobile";
  const popRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ top: number; left: number } | null>(null);
  useOverlayBack(open && mobile, onClose);

  useLayoutEffect(() => {
    if (!open || mobile || !anchorRef) return;
    const anchor = anchorRef.current;
    const pop = popRef.current;
    if (!anchor || !pop) return;

    function sync() {
      const node = anchorRef?.current;
      const panel = popRef.current;
      if (!node || !panel) return;
      const next = placeGroupMenu(node.getBoundingClientRect(), panel.offsetWidth, panel.offsetHeight);
      setBox((prev) => (prev && prev.top === next.top && prev.left === next.left ? prev : next));
    }

    sync();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    ro?.observe(pop);
    function onScroll(ev: Event) {
      const panel = popRef.current;
      if (panel && ev.target instanceof Node && panel.contains(ev.target)) return;
      sync();
    }
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", sync);
    return () => {
      ro?.disconnect();
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", sync);
    };
  }, [open, mobile, anchorRef]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  if (mobile) {
    return (
      <div className="wizard-overlay" onClick={onClose}>
        <div className="m-note-sheet group-menu-sheet" onClick={(e) => e.stopPropagation()}>
          <div className="m-note-sheet-handle" />
          <div className="m-note-sheet-head">
            <div className="m-note-sheet-title">{title}</div>
          </div>
          {children}
        </div>
      </div>
    );
  }

  const pop = (
    <div
      ref={popRef}
      className="group-menu-pop"
      role="dialog"
      aria-label={title}
      style={
        anchorRef
          ? {
              position: "fixed",
              top: box?.top ?? -9999,
              left: box?.left ?? 0,
              right: "auto",
            }
          : undefined
      }
    >
      {children}
    </div>
  );

  if (anchorRef) {
    return createPortal(
      <>
        <div className="group-menu-backdrop" onClick={onClose} />
        {pop}
      </>,
      document.body,
    );
  }

  return (
    <>
      <div className="group-menu-backdrop" onClick={onClose} />
      {pop}
    </>
  );
}
