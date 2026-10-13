import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import {
  Camera,
  ChevronsDown,
  ChevronsUp,
  ImagePlus,
  MoreHorizontal,
  Plus,
  Check,
  FolderKanban,
} from "lucide-react";
import { type TotpEntry } from "../lib/ipc";
import { Badge } from "../ui/common";
import { IconMark } from "../ui/IconMark";
import { MobileListToolbar } from "../ui/MobileListToolbar";
import { GroupPicker } from "../ui/GroupPicker";
import { useTranslation } from "react-i18next";
import { useTotpModel, clipNote, type TotpModel } from "../shared/hooks/useTotpModel";
import { pushMobileBack, useOverlayBack } from "../shared/mobileBack";
import { TotpCodeSlot } from "../ui/TotpCodeSlot";
import {
  TotpDialogs,
  TotpEmpty,
  TotpFilters,
  TotpPlatformGroups,
  TotpViewSwitcher,
  totpActionItems,
  totpSlotProps,
} from "./Totp.shared";
import { TotpMobileEditor } from "./TotpMobileEditor";
import { useItemFocus } from "../shared/hooks/useItemFocus";
import { can } from "../platform/capabilities";

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

  const body = (moreBtn?: ReactNode) => (
    <>
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
        {!selecting && moreBtn ? <div className="m-totp-card-ops">{moreBtn}</div> : null}
      </div>
      <TotpCodeSlot {...totpSlotProps(m, e)} fade selecting={selecting} />
    </>
  );

  const cardProps = {
    role: selecting ? ("checkbox" as const) : undefined,
    "aria-checked": selecting ? selected : undefined,
    onPointerDown,
    onPointerMove,
    onPointerUp: clearPress,
    onPointerCancel: clearPress,
    onContextMenu: (ev: { preventDefault(): void }) => ev.preventDefault(),
    onClickCapture: (ev: { preventDefault(): void; stopPropagation(): void }) => {
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
    },
  };

  return (
    <div
      className={"m-totp-card" + (selecting ? " is-selecting" : "") + (selected ? " is-checked" : "")}
      data-focus-id={e.id}
      {...cardProps}
    >
      {body(
        selecting ? undefined : (
          <button
            type="button"
            className="totp-more-btn m-totp-more-btn"
            aria-label={t("totp.moreActions")}
            aria-haspopup="dialog"
            aria-expanded={m.moreOpenId === e.id}
            onPointerDown={(ev) => ev.stopPropagation()}
            onClick={(ev) => {
              ev.stopPropagation();
              m.setMoreOpenId(e.id);
            }}
          >
            <MoreHorizontal size={18} aria-hidden />
          </button>
        ),
      )}
    </div>
  );
}

function TotpActionSheet({ m }: { m: TotpModel }) {
  const { t } = useTranslation();
  const entry = m.moreOpenId ? m.entries.find((e) => e.id === m.moreOpenId) : undefined;
  const setMoreOpenId = m.setMoreOpenId;
  const close = useCallback(() => setMoreOpenId(null), [setMoreOpenId]);
  useOverlayBack(!!entry, close);
  if (!entry) return null;
  const title = entry.issuer || t("totp.unnamed");
  return (
    <div className="wizard-overlay" onClick={close}>
      <div
        className="m-note-sheet m-totp-action-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(ev) => ev.stopPropagation()}
      >
        <div className="m-note-sheet-handle" />
        <div className="m-note-sheet-head">
          <div className="m-note-sheet-title">{title}</div>
          {entry.account && (
            <div className="m-note-sheet-meta">
              <span>{entry.account}</span>
            </div>
          )}
        </div>
        <div className="m-note-sheet-actions">
          {totpActionItems(entry, m, t, 18).map((item) => (
            <button
              key={item.key}
              type="button"
              className={"m-note-sheet-item" + (item.danger ? " is-danger" : "")}
              disabled={item.disabled}
              onClick={() => {
                close();
                item.onClick();
              }}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
        <button type="button" className="btn m-note-sheet-cancel" onClick={close}>
          {t("common.cancel")}
        </button>
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
    m.setMoreOpenId(null);
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

  const allFolded = m.platforms.length > 0 && m.platforms.every((g) => m.collapsed[g.key]);
  const foldLabel = allFolded ? t("pages.expandAll") : t("pages.collapseAll");

  function renderCard(e: TotpEntry) {
    return (
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
    );
  }

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
          ...(can("cameraQrScan")
            ? [
                {
                  key: "scan",
                  label: t("totp.scanImport"),
                  hint: t("totp.scanImportHint"),
                  icon: <Camera size={18} />,
                  onClick: () => void m.scanCamera(),
                },
              ]
            : []),
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

      <div className="m-totp-view-row">
        <TotpViewSwitcher view={m.view} setViewMode={m.setViewMode} />
      </div>
      <TotpFilters
        m={m}
        hideSearch
        trailing={
          m.view === "platform" && m.platforms.length > 0 ? (
            <button
              type="button"
              className={"m-group-more-btn" + (allFolded ? " is-on" : "")}
              title={foldLabel}
              aria-label={foldLabel}
              aria-expanded={!allFolded}
              onClick={() => (allFolded ? m.expandAll() : m.collapseAll())}
            >
              {allFolded ? <ChevronsDown size={15} aria-hidden /> : <ChevronsUp size={15} aria-hidden />}
            </button>
          ) : undefined
        }
      />

      {m.filtered.length === 0 ? (
        <div className="card" style={{ padding: "30px 10px" }}>
          <TotpEmpty m={m} mobile />
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
          {m.view === "platform"
            ? (
              <TotpPlatformGroups
                m={m}
                variant="mobile"
                renderRow={(e) => renderCard(e)}
              />
            )
            : m.filtered.map((e) => renderCard(e))}
        </div>
      )}

      <TotpDialogs m={m} skipEditor />
      <TotpActionSheet m={m} />

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
