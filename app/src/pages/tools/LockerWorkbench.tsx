import {
  ArrowLeft,
  Check,
  Clock3,
  Copy,
  Download,
  File,
  FolderOpen,
  Inbox,
  Link,
  LockKeyhole,
  PackageOpen,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useApp } from "../../store";
import { api, entryAttachments, errMessage } from "../../lib/ipc";
import type { LockerOperation } from "../../lib/locker";
import {
  lockerAccessEnded,
  LOCKER_FILE_LIMIT,
  type LockerPullChoice,
  type LockerTtlChoice,
} from "../../shared/lockerUi";
import { formatBytes } from "../../shared/hooks/useFilesModel";
import { ConfirmDialog } from "../../ui/common";
import { ReauthDialog } from "../../ui/ReauthDialog";
import { ToolSubPage } from "./ToolsShared";
import { LockerConnectionSettings } from "./LockerConnectionSettings";
import {
  useLockerWorkbench,
  type LockerWorkbenchModel as Model,
} from "./useLockerWorkbench";
import "./ToolsLockerPage.css";

export function ToolsLockerPage({
  initialVault,
}: {
  initialVault?: { entryId: string; attId?: string } | null;
}) {
  const status = useApp((state) => state.status);
  const { t } = useTranslation();
  if (status?.unlocked === false)
    return (
      <ToolSubPage title={t("locker.title")}>
        <div className="callout">{t("locker.locked")}</div>
      </ToolSubPage>
    );
  return (
    <Workbench
      key={status?.workspaceId || "workspace"}
      initialVault={initialVault}
    />
  );
}

function Workbench({
  initialVault,
}: {
  initialVault?: { entryId: string; attId?: string } | null;
}) {
  const m = useLockerWorkbench(initialVault),
    { tr } = m;
  return (
    <ToolSubPage title={tr("title")} desc={tr("description")}>
      <div className="locker-v2">
        <input
          ref={m.fileRef}
          type="file"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) m.selectFile(file);
            event.target.value = "";
          }}
        />
        {m.writesLocked && (
          <div className="locker-v2-alert warning">{tr("readOnly")}</div>
        )}
        {m.screen !== "home" && m.screen !== "service" && (
          <div className="locker-v2-taskbar">
            <button type="button" className="btn ghost sm" onClick={m.goHome}>
              <ArrowLeft size={15} />
              {tr("back")}
            </button>
          </div>
        )}
        {m.toast && (
          <div role="status" className="locker-v2-alert">
            <span>{m.toast}</span>
            <button
              type="button"
              className="btn ghost sm"
              aria-label={m.t("common.close")}
              onClick={() => m.setToast("")}
            >
              <X size={14} />
            </button>
          </div>
        )}
        {m.screen === "home" && <Home m={m} />}
        {m.screen === "put" && <Deposit m={m} />}
        {m.screen === "take" && <Pickup m={m} />}
        {m.screen === "detail" && <Detail m={m} />}
        {m.screen === "settings" && <Connections m={m} />}
        {m.screen === "service" && (
          <LockerConnectionSettings
            disabled={m.writesLocked}
            onClose={() => m.setScreen("settings")}
            onChanged={m.onConfigChanged}
          />
        )}
        {m.vaultOpen && <VaultPicker m={m} />}
        <ActionConfirmation m={m} />
        {m.reauth && (
          <ReauthDialog
            hint={m.t("tools.lockerReauthHint")}
            onCancel={() => m.reauthCancel.current?.()}
            onConfirm={m.reauth}
          />
        )}
      </div>
    </ToolSubPage>
  );
}

