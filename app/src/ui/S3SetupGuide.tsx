import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { BookOpen, ExternalLink, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/ipc";

export type S3GuideProvider = "r2" | "s3" | "minio" | "other";

type Step = {
  title: string;
  body: string;
  url?: { href: string; label: string };
};

function guideProviders(t: (key: string) => string): { id: S3GuideProvider; label: string; hint: string }[] {
  return [
    { id: "r2", label: "Cloudflare R2", hint: t("s3guide.r2Hint") },
    { id: "s3", label: "AWS S3", hint: t("s3guide.s3Hint") },
    { id: "minio", label: "MinIO", hint: t("s3guide.minioHint") },
    { id: "other", label: t("s3guide.otherLabel"), hint: t("s3guide.otherHint") },
  ];
}

function guidePack(
  t: (key: string) => string,
  tab: S3GuideProvider,
): { blurb: string; steps: Step[]; fill: string[] } {
  if (tab === "r2") {
    return {
      blurb: t("s3guide.r2Blurb"),
      steps: [
        { title: t("s3guide.r2s1t"), body: t("s3guide.r2s1b"), url: { href: "https://dash.cloudflare.com/sign-up", label: t("s3guide.r2s1u") } },
        { title: t("s3guide.r2s2t"), body: t("s3guide.r2s2b"), url: { href: "https://dash.cloudflare.com/?to=/:account/r2/overview", label: t("s3guide.r2s2u") } },
        { title: t("s3guide.r2s3t"), body: t("s3guide.r2s3b") },
        { title: t("s3guide.r2s4t"), body: t("s3guide.r2s4b") },
        { title: t("s3guide.r2s5t"), body: t("s3guide.r2s5b") },
        { title: t("s3guide.r2s6t"), body: t("s3guide.r2s6b") },
      ],
      fill: [t("s3guide.r2f1"), t("s3guide.r2f2"), t("s3guide.r2f3"), t("s3guide.r2f4")],
    };
  }
  if (tab === "s3") {
    return {
      blurb: t("s3guide.s3Blurb"),
      steps: [
        { title: t("s3guide.s3s1t"), body: t("s3guide.s3s1b"), url: { href: "https://console.aws.amazon.com/", label: t("s3guide.s3s1u") } },
        { title: t("s3guide.s3s2t"), body: t("s3guide.s3s2b"), url: { href: "https://s3.console.aws.amazon.com/s3/home", label: t("s3guide.s3s2u") } },
        { title: t("s3guide.s3s3t"), body: t("s3guide.s3s3b"), url: { href: "https://console.aws.amazon.com/iam/home#/users", label: t("s3guide.s3s3u") } },
        { title: t("s3guide.s3s4t"), body: t("s3guide.s3s4b") },
        { title: t("s3guide.s3s5t"), body: t("s3guide.s3s5b") },
        { title: t("s3guide.s3s6t"), body: t("s3guide.s3s6b") },
      ],
      fill: [t("s3guide.s3f1"), t("s3guide.s3f2"), t("s3guide.s3f3"), t("s3guide.s3f4")],
    };
  }
  if (tab === "minio") {
    return {
      blurb: t("s3guide.minioBlurb"),
      steps: [
        { title: t("s3guide.minios1t"), body: t("s3guide.minios1b"), url: { href: "https://min.io/download", label: t("s3guide.minios1u") } },
        { title: t("s3guide.minios2t"), body: t("s3guide.minios2b") },
        { title: t("s3guide.minios3t"), body: t("s3guide.minios3b") },
        { title: t("s3guide.minios4t"), body: t("s3guide.minios4b") },
      ],
      fill: [t("s3guide.miniof1"), t("s3guide.miniof2"), t("s3guide.miniof3"), t("s3guide.miniof4")],
    };
  }
  return {
    blurb: t("s3guide.otherBlurb"),
    steps: [
      { title: t("s3guide.others1t"), body: t("s3guide.others1b") },
      { title: t("s3guide.others2t"), body: t("s3guide.others2b") },
      { title: t("s3guide.others3t"), body: t("s3guide.others3b") },
      { title: t("s3guide.others4t"), body: t("s3guide.others4b") },
      { title: t("s3guide.others5t"), body: t("s3guide.others5b") },
    ],
    fill: [t("s3guide.otherf1"), t("s3guide.otherf2"), t("s3guide.otherf3"), t("s3guide.otherf4")],
  };
}

export function S3SetupGuide({
  open,
  initial = "r2",
  onClose,
  onApplyPreset,
}: {
  open: boolean;
  initial?: S3GuideProvider;
  onClose: () => void;
  onApplyPreset?: (type: Exclude<S3GuideProvider, "other">) => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<S3GuideProvider>(initial);

  useEffect(() => {
    if (open) setTab(initial);
  }, [open, initial]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const pack = guidePack(t, tab);
  const canFill = tab !== "other" && onApplyPreset;
  const providers = guideProviders(t);

  return createPortal(
    <div className="wizard-overlay" role="dialog" aria-modal="true" aria-labelledby="s3-guide-title" onClick={onClose}>
      <div className="card dialog-card s3-guide" onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <div className="card-title" id="s3-guide-title">
            {t("s3guide.title")}
          </div>
          <button type="button" className="btn ghost sm" onClick={onClose} aria-label={t("common.close")}>
            <X size={14} />
          </button>
        </div>
        <div className="card-body s3-guide-body">
          <p className="s3-guide-intro">{t("s3guide.intro")}</p>
          <div className="s3-guide-tabs" role="tablist">
            {providers.map((p) => (
              <button
                key={p.id}
                type="button"
                role="tab"
                aria-selected={tab === p.id}
                className={"s3-guide-tab" + (tab === p.id ? " on" : "")}
                onClick={() => setTab(p.id)}
              >
                <span>{p.label}</span>
                <em>{p.hint}</em>
              </button>
            ))}
          </div>
          <p className="muted s3-guide-blurb">{pack.blurb}</p>
          <ol className="s3-guide-steps">
            {pack.steps.map((s, i) => (
              <li key={s.title}>
                <span className="s3-guide-num">{i + 1}</span>
                <div>
                  <div className="s3-guide-step-title">{s.title}</div>
                  <p>{s.body}</p>
                  {s.url && (
                    <button
                      type="button"
                      className="btn ghost sm s3-guide-link"
                      onClick={() => api.openUrl(s.url!.href)}
                    >
                      <ExternalLink size={12} />
                      {s.url.label}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ol>
          <div className="s3-guide-map">
            <div className="s3-guide-step-title">{t("s3guide.mapTitle")}</div>
            <ul>
              {pack.fill.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="muted sm" style={{ marginTop: 6 }}>
              {t("s3guide.keepKeys")}
            </p>
          </div>
        </div>
        <div className="card-foot">
          <span className="muted sm">{t("s3guide.afterFill")}</span>
          <div className="row" style={{ gap: 6 }}>
            {canFill && (
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  onApplyPreset(tab);
                  onClose();
                }}
              >
                {t("s3guide.applyPreset")}
              </button>
            )}
            <button type="button" className="btn primary sm" onClick={onClose}>
              {t("s3guide.goFill")}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function S3GuideButton({
  onClick,
}: {
  onClick: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button type="button" className="btn ghost sm" onClick={onClick} title={t("s3guide.btnTip")}>
      <BookOpen size={13} />
      {t("s3guide.btn")}
    </button>
  );
}
