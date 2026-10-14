import { useEffect, useState } from "react";
import { api } from "../../lib/ipc";
import { useApp } from "../../store";
import { afterNextPaint } from "../yieldToPaint";

export type HomeStats = {
  totp: number | null;
  account: number | null;
  note: number | null;
  file: number | null;
};

const EMPTY: HomeStats = { totp: null, account: null, note: null, file: null };

export function formatHomeStat(n: number | null): string {
  return n == null ? "-" : String(n);
}

/** 移动端总览四项计数。锁定时不打列表接口，显示 `-`。 */
export function useHomeStats(): HomeStats {
  const { writesLocked, dataVersion } = useApp();
  const [stats, setStats] = useState<HomeStats>(EMPTY);

  useEffect(() => {
    if (writesLocked) {
      setStats(EMPTY);
      return;
    }
    let cancelled = false;
    void afterNextPaint().then(() => {
      if (cancelled) return Promise.resolve(null);
      return Promise.all([api.totpList(), api.accountList(), api.noteList(), api.fileList()]);
    })
      .then((loaded) => {
        if (!loaded || cancelled) return;
        const [totp, account, note, file] = loaded;
        if (cancelled) return;
        setStats({
          totp: totp.entries.length,
          account: account.entries.length,
          note: note.entries.length,
          file: file.entries.length,
        });
      })
      .catch(() => {
        if (!cancelled) setStats({ totp: 0, account: 0, note: 0, file: 0 });
      });
    return () => {
      cancelled = true;
    };
  }, [writesLocked, dataVersion]);

  return stats;
}