function Home({ m }: { m: Model }) {
  const { tr } = m;
  const knownOperations = new Map(
    m.operations.map((operation) => [operation.operationId, operation]),
  );
  // Newly started work must stay visible immediately when leaving its form,
  // before the next persisted-ledger refresh. Prefer the newest known snapshot.
  for (const local of [m.putOperation, m.receiveOperation]) {
    if (!local) continue;
    const stored = knownOperations.get(local.operationId);
    if (!stored || local.updatedAt >= stored.updatedAt)
      knownOperations.set(local.operationId, local);
  }
  const pending = [...knownOperations.values()].filter(
    (operation) => operation.status !== "completed",
  );
  return (
    <>
      <div className="locker-v2-statusbar">
        <div className="locker-v2-row">
          <span>
            <i className={m.storageReady ? "ok" : "warn"} />
            {tr("cloudStorage")} ·{" "}
            {m.connection?.storageVerified
              ? tr("verified")
              : m.storageReady
                ? tr("configured")
                : tr("notConfigured")}
          </span>
          <span>
            <i className={m.serviceReady ? "ok" : "warn"} />
            {tr("pickupService")} ·{" "}
            {m.connection?.serviceVerified
              ? tr("verified")
              : m.serviceReady
                ? tr("ready")
                : tr("unavailable")}
          </span>
        </div>
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => m.setScreen("settings")}
        >
          <Settings2 size={15} />
          {tr("connectionSettings")}
        </button>
      </div>
      {(!m.storageReady ||
        !m.serviceReady ||
        m.connectionError ||
        m.connection?.error) && (
        <div className="locker-v2-alert warning">
          <TriangleAlert size={17} />
          <div>
            {m.connectionError ||
              m.connection?.error ||
              tr(
                !m.storageReady
                  ? "storageNeeded"
                  : m.connection?.protocolVersion &&
                      m.connection.protocolVersion < 2
                    ? "legacyService"
                    : "serviceNeeded",
              )}
          </div>
          <button
            type="button"
            className="btn sm"
            onClick={() => m.setScreen("settings")}
          >
            {tr("connectionSettings")}
          </button>
        </div>
      )}
      <div className="locker-v2-toolbar">
        <div className="locker-v2-row">
          <button
            type="button"
            className="btn primary"
            disabled={m.writesLocked}
            onClick={m.openPut}
          >
            <Plus size={16} />
            {tr("deposit")}
          </button>
          <button
            type="button"
            className="btn"
            disabled={m.writesLocked}
            onClick={m.openTake}
          >
            <Download size={16} />
            {tr("take")}
          </button>
        </div>
        <div className="locker-v2-row">
          <span className="locker-v2-small">
            {tr("activeCount", {
              count: m.items.filter((item) => !lockerAccessEnded(item, m.tick))
                .length,
            })}
          </span>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => void m.reload()}
            aria-label={tr("refresh")}
          >
            <RefreshCw size={15} />
          </button>
        </div>
      </div>
      {pending.length > 0 && (
        <details className="locker-v2-recovery">
          <summary>
            {tr("operationRecovery")} ({pending.length})
          </summary>
          {pending.map((operation) => (
            <div
              key={operation.operationId}
              className="locker-v2-row locker-v2-recovery-row"
            >
              <span>
                {operation.name ||
                  tr(operation.kind === "put" ? "deposit" : "take")}
              </span>
              <span className="locker-v2-small">
                {tr(
                  `status${operation.status[0].toUpperCase()}${operation.status.slice(1)}`,
                )}
              </span>
              <button
                type="button"
                className="btn sm"
                disabled={!!m.operationBusy}
                onClick={() => void m.checkOperation(operation)}
              >
                {tr("viewStatus")}
              </button>
            </div>
          ))}
        </details>
      )}
      {m.listError && (
        <div className="locker-v2-alert warning" role="alert">
          <span>
            {tr("loadFailed")} {m.listError}
          </span>
          <button
            type="button"
            className="btn sm"
            onClick={() => void m.reload()}
          >
            {tr("refresh")}
          </button>
        </div>
      )}
      <section className="locker-v2-panel locker-v2-list">
        <div className="locker-v2-filters">
          <div className="locker-v2-tabs">
            {(["active", "ended", "all"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={m.filter === value}
                onClick={() => m.setFilter(value)}
              >
                {tr(value)}
              </button>
            ))}
          </div>
          <label className="locker-v2-search">
            <Search size={15} />
            <input
              className="input"
              aria-label={tr("search")}
              placeholder={tr("search")}
              value={m.search}
              onChange={(event) => m.setSearch(event.target.value)}
            />
          </label>
        </div>
        <div className="locker-v2-columns">
          <span>{tr("file")}</span>
          <span>{tr("rules")}</span>
          <span>{tr("status")}</span>
          <span>{tr("actions")}</span>
        </div>
        {m.loading ? (
          <div className="locker-v2-empty" role="status">
            {m.t("common.busy")}
          </div>
        ) : m.filtered.length ? (
          m.filtered.map((item) => (
            <div className="locker-v2-file-row" key={item.id}>
              <div className="locker-v2-file">
                <span className="locker-v2-file-icon">
                  <File size={19} />
                </span>
                <div>
                  <strong>{item.name}</strong>
                  <span className="locker-v2-small">
                    {formatBytes(item.size)} ·{" "}
                    {tr(
                      item.share ||
                        (item.shareRequested && item.shareStatus !== "stopped")
                        ? "share"
                        : "self",
                    )}
                  </span>
                </div>
              </div>
              <div>
                <span>{m.expiry(item)}</span>
                <span className="locker-v2-small">{m.quota(item)}</span>
              </div>
              <div className="locker-v2-status">
                <span
                  className={`locker-v2-badge ${lockerAccessEnded(item, m.tick) || item.shareStatus === "pending" || item.shareStatus === "failed" ? "warn" : ""}`}
                >
                  {m.statusLabel(item)}
                </span>
                {item.legacy && (
                  <span className="locker-v2-small">{tr("legacy")}</span>
                )}
                {item.syncStatus === "unknown" && (
                  <span className="locker-v2-small">{tr("stale")}</span>
                )}
              </div>
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => m.openDetail(item)}
              >
                {tr(lockerAccessEnded(item, m.tick) ? "viewStatus" : "detail")}
              </button>
            </div>
          ))
        ) : (
          <div className="locker-v2-empty">
            <Inbox size={32} />
            <h3>
              {tr(
                m.search
                  ? "noMatches"
                  : m.filter === "ended"
                    ? "noEnded"
                    : "noItems",
              )}
            </h3>
            <p>{tr("noItemsHint")}</p>
            {m.search ? (
              <button
                type="button"
                className="btn"
                onClick={() => m.setSearch("")}
              >
                {tr("clearSearch")}
              </button>
            ) : (
              m.filter !== "ended" && (
                <button
                  type="button"
                  className="btn primary"
                  disabled={m.writesLocked}
                  onClick={m.openPut}
                >
                  {tr("deposit")}
                </button>
              )
            )}
          </div>
        )}
      </section>
      <div className="locker-v2-footer">
        <span>
          <ShieldCheck size={14} />
          {tr("encryptedStorage")}
        </span>
        <span>
          {tr("historyRetention")}
          {m.items.some((item) => item.cleanupStatus === "cleaned") && (
            <button
              type="button"
              className="btn ghost sm"
              disabled={m.writesLocked}
              onClick={() => m.setConfirm({ kind: "history" })}
            >
              {tr("clearHistory")}
            </button>
          )}
        </span>
      </div>
    </>
  );
}

