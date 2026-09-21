import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { BuiltinIconInfo } from "../lib/ipc";
import { resolvePlatform } from "../platform/resolve";
import { filterBuiltinIcons } from "../shared/iconAliases";
import { GroupMenuSurface } from "./GroupMenu";
import { IconMark } from "./IconMark";

export function BuiltinIconSelect({
  value,
  builtins,
  autoLabel,
  onChange,
}: {
  value: string;
  builtins: BuiltinIconInfo[];
  autoLabel: string;
  onChange: (next: string) => void;
}) {
  const { t } = useTranslation();
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [box, setBox] = useState<{ top: number; left: number; width: number } | null>(null);
  const mobile = resolvePlatform() === "mobile";
  const selectedId = value.startsWith("builtin:") ? value.slice("builtin:".length) : "";
  const selected = builtins.find((item) => item.id === selectedId);
  const shown = filterBuiltinIcons(builtins, query);

  function place() {
    const el = btnRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const width = Math.min(300, Math.max(rect.width, 220), window.innerWidth - 16);
    let left = rect.left;
    let top = rect.bottom + 6;
    if (left + width > window.innerWidth - 8) left = window.innerWidth - 8 - width;
    if (left < 8) left = 8;
    if (top + 280 > window.innerHeight - 8) top = Math.max(8, rect.top - 6 - 280);
    setBox({ top, left, width });
  }

  useEffect(() => {
    if (!open || mobile) return;
    searchRef.current?.focus();
    function onPointer(ev: MouseEvent) {
      const target = ev.target as Node;
      if (btnRef.current?.contains(target) || popRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") setOpen(false);
    }
    function onScroll(ev: Event) {
      if (popRef.current?.contains(ev.target as Node)) return;
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

  function choose(next: string) {
    onChange(next);
    setOpen(false);
    setQuery("");
  }

  if (mobile) {
    return (
      <>
        <button type="button" className="m-group-cell-btn" onClick={() => { setQuery(""); setOpen(true); }}>
          {selected ? (
            <IconMark icon={`builtin:${selected.id}`} builtins={builtins} label={selected.name} size={22} />
          ) : null}
          <span className={"m-group-cell-name" + (selected ? "" : " is-none")}>
            {selected ? selected.name : autoLabel}
          </span>
          <ChevronRight size={16} className="m-group-cell-arrow" />
        </button>
        <GroupMenuSurface open={open} onClose={() => setOpen(false)} title={autoLabel}>
          <label className="group-menu-search">
            <input
              className="input"
              type="search"
              value={query}
              placeholder={t("common.iconSearch")}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="group-menu-list" role="listbox">
            <div className={"group-menu-item" + (selected ? "" : " on")}>
              <button type="button" className="group-menu-item-pick" onClick={() => choose("")}>
                <span className="group-menu-item-label">{autoLabel}</span>
                {selected ? null : <Check size={15} />}
              </button>
            </div>
            {shown.map((item) => (
              <div key={item.id} className={"group-menu-item" + (item.id === selectedId ? " on" : "")}>
                <button type="button" className="group-menu-item-pick" onClick={() => choose(`builtin:${item.id}`)}>
                  <span className="group-menu-item-main">
                    <IconMark icon={`builtin:${item.id}`} builtins={builtins} label={item.name} size={22} />
                    <span className="group-menu-item-label">{item.name}</span>
                  </span>
                  {item.id === selectedId ? <Check size={15} /> : null}
                </button>
              </div>
            ))}
            {shown.length === 0 ? <div className="group-menu-empty">{t("common.iconSearchEmpty")}</div> : null}
          </div>
        </GroupMenuSurface>
      </>
    );
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={"input icon-select-trigger" + (open ? " is-open" : "")}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          place();
          setQuery("");
          setOpen(true);
        }}
      >
        {selected ? (
          <IconMark icon={`builtin:${selected.id}`} builtins={builtins} label={selected.name} size={22} />
        ) : null}
        <span className={selected ? "" : "muted"}>{selected ? selected.name : autoLabel}</span>
        <ChevronDown size={14} />
      </button>
      {open && box
        ? createPortal(
            <div
              ref={popRef}
              className="icon-select-pop"
              style={{ top: box.top, left: box.left, width: box.width }}
            >
              <input
                ref={searchRef}
                className="input"
                value={query}
                placeholder={t("common.iconSearch")}
                onChange={(e) => setQuery(e.target.value)}
              />
              <div className="icon-select-list" role="listbox">
                <button type="button" className={"icon-select-item" + (selected ? "" : " is-active")} onClick={() => choose("")}>
                  <span>{autoLabel}</span>
                </button>
                {shown.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={item.id === selectedId}
                    className={"icon-select-item" + (item.id === selectedId ? " is-active" : "")}
                    onClick={() => choose(`builtin:${item.id}`)}
                  >
                    <IconMark icon={`builtin:${item.id}`} builtins={builtins} label={item.name} size={22} />
                    <span>{item.name}</span>
                  </button>
                ))}
                {shown.length === 0 ? <div className="hint">{t("common.iconSearchEmpty")}</div> : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
