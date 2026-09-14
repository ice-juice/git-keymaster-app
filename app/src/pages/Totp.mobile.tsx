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
import { useTotpModel, clipNote, type TotpModel } from "../shared/hooks/useTotpModel";
import { formatCode, TotpDialogs, TotpFilters } from "./Totp.shared";

function TotpMobileCard({ e, m }: { e: TotpEntry; m: TotpModel }) {
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
                  title="访问登录页面"
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
            title="取回原始密钥"
            onClick={() => m.openSecret(e.id)}
          >
            <KeyRound size={14} />
          </button>
          <button
            type="button"
            className="m-totp-op-btn"
            disabled={m.writesLocked}
            title="编辑"
            onClick={() => m.setEditor({ ...e })}
          >
            <Edit3 size={14} />
          </button>
          <button
            type="button"
            className="m-totp-op-btn danger"
            disabled={m.writesLocked}
            title="删除"
            onClick={() => m.deleteEntry(e)}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {seedMissing && (
        <div className="callout danger sm" style={{ margin: 0 }}>
          种子已丢失，请编辑重新填入密钥。
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
                    <Check size={12} /> 已复制
                  </>
                ) : (
                  <>
                    <Copy size={12} /> 复制
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
              <span>查看验证码</span>
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function TotpMobile() {
  const m = useTotpModel();
  const [sheetOpen, setSheetOpen] = useState(false);

  return (
    <div className="stack-lg">
      <MobileListToolbar
        query={m.q}
        onQueryChange={m.setQ}
        placeholder="搜索平台 / 账号"
        addLabel="添加"
        addDisabled={m.writesLocked || m.busy}
        sheetOpen={sheetOpen}
        onSheetOpenChange={setSheetOpen}
        addActions={[
          {
            key: "scan",
            label: "扫码导入",
            hint: "打开摄像头识别二维码",
            icon: <Camera size={18} />,
            onClick: () => void m.scanCamera(),
          },
          {
            key: "image",
            label: "导入图片",
            hint: "从相册选择二维码截图",
            icon: <ImagePlus size={18} />,
            onClick: () => void m.importImage(),
          },
          {
            key: "manual",
            label: "手动添加",
            hint: "填写平台、账号与密钥",
            icon: <Plus size={18} />,
            disabled: m.writesLocked,
            onClick: () => m.setEditor({}),
          },
        ]}
      />

      <TotpFilters m={m} hideSearch />

      {m.filtered.length === 0 ? (
        <div className="card" style={{ padding: "30px 10px" }}>
          <Empty icon="⏳" text={m.q ? "没有匹配的 2FA 条目。" : "还没有 2FA 密钥。点右上角「添加」扫码或手动录入。"} />
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