function TaskCard({
  m,
  operation,
  running = false,
}: {
  m: Model;
  operation: LockerOperation;
  running?: boolean;
}) {
  const { tr } = m,
    complete = operation.status === "completed",
    saved = operation.status === "saved";
  return (
    <section className="locker-v2-panel locker-v2-operation" aria-live="polite">
      <div className="locker-v2-row">
        <span className={`locker-v2-badge ${complete ? "" : "warn"}`}>
          {tr(
            `status${operation.status[0].toUpperCase()}${operation.status.slice(1)}`,
          )}
        </span>
        <strong>{operation.name}</strong>
      </div>
      {running ? (
        <>
          <p>{m.phaseLabel(operation.phase)}</p>
          <p className="locker-v2-muted">{tr("backgroundHint")}</p>
        </>
      ) : saved ? (
        <p>{tr("savedAwaitingAck")}</p>
      ) : operation.status === "unknown" ? (
        <p>{tr("resultUnknown")}</p>
      ) : null}
      {operation.error && (
        <div className="locker-v2-alert warning">{operation.error}</div>
      )}
      <div className="locker-v2-small">
        {tr("operationId")} <code>{operation.operationId}</code>
      </div>
      {!running && !complete && (
        <div className="locker-v2-row">
          <button
            type="button"
            className="btn"
            disabled={!!m.operationBusy}
            onClick={() => void m.checkOperation(operation)}
          >
            {tr("checkOperation")}
          </button>
          {operation.recoverable && (
            <button
              type="button"
              className="btn primary"
              disabled={!!m.operationBusy || m.writesLocked}
              onClick={() => void m.checkOperation(operation, true)}
            >
              {tr("resumeOperation")}
            </button>
          )}
          {operation.canRetarget && operation.kind === "receive" && !saved && (
            <button
              type="button"
              className="btn"
              disabled={!!m.operationBusy || m.writesLocked}
              onClick={() => void m.retargetOperation(operation)}
            >
              <FolderOpen size={16} />
              {tr("retargetOperation")}
            </button>
          )}
        </div>
      )}
      {(complete || saved) && operation.kind === "receive" && (
        <>
          <div className="locker-v2-rule">
            <span>{tr("saveLocation")}</span>
            <span>{operation.destPath || tr("vaultTarget")}</span>
          </div>
          <div className="locker-v2-rule">
            <span>{tr("remaining")}</span>
            <span>
              {operation.pullsLeft == null
                ? tr("unlimited")
                : tr("count", { count: operation.pullsLeft })}
            </span>
          </div>
          <div className="locker-v2-row">
            {operation.destPath && (
              <button
                type="button"
                className="btn primary"
                onClick={() =>
                  void api
                    .revealPath(operation.destPath!)
                    .catch((error) => m.setToast(errMessage(error)))
                }
              >
                <FolderOpen size={16} />
                {tr("openFolder")}
              </button>
            )}
            {operation.fileId && (
              <button
                type="button"
                className="btn primary"
                onClick={() =>
                  m.navigate(
                    `/files?focus=${encodeURIComponent(operation.fileId!)}`,
                  )
                }
              >
                {tr("openVault")}
              </button>
            )}
            {complete && (
              <button type="button" className="btn" onClick={m.resetTake}>
                {tr("newPickup")}
              </button>
            )}
          </div>
        </>
      )}
      {(complete ||
        (operation.status === "failed" && !operation.recoverable)) &&
        operation.kind === "put" && (
          <button type="button" className="btn" onClick={m.resetPut}>
            {tr("anotherDeposit")}
          </button>
        )}
      {operation.status === "failed" &&
        !operation.recoverable &&
        operation.kind === "receive" && (
          <button type="button" className="btn" onClick={m.resetTake}>
            {tr("newPickup")}
          </button>
        )}
    </section>
  );
}

function Handoff({
  m,
  id,
  code,
  name,
}: {
  m: Model;
  id: string;
  code: string;
  name: string;
}) {
  const { tr } = m,
    url = m.shareForId === id ? m.shareUrl : "";
  return (
    <div className="locker-v2-stack">
      <div>
        <span className="locker-v2-muted">{tr("pickupCode")}</span>
        <div className="locker-v2-code">
          {code ? `${code.slice(0, 3)} ${code.slice(3)}` : "••• •••"}
        </div>
      </div>
      <div className="locker-v2-row">
        {code ? (
          <button
            type="button"
            className="btn"
            onClick={() => void m.copy(code)}
          >
            <Copy size={15} />
            {tr("copyCode")}
          </button>
        ) : (
          <button
            type="button"
            className="btn"
            disabled={m.detailBusy}
            onClick={() => void m.showCode(id)}
          >
            {tr("showCode")}
          </button>
        )}
        {url && (
          <button
            type="button"
            className="btn"
            onClick={() => void m.copy(url)}
          >
            {tr("copyLink")}
          </button>
        )}
        {url && code && (
          <button
            type="button"
            className="btn primary"
            onClick={() =>
              void m.copy(`${name}\n${url}\n${tr("pickupCode")}: ${code}`)
            }
          >
            {tr("copyHandoff")}
          </button>
        )}
      </div>
      {url && (
        <>
          <label className="field">
            <span>{tr("shareLink")}</span>
            <input className="input" readOnly value={url} />
          </label>
          <p className="locker-v2-small">{tr("shareWarning")}</p>
          {m.shareSvg && (
            <div
              className="locker-v2-qr"
              aria-label={tr("shareLink")}
              dangerouslySetInnerHTML={{ __html: m.shareSvg }}
            />
          )}
        </>
      )}
    </div>
  );
}

