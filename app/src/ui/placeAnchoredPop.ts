export type AnchoredPopBox = { top: number; left: number; width: number };

const GAP = 6;
const PAD = 8;

/** 触发器初始占位：先贴下方，宽度对齐触发器；真实高度稍后校正。 */
export function placeAnchoredPopInitial(trigger: DOMRect): AnchoredPopBox {
  return placeAnchoredPop(trigger, null);
}

/**
 * 按触发器定位 fixed 弹层。
 * - 优先触发器正下方，间距 6px，左右与触发器对齐（宽度不窄于触发器，仅视口不够时收缩）。
 * - 下方不够时翻到上方，底边贴触发器顶边；必须传入弹层真实高度，避免按过大预估高度悬空。
 */
export function placeAnchoredPop(trigger: DOMRect, popHeight: number | null): AnchoredPopBox {
  const width = Math.min(trigger.width, window.innerWidth - PAD * 2);
  let left = trigger.left;
  if (left + width > window.innerWidth - PAD) left = window.innerWidth - PAD - width;
  if (left < PAD) left = PAD;

  const belowTop = trigger.bottom + GAP;
  if (popHeight == null || popHeight <= 0) {
    return { top: belowTop, left, width };
  }

  const spaceBelow = window.innerHeight - PAD - belowTop;
  const spaceAbove = trigger.top - PAD - GAP;
  const preferAbove = popHeight > spaceBelow && spaceAbove > spaceBelow;

  let top: number;
  if (preferAbove) {
    top = trigger.top - GAP - popHeight;
    if (top < PAD) top = PAD;
  } else {
    top = belowTop;
    if (top + popHeight > window.innerHeight - PAD) {
      top = Math.max(PAD, window.innerHeight - PAD - popHeight);
    }
  }

  return { top, left, width };
}
