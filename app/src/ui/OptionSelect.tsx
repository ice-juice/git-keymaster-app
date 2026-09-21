import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { resolvePlatform } from "../platform/resolve";
import { GroupMenuList, GroupMenuSurface, type GroupMenuItem } from "./GroupMenu";
import { placeAnchoredPop, placeAnchoredPopInitial, type AnchoredPopBox } from "./placeAnchoredPop";

export type OptionSelectItem = {
  value: string;
  label: string;
};

function isInsideRowMenu(target: EventTarget | null) {
  return target instanceof Element && !!target.closest(".group-row-menu");
}

/** 移动端底部选择单；桌面端为可搜索的固定定位下拉。 */
export function OptionSelect({
  value,
  options,
  onChange,
  title,
  disabled,
  className,
  style,
}: {
  value: string;
  options: OptionSelectItem[];
  onChange: (value: string) => void;
  title: string;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const { t } = useTranslation();
  const mobile = resolvePlatform() === "mobile";
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<AnchoredPopBox | null>(null);
  const current = options.find((item) => item.value === value);
  const items = useMemo<GroupMenuItem[]>(
    () => options.map((item) => ({ key: item.value, label: item.label })),
    [options],
  );

  function placeInitial() {
    const el = btnRef.current;
    if (!el) return;
    setBox(placeAnchoredPopInitial(el.getBoundingClientRect()));
  }

  function syncPopBox() {
    const btn = btnRef.current;
    const pop = popRef.current;
    if (!btn || !pop) return;
    const next = placeAnchoredPop(btn.getBoundingClientRect(), pop.getBoundingClientRect().height);
    setBox((prev) =>
      prev && prev.top === next.top && prev.left === next.left && prev.width === next.width ? prev : next,
    );
  }

  useLayoutEffect(() => {
    if (!open || mobile) return;
    syncPopBox();
    const pop = popRef.current;
    if (!pop || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => syncPopBox());
    ro.observe(pop);
    return () => ro.disconnect();
  }, [open, mobile]);

  useEffect(() => {
    if (!open || mobile) return;
    function onPointer(ev: MouseEvent) {
      const target = ev.target as Node;
      if (btnRef.current?.contains(target) || popRef.current?.contains(target)) return;
      if (isInsideRowMenu(ev.target)) return;
      setOpen(false);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") setOpen(false);
    }
    function onScroll(ev: Event) {
      if (popRef.current?.contains(ev.target as Node)) return;
      if (isInsideRowMenu(ev.target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, mobile]);

  const hostClass = "option-select-host" + (className ? ` ${className}` : "");

  if (mobile) {
    return (
      <div className={hostClass} style={style}>
        <button
          type="button"
          className="m-group-cell-btn"
          disabled={disabled}
          onClick={() => {
            if (disabled) return;
            setOpen(true);
          }}
        >
          <span className={"m-group-cell-name" + (current ? "" : " is-none")}>
            {current?.label || title}
          </span>
          <ChevronRight size={16} className="m-group-cell-arrow" />
        </button>
        <GroupMenuSurface open={open} onClose={() => setOpen(false)} title={title}>
          <GroupMenuList
            items={items}
            value={value}
            forceSearch
            searchPlaceholder={t("common.listSearch")}
            emptyLabel={t("common.listSearchEmpty")}
            onSelect={(key) => {
              onChange(key);
              setOpen(false);
            }}
          />
          {options.length === 0 ? <div className="group-menu-empty">{t("common.listSearchEmpty")}</div> : null}
        </GroupMenuSurface>
      </div>
    );
  }

  return (
    <div className={hostClass} style={style}>
      <button
        ref={btnRef}
        type="button"
        className={"input icon-select-trigger option-select-trigger" + (open ? " is-open" : "")}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => {
          if (disabled) return;
          if (open) {
            setOpen(false);
            return;
          }
          placeInitial();
          setOpen(true);
        }}
      >
        <span className={current ? "" : "muted"}>{current?.label || title}</span>
        <ChevronDown size={14} />
      </button>
      {open && box
        ? createPortal(
            <div
              ref={popRef}
              className="option-select-pop"
              role="listbox"
              aria-label={title}
              style={{ top: box.top, left: box.left, width: box.width }}
            >
              <GroupMenuList
                items={items}
                value={value}
                forceSearch
                searchPlaceholder={t("common.listSearch")}
                emptyLabel={t("common.listSearchEmpty")}
                onSelect={(key) => {
                  onChange(key);
                  setOpen(false);
                }}
              />
              {options.length === 0 ? <div className="group-menu-empty">{t("common.listSearchEmpty")}</div> : null}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