function Deposit({ m }: { m: Model }) {
  const { tr, rules } = m;
  return (
    <>
      <div className="locker-v2-heading">
        <h2>{tr(m.putResult ? "depositSuccess" : "deposit")}</h2>
        {!m.putResult && <p>{tr("selectFirst")}</p>}
      </div>
      {m.putError && (
        <div className="locker-v2-alert warning" role="alert">
          {m.putError}
        </div>
      )}
      {m.putOperation && !m.putResult && (
        <TaskCard m={m} operation={m.putOperation} running={m.putBusy} />
      )}
      {m.putResult ? (
        <section className="locker-v2-panel locker-v2-result">
          <div className="locker-v2-success">
            <Check size={25} />
          </div>
          <h3>{m.putResult.name}</h3>
          {m.putResult.shareError && (
            <div className="locker-v2-alert warning">
              <TriangleAlert size={17} />
              <div>
                {tr("depositPartial")}
                <p>{m.putResult.shareError}</p>
              </div>
            </div>
          )}
          <Handoff
            m={m}
            id={m.putResult.id}
            code={m.putResult.code}
            name={m.putResult.name}
          />
          {!m.putResult.shared && !m.putResult.shareError && (
            <p className="locker-v2-muted">{tr("selfSuccess")}</p>
          )}
          <div className="locker-v2-row">
            {m.serviceReady &&
              (!m.putResult.shared || m.shareForId !== m.putResult.id) && (
                <button
                  type="button"
                  className="btn"
                  disabled={m.shareBusy || m.writesLocked}
                  onClick={() => void m.makeShare(m.putResult!.id)}
                >
                  {tr(
                    m.putResult.shared
                      ? "showHandoff"
                      : m.putResult.shareError
                        ? "retryShare"
                        : "createShare",
                  )}
                </button>
              )}
            <button type="button" className="btn" onClick={m.goHome}>
              {tr("back")}
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={m.putBusy}
              onClick={m.resetPut}
            >
              {tr("anotherDeposit")}
            </button>
          </div>
        </section>
      ) : (
        !m.putOperation && (
          <div className="locker-v2-grid">
            <fieldset
              className="locker-v2-panel locker-v2-form"
              disabled={m.putPending || m.selecting || m.writesLocked}
            >
              <div>
                <h3>{tr("selectStep")}</h3>
                {m.chosen ? (
                  <div className="locker-v2-selected">
                    <span className="locker-v2-file-icon">
                      <File size={20} />
                    </span>
                    <div>
                      <strong>{m.chosen.name}</strong>
                      <span className="locker-v2-small">
                        {formatBytes(m.chosen.size)} ·{" "}
                        {tr(
                          m.chosen.kind === "vault"
                            ? "vaultSource"
                            : "localSource",
                        )}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={m.removeChosen}
                    >
                      {tr("remove")}
                    </button>
                  </div>
                ) : (
                  <div
                    className="locker-v2-drop"
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (event.dataTransfer.files.length !== 1) {
                        m.setPutError(tr("onlyOne"));
                        return;
                      }
                      m.selectFile(event.dataTransfer.files[0]);
                    }}
                  >
                    <span className="locker-v2-upload-icon">
                      <Upload size={24} />
                    </span>
                    <p>{tr("dropHint")}</p>
                    <div className="locker-v2-row">
                      <button
                        type="button"
                        className="btn"
                        onClick={() => void m.chooseLocal()}
                      >
                        <FolderOpen size={16} />
                        {tr("chooseFile")}
                      </button>
                      <button
                        type="button"
                        className="btn ghost sm"
                        onClick={() => void m.chooseVault()}
                      >
                        {tr("fromVault")}
                      </button>
                    </div>
                    <span className="locker-v2-small">{tr("fileLimit")}</span>
                  </div>
                )}
              </div>
              <label className="field">
                <span>{tr("name")}</span>
                <input
                  className="input"
                  value={m.name}
                  maxLength={255}
                  onChange={(event) => m.setName(event.target.value)}
                />
              </label>
              <div>
                <h3>{tr("ruleStep")}</h3>
                <div className="locker-v2-two">
                  <label className="field">
                    <span>{tr("ttl")}</span>
                    <select
                      className="input"
                      value={m.ttl}
                      onChange={(event) =>
                        m.setTtl(event.target.value as LockerTtlChoice)
                      }
                    >
                      <option value="1h">{tr("hour")}</option>
                      <option value="24h">{tr("day")}</option>
                      <option value="7d">{tr("week")}</option>
                      <option value="30d">{tr("month")}</option>
                      <option value="custom">{tr("custom")}</option>
                      {m.advanced && (
                        <option value="forever">{tr("forever")}</option>
                      )}
                    </select>
                  </label>
                  <label className="field">
                    <span>{tr("pulls")}</span>
                    <select
                      className="input"
                      value={m.pulls}
                      onChange={(event) =>
                        m.setPulls(event.target.value as LockerPullChoice)
                      }
                    >
                      <option value="1">{tr("once")}</option>
                      <option value="3">{tr("thrice")}</option>
                      <option value="custom">{tr("custom")}</option>
                      <option value="unlimited">{tr("unlimited")}</option>
                    </select>
                  </label>
                </div>
                {(m.ttl === "custom" || m.pulls === "custom") && (
                  <div className="locker-v2-two">
                    {m.ttl === "custom" && (
                      <label className="field">
                        <span>{tr("hours")}</span>
                        <input
                          className="input"
                          inputMode="numeric"
                          value={m.hours}
                          onChange={(event) => m.setHours(event.target.value)}
                          aria-invalid={!rules.ok && rules.field === "hours"}
                        />
                      </label>
                    )}
                    {m.pulls === "custom" && (
                      <label className="field">
                        <span>{tr("customPulls")}</span>
                        <input
                          className="input"
                          inputMode="numeric"
                          value={m.customPulls}
                          onChange={(event) =>
                            m.setCustomPulls(event.target.value)
                          }
                          aria-invalid={!rules.ok && rules.field === "pulls"}
                        />
                      </label>
                    )}
                  </div>
                )}
                {!rules.ok && (
                  <p className="locker-v2-error" role="alert">
                    {tr(
                      rules.field === "hours" ? "invalidHours" : "invalidPulls",
                    )}
                  </p>
                )}
                <label className="locker-v2-check">
                  <input
                    type="checkbox"
                    checked={m.advanced}
                    onChange={(event) => {
                      m.setAdvanced(event.target.checked);
                      if (!event.target.checked && m.ttl === "forever")
                        m.setTtl("24h");
                    }}
                  />
                  {tr("advanced")}
                </label>
                {m.ttl === "forever" && m.pulls === "unlimited" && (
                  <div className="locker-v2-alert warning">
                    {tr("foreverWarning")}
                  </div>
                )}
              </div>
              <div>
                <h3>{tr("purposeStep")}</h3>
                <div className="locker-v2-two">
                  {[false, true].map((value) => (
                    <label className="locker-v2-radio" key={String(value)}>
                      <input
                        type="radio"
                        name="locker-purpose"
                        checked={m.sharePurpose === value}
                        onChange={() => m.setSharePurpose(value)}
                      />
                      <span>
                        {tr(value ? "share" : "self")}
                        <small>{tr(value ? "shareHint" : "selfHint")}</small>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            </fieldset>
            <aside className="locker-v2-panel locker-v2-summary">
              <h3>{tr("summary")}</h3>
              <div className="locker-v2-rule">
                <span>{tr("size")}</span>
                <span>
                  {m.chosen ? formatBytes(m.chosen.size) : tr("unselected")}
                </span>
              </div>
              <div className="locker-v2-rule">
                <span>{tr("ttl")}</span>
                <span>
                  {rules.ok
                    ? rules.permanent
                      ? tr("forever")
                      : tr("hoursCount", { count: rules.ttlSecs! / 3600 })
                    : "—"}
                </span>
              </div>
              <div className="locker-v2-rule">
                <span>{tr("quota")}</span>
                <span>
                  {rules.ok
                    ? rules.unlimitedPulls
                      ? tr("unlimited")
                      : tr("count", { count: rules.maxPulls })
                    : "—"}
                </span>
              </div>
              <div className="locker-v2-alert">
                <Clock3 size={17} />
                <p>{tr("policyHint")}</p>
              </div>
              {!m.canPut && !m.writesLocked && (
                <div className="locker-v2-alert warning">
                  <p>
                    {tr(!m.storageReady ? "storageNeeded" : "serviceNeeded")}
                  </p>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => m.setScreen("settings")}
                  >
                    {tr("connectionSettings")}
                  </button>
                </div>
              )}
              <button
                type="button"
                className="btn primary"
                disabled={
                  !m.chosen ||
                  !m.name.trim() ||
                  !rules.ok ||
                  !m.canPut ||
                  m.selecting
                }
                onClick={() => void m.startPut()}
              >
                <LockKeyhole size={16} />
                {tr("startDeposit")}
              </button>
              <p className="locker-v2-small">{tr("selectDoesNotUpload")}</p>
            </aside>
          </div>
        )
      )}
    </>
  );
}

