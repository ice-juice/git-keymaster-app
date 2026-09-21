import { api } from "../lib/ipc";

/** 心跳节流间隔。空闲判定精度只到巡检的 10s，没必要报得更密。 */
const THROTTLE_MS = 20_000;

/**
 * 把用户操作节流上报给后端，供空闲自动锁定判定。
 *
 * 只监听"真的有人在操作"的事件：`mousemove` 不算，否则鼠标被宠物或震动碰一下
 * 就能无限续期，自动锁定形同虚设。
 */
export function startActivityHeartbeat(): () => void {
  let last = 0;
  let stopped = false;

  const report = () => {
    if (stopped) return;
    const now = Date.now();
    if (now - last < THROTTLE_MS) return;
    last = now;
    void api.reportActivity().catch(() => {
      /* 非 Tauri 环境或尚未解锁 */
    });
  };

  const events: (keyof WindowEventMap)[] = ["keydown", "pointerdown", "wheel", "focus"];
  for (const name of events) window.addEventListener(name, report, { passive: true });

  report();

  return () => {
    stopped = true;
    for (const name of events) window.removeEventListener(name, report);
  };
}
