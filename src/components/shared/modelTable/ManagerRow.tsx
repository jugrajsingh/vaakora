import React, { useId } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ChevronDown, Loader2, Lock, RotateCcw, Trash2, X } from "lucide-react";
import { Radio } from "@/components/ui/Radio";
import { DownloadMark } from "@/components/shared/DownloadMark";
import { InlineConfirm } from "@/components/shared/InlineConfirm";
import { ProgressRing } from "@/components/shared/ProgressRing";
import { SpeedBars } from "@/components/shared/SpeedBars";
import { Tag } from "@/components/shared/Tag";
import { useRevealOnOpen } from "@/components/shared/useRevealOnOpen";
import {
  openLink,
  type OpenLink,
} from "@/components/settings/post-processing/LocalLlmAttribution";
import { languageList } from "@/lib/constants/languages";
import { formatBytes } from "@/lib/utils/format";
import type { Grading } from "@/lib/models/grading";
import { HEAD_CLASS, Values, rowGrid } from "./columns";
import type { TableModel } from "./context";
import type { ManagerModel, Measure, ModelState } from "./roles";

export interface ManagerRowProps {
  model: ManagerModel;
  open: boolean;
  toggle: () => void;
  cells: React.ReactNode;
  mark: { label: string; disabled?: string; press: () => void } | null;
  remove?: { label: string; press: () => void };
  question?: { message: string; confirm: () => void; cancel: () => void };
  /** Under the detail list (the token field). */
  detail?: React.ReactNode;
  /** The Run on value (read aloud's per-model control); else the model's Run on text. */
  runOn?: React.ReactNode;
  /** The Voices value (voices with Listen); else the voice names. */
  voices?: React.ReactNode;
  /** Replaces the second line. */
  line?: React.ReactNode;
  /** A lock where the trash would be. */
  locked?: boolean;
  /** Makes the row focusable and receives its keys. */
  onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
}

const SLOT_CLASS =
  "grid size-[24px] cursor-pointer place-items-center rounded-[7px] text-ink-3 hover:bg-line hover:text-text focus:outline-none focus-visible:ring-1 focus-visible:ring-logo-primary";

const VALUE_CLASS = "min-w-0 [overflow-wrap:anywhere] text-ink-2";

const sizeOf = (bytes: number | null): string | null =>
  bytes === null ? null : formatBytes(bytes);

/** A formatted size that keeps its digits before its unit in right-to-left text. */
const isolated = (size: string): React.ReactNode => (
  <span dir="ltr">{size}</span>
);

function markIcon(state: ModelState, cancels: boolean): React.ReactNode {
  switch (state.kind) {
    case "selected":
      return state.runtime === "loading" ? (
        <Loader2
          className="size-[18px] animate-spin text-ink-3"
          aria-hidden="true"
        />
      ) : (
        <Radio checked />
      );
    case "downloaded":
      return <Radio checked={false} />;
    case "remote":
      return <DownloadMark />;
    case "failed":
      return (
        <span
          aria-hidden="true"
          className="grid size-[18px] place-items-center rounded-full border-[1.5px] border-line-strong text-ink-2"
        >
          <RotateCcw className="size-[11px]" strokeWidth={2.5} />
        </span>
      );
    case "downloading":
      return (
        <span className="relative grid place-items-center">
          <ProgressRing size={18} value={(state.percent ?? 0) / 100} />
          {cancels && (
            <X
              className="absolute size-[10px] text-ink-2"
              strokeWidth={3}
              aria-hidden="true"
            />
          )}
        </span>
      );
  }
}