function Pickup({ m }: { m: Model }) {
  const { tr } = m;
  return (
    <>
      <div className="locker-v2-heading">
        <h2>
          {tr(
            m.receiveOperation &&
              ["saved", "completed"].includes(m.receiveOperation.status)
              ? "receiveSuccess"
              : "take",
          )}
        </h2>
        <p>{tr("lookupHint")}</p>
      </div>
      {m.receiveOperation ? (
        <TaskCard
          m={m}
          operation={m.receiveOperation}
          running={m.receiveBusy}
        />
      ) : (
        <div className="locker-v2-grid">
          <section className="locker-v2-panel locker-v2-form">
            <div className="locker-v2-tabs">
              {(["own", "share"] as const).map((value) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={m.receiveType === value}
                  disabled={m.receiveBusy}
                  onClick={() => {
                    m.invalidateLookup();
                    m.setReceiveType(value);
                  }}
                >
                  {tr(value === "own" ? "ownTab" : "sharedTab")}
                </button>
              ))}
            </div>
            <p className="locker-v2-small">
              {tr(m.receiveType === "own" ? "ownCodeHint" : "sharedCodeHint")}
            </p>
            {m.receiveType === "share" && (
              <label className="field">
                <span>{tr("shareLink")}</span>
                <input
                  className="input"
                  value={m.externalLink}
                  onChange={(event) => {
                    m.invalidateLookup();
                    m.setExternalLink(event.target.value);
                  }}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="https://…/d/…#…"
                />
              </label>
            )}
            {m.lookup?.source.id ? (
              <div className="locker-v2-alert">
                <p>{tr("ownSelected")}</p>
                <button
                  type="button"
                  className="btn sm"
                  onClick={m.invalidateLookup}
                >
                  {tr("useCode")}
                </button>
              </div>
            ) : (
              <label className="field">
                <span>{tr("pickupCode")}</span>
                <input
                  className="input locker-v2-code-input"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={m.code}
                  placeholder={tr("codePlaceholder")}
                  maxLength={32}
                  onChange={(event) => {
                    m.invalidateLookup();
                    m.setCode(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.nativeEvent.isComposing &&
                      !m.lookupBusy
                    )
                      void m.lookupFile();
                  }}
                />
              </label>
            )}
            {m.takeError && (
              <div className="locker-v2-error" role="alert">
                {m.takeError}
              </div>
            )}
            {!m.lookup?.source.id && (
              <div>
                <button
                  type="button"
                  className="btn primary"
                  disabled={m.lookupBusy || m.writesLocked}
                  onClick={() => void m.lookupFile()}
                >
                  <Search size={16} />
                  {m.lookupBusy ? m.t("common.busy") : tr("lookup")}
                </button>
              </div>
            )}
            <p className="locker-v2-small">{tr("lookupFree")}</p>
          </section>
          <aside className="locker-v2-panel locker-v2-summary">
            {m.lookup ? (
              <>
                <span className="locker-v2-badge">
                  {tr(
                    m.lookup.info.expireAt &&
                      Date.parse(m.lookup.info.expireAt) <= m.tick
                      ? "expired"
                      : m.lookup.info.pullsLeft === 0 &&
                          m.lookup.info.inFlightClaims
                        ? "inFlight"
                        : "available",
                  )}
                </span>
                <h3>{m.lookup.info.name}</h3>
                <p className="locker-v2-muted">
                  {m.lookup.info.sizeIsEstimate
                    ? `${tr("transferSize")}: `
                    : ""}
                  {formatBytes(m.lookup.info.size)} · {m.expiry(m.lookup.info)}
                </p>
                {m.lookup.info.legacy && (
                  <div className="locker-v2-alert warning">
                    {tr("legacyHint")}
                  </div>
                )}
                {m.lookup.info.quotaOrigin === "legacyWorkspace" && (
                  <div className="locker-v2-alert warning">
                    {tr("migrationLocalWarning")}
                  </div>
                )}
                <div className="locker-v2-rule">
                  <span>{tr("remaining")}</span>
                  <strong>
                    {m.lookup.info.pullsLeft == null
                      ? tr("unlimited")
                      : tr("count", { count: m.lookup.info.pullsLeft })}
                  </strong>
                </div>
                <h3>{tr("saveTo")}</h3>
                {(["disk", "vault"] as const).map((value) => (
                  <label className="locker-v2-radio" key={value}>
                    <input
                      type="radio"
                      name="locker-target"
                      checked={m.target === value}
                      disabled={m.receiveBusy}
                      onChange={() => m.setTarget(value)}
                    />
                    <span>
                      {tr(value === "disk" ? "localTarget" : "vaultTarget")}
                      <small>
                        {tr(
                          value === "disk"
                            ? "localTargetHint"
                            : "vaultTargetHint",
                        )}
                      </small>
                    </span>
                  </label>
                ))}
                <p className="locker-v2-small">{tr("consumeHint")}</p>
                <button
                  type="button"
                  className="btn primary"
                  disabled={
                    m.receiveBusy ||
                    m.writesLocked ||
                    m.lookup.info.pullsLeft === 0 ||
                    (!!m.lookup.info.expireAt &&
                      Date.parse(m.lookup.info.expireAt) <= m.tick)
                  }
                  onClick={() => void m.receive()}
                >
                  <Download size={16} />
                  {tr("receive")}
                </button>
              </>
            ) : (
              <div className="locker-v2-empty">
                <Search size={28} />
                <h3>{tr("waitLookup")}</h3>
                <p>{tr("waitLookupHint")}</p>
              </div>
            )}
          </aside>
        </div>
      )}
    </>
  );
}

