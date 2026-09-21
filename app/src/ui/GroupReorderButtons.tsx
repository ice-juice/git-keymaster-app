import type { ReactNode } from "react";
import { ArrowDownToLine, ArrowUpToLine, ChevronDown, ChevronUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { GroupMove } from "./groupOrder";

export function GroupReorderButtons({
  canUp,
  canDown,
  onMove,
  disabled,
}: {
  canUp: boolean;
  canDown: boolean;
  onMove: (action: GroupMove) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div
      className="group-reorder"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <ReorderIcon
        title={t("group.moveUp")}
        disabled={disabled || !canUp}
        onClick={() => onMove("up")}
      >
        <ChevronUp size={14} />
      </ReorderIcon>
      <ReorderIcon
        title={t("group.moveDown")}
        disabled={disabled || !canDown}
        onClick={() => onMove("down")}
      >
        <ChevronDown size={14} />
      </ReorderIcon>
      <ReorderIcon
        title={t("group.moveTop")}
        disabled={disabled || !canUp}
        onClick={() => onMove("top")}
      >
        <ArrowUpToLine size={14} />
      </ReorderIcon>
      <ReorderIcon
        title={t("group.moveBottom")}
        disabled={disabled || !canDown}
        onClick={() => onMove("bottom")}
      >
        <ArrowDownToLine size={14} />
      </ReorderIcon>
    </div>
  );
}

function ReorderIcon({
  title,
  disabled,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="group-reorder-btn"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!disabled) onClick();
      }}
    >
      {children}
    </button>
  );
}
