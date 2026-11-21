import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { CircleHelp, Search } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { FilterChip } from "@/components/shared/FilterChip";
import { SpeedBars } from "@/components/shared/SpeedBars";
import { usePressAway } from "@/hooks/usePressAway";
import { isComposingKeyEvent } from "@/lib/utils/keyboard";
import { CODE_CLASS, rowGrid } from "./columns";
import {
  SPEED_SCORE_FLOORS,
  createOpenSync,
  nextOpen,
  type Chip,
  type ManagerModel,
  type ModelRole,
} from "./roles";

/** A run of rows under one label; the caller drops sections with no rows. */
export interface ManagerSection {
  key: string;
  label: React.ReactNode;
  rows: ManagerModel[];
  /** Under its rows. */
  after?: React.ReactNode;
}

export interface ManagerTableProps {
  role: ModelRole;
  sections: ManagerSection[];
  query: string;
  setQuery: (q: string) => void;
  chips: Chip[];
  pressed: ReadonlySet<string>;
  toggleChip: (key: string) => void;
  /** The column heads over the rows' cells. */
  heads: React.ReactNode;
  legend: React.ReactNode;
  /** In the toolbar before the legend (dictation's Change languages link). */
  aside?: React.ReactNode;
  /** The row whose details are open; the page owns it. */
  openId: string | null;
  /** Every open and close, including a row closed because another opened or its model left the list. */
  onOpenChange: (id: string | null) => void;
  renderRow: (
    m: ManagerModel,
    open: boolean,
    toggle: () => void,
  ) => React.ReactNode;
}

/** The table with its translator injected; `ManagerTable` supplies it and reports a row closed by leaving the list. */
export function ManagerTableView({
  role,
  sections,
  query,
  setQuery,
  chips,
  pressed,
  toggleChip,
  heads,
  legend,
  aside,
  openId,
  onOpenChange,
  renderRow,
  t,
}: ManagerTableProps & { t: TFunction }): React.JSX.Element {
  const empty = sections.every((section) => section.rows.length === 0);
  const searched = query.trim();
  const filtered = empty && (searched !== "" || pressed.size > 0);
  const clearFilters = () => {
    setQuery("");
    for (const key of [...pressed]) toggleChip(key);
  };

  return (
    <div data-model-table={role} className="w-full max-w-3xl min-w-0">
      <div
        data-model-toolbar=""
        className="sticky top-0 z-10 flex flex-wrap items-center gap-2 bg-background py-2"
      >
        <label className="flex h-[30px] min-w-0 flex-1 basis-[160px] cursor-text items-center gap-[8px] rounded-control border border-line px-[8px] focus-within:ring-2 focus-within:ring-logo-primary">
          <Search
            size={14}
            aria-hidden="true"
            className="shrink-0 text-ink-3"
          />
          <input
            type="search"
            value={query}
            placeholder={t("models.search")}
            aria-label={t("models.search")}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key !== "Escape" ||
                query === "" ||
                isComposingKeyEvent(event.nativeEvent)
              )
                return;
              event.stopPropagation();
              setQuery("");
            }}
            className="h-full min-w-0 flex-1 bg-transparent text-small text-text outline-none placeholder:text-ink-3 [&::-webkit-search-cancel-button]:appearance-none"
          />
        </label>
        {chips.map((chip) => (
          <FilterChip
            key={chip.key}
            pressed={pressed.has(chip.key)}
            onToggle={() => toggleChip(chip.key)}
          >
            {chip.label}
          </FilterChip>
        ))}
        {aside}
        {legend}
      </div>
      {filtered ? (
        <div className="flex flex-col items-center gap-2 px-3 py-7 text-center">
          <p className="text-small text-text">
            {searched
              ? t("models.noMatch", { query: searched })
              : t("models.noFilterMatch")}
          </p>
          <Button variant="secondary" size="sm" onClick={clearFilters}>
            {t("models.clearFilters")}
          </Button>
        </div>
      ) : (
        <>
          {!empty && (
            <div className={`${rowGrid(true)} min-h-[32px] px-[14px]`}>
              <span />
              <span className={`min-w-0 ${CODE_CLASS}`}>
                {sections[0]?.label}
              </span>
              <span className="grid">{heads}</span>
              <span />
            </div>
          )}
          {sections.map((section, index) => (
            <section key={section.key} data-section={section.key}>
              {index > 0 && (
                <div
                  className={`${rowGrid(true)} mt-[6px] min-h-[33px] border-t border-line px-[14px]`}
                >
                  <span />
                  <span className={`min-w-0 ${CODE_CLASS}`}>
                    {section.label}
                  </span>
                </div>
              )}
              <div className="flex flex-col gap-[4px]">
                {section.rows.map((m) => (
                  <React.Fragment key={m.id}>
                    {renderRow(m, m.id === openId, () =>
                      onOpenChange(m.id === openId ? null : m.id),
                    )}
                  </React.Fragment>
                ))}
              </div>
              {section.after}
            </section>
          ))}
        </>
      )}
    </div>
  );
}

