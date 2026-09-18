import { useEffect, useRef, useState, type PointerEvent } from "react";
import {
  Camera,
  ImagePlus,
  Plus,
  Eye,
  EyeOff,
  KeyRound,
  Edit3,
  Trash2,
  Check,
  Copy,
  Link2,
  FolderKanban,
} from "lucide-react";
import { api, type TotpEntry } from "../lib/ipc";
import { Badge, Empty } from "../ui/common";
import { IconMark } from "../ui/IconMark";
import { CountdownRing } from "../ui/CountdownRing";
import { MobileListToolbar } from "../ui/MobileListToolbar";
import { GroupPicker } from "../ui/GroupPicker";
import { useTranslation } from "react-i18next";
import { useTotpModel, clipNote, type TotpModel } from "../shared/hooks/useTotpModel";
import { pushMobileBack } from "../shared/mobileBack";
import { formatCode, TotpDialogs, TotpFilters } from "./Totp.shared";
import { TotpMobileEditor } from "./TotpMobileEditor";
import { useItemFocus } from "../shared/hooks/useItemFocus";

const LONG_PRESS_MS = 500;
const MOVE_CANCEL_PX = 10;

function TotpMobileCard({
  e,
  m,
  selecting,
  selected,
  locked,
  onToggle,
  onEnterSelect,
}: {
  e: TotpEntry;
  m: TotpModel;
  selecting: boolean;
  selected: boolean;
  locked: boolean;
  onToggle: () => void;
  onEnterSelect: () => void;
}) {
  const { t } = useTranslation();
  const shown = m.codes[e.id];
  const [cached, setCached] = useState(shown);
  useEffect(() => {
    if (shown) setCached(shown);
  }, [shown]);
  const live = shown ?? cached;
  const revealed = !!shown;
  const seedMissing = e.hasSeed === false;
  const isCopied = m.copiedId === e.id;
  const timerRef = useRef<number | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const skipClickRef = useRef(false);

  function clearPress() {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startRef.current = null;
  }

  function onPointerDown(ev: PointerEvent) {
    if (selecting || locked) return;
    startRef.current = { x: ev.clientX, y: ev.clientY };
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      skipClickRef.current = true;
      onEnterSelect();
    }, LONG_PRESS_MS);
  }

  function onPointerMove(ev: PointerEvent) {
    const start = startRef.current;
    if (!start || timerRef.current == null) return;
    if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > MOVE_CANCEL_PX) clearPress();
  }

  return (
    <div
      className={
        "m-totp-card" + (selecting ? " is-selecting" : "") + (selected ? " is-checked" : "")
      }
      data-focus-id={e.id}
      role={selecting ? "checkbox" : undefined}
      aria-checked={selecting ? selected : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={clearPress}
      onPointerCancel={clearPress}
      onContextMenu={(ev) => ev.preventDefault()}
      onClickCapture={(ev) => {
        if (skipClickRef.current) {
          skipClickRef.current = false;
          ev.preventDefault();
          ev.stopPropagation();
          return;
        }
        if (!selecting) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (!locked) onToggle();
      }}
    >
      <div className="m-totp-card-head">
        {selecting && (
          <span className={"m-totp-check" + (selected ? " on" : "")} aria-hidden>
            {selected ? <Check size={12} strokeWidth={2.8} /> : null}
          </span>
        )}
        <div className="m-totp-card-identity">
          <IconMark icon={e.icon} builtins={m.builtins} label={e.issuer} size={28} />
          <div className="m-totp-card-meta">
            <div className="m-totp-card-issuer" title={e.issuer}>
              <span>{e.issuer}</span>
              {e.group && <Badge kind="info">{e.group}</Badge>}
              {e.url && !selecting && (
                <button
                  type="button"
                  className="btn ghost sm"
                  style={{ padding: "0 2px" }}
                  title={t("totp.openSite")}
                  onPointerDown={(ev) => ev.stopPropagation()}
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

        {!selecting && (
          <div className="m-totp-card-ops">
            <button
              type="button"
              className="m-totp-op-btn"
              title={t("totp.secretTitle")}
              onPointerDown={(ev) => ev.stopPropagation()}
              onClick={() => m.openSecret(e.id)}
            >
              <KeyRound size={14} />
            </button>
            <button
              type="button"
              className="m-totp-op-btn"
              disabled={m.writesLocked}
              title={t("common.edit")}
              onPointerDown={(ev) => ev.stopPropagation()}
              onClick={() => m.setEditor({ ...e })}
            >
              <Edit3 size={14} />
            </button>
            <button
              type="button"
              className="m-totp-op-btn danger"
              disabled={m.writesLocked}
              title={t("common.delete")}
              onPointerDown={(ev) => ev.stopPropagation()}
              onClick={() => m.deleteEntry(e)}
            >
              <Trash2 size={14} />
            </button>
          </div>
        )}
      </div>

      {seedMissing && (
        <div className="callout danger sm" style={{ margin: 0 }}>
          {t("totp.seedLostShort")}
        </div>
      )}

      <div
        className={"m-totp-code-area" + (revealed ? " is-revealed" : "") + (selecting ? " is-static" : "")}
        onClick={() => {
          if (selecting || seedMissing) return;
          if (shown) {
            m.copyCode(e.id);
          } else {
            m.reveal(e.id);
          }
        }}
      >
        <div className="m-totp-code-layer is-masked">
          <span className="m-totp-code-masked">••••••</span>
          <button
            type="button"
            className="m-totp-view-btn"
            disabled={seedMissing || selecting}
            onClick={(ev) => {
              ev.stopPropagation();
              if (selecting) return;
              m.reveal(e.id);
            }}
          >
            <Eye size={13} />
            <span>{t("totp.view")}</span>
          </button>
        </div>
        <div className="m-totp-code-layer is-live" aria-hidden={!revealed}>
          <div className="m-totp-live-left">
            {live && (
              <CountdownRing
                remain={live.remain}
                period={live.period || e.period || 30}
                size={28}
              />
            )}
          </div>
          <span className="m-totp-code-num" key={live?.code || "idle"}>
            {live ? formatCode(live.code) : "••••••"}
          </span>
          <div className="m-totp-live-right">
            <button
              type="button"
              className="m-totp-hide-btn"
              title={t("totp.hideCode")}
              aria-label={t("totp.hideCode")}
              onClick={(ev) => {
                ev.stopPropagation();
                if (selecting) return;
                m.hideCode(e.id);
              }}
            >
              <EyeOff size={14} />
            </button>
            <span className={"m-totp-copy-icon" + (isCopied ? " copied" : "")} title={isCopied ? t("totp.copied") : t("common.copy")}>
              {isCopied ? <Check size={14} /> : <Copy size={14} />}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function TotpMobile() {
  const { t } = useTranslation();
  const m = useTotpModel();
  useItemFocus(true, () => {
    m.setGroup("全部");
    m.setQ("");
  });
  const [sheetOpen, setSheetOpen] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [groupSheet, setGroupSheet] = useState(false);
  const [sheetGroup, setSheetGroup] = useState("");

  const selectedSet = new Set(selectedIds);
  const selectedCount = selectedIds.length;
  const filteredIds = m.filtered.map((e) => e.id);
  const allFilteredSelected =
    filteredIds.length > 0 && filteredIds.every((id) => selectedSet.has(id));
  const writeBlocked = m.writesLocked || m.busy;

  function exitSelect() {
    setSelecting(false);
    setSelectedIds([]);
    setGroupSheet(false);
  }

  function enterSelect(id: string) {
    setSelecting(true);
    setSelectedIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function toggleSelectAll() {
    if (allFilteredSelected) {
      const drop = new Set(filteredIds);
      setSelectedIds((prev) => prev.filter((id) => !drop.has(id)));
      return;
    }
    setSelectedIds((prev) => [...new Set([...prev, ...filteredIds])]);
  }

  function openGroupSheet() {
    if (selectedCount === 0 || writeBlocked) return;
    const selected = m.entries.filter((e) => selectedSet.has(e.id));
    const groups = new Set(selected.map((e) => e.group || ""));
    setSheetGroup(groups.size === 1 ? [...groups][0] : "");
    setGroupSheet(true);
  }

  async function applyGroup() {
    if (selectedCount === 0 || writeBlocked) return;
    const result = await m.batchUpdateGroup(selectedIds, sheetGroup);
    if (!result) return;
    if (result.failedIds.length === 0) {
      exitSelect();
      return;
    }
    setSelectedIds(result.failedIds);
    setGroupSheet(false);
  }

  useEffect(() => {
    if (!selecting) return;
    return pushMobileBack(() => {
      if (m.busy) return true;
      exitSelect();
      return true;
    });
  }, [selecting, m.busy]);

  useEffect(() => {
    if (!groupSheet) return;
    return pushMobileBack(() => {
      if (m.busy) return true;
      setGroupSheet(false);
      return true;
    });
  }, [groupSheet, m.busy]);

  return (
    <div className="stack-lg">
      <MobileListToolbar
        query={m.q}
        onQueryChange={m.setQ}
        placeholder={t("totp.searchShort")}
        addLabel={t("pages.add")}
        addDisabled={m.writesLocked || m.busy || selecting}
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
          {selecting && (
            <div className="m-totp-select-bar">
              <div className="m-totp-select-row">
                <span className="m-totp-select-count">{t("totp.selectedCount", { n: selectedCount })}</span>
                <button
                  type="button"
                  className="m-totp-select-all"
                  disabled={filteredIds.length === 0 || m.busy}
                  onClick={toggleSelectAll}
                >
                  {allFilteredSelected ? t("totp.deselectAll") : t("totp.selectAll")}
                </button>
                <button
                  type="button"
                  className="m-totp-select-done"
                  disabled={m.busy}
                  onClick={exitSelect}
                >
                  {t("totp.selectCancel")}
                </button>
              </div>
              <button
                type="button"
                className="m-totp-select-group-btn"
                disabled={selectedCount === 0 || writeBlocked}
                onClick={openGroupSheet}
              >
                <FolderKanban size={15} />
                <span>
                  {m.batchProgress
                    ? t("totp.batchGroupProgress", m.batchProgress)
                    : t("totp.batchGroup")}
                </span>
              </button>
            </div>
          )}
          {m.filtered.map((e) => (
            <TotpMobileCard
              key={e.id}
              e={e}
              m={m}
              selecting={selecting}
              selected={selectedSet.has(e.id)}
              locked={m.busy}
              onToggle={() => toggleSelect(e.id)}
              onEnterSelect={() => enterSelect(e.id)}
            />
          ))}
        </div>
      )}

      <TotpDialogs m={m} skipEditor />

      {m.editor && (
        <TotpMobileEditor
          m={m}
          onClose={() => m.setEditor(null)}
        />
      )}

      {groupSheet && (
        <div className="wizard-overlay" onClick={() => { if (!m.busy) setGroupSheet(false); }}>
          <div className="m-note-sheet m-totp-group-sheet" onClick={(ev) => ev.stopPropagation()}>
            <div className="m-note-sheet-handle" />
            <div className="m-note-sheet-head">
              <div className="m-note-sheet-title">{t("totp.batchGroupTitle")}</div>
              <div className="m-note-sheet-meta">{t("totp.batchGroupMeta", { n: selectedCount })}</div>
            </div>
            <GroupPicker
              groups={m.groups}
              value={sheetGroup}
              onChange={setSheetGroup}
              inline
              onReorder={m.writesLocked ? undefined : m.reorderGroups}
            />
            {m.writesLocked && <div className="hint">{t("totp.batchGroupLocked")}</div>}
            <div className="m-totp-sheet-foot">
              <button
                type="button"
                className="btn ghost sm"
                disabled={m.busy}
                onClick={() => setGroupSheet(false)}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="btn primary sm"
                disabled={selectedCount === 0 || writeBlocked}
                onClick={() => void applyGroup()}
              >
                {m.batchProgress
                  ? t("totp.batchGroupProgress", m.batchProgress)
                  : t("totp.batchGroupApply", { n: selectedCount })}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
