import { useEffect, useMemo, useState, type ReactNode } from "react";
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
}: {
  items: GroupMenuItem[];
  value: string;
  onSelect: (key: string) => void;
  onReorder?: (orderedKeys: string[]) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const showSearch = items.length > 8;
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
            placeholder={t("group.searchPh")}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      )}
      <div className="group-menu-list" role="listbox">
        {visible.length === 0 ? (
          <div className="group-menu-empty">{t("group.noMatch")}</div>
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
                  onClick={() => onSelect(item.key)}
                >
                  <span className="group-menu-item-main">
                    {item.color ? <span className="group-tab-dot" style={{ background: item.color }} /> : null}
                    <span className="group-menu-item-label">{item.label}</span>
                    {item.count != null && <span className="group-tab-count">{item.count}</span>}
                  </span>
                  {on && !showOrder ? <Check size={15} /> : null}
                </button>
                {showOrder ? (
                  <GroupReorderButtons
                    canUp={sortIndex > 0}
                    canDown={sortIndex < sortableKeys.length - 1}
                    onMove={(action) => move(item.key, action)}
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

export function GroupMenuSurface({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const mobile = resolvePlatform() === "mobile";
  useOverlayBack(open && mobile, onClose);

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

  return (
    <>
      <div className="group-menu-backdrop" onClick={onClose} />
      <div className="group-menu-pop" role="dialog" aria-label={title}>
        {children}
      </div>
    </>
  );
}
