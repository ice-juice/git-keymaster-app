import { api } from "../lib/ipc";

type NetworkConnection = {
  type?: string;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
};

function connection(): NetworkConnection | undefined {
  const nav = navigator as Navigator & { connection?: NetworkConnection; mozConnection?: NetworkConnection };
  return nav.connection || nav.mozConnection;
}

/** Wi-Fi / 以太网视为非按量。探测不到（桌面、iOS）时放行，避免误拦。 */
export function isNetworkUnmetered(): boolean {
  const type = connection()?.type;
  if (!type || type === "unknown" || type === "none") return true;
  return type === "wifi" || type === "ethernet";
}

export function startNetworkGuard(): () => void {
  const report = () => {
    void api.reportNetworkUnmetered(isNetworkUnmetered()).catch(() => {
      /* 非 Tauri 或尚未解锁 */
    });
  };
  report();
  const conn = connection();
  conn?.addEventListener?.("change", report);
  window.addEventListener("online", report);
  return () => {
    conn?.removeEventListener?.("change", report);
    window.removeEventListener("online", report);
  };
}
