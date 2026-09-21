import { useEffect, useState } from "react";
import { api, type Candidate } from "../../lib/ipc";
import { readClipboard } from "../../lib/clipboard";
import { CLIPBOARD_WATCH_EVENT } from "../clipboardWatch";
import { extractGitRepoUrl, repoLabelFromUrl } from "../gitUrl";

const POLL_MS = 2000;

export interface ClipboardCloneHint {
  url: string;
  repo: string;
  identityName: string | null;
  rewrittenUrl: string | null;
  recommended: Candidate | null;
}

export function useClipboardCloneHint(active: boolean) {
  const [hint, setHint] = useState<ClipboardCloneHint | null>(null);

  useEffect(() => {
    if (!active) {
      setHint(null);
      return;
    }

    let cancelled = false;
    let timer = 0;
    let lastUrl = "";

    async function tick() {
      if (cancelled) return;
      let raw = "";
      try {
        raw = await readClipboard();
      } catch {
        return;
      }
      const url = extractGitRepoUrl(raw);
      raw = "";
      if (!url || url === lastUrl) return;
      lastUrl = url;
      try {
        const inf = await api.resolveUrl(url);
        if (cancelled) return;
        setHint({
          url,
          repo: repoLabelFromUrl(inf.rewrittenUrl || url),
          identityName: inf.recommended?.identityName ?? null,
          rewrittenUrl: inf.rewrittenUrl,
          recommended: inf.recommended,
        });
      } catch {
        /* 非仓库地址或未解锁：不留痕 */
      }
    }

    function startPolling() {
      window.clearInterval(timer);
      timer = window.setInterval(() => {
        void tick();
      }, POLL_MS);
      void tick();
    }

    function stopPolling() {
      window.clearInterval(timer);
      timer = 0;
      lastUrl = "";
      setHint(null);
    }

    async function syncWatch() {
      if (cancelled) return;
      let enabled = false;
      try {
        enabled = await api.getClipboardWatch();
      } catch {
        enabled = false;
      }
      if (cancelled) return;
      if (enabled) startPolling();
      else stopPolling();
    }

    void syncWatch();
    const onChange = () => {
      void syncWatch();
    };
    window.addEventListener(CLIPBOARD_WATCH_EVENT, onChange);
    return () => {
      cancelled = true;
      window.removeEventListener(CLIPBOARD_WATCH_EVENT, onChange);
      window.clearInterval(timer);
    };
  }, [active]);

  return { hint, dismiss: () => setHint(null) };
}