function Detail({ m }: { m: Model }) {
  const { tr, detail } = m;
  if (!detail)
    return (
      <div className="locker-v2-empty">
        <p>{tr("noMatches")}</p>
        <button type="button" className="btn" onClick={m.goHome}>
          {tr("back")}
        </button>
      </div>
    );
  const ended = lockerAccessEnded(detail, m.tick);
  return (
    <>
      <div className="locker-v2-heading">
        <h2>{detail.name}</h2>
        <p>
          {formatBytes(detail.size)} ·{" "}
          {tr(
            detail.share ||
              (detail.shareRequested && detail.shareStatus !== "stopped")
              ? "share"
              : "self",
          )}
        </p>
      </div>
      {m.detailError && (
        <div role="alert" className="locker-v2-alert warning">
          {m.detailError}
        </div>
      )}
      {detail.lastError && (
        <div className="locker-v2-alert warning">{detail.lastError}</div>
      )}
      {detail.syncStatus === "unknown" && (
        <div className="locker-v2-alert warning">{tr("stale")}</div>
      )}
      <div className="locker-v2-grid">
        <section className="locker-v2-panel locker-v2-form">
          <h3>{tr("expiryAndQuota")}</h3>
          <span className={`locker-v2-badge ${ended ? "warn" : ""}`}>
            {m.statusLabel(detail)}
          </span>
          <div className="locker-v2-rule">
            <span>{tr("ttl")}</span>
            <span>{m.expiry(detail)}</span>
          </div>
          <div className="locker-v2-rule">
            <span>{tr("expiresAt")}</span>
            <span>
              {detail.expireAt
                ? new Date(detail.expireAt).toLocaleString(m.i18n.language)
                : tr("forever")}
            </span>
          </div>
          <div className="locker-v2-rule">
            <span>{tr("remaining")}</span>
            <span>{m.quota(detail)}</span>
          </div>
          {detail.legacy && (
            <div className="locker-v2-alert warning">
              <p>{tr("legacyHint")}</p>
              <button
                type="button"
                className="btn"
                disabled={
                  !m.serviceReady ||
                  m.writesLocked ||
                  m.detailBusy ||
                  m.receivePending ||
                  detail.syncStatus === "unknown" ||
                  m.operations.some(
                    (op) =>
                      op.itemId === detail.id && op.status !== "completed",
                  )
                }
                onClick={() => m.setConfirm({ kind: "migrate", item: detail })}
              >
                {tr("migrateLegacy")}
              </button>
            </div>
          )}
          {detail.quotaOrigin === "legacyWorkspace" && (
            <div className="locker-v2-alert warning">
              {tr("migrationLocalWarning")}
            </div>
          )}
          {!ended ? (
            <button
              type="button"
              className="btn"
              disabled={m.writesLocked || m.receivePending}
              onClick={() => m.takeItem(detail.id)}
            >
              <Download size={16} />
              {tr("takeBack")}
            </button>
          ) : (
            <>
              <p className="locker-v2-small">{tr("cleanupHint")}</p>
              {detail.cleanupStatus !== "cleaned" && (
                <button
                  type="button"
                  className="btn"
                  disabled={m.writesLocked || m.detailBusy}
                  onClick={() => m.setConfirm({ kind: "delete", item: detail })}
                >
                  <RefreshCw size={16} />
                  {tr("retryCleanup")}
                </button>
              )}
            </>
          )}
          <div className="locker-v2-danger-zone">
            <h3>{tr("manage")}</h3>
            <p className="locker-v2-small">{tr("deleteHint")}</p>
            {!ended && (
              <button
                type="button"
                className="btn danger"
                disabled={m.writesLocked || m.detailBusy}
                onClick={() => m.setConfirm({ kind: "delete", item: detail })}
              >
                {tr("delete")}
              </button>
            )}
          </div>
        </section>
        <aside className="locker-v2-panel locker-v2-summary">
          <h3>{tr("shareManage")}</h3>
          {!ended ? (
            <>
              {detail.share ? (
                <>
                  <span className="locker-v2-badge">{tr("shareEnabled")}</span>
                  <button
                    type="button"
                    className="btn primary"
                    disabled={m.shareBusy || !m.serviceReady || m.writesLocked}
                    onClick={() => void m.makeShare(detail.id)}
                  >
                    <Link size={16} />
                    {tr("showHandoff")}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={
                      m.detailBusy ||
                      !m.serviceReady ||
                      detail.legacy ||
                      m.writesLocked
                    }
                    onClick={() => m.setConfirm({ kind: "stop", item: detail })}
                  >
                    {tr("stopShare")}
                  </button>
                  <p className="locker-v2-small">{tr("stopShareHint")}</p>
                </>
              ) : (
                <>
                  {detail.shareStatus === "pending" ||
                  detail.shareStatus === "failed" ? (
                    <div className="locker-v2-alert warning">
                      <p>{tr("depositPartial")}</p>
                      {detail.shareError && <p>{detail.shareError}</p>}
                    </div>
                  ) : (
                    <p>{tr("selfHint")}</p>
                  )}
                  <button
                    type="button"
                    className="btn primary"
                    disabled={
                      m.shareBusy ||
                      !m.serviceReady ||
                      detail.legacy ||
                      m.writesLocked
                    }
                    onClick={() => void m.makeShare(detail.id)}
                  >
                    <Link size={16} />
                    {tr(
                      detail.shareStatus === "failed" ||
                        detail.shareStatus === "pending"
                        ? "retryShare"
                        : "createShare",
                    )}
                  </button>
                </>
              )}
              {!m.detailCode && m.shareForId !== detail.id && (
                <button
                  type="button"
                  className="btn"
                  disabled={m.detailBusy}
                  onClick={() => void m.showCode(detail.id)}
                >
                  {tr("showCode")}
                </button>
              )}
              {(m.detailCode || m.shareForId === detail.id) && (
                <Handoff
                  m={m}
                  id={detail.id}
                  code={m.detailCode}
                  name={detail.name}
                />
              )}
            </>
          ) : (
            <p className="locker-v2-muted">{tr("cleanupHint")}</p>
          )}
        </aside>
      </div>
    </>
  );
}