/** A model row with its injected translator, link opener and detail id; `ManagerRow` supplies them. */
export function ManagerRowView({
  model,
  open,
  toggle,
  cells,
  mark,
  remove,
  question,
  detail,
  runOn,
  voices,
  line,
  locked = false,
  onKeyDown,
  t,
  language,
  detailId,
  openLink: openUrl,
  rowRef,
}: ManagerRowProps & {
  t: TFunction;
  language: string;
  detailId: string;
  openLink: OpenLink;
  rowRef?: React.Ref<HTMLDivElement>;
}): React.JSX.Element {
  const { state } = model;
  const selected = state.kind === "selected";
  const pressable =
    mark !== null &&
    question === undefined &&
    !(state.kind === "downloading" && !state.cancellable)
      ? mark
      : null;
  const icon = markIcon(state, pressable !== null);
  const size = sizeOf(model.sizeBytes);
  const memory = sizeOf(model.memoryBytes);
  const notListed = t("models.missing.notListed");

  const secondLine = (): React.ReactNode => {
    if (line !== undefined) return line;
    switch (state.kind) {
      case "downloading":
        return (
          <span className="tabular-nums">
            {t("models.downloading", {
              percent: Math.round(state.percent ?? 0),
              size: size ?? notListed,
            })}
          </span>
        );
      case "failed":
        return state.error;
      case "selected":
        return (
          <>
            <span className="text-moss">{t("models.selected")}</span>
            {state.runtime && (
              <>
                {" · "}
                {t(`models.runtime.${state.runtime}`)}
              </>
            )}
          </>
        );
      default:
        return model.description;
    }
  };

  const measured = model.measuredOn ?? t("models.missing.notMeasured");
  const speedLine =
    model.speed.figure !== null
      ? model.speed.figure
      : model.speed.provenance !== null
        ? t("models.missing.notMeasured")
        : null;
  const measuredOn =
    speedLine === null
      ? measured
      : `${measured} · ${t("models.cell.value", { head: t("models.heads.speed"), figure: speedLine })}`;
  const runOnValue =
    runOn ?? (model.runOn?.kind === "text" ? model.runOn.text : null);
  const { licence } = model;
  const facts: [string, React.ReactNode][] = [
    [
      t("models.detail.languages"),
      model.languages
        ? languageList(model.languages, language)
        : t("models.missing.languages"),
    ],
    ...(runOnValue === null
      ? []
      : [[t("models.detail.runOn"), runOnValue] as [string, React.ReactNode]]),
    [
      t("models.detail.memory"),
      memory === null ? t("models.missing.notMeasured") : isolated(memory),
    ],
    [t("models.detail.measuredOn"), measuredOn],
    ...(model.role === "readAloud"
      ? [
          [
            t("models.detail.voices"),
            voices ??
              (model.voices.length > 0
                ? new Intl.ListFormat(language, { type: "unit" }).format(
                    model.voices,
                  )
                : notListed),
          ] as [string, React.ReactNode],
        ]
      : []),
    [
      t("models.detail.licence"),
      <>
        {licence.name ?? t("models.missing.licence")}
        {licence.terms && (
          <>
            {" · "}
            {licence.terms}
          </>
        )}
        {licence.url && (
          <>
            {" · "}
            <button
              type="button"
              className="cursor-pointer underline focus:outline-none focus-visible:ring-1 focus-visible:ring-logo-primary"
              onClick={() => openUrl(licence.url ?? "", "model card")}
            >
              {t("models.detail.modelCard")}
            </button>
          </>
        )}
      </>,
    ],
    [
      t("models.detail.source"),
      model.sources.length > 0
        ? model.sources.map((source) => (
            <span key={source.repository} className="block">
              {t("models.detail.revision", {
                repository: source.repository,
                revision: source.revision.slice(0, 7),
              })}
            </span>
          ))
        : notListed,
    ],
    ...(model.role === "dictation"
      ? [
          [
            t("models.detail.customWords"),
            t(
              model.customWords === null
                ? "models.customWords.unknown"
                : model.customWords
                  ? "models.customWords.native"
                  : "models.customWords.corrected",
            ),
          ] as [string, React.ReactNode],
        ]
      : []),
  ];

  const slot = question ? null : remove ? (
    <button
      type="button"
      aria-label={remove.label}
      title={remove.label}
      onClick={remove.press}
      className={`${SLOT_CLASS} opacity-40 transition-opacity group-hover:opacity-100 focus-visible:opacity-100`}
    >
      <Trash2 className="size-[14px]" aria-hidden="true" />
    </button>
  ) : locked ? (
    <Lock className="size-[13px] text-ink-3" aria-hidden="true" />
  ) : (
    <button
      type="button"
      aria-label={t(open ? "models.row.close" : "models.row.open")}
      title={t(open ? "models.row.close" : "models.row.open")}
      aria-expanded={open}
      aria-controls={detailId}
      onClick={toggle}
      className={SLOT_CLASS}
    >
      <ChevronDown
        className={`size-[14px] transition-transform ${open ? "rotate-180" : ""}`}
        aria-hidden="true"
      />
    </button>
  );

  return (
    <div
      ref={rowRef}
      data-row={model.id}
      data-selected={selected ? "" : undefined}
      tabIndex={onKeyDown ? 0 : undefined}
      onKeyDown={onKeyDown}
      className={`group ${rowGrid(true)} min-h-[50px] w-full min-w-0 rounded-control px-[14px] py-[9px] text-start text-small leading-[1.5] text-text focus:outline-none focus-visible:ring-1 focus-visible:ring-logo-primary ${selected || question ? "bg-wash" : ""}`}
    >
      <span className="grid place-items-center" title={pressable?.disabled}>
        {pressable ? (
          <button
            type="button"
            aria-label={pressable.label}
            title={pressable.disabled ?? pressable.label}
            disabled={pressable.disabled !== undefined}
            onClick={pressable.press}
            className="-m-[3px] grid size-[24px] cursor-pointer place-items-center rounded-full focus:outline-none focus-visible:ring-1 focus-visible:ring-logo-primary disabled:cursor-default disabled:opacity-40"
          >
            {icon}
          </button>
        ) : (
          icon
        )}
      </span>
      <span className="flex min-w-0 flex-col items-start">
        <span className="flex min-w-0 max-w-full flex-wrap items-center gap-x-[6px] gap-y-[2px]">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailId}
            onClick={toggle}
            className="min-w-0 max-w-full cursor-pointer break-words rounded-[4px] text-start font-[650] text-text focus:outline-none focus-visible:ring-1 focus-visible:ring-logo-primary"
          >
            {model.name}
          </button>
          {model.tags.map((tag) => (
            <Tag key={tag}>{t(`models.tags.${tag}`)}</Tag>
          ))}
        </span>
        <span className="max-w-full break-words text-ink-3">
          {secondLine()}
        </span>
      </span>
      <span className="grid">{cells}</span>
      <span data-confirm-row={model.id} className="grid place-items-center">
        {slot}
      </span>
      {question && (
        <div className="col-span-full -mx-[14px] ps-[42px] pe-[14px] pt-[6px]">
          <InlineConfirm
            message={question.message}
            action={t("models.delete.action")}
            onCancel={question.cancel}
            onConfirm={question.confirm}
          />
        </div>
      )}
      {open && (
        <dl
          id={detailId}
          className="col-span-full grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 px-[42px] pb-3 text-small -mx-[14px] mt-[6px]"
        >
          {facts.map(([label, value]) => (
            <React.Fragment key={label}>
              <dt className="text-ink-3">{label}</dt>
              <dd className={VALUE_CLASS}>{value}</dd>
            </React.Fragment>
          ))}
        </dl>
      )}
      {open && detail && (
        <div className="col-span-full -mx-[14px] px-[42px] pb-3">{detail}</div>
      )}
    </div>
  );
}

