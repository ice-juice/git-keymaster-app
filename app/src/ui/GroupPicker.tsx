import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { GroupMeta } from "../lib/ipc";
import { resolvePlatform } from "../platform/resolve";
import { GROUP_COLORS } from "./GroupDialog";
import { GroupMenuList, GroupMenuSurface, type GroupMenuItem } from "./GroupMenu";
import { GroupReorderButtons } from "./GroupReorderButtons";
import { moveGroupNames, type GroupMove } from "./groupOrder";
import { placeAnchoredPop, placeAnchoredPopInitial, type AnchoredPopBox } from "./placeAnchoredPop";

export function resolveGroupName(groups: GroupMeta[], raw?: string | null): string | undefined {
  const trimmed = (raw || "").trim();
  if (!trimmed) return undefined;
  return groups.find((g) => g.name.toLowerCase() === trimmed.toLowerCase())?.name || trimmed;
}

export function appendGroupIfNew(groups: GroupMeta[], raw?: string | null): GroupMeta[] | null {
  const name = resolveGroupName(groups, raw);
  if (!name) return null;
  if (groups.some((g) => g.name.toLowerCase() === name.toLowerCase())) return null;
  return [
    ...groups,
    {
      name,
      color: GROUP_COLORS[groups.length % GROUP_COLORS.length],
      sortOrder: groups.length,
    },
  ];
}

function isInsideRowMenu(target: EventTarget | null) {
  return target instanceof Element && !!target.closest(".group-row-menu");
}