function Connections({ m }: { m: Model }) {
  const { tr } = m;
  return (
    <>
      <div className="locker-v2-heading">
        <h2>{tr("connectionSettings")}</h2>
        <p>{tr("connectionHint")}</p>
      </div>
      <div className="locker-v2-grid">
        <div className="locker-v2-stack">
          <section className="locker-v2-panel locker-v2-form">
            <h3>1. {tr("cloudStorage")}</h3>
            <span className={`locker-v2-badge ${m.storageReady ? "" : "warn"}`}>
              {m.connection?.storageVerified
                ? tr("verified")
                : m.storageReady
                  ? tr("configured")
                  : tr("notConfigured")}
            </span>
            <p className="locker-v2-small">{tr("encryptedStorage")}</p>
            <button
              type="button"
              className="btn"
              onClick={() => m.navigate("/sync")}
            >
              {tr("setupCloud")}
            </button>
          </section>
          <section className="locker-v2-panel locker-v2-form">
            <h3>2. {tr("pickupService")}</h3>
            <span className={`locker-v2-badge ${m.serviceReady ? "" : "warn"}`}>
              {m.connection?.serviceVerified
                ? tr("verified")
                : m.serviceReady
                  ? tr("ready")
                  : tr("unavailable")}
            </span>
            <p className="locker-v2-small">{tr("serviceNeeded")}</p>
            <button
              type="button"
              className="btn primary"
              onClick={() => m.setScreen("service")}
            >
              {tr("configService")}
            </button>
          </section>
        </div>
        <aside className="locker-v2-panel locker-v2-summary">
          <h3>{tr("testConnection")}</h3>
          <button
            type="button"
            className="btn"
            disabled={m.checking}
            onClick={() => void m.checkConnections()}
          >
            <RefreshCw size={16} />
            {m.checking ? tr("checking") : tr("testConnection")}
          </button>
          {(m.connectionError || m.connection?.error) && (
            <div className="locker-v2-alert warning">
              {m.connectionError || m.connection?.error}
            </div>
          )}
          {m.connection?.checkedAt && (
            <p className="locker-v2-small">
              {tr("lastChecked", {
                time: new Date(m.connection.checkedAt).toLocaleTimeString(
                  m.i18n.language,
                ),
              })}
            </p>
          )}
        </aside>
      </div>
    </>
  );
}