/** One model row: the leading mark selects, downloads or cancels; the name or chevron opens the details. */
export function ManagerRow(props: ManagerRowProps): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const detailId = `${useId()}-detail`;
  const reveal = useRevealOnOpen<HTMLDivElement>(
    props.open,
    props.toggle,
    "[data-model-toolbar]",
  );
  return (
    <ManagerRowView
      {...props}
      toggle={reveal.toggle}
      rowRef={reveal.ref}
      t={t}
      language={i18n.language}
      detailId={detailId}
      openLink={openLink}
    />
  );
}

/** The quality, speed and size columns shared by `RoleHeads` and `RoleCells`. */
const ROLE_COLUMNS =
  "grid grid-cols-[44px_40px_64px] items-center justify-items-center gap-x-[6px]";

/** The column heads over `RoleCells`. */
export function RoleHeads(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <span className={ROLE_COLUMNS}>
      {(["score", "speed", "size"] as const).map((head) => (
        <span
          key={head}
          title={t(`models.heads.${head}`)}
          className={`text-center ${HEAD_CLASS}`}
        >
          {t(`models.heads.short.${head}`)}
        </span>
      ))}
    </span>
  );
}

const measureLabel = (t: TFunction, head: string, measure: Measure) =>
  measure.text === null
    ? t("models.cell.unmeasured", { head })
    : measure.provenance === null
      ? t("models.cell.value", { head, figure: measure.figure ?? measure.text })
      : t("models.cell.measured", {
          head,
          figure: measure.figure ?? measure.text,
          provenance: measure.provenance,
        });

/** Read aloud and cleanup cells: score, speed bars and size, each named with its figure and provenance. */
export function RoleCells({
  model,
}: {
  model: ManagerModel;
}): React.JSX.Element {
  const { t } = useTranslation();
  const unmeasured = t("models.missing.unmeasured");
  const score = measureLabel(t, t("models.heads.score"), model.quality);
  const speed = measureLabel(t, t("models.heads.speed"), model.speed);
  const listedSize = sizeOf(model.sizeBytes);
  const shownSize = listedSize ?? t("models.missing.notListed");
  const size = t("models.cell.value", {
    head: t("models.heads.size"),
    figure: shownSize,
  });
  return (
    <span className={ROLE_COLUMNS}>
      <span
        role="img"
        aria-label={score}
        title={score}
        className="text-label tabular-nums text-ink-2"
      >
        {model.quality.text ?? unmeasured}
      </span>
      <span
        role="img"
        aria-label={speed}
        title={speed}
        className="inline-grid h-[22px] w-[36px] place-items-center text-label text-ink-2"
      >
        {model.speed.text === null ? (
          unmeasured
        ) : (
          <SpeedBars level={model.speed.level} className="h-[12px]!" />
        )}
      </span>
      <span
        role="img"
        aria-label={size}
        title={size}
        className="text-center text-label tabular-nums text-ink-3"
      >
        {listedSize === null ? shownSize : isolated(listedSize)}
      </span>
    </span>
  );
}

/** Dictation cells: the upstream grade, speed and size, with the speed's figure and provenance in its name and tooltip. */
export function DictationCells({
  model,
  entry,
  grading,
}: {
  model: ManagerModel;
  entry: TableModel;
  grading: Grading;
}): React.JSX.Element {
  return (
    <Values
      grading={grading}
      model={entry.model}
      streaming={entry.streaming}
      sizeMb={entry.sizeMb}
      speed={model.speed}
    />
  );
}
