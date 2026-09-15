import { useState } from "react";
import {
  Camera,
  ImagePlus,
  Plus,
  Eye,
  KeyRound,
  Edit3,
  Trash2,
  Check,
  Copy,
  Link2,
} from "lucide-react";
import { api, type TotpEntry } from "../lib/ipc";
import { Badge, Empty } from "../ui/common";
import { IconMark } from "../ui/IconMark";
import { CountdownRing } from "../ui/CountdownRing";
import { MobileListToolbar } from "../ui/MobileListToolbar";
import { useTranslation } from "react-i18next";
import { useTotpModel, clipNote, type TotpModel } from "../shared/hooks/useTotpModel";
import { formatCode, TotpDialogs, TotpFilters } from "./Totp.shared";

function TotpMobileCard({ e, m }: { e: TotpEntry; m: TotpModel }) {
  const { t } = useTranslation();
  const shown = m.codes[e.id];
  const seedMissing = e.hasSeed === false;
  const isCopied = m.copiedId === e.id;

  return (
    <div className="m-totp-card">
      {/* 头部：应用身份与右上角操作 */}
      <div className="m-totp-card-head">
        <div className="m-totp-card-identity">
          <IconMark icon={e.icon} builtins={m.builtins} label={e.issuer} size={36} />
          <div className="m-totp-card-meta">
            <div className="m-totp-card-issuer" title={e.issuer}>
              <span>{e.issuer}</span>
              {e.group && <Badge kind="info">{e.group}</Badge>}
              {e.url && (
                <button
                  type="button"
                  className="btn ghost sm"
                  style={{ padding: "0 2px" }}
                  title={t("totp.openSite")}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    api.openUrl(e.url!);
                  }}
                >
                  <Link2 size={12} />
                </button>
              )}
            </div>
            <div className="m-totp-card-account" title={e.account}>
              {e.account}
            </div>
            {e.note?.trim() && (
              <div className="totp-card-note" style={{ marginTop: 2 }} title={e.note.trim()}>
                {clipNote(e.note)}
              </div>
            )}
          </div>
        </div>

        <div className="m-totp-card-ops">
          <button
            type="button"
            className="m-totp-op-btn"
            title={t("totp.secretTitle")}
            onClick={() => m.openSecret(e.id)}
          >
            <KeyRound size={14} />
          </button>
          <button
            type="button"
            className="m-totp-op-btn"
            disabled={m.writesLocked}
            title={t("common.edit")}
            onClick={() => m.setEditor({ ...e })}
          >
            <Edit3 size={14} />
          </button>
          <button
            type="button"
            className="m-totp-op-btn danger"
            disabled={m.writesLocked}
            title={t("common.delete")}
            onClick={() => m.deleteEntry(e)}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {seedMissing && (
        <div className="callout danger sm" style={{ margin: 0 }}>
          {t("totp.seedLostShort")}
        </div>
      )}

      {/* 验证码核心交互区 */}
      <div
        className={"m-totp-code-area" + (shown ? " revealed" : "")}
        onClick={() => {
          if (seedMissing) return;
          if (shown) {
            m.copyCode(e.id);
          } else {
            m.reveal(e.id);
          }
        }}
      >
        {shown ? (
          <>
            <span className="m-totp-code-num">{formatCode(shown.code)}</span>
            <div className="m-totp-code-right">
              <CountdownRing
                remain={shown.remain}
                period={shown.period || e.period || 30}
                size={26}
              />
              <span className={"m-totp-copy-tag" + (isCopied ? " copied" : "")}>
                {isCopied ? (
                  <>
                    <Check size={12} /> {t("totp.copied")}
                  </>
                ) : (
                  <>
                    <Copy size={12} /> {t("common.copy")}
                  </>
                )}
              </span>
            </div>
          </>
        ) : (
          <>
            <span className="m-totp-code-masked">••••••</span>
            <button
              type="button"
              className="btn primary sm"
              disabled={seedMissing}
              onClick={(ev) => {
                ev.stopPropagation();
                m.reveal(e.id);
              }}
            >
              <Eye size={13} />
              <span>{t("totp.viewCode")}</span>
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function TotpMobile() {
  const { t } = useTranslation();
  const m = useTotpModel();
  const [sheetOpen, setSheetOpen] = useState(false);

  return (
    <div className="stack-lg">
      <MobileListToolbar
        query={m.q}
        onQueryChange={m.setQ}
        placeholder={t("totp.searchShort")}
        addLabel={t("pages.add")}
        addDisabled={m.writesLocked || m.busy}
        sheetOpen={sheetOpen}
        onSheetOpenChange={setSheetOpen}
        addActions={[
          {
            key: "scan",
            label: t("totp.scanImport"),
            hint: t("totp.scanImportHint"),
            icon: <Camera size={18} />,
            onClick: () => void m.scanCamera(),
          },
          {
            key: "image",
            label: t("pages.importImage"),
            hint: t("totp.importImageHint"),
            icon: <ImagePlus size={18} />,
            onClick: () => void m.importImage(),
          },
          {
            key: "manual",
            label: t("totp.manualAdd"),
            hint: t("totp.manualAddHint"),
            icon: <Plus size={18} />,
            disabled: m.writesLocked,
            onClick: () => m.setEditor({}),
          },
        ]}
      />

      <TotpFilters m={m} hideSearch />

      {m.filtered.length === 0 ? (
        <div className="card" style={{ padding: "30px 10px" }}>
          <Empty icon="⏳" text={m.q ? t("totp.emptySearch") : t("totp.emptyMobile")} />
        </div>
      ) : (
        <div className="m-totp-list">
          {m.filtered.map((e) => (
            <TotpMobileCard key={e.id} e={e} m={m} />
          ))}
        </div>
      )}

      <TotpDialogs m={m} />
    </div>
  );
}
