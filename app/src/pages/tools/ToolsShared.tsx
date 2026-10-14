import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { copyWithClear } from "../../lib/secretsUi";
import { PageHead } from "../../ui/common";

const ToolEmbedContext = createContext(false);

/** 移动端子页复用工具页正文时关掉桌面页头，避免再链回只在桌面注册的 /tools。 */
export function ToolEmbed({ children }: { children: ReactNode }) {
  return <ToolEmbedContext.Provider value={true}>{children}</ToolEmbedContext.Provider>;
}

export function ToolsBack() {
  const { t } = useTranslation();
  return (
    <Link to="/tools" className="btn ghost sm tools-back">
      <ChevronLeft size={16} />
      {t("common.back")}
    </Link>
  );
}

export function ToolSubPage({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  const embedded = useContext(ToolEmbedContext);
  if (embedded) {
    return <div className="stack-lg tools-page tools-embedded">{children}</div>;
  }
  return (
    <div className="stack-lg tools-page">
      <PageHead
        title={title}
        desc={desc}
        actions={
          <ToolsBack />
        }
      />
      {children}
    </div>
  );
}

export function CopyField({
  label,
  value,
  secret = false,
  mono = true,
  rows = 3,
}: {
  label: string;
  value: string;
  secret?: boolean;
  mono?: boolean;
  rows?: number;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCopied(false);
  }, [value]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <div className="field">
      <div className="tools-field-head">
        <span className="field-label">{label}</span>
        <button
          type="button"
          className="btn sm"
          disabled={!value}
          onClick={() => {
            if (!value) return;
            void copyWithClear(value, undefined, secret)
              .then(() => setCopied(true))
              .catch(() => {});
          }}
        >
          {copied ? t("common.copied") : t("common.copy")}
        </button>
      </div>
      <textarea className={"input tools-output" + (mono ? " mono" : "")} readOnly rows={rows} value={value} />
    </div>
  );
}

export function formatToolTime(ts: number, locale: string): string {
  try {
    return new Date(ts).toLocaleString(locale.startsWith("zh") ? "zh-CN" : "en-US");
  } catch {
    return String(ts);
  }
}
