import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { api, errMessage, type UpdateCheckResult, type UpdateProgress } from "../lib/ipc";
import { UpdateNotesDialog } from "./UpdateNotesDialog";

export function UpdateToast() {
  const { t } = useTranslation();
  const [notice, setNotice] = useState<UpdateCheckResult | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let unavail: (() => void) | undefined;
    let unprog: (() => void) | undefined;
    listen<UpdateCheckResult>("update-available", (ev) => {
      if (ev.payload?.available) {
        setNotice(ev.payload);
        setErr("");
      }
    })
      .then((fn) => {
        unavail = fn;
      })
      .catch(() => {});
    listen<UpdateProgress>("update-progress", (ev) => {
      setProgress(ev.payload);
    })
      .then((fn) => {
        unprog = fn;
      })
      .catch(() => {});
    return () => {
      unavail?.();
      unprog?.();
    };
  }, []);

  async function install() {
    setInstalling(true);
    setErr("");
    try {
      await api.downloadAndInstallUpdate();
    } catch (e) {
      setErr(errMessage(e));
      setInstalling(false);
    }
  }

  async function skip() {
    const ver = notice?.latestVersion;
    if (!ver) return;
    setBusy(true);
    try {
      await api.skipUpdateVersion(ver);
      setNotice(null);
      setNotesOpen(false);
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const downloading = progress && progress.phase !== "finished";
  const percent =
    progress && progress.total && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null;

  if (!notice && !progress && !notesOpen) return null;

  return (
    <div className="update-toast" role="status">
      {progress?.phase === "finished" ? (
        <div className="update-toast-title">{t("update.toastReady")}</div>
      ) : downloading ? (
        <>
          <div className="update-toast-title">{t("update.toastDownloading")}</div>
          <div className="update-progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? 0}>
            <span style={{ width: `${percent ?? 15}%` }} />
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            {percent != null
              ? `${percent}%`
              : `${Math.round(progress.downloaded / 1024)} KB`}
          </div>
        </>
      ) : notice ? (
        <>
          <div className="update-toast-title">{t("update.toastFound", { version: notice.latestVersion })}</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            {t("update.toastCurrent", { version: notice.currentVersion })}
            {notice.selfUpdateSupported || notice.sideloadUpdateSupported
              ? t("update.toastCanInstall")
              : t("update.toastManual")}
          </div>
          {err && !notesOpen && <div className="err-text">{err}</div>}
          <div className="row" style={{ flexWrap: "wrap", marginTop: 10 }}>
            <button type="button" className="btn primary sm" onClick={() => setNotesOpen(true)}>
              {t("update.openUpdate")}
            </button>
          </div>
        </>
      ) : null}
      {notesOpen && notice?.available && (
        <UpdateNotesDialog
          version={notice.latestVersion}
          notes={notice.notes ?? ""}
          onClose={() => setNotesOpen(false)}
          actions={{
            canAuto: !!(notice.selfUpdateSupported || notice.sideloadUpdateSupported),
            manualUrl: notice.downloadUrl,
            installing,
            busy,
            error: err || undefined,
            note:
              notice.selfUpdateSupported || notice.sideloadUpdateSupported
                ? undefined
                : t("update.manualOnly"),
            onAuto: () => void install(),
            onManual: () => {
              if (notice.downloadUrl) void api.openUrl(notice.downloadUrl);
            },
            onSkip: () => void skip(),
          }}
        />
      )}
    </div>
  );
}
