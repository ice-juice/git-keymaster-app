import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, errMessage, type ConfigView } from "../lib/ipc";
import { PageHead, Card, Empty, Badge } from "../ui/common";
import { useApp } from "../store";

export function ConfigPage() {
  const { t } = useTranslation();
  const [view, setView] = useState<ConfigView | null>(null);
  const [err, setErr] = useState("");
  const { writesLocked } = useApp();

  async function load(repair = false) {
    setErr("");
    try {
      setView(await api.readSshConfig(repair));
    } catch (e) {
      setErr(errMessage(e));
    }
  }

  useEffect(() => {
    load(false);
  }, []);

  useEffect(() => {
    if (!writesLocked) {
      load(true);
    }
  }, [writesLocked]);

  return (
    <div className="stack-lg">
      <PageHead
        title={t("config.title")}
        desc={t("config.desc")}
        actions={
          <div className="row" style={{ gap: 6 }}>
            <button
              className="btn primary"
              disabled={writesLocked}
              onClick={async () => {
                setErr("");
                try {
                  await api.openSshConfig();
                } catch (e) {
                  setErr(errMessage(e));
                }
              }}
            >
              {t("config.openEdit")}
            </button>
            <button className="btn ghost" onClick={() => load(true)}>{t("common.refresh")}</button>
          </div>
        }
      />
      {err && <div className="err-text">{err}</div>}
      {view && (
        <div className="muted sm">
          {t("config.wsCanon")} <span className="mono">{view.path}</span>
          <br />
          {t("config.sysEntry")} <span className="mono">{view.systemPath}</span>
          {view.registered ? t("config.registered") : t("config.unregistered")}
        </div>
      )}

      <Card title={t("config.health")}>
        {!view || view.diagnostics.length === 0 ? (
          <div className="callout good">{t("config.healthOk")}</div>
        ) : (
          <div className="list">
            {view.diagnostics.map((d, i) => (
              <div className="list-row" key={i}>
                <div className="grow">
                  <div className="row" style={{ gap: 8 }}>
                    <Badge kind={d.severity === "error" ? "danger" : "warn"}>{d.severity}</Badge>
                    {d.host && <span className="mono sm">{d.host}</span>}
                  </div>
                  <div className="muted sm">{d.message}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title={t("config.hostBlocks", { n: view?.blocks.length ?? 0 })}>
        {!view || view.blocks.length === 0 ? (
          <Empty icon="📄" text={t("config.noHosts")} />
        ) : (
          <div className="list">
            {view.blocks.map((b, i) => (
              <div className="list-row" key={i}>
                <div className="grow">
                  <div className="mono">{b.patterns.join(" ")}</div>
                  <div className="mono muted sm">
                    {b.options.map(([k, v]) => `${k} ${v}`).join("  ·  ")}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title={t("config.rawTitle")}>
        <pre className="code-block">{view?.raw || t("config.empty")}</pre>
      </Card>
    </div>
  );
}
