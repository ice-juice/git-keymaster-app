import { useState } from "react";
import { Check, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { GroupMeta } from "../lib/ipc";
import { resolvePlatform } from "../platform/resolve";
import { GROUP_COLORS } from "./GroupDialog";
import { GroupMenuList, GroupMenuSurface, type GroupMenuItem } from "./GroupMenu";
import { GroupReorderButtons } from "./GroupReorderButtons";
import { moveGroupNames, type GroupMove } from "./groupOrder";

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
  const isMobile = resolvePlatform() === "mobile";

  const current = (value || "").trim();
  const matched = groups.find((g) => g.name.toLowerCase() === current.toLowerCase());
  const isNew = current.length > 0 && !matched;
  const groupNames = groups.map((g) => g.name);
  const showOrder = !!onReorder && groups.length > 1;

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

  // 1. 内嵌选择模式（如在已有的底部抽屉 / 批量弹窗内）
  if (inline || (isMobile && inline)) {
    return (
      <div className="m-group-inline-picker">
        <div className="m-group-inline-list">
          {items.map((item) => {
            const on = item.key === (matched?.name || (isNew ? current : ""));
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
              {matched?.name || (isNew ? current : t("group.none"))}
            </span>
            {isNew && <span className="m-group-cell-new-badge">{t("common.recommended")}</span>}
          </div>
          <ChevronRight size={16} className="m-group-cell-arrow" />
        </button>

        <GroupMenuSurface open={open} onClose={() => setOpen(false)} title={t("group.openList")}>
          <GroupMenuList
            items={items}
            value={matched?.name || (isNew ? current : "")}
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

  // 3. 桌面端模式：平铺 Choice 按钮或紧凑 Choice 栏
  return (
    <div className="group-picker">
      {showOrder ? (
        <div className="group-picker-rows">
          <button
            type="button"
            className={"group-picker-row-pick" + (!current ? " on" : "")}
            onClick={() => onChange("")}
          >
            {t("group.none")}
          </button>
          {groups.map((g, idx) => (
            <div
              key={g.name}
              className={"group-picker-row" + (matched?.name === g.name ? " on" : "")}
            >
              <button
                type="button"
                className="group-picker-row-pick"
                onClick={() => onChange(g.name)}
              >
                {g.color && <span className="group-tab-dot" style={{ background: g.color }} />}
                <span className="group-menu-item-label">{g.name}</span>
              </button>
              <GroupReorderButtons
                canUp={idx > 0}
                canDown={idx < groups.length - 1}
                onMove={(action) => move(g.name, action)}
              />
            </div>
          ))}
        </div>
      ) : (
        <div className="choice-row">
          <button
            type="button"
            className={"choice" + (!current ? " on" : "")}
            onClick={() => onChange("")}
          >
            {t("group.none")}
          </button>
          {groups.map((g) => (
            <button
              key={g.name}
              type="button"
              className={"choice" + (matched?.name === g.name ? " on" : "")}
              onClick={() => onChange(g.name)}
            >
              {g.color && <span className="group-tab-dot" style={{ background: g.color }} />}
              {g.name}
            </button>
          ))}
        </div>
      )}
      <input
        className="input"
        placeholder={groups.length ? t("group.orNew") : t("group.newPh")}
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
      />
      {isNew && <div className="hint">{t("group.willCreate", { name: current })}</div>}
    </div>
  );
}
