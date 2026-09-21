import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, Layers, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { resolvePlatform } from "../platform/resolve";
import { GroupMenuList, GroupMenuSurface, type GroupMenuItem } from "./GroupMenu";

export type GroupTabItem = GroupMenuItem;

function createLabelText(label: string | undefined, fallback: string) {
  return (label || fallback).replace(/^\+\s*/, "");
}

export function GroupTabs({
  items,
  value,
  onChange,
  onCreate,
  onReorder,
  onEdit,
  onDelete,
  createLabel,
  createDisabled,
}: {
  items: GroupTabItem[];
  value: string;
  onChange: (key: string) => void;
  onCreate?: () => void;
  onReorder?: (orderedKeys: string[]) => void;
  onEdit?: (key: string) => void;
  onDelete?: (key: string) => void;
  createLabel?: string;
  createDisabled?: boolean;
}) {
  const isMobile = resolvePlatform() === "mobile";

  if (isMobile) {
    return (
      <MobileGroupTabs
        items={items}
        value={value}
        onChange={onChange}
        onCreate={onCreate}
        onReorder={onReorder}
        onEdit={onEdit}
        onDelete={onDelete}
        createLabel={createLabel}
        createDisabled={createDisabled}
      />
    );
  }

  return (
    <DesktopGroupTabs
      items={items}
      value={value}
      onChange={onChange}
      onCreate={onCreate}
      onReorder={onReorder}
      onEdit={onEdit}
      onDelete={onDelete}
      createLabel={createLabel}
      createDisabled={createDisabled}
    />
  );
}

function DesktopGroupTabs({
  items,
  value,
  onChange,
  onCreate,
  onReorder,
  onEdit,
  onDelete,
  createLabel,
  createDisabled,
}: {
  items: GroupTabItem[];
  value: string;
  onChange: (key: string) => void;
  onCreate?: () => void;
  onReorder?: (orderedKeys: string[]) => void;
  onEdit?: (key: string) => void;
  onDelete?: (key: string) => void;
  createLabel?: string;
  createDisabled?: boolean;
}) {
  const { t } = useTranslation();
  const trackRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [overflows, setOverflows] = useState(false);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const check = () => {
      setOverflows(track.scrollWidth > track.clientWidth + 2);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(track);
    return () => ro.disconnect();
  }, [items, createLabel]);

  useEffect(() => {
    const el = itemRefs.current[value];
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    }
  }, [value]);

  return (
    <div className="group-tabs-bar">
      <div className={"group-tabs-track" + (overflows ? " is-overflow" : "")} ref={trackRef}>
        {items.map((item) => {
          const on = item.key === value;
          return (
            <button
              key={item.key}
              ref={(el) => {
                itemRefs.current[item.key] = el;
              }}
              type="button"
              className={"group-tab" + (on ? " on" : "")}
              onClick={() => onChange(item.key)}
            >
              {item.color ? <span className="group-tab-dot" style={{ background: item.color }} /> : null}
              <span>{item.label}</span>
              {item.count != null && <span className="group-tab-count">{item.count}</span>}
            </button>
          );
        })}
      </div>

      {(overflows || items.length > 2) && (
        <div className="group-tabs-more-wrap">
          <button
            type="button"
            className={"group-tabs-more" + (open ? " is-open" : "")}
            aria-expanded={open}
            aria-haspopup="listbox"
            title={t("group.openList")}
            onClick={() => setOpen((v) => !v)}
          >
            <span>{t("group.more")}</span>
            <ChevronDown size={14} />
          </button>
          <GroupMenuSurface open={open} onClose={() => setOpen(false)} title={t("group.openList")}>
            <GroupMenuList
              items={items}
              value={value}
              onSelect={(key) => {
                onChange(key);
                setOpen(false);
              }}
              onReorder={onReorder}
              onEdit={
                onEdit
                  ? (key) => {
                      setOpen(false);
                      onEdit(key);
                    }
                  : undefined
              }
              onDelete={
                onDelete
                  ? (key) => {
                      setOpen(false);
                      onDelete(key);
                    }
                  : undefined
              }
            />
          </GroupMenuSurface>
        </div>
      )}

      {onCreate && (
        <button
          type="button"
          className="group-tab dashed"
          disabled={createDisabled}
          onClick={onCreate}
        >
          {createLabel || t("group.create")}
        </button>
      )}
    </div>
  );
}

function MobileGroupTabs({
  items,
  value,
  onChange,
  onCreate,
  onReorder,
  onEdit,
  onDelete,
  createLabel,
  createDisabled,
}: {
  items: GroupTabItem[];
  value: string;
  onChange: (key: string) => void;
  onCreate?: () => void;
  onReorder?: (orderedKeys: string[]) => void;
  onEdit?: (key: string) => void;
  onDelete?: (key: string) => void;
  createLabel?: string;
  createDisabled?: boolean;
}) {
  const { t } = useTranslation();
  const [sheetOpen, setSheetOpen] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const hasMultiple = items.length > 2;

  useEffect(() => {
    const el = itemRefs.current[value];
    if (el && trackRef.current) {
      el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    }
  }, [value]);

  return (
    <div className="m-group-filter-bar">
      <div className="m-group-track" ref={trackRef}>
        {items.map((item) => {
          const on = item.key === value;
          return (
            <button
              key={item.key}
              ref={(el) => {
                itemRefs.current[item.key] = el;
              }}
              type="button"
              className={"m-group-pill" + (on ? " is-active" : "")}
              onClick={() => onChange(item.key)}
            >
              {item.color ? (
                <span className="m-group-pill-dot" style={{ background: item.color }} />
              ) : null}
              <span className="m-group-pill-text">{item.label}</span>
              {item.count != null && <span className="m-group-pill-count">{item.count}</span>}
            </button>
          );
        })}
        {onCreate && (
          <button
            type="button"
            className="m-group-pill is-create"
            disabled={createDisabled}
            onClick={onCreate}
          >
            <Plus size={13} />
            <span>{createLabelText(createLabel, t("group.create"))}</span>
          </button>
        )}
      </div>

      {hasMultiple && (
        <div className="m-group-more-box">
          <button
            type="button"
            className={"m-group-more-btn" + (sheetOpen ? " is-open" : "")}
            aria-label={t("group.openList")}
            title={t("group.openList")}
            onClick={() => setSheetOpen(true)}
          >
            <Layers size={15} />
          </button>
        </div>
      )}

      {hasMultiple && (
        <GroupMenuSurface
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          title={t("group.openList")}
        >
          <GroupMenuList
            items={items}
            value={value}
            onSelect={(key) => {
              onChange(key);
              setSheetOpen(false);
            }}
            onReorder={onReorder}
            onEdit={
              onEdit
                ? (key) => {
                    setSheetOpen(false);
                    onEdit(key);
                  }
                : undefined
            }
            onDelete={
              onDelete
                ? (key) => {
                    setSheetOpen(false);
                    onDelete(key);
                  }
                : undefined
            }
          />
          {onCreate && (
            <button
              type="button"
              className="group-menu-create"
              disabled={createDisabled}
              onClick={() => {
                setSheetOpen(false);
                onCreate();
              }}
            >
              <Plus size={15} />
              <span>{createLabelText(createLabel, t("group.create"))}</span>
            </button>
          )}
        </GroupMenuSurface>
      )}
    </div>
  );
}