function VaultPicker({ m }: { m: Model }) {
  const { tr } = m;
  return (
    <div className="wizard-overlay" onClick={() => m.setVaultOpen(false)}>
      <section
        className="locker-v2-vault-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={tr("fromVault")}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="locker-v2-row locker-v2-between">
          <h3>{tr("fromVault")}</h3>
          <button
            type="button"
            className="btn ghost sm"
            aria-label={m.t("common.close")}
            onClick={() => m.setVaultOpen(false)}
          >
            <X size={16} />
          </button>
        </div>
        {m.vaultLoading ? (
          <p>{m.t("common.busy")}</p>
        ) : !m.vaultEntries.length ? (
          <p>{tr("vaultEmpty")}</p>
        ) : (
          m.vaultEntries.map((entry) => (
            <div key={entry.id} className="locker-v2-vault-entry">
              <strong>
                <PackageOpen size={15} /> {entry.name}
              </strong>
              {entryAttachments(entry).map((attachment) => (
                <button
                  type="button"
                  className="btn"
                  key={attachment.id}
                  disabled={attachment.size > LOCKER_FILE_LIMIT}
                  onClick={() => m.selectVault(entry, attachment.id)}
                >
                  <span>{attachment.originalName}</span>
                  <small>{formatBytes(attachment.size)}</small>
                </button>
              ))}
            </div>
          ))
        )}
        {m.vaultError && (
          <div role="alert" className="locker-v2-error">
            {m.vaultError}
          </div>
        )}
      </section>
    </div>
  );
}

function ActionConfirmation({ m }: { m: Model }) {
  const c = m.confirm,
    { tr } = m;
  if (!c) return null;
  const title =
    c.kind === "stop"
      ? tr("stopShareConfirm")
      : c.kind === "history"
        ? tr("clearHistory")
        : c.kind === "migrate"
          ? tr("migrateLegacy")
          : tr("delete");
  const message =
    c.kind === "history"
      ? tr("clearHistoryConfirm")
      : c.kind === "stop"
        ? tr("stopShareHint")
        : c.kind === "migrate"
          ? tr("migrationConfirm", { name: c.item.name })
          : tr("deleteConfirm", { name: c.item.name });
  const detail =
    c.kind === "delete"
      ? tr("deleteHint")
      : c.kind === "migrate" && !c.item.share
        ? tr("migrationLocalWarning")
        : undefined;
  return (
    <ConfirmDialog
      title={title}
      message={message}
      detail={detail}
      tone={c.kind === "delete" ? "danger" : "default"}
      busy={m.detailBusy}
      confirmLabel={tr("confirm")}
      onCancel={() => m.setConfirm(null)}
      onConfirm={() => void m.performConfirmed()}
    />
  );
}
