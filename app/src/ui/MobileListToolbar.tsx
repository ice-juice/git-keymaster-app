import { useEffect, type ReactNode } from "react";
import { Plus, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useOverlayBack } from "../shared/mobileBack";

export type MobileAddAction = {
  key: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
};

export function MobileListToolbar({
  query,
  onQueryChange,
  placeholder,
  addLabel,
  addDisabled,
  onAdd,
  addActions,
  sheetOpen,
  onSheetOpenChange,
  beforeAdd,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  placeholder: string;
  addLabel: string;
  addDisabled?: boolean;
  onAdd?: () => void;
  addActions?: MobileAddAction[];
  sheetOpen?: boolean;
  onSheetOpenChange?: (open: boolean) => void;
  beforeAdd?: ReactNode;
}) {
  const { t } = useTranslation();
  const hasSheet = !!addActions?.length;
  const open = !!sheetOpen;
  useOverlayBack(open, () => onSheetOpenChange?.(false));

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onSheetOpenChange?.(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onSheetOpenChange]);

  function handleAdd() {
    if (addDisabled) return;
    if (hasSheet) {
      onSheetOpenChange?.(!open);
      return;
    }
    onAdd?.();
  }

  return (
    <>
      <div className="m-list-toolbar">
        <label className="m-list-search">
          <Search size={16} className="m-list-search-icon" aria-hidden />
          <input
            type="search"
            enterKeyHint="search"
            placeholder={placeholder}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
          />
          {query && (
            <button
              type="button"
              className="m-list-search-clear"
              aria-label={t("common.clearSearch")}
              onClick={() => onQueryChange("")}
            >
              <X size={14} />
            </button>
          )}
        </label>
        {beforeAdd}
        <button
          type="button"
          className={"m-list-add-btn" + (open ? " on" : "")}
          disabled={addDisabled}
          aria-expanded={hasSheet ? open : undefined}
          onClick={handleAdd}
        >
          {open ? <X size={16} /> : <Plus size={16} />}
          <span>{addLabel}</span>
        </button>
      </div>

      {hasSheet && open && (
        <div
          className="m-list-sheet-overlay"
          role="presentation"
          onClick={() => onSheetOpenChange?.(false)}
        >
          <div
            className="m-list-sheet"
            role="menu"
            aria-label={addLabel}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="m-list-sheet-handle" />
            <div className="m-list-sheet-title">{addLabel}</div>
            {addActions!.map((action) => (
              <button
                key={action.key}
                type="button"
                role="menuitem"
                className="m-list-sheet-item"
                disabled={action.disabled}
                onClick={() => {
                  onSheetOpenChange?.(false);
                  action.onClick();
                }}
              >
                <span className="m-list-sheet-icon">{action.icon}</span>
                <span className="m-list-sheet-copy">
                  <span className="m-list-sheet-label">{action.label}</span>
                  {action.hint && <span className="m-list-sheet-hint">{action.hint}</span>}
                </span>
              </button>
            ))}
            <button
              type="button"
              className="m-list-sheet-cancel"
              onClick={() => onSheetOpenChange?.(false)}
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
