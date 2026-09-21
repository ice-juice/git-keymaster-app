import { useEffect, useMemo, useRef, useState, type KeyboardEvent as InputKeyEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { FileLock2, NotebookPen, Search, ShieldCheck, UserRound, Users } from "lucide-react";
import { filterSearchItems, useSearchIndex, type SearchItem, type SearchKind } from "../shared/hooks/useSearchIndex";
import { onOpenCommandPalette } from "./commandPaletteBus";

const KIND_ICON: Record<SearchKind, typeof Search> = {
  identity: Users,
  totp: ShieldCheck,
  account: UserRound,
  file: FileLock2,
  note: NotebookPen,
};

export function CommandPalette() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { items, loading, ensureLoaded, clear } = useSearchIndex();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => filterSearchItems(items, q).slice(0, 40), [items, q]);

  useEffect(() => {
    return onOpenCommandPalette(() => setOpen(true));
  }, []);

  useEffect(() => {
    function onKey(ev: globalThis.KeyboardEvent) {
      const meta = ev.metaKey || ev.ctrlKey;
      if (meta && ev.key.toLowerCase() === "k") {
        ev.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) {
      setQ("");
      setActive(0);
      return;
    }
    void ensureLoaded();
    const tmr = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => window.clearTimeout(tmr);
  }, [open, ensureLoaded]);

  useEffect(() => {
    return () => clear();
  }, [clear]);

  useEffect(() => {
    setActive(0);
  }, [q, items]);

  function close() {
    setOpen(false);
  }

  function go(item: SearchItem) {
    navigate(item.path);
    close();
  }

  function onInputKey(ev: InputKeyEvent<HTMLInputElement>) {
    if (ev.key === "Escape") {
      ev.preventDefault();
      close();
      return;
    }
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      setActive((i) => Math.min(results.length - 1, i + 1));
      return;
    }
    if (ev.key === "ArrowUp") {
      ev.preventDefault();
      setActive((i) => Math.max(0, i - 1));
      return;
    }
    if (ev.key === "Enter") {
      ev.preventDefault();
      const hit = results[active];
      if (hit) go(hit);
    }
  }

  if (!open) return null;

  return (
    <div className="palette-overlay" role="presentation" onMouseDown={close}>
      <div
        className="palette-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t("palette.title")}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="palette-search">
          <Search size={16} />
          <input
            ref={inputRef}
            className="input"
            value={q}
            placeholder={t("palette.placeholder")}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onInputKey}
          />
        </div>
        <div className="palette-body" role="listbox">
          {loading && items.length === 0 ? (
            <div className="palette-empty">{t("palette.loading")}</div>
          ) : results.length === 0 ? (
            <div className="palette-empty">
              <div>{t("palette.empty")}</div>
              <div className="hint">{t("palette.emptyHint")}</div>
            </div>
          ) : (
            results.map((item, index) => {
              const Icon = KIND_ICON[item.kind];
              const title = item.title.trim() || t("notes.untitled");
              return (
                <button
                  key={`${item.kind}-${item.id}`}
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  className={"palette-item" + (index === active ? " on" : "")}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => go(item)}
                >
                  <Icon size={16} />
                  <span className="palette-item-copy">
                    <span className="palette-item-title">{title}</span>
                    {item.subtitle && <span className="palette-item-sub">{item.subtitle}</span>}
                  </span>
                  <span className="palette-item-kind">{t(`palette.kind.${item.kind}`)}</span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