export function GroupPicker({
  groups,
  value,
  onChange,
  onReorder,
  inline,
}: {
  groups: GroupMeta[];
  value?: string | null;
  onChange: (name: string) => void;
  onReorder?: (orderedNames: string[]) => void;
  inline?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [newInput, setNewInput] = useState("");
  const [box, setBox] = useState<AnchoredPopBox | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const isMobile = resolvePlatform() === "mobile";

  const current = (value || "").trim();
  const matched = groups.find((g) => g.name.toLowerCase() === current.toLowerCase());
  const isNew = current.length > 0 && !matched;
  const groupNames = groups.map((g) => g.name);
  const showOrder = !!onReorder && groups.length > 1;
  const selectedKey = matched?.name || (isNew ? current : "");
  const displayLabel = matched?.name || (isNew ? current : t("group.none"));

  function move(name: string, action: GroupMove) {
    if (!onReorder) return;
    const next = moveGroupNames(groupNames, name, action);
    if (next) onReorder(next);
  }

  const items: GroupMenuItem[] = [
    { key: "", label: t("group.none"), color: null },
    ...groups.map((g) => ({
      key: g.name,
      label: g.name,
      color: g.color,
      sortable: true,
    })),
  ];

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
    if (!open || isMobile) return;
    syncPopBox();
    const pop = popRef.current;
    if (!pop || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => syncPopBox());
    ro.observe(pop);
    return () => ro.disconnect();
  }, [open, isMobile]);

  useEffect(() => {
    if (!open || isMobile) return;
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
  }, [open, isMobile]);

  function commitNew() {
    const name = newInput.trim();
    if (!name) return;
    onChange(name);
    setNewInput("");
    setOpen(false);
  }

  const createRow = (
    <div className="group-picker-create">
      <input
        className="input"
        placeholder={groups.length ? t("group.orNew") : t("group.newPh")}
        value={newInput}
        onChange={(e) => setNewInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commitNew();
        }}
      />
      {newInput.trim() ? (
        <button type="button" className="btn primary sm" onClick={commitNew}>
          {t("common.ok")}
        </button>
      ) : null}
    </div>
  );

  // 1. 内嵌选择模式（如在已有的底部抽屉 / 批量弹窗内）
  if (inline || (isMobile && inline)) {
    return (
      <div className="m-group-inline-picker">
        <div className="m-group-inline-list">
          {items.map((item) => {
            const on = item.key === selectedKey;
            const sortIndex = item.sortable ? groupNames.indexOf(item.key) : -1;
            const rowOrder = showOrder && item.sortable && sortIndex >= 0;
            return (
              <div
                key={item.key}
                className={"m-group-inline-item" + (on ? " on" : "")}
              >
                <button
                  type="button"
                  className="group-menu-item-pick"
                  onClick={() => onChange(item.key)}
                >
                  <div className="m-group-inline-item-main">
                    {item.color ? (
                      <span className="group-tab-dot" style={{ background: item.color }} />
                    ) : null}
                    <span>{item.label}</span>
                  </div>
                  {on && !rowOrder && <Check size={16} />}
                </button>
                {rowOrder ? (
                  <GroupReorderButtons
                    canUp={sortIndex > 0}
                    canDown={sortIndex < groupNames.length - 1}
                    onMove={(action) => move(item.key, action)}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
        <div className="m-group-inline-create">
          <input
            className="input"
            placeholder={groups.length ? t("group.orNew") : t("group.newPh")}
            value={newInput}
            onChange={(e) => setNewInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newInput.trim()) {
                onChange(newInput.trim());
                setNewInput("");
              }
            }}
          />
          {newInput.trim() && (
            <button
              type="button"
              className="btn primary sm"
              onClick={() => {
                onChange(newInput.trim());
                setNewInput("");
              }}
            >
              {t("common.ok")}
            </button>
          )}
        </div>
        {isNew && <div className="hint">{t("group.willCreate", { name: current })}</div>}
      </div>
    );
  }

  // 2. 移动端表单触发条模式：点击拉起底部选择抽屉
  if (isMobile) {
    return (
      <div className="m-group-form-picker">
        <button
          type="button"
          className="m-group-cell-btn"
          onClick={() => setOpen(true)}
        >
          <div className="m-group-cell-val">
            {matched?.color ? (
              <span className="group-tab-dot" style={{ background: matched.color }} />
            ) : null}
            <span className={"m-group-cell-name" + (!current ? " is-none" : "")}>
              {displayLabel}
            </span>
            {isNew && <span className="m-group-cell-new-badge">{t("common.recommended")}</span>}
          </div>
          <ChevronRight size={16} className="m-group-cell-arrow" />
        </button>

        <GroupMenuSurface open={open} onClose={() => setOpen(false)} title={t("group.openList")}>
          <GroupMenuList
            items={items}
            value={selectedKey}
            forceSearch
            searchPlaceholder={t("common.listSearch")}
            emptyLabel={t("common.listSearchEmpty")}
            onSelect={(key) => {
              onChange(key);
              setOpen(false);
            }}
            onReorder={onReorder}
          />
          <div className="m-group-picker-create">
            <input
              className="input"
              placeholder={groups.length ? t("group.orNew") : t("group.newPh")}
              value={newInput}
              onChange={(e) => setNewInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newInput.trim()) {
                  onChange(newInput.trim());
                  setOpen(false);
                  setNewInput("");
                }
              }}
            />
            {newInput.trim() && (
              <button
                type="button"
                className="btn primary sm"
                onClick={() => {
                  onChange(newInput.trim());
                  setOpen(false);
                  setNewInput("");
                }}
              >
                {t("common.ok")}
              </button>
            )}
          </div>
        </GroupMenuSurface>
      </div>
    );
  }

  // 3. 桌面端：精简触发器 + 可搜索固定弹层（含排序菜单）
  return (
    <div className="group-picker group-picker-compact">
      <button
        ref={btnRef}
        type="button"
        className={"input icon-select-trigger option-select-trigger" + (open ? " is-open" : "")}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          setNewInput("");
          placeInitial();
          setOpen(true);
        }}
      >
        <span className="group-select-main">
          {matched?.color ? (
            <span className="group-tab-dot" style={{ background: matched.color }} />
          ) : null}
          <span className={"group-select-label" + (!current ? " muted" : "")}>{displayLabel}</span>
        </span>
        <ChevronDown size={14} />
      </button>
      {open && box
        ? createPortal(
            <div
              ref={popRef}
              className="option-select-pop"
              role="dialog"
              aria-label={t("group.openList")}
              style={{ top: box.top, left: box.left, width: box.width }}
            >
              <GroupMenuList
                items={items}
                value={selectedKey}
                forceSearch
                searchPlaceholder={t("common.listSearch")}
                emptyLabel={t("common.listSearchEmpty")}
                onSelect={(key) => {
                  onChange(key);
                  setOpen(false);
                }}
                onReorder={onReorder}
              />
              {createRow}
            </div>,
            document.body,
          )
        : null}
      {isNew && <div className="hint">{t("group.willCreate", { name: current })}</div>}
    </div>
  );
}
