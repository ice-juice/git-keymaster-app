import { useEffect, useRef, useState } from "react";
import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { prefersReducedMotion } from "../lib/prefs";
import { maskTotpCode } from "../shared/hooks/useTotpModel";
import { totpRemainSeconds } from "../shared/totpTime";
import type { TotpEntry } from "../lib/ipc";
import { CountdownRing } from "./CountdownRing";

export function formatCode(code: string) {
  if (code.length === 6) return `${code.slice(0, 3)} ${code.slice(3)}`;
  if (code.length === 8) return `${code.slice(0, 4)} ${code.slice(4)}`;
  return code;
}

export function TotpCodeSlot({
  entry,
  shown,
  copied,
  clipRemain,
  nowMs,
  onReveal,
  onHide,
  onCopy,
  onEdit,
  fade,
  selecting,
}: {
  entry: TotpEntry;
  shown?: { code: string; remain: number; period: number };
  copied?: boolean;
  clipRemain?: number;
  nowMs: number;
  onReveal: () => void;
  onHide: () => void;
  onCopy: () => void;
  onEdit?: () => void;
  fade?: boolean;
  selecting?: boolean;
}) {
  const { t } = useTranslation();
  const seedMissing = entry.hasSeed === false;
  const period = shown?.period || entry.period || 30;
  // 揭开后也不用缓存的剩余秒，和掩码态同一套 Unix 对齐。
  const remain = totpRemainSeconds(period, nowMs);
  const urgent = remain <= 5;
  const digits = entry.digits || 6;
  const masked = maskTotpCode(digits);
  const liveCode = shown ? formatCode(shown.code) : masked;
  const [status, setStatus] = useState("");
  const prevCode = useRef<string | undefined>(shown?.code);
  const reduceMotion = prefersReducedMotion();

  useEffect(() => {
    if (shown?.code && prevCode.current && shown.code !== prevCode.current) {
      setStatus(t("totp.codeUpdated"));
    }
    prevCode.current = shown?.code;
  }, [shown?.code, t]);

  const copyLabel = copied ? t("totp.copied") : t("totp.copyCode");
  const revealLabel = shown ? t("totp.hideCode") : t("totp.viewCode");

  function handleCopy(ev: { stopPropagation(): void }) {
    ev.stopPropagation();
    if (selecting || seedMissing) return;
    onCopy();
  }

  function handleReveal(ev: { stopPropagation(): void }) {
    ev.stopPropagation();
    if (selecting || seedMissing) return;
    if (shown) onHide();
    else onReveal();
  }

  const ops = (
    <div className="totp-slot-ops">
      <button
        type="button"
        className="totp-slot-icon-btn"
        disabled={seedMissing || selecting}
        aria-label={revealLabel}
        title={revealLabel}
        onClick={handleReveal}
      >
        {shown ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
      </button>
      <button
        type="button"
        className={"totp-slot-copy" + (copied ? " is-copied" : "")}
        disabled={seedMissing || selecting}
        aria-label={copyLabel}
        title={copyLabel}
        onClick={handleCopy}
      >
        {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      </button>
    </div>
  );

  const ring = (
    <div className="totp-slot-timer" title={urgent ? t("totp.refreshSoon") : undefined}>
      <CountdownRing remain={remain} period={period} size={fade ? 28 : 30} />
      {urgent && <span className="sr-only">{t("totp.refreshSoon")}</span>}
    </div>
  );

  if (fade) {
    return (
      <div className="totp-slot-wrap">
        <div
          className={
            "m-totp-code-area totp-code-slot is-mobile" +
            (shown ? " is-revealed" : "") +
            (urgent ? " is-urgent" : "") +
            (selecting ? " is-static" : "") +
            (reduceMotion ? " is-reduced" : "")
          }
          onClick={() => {
            if (selecting || seedMissing) return;
            if (shown) onCopy();
            else onReveal();
          }}
        >
          <div className="m-totp-live-left">{ring}</div>
          <div className="m-totp-code-fade">
            <span className="m-totp-code-layer is-masked m-totp-code-masked" aria-hidden={!!shown}>
              {masked}
            </span>
            <span className="m-totp-code-layer is-live" aria-hidden={!shown}>
              <span className="m-totp-code-num" key={reduceMotion ? "static" : liveCode}>
                {liveCode}
              </span>
            </span>
          </div>
          {ops}
        </div>
        <SlotFooter
          seedMissing={seedMissing}
          clipRemain={clipRemain}
          status={status}
          onEdit={onEdit}
        />
      </div>
    );
  }

  return (
    <div className="totp-slot-wrap">
      <div
        className={
          "totp-code-slot" +
          (shown ? " is-revealed" : "") +
          (urgent ? " is-urgent" : "") +
          (seedMissing ? " is-missing" : "")
        }
      >
        <span className={"totp-code" + (shown ? "" : " masked")} key={reduceMotion || !shown ? "static" : shown.code}>
          {shown ? formatCode(shown.code) : masked}
        </span>
        {ring}
        {ops}
      </div>
      <SlotFooter
        seedMissing={seedMissing}
        clipRemain={clipRemain}
        status={status}
        onEdit={onEdit}
      />
    </div>
  );
}

function SlotFooter({
  seedMissing,
  clipRemain,
  status,
  onEdit,
}: {
  seedMissing: boolean;
  clipRemain?: number;
  status: string;
  onEdit?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {seedMissing && (
        <div className="totp-slot-missing">
          <span>{t("totp.secretMissing")}</span>
          {onEdit && (
            <button type="button" className="btn ghost sm" onClick={onEdit}>
              {t("totp.goEdit")}
            </button>
          )}
        </div>
      )}
      {!!clipRemain && clipRemain > 0 && (
        <div className="totp-slot-clip">{t("totp.clipClearIn", { n: clipRemain })}</div>
      )}
      <div className="sr-only" role="status">
        {status}
      </div>
    </>
  );
}

export function clipRemainSeconds(until: number | undefined, nowMs: number): number {
  if (!until) return 0;
  return Math.max(0, Math.ceil((until - nowMs) / 1000));
}