/** Search, chips and sections of model rows; one row's details open at a time. */
export function ManagerTable(props: ManagerTableProps): React.JSX.Element {
  const { t } = useTranslation();
  const { sections, openId, onOpenChange } = props;
  const [sync] = useState(createOpenSync);
  const ids = sections.flatMap((section) => section.rows.map((m) => m.id));
  useEffect(() => {
    const next = sync(openId, ids);
    if (next !== undefined) onOpenChange(next);
  }, [sync, openId, ids.join("\n"), onOpenChange]);
  return <ManagerTableView {...props} openId={nextOpen(openId, ids)} t={t} />;
}

interface RoleLegendProps {
  role: "readAloud" | "cleanup";
  /** The machine and date the figures were measured on, or null. */
  measuredOn: string | null;
}

const SCORE_BOUNDS = [0, ...SPEED_SCORE_FLOORS, 10];

/** What the score and speed columns mean, the speed bands, and where they were measured. */
export function RoleLegendBody({
  role,
  measuredOn,
}: RoleLegendProps): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const number = new Intl.NumberFormat(i18n.language);
  return (
    <>
      <p className="font-semibold text-text">{t("models.heads.score")}</p>
      <p className="mt-[2px] text-ink-2">{t(`models.legend.score.${role}`)}</p>
      <p className="mt-[12px] font-semibold text-text">
        {t("models.heads.speed")}
      </p>
      <p className="mt-[2px] text-ink-2">{t(`models.legend.speed.${role}`)}</p>
      {role === "readAloud" && (
        <ul className="mt-[8px] grid grid-cols-[auto_1fr] items-center gap-x-[8px] gap-y-[5px]">
          {[4, 3, 2, 1].map((level) => (
            <li key={level} className="contents">
              <span className="inline-grid w-[30px] place-items-center">
                <SpeedBars level={level} />
              </span>
              <span className="tabular-nums text-ink-2">
                {t("models.legend.range", {
                  low: number.format(SCORE_BOUNDS[level - 1]),
                  high: number.format(SCORE_BOUNDS[level]),
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-[10px] border-t border-line pt-[8px] text-ink-3">
        {t("models.legend.unmeasured")}
      </p>
      {measuredOn !== null && (
        <p className="mt-[2px] text-ink-3">
          {t("models.legend.measuredOn", { machine: measuredOn })}
        </p>
      )}
    </>
  );
}

/** The "(?)" beside the read-aloud and cleanup heads. */
export function RoleLegend(props: RoleLegendProps): React.JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  usePressAway(open, ref, () => setOpen(false));
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [open]);
  return (
    <div ref={ref} className="relative grid">
      <button
        type="button"
        aria-expanded={open}
        aria-label={t("models.legend.open")}
        title={t("models.legend.open")}
        onClick={() => setOpen((shown) => !shown)}
        className={`grid size-[22px] cursor-pointer place-items-center rounded-full transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-logo-primary ${open ? "bg-line text-text" : "text-ink-3 hover:bg-wash hover:text-text"}`}
      >
        <CircleHelp className="size-[15px]" aria-hidden="true" />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={t("models.legend.open")}
          className="absolute end-0 top-[28px] z-30 w-[300px] max-w-[calc(100vw-32px)] animate-rise rounded-card border border-line-strong bg-background p-[14px] text-start text-small leading-[1.45] shadow-[0_12px_32px_-12px_color-mix(in_srgb,var(--color-shadow)_35%,transparent)]"
        >
          <RoleLegendBody {...props} />
        </div>
      )}
    </div>
  );
}
