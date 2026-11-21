import React, { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Tooltip } from "@/components/ui/Tooltip";
import { useModelStore } from "@/stores/modelStore";
import {
  areModelsLocked,
  useModelsLocked,
} from "@/stores/transcriptionJobsStore";
import { useSettings } from "@/hooks/useSettings";
import { useRowConfirm } from "@/components/shared/InlineConfirm";
import { Codes } from "@/components/shared/modelTable/columns";
import { Note } from "@/components/shared/modelTable/ModelTable";
import {
  ManagerTable,
  type ManagerSection,
} from "@/components/shared/modelTable/ManagerTable";
import {
  applyChips,
  dictationModel,
  matchesQuery,
  type Chip,
  type ManagerModel,
} from "@/components/shared/modelTable/roles";
import { languageName } from "@/lib/constants/languages";
import { formatBytes } from "@/lib/utils/format";
import RetiredModelsNotice from "./RetiredModelsNotice";
import { ModelRow } from "./ModelRow";
import { Legend } from "./Legend";
import { deleteChecks, deleteMessage, type DeleteAsk } from "./managerRows";
import {
  placeNow,
  placeOf,
  useModelEntries,
  useSwitching,
  type Entry,
} from "./modelEntries";

/** Past this many models on disk, the rest fold under "Show N more". */
const YOURS_LIMIT = 5;

/** Look for model files added outside Handy: quiet, beside its section's name. */
const Rescan: React.FC = () => {
  const { t } = useTranslation();
  const rescanning = useModelStore((s) => s.isRescanning);
  return (
    <Tooltip text={t("settings.models.rescan.tooltip")}>
      <button
        type="button"
        onClick={() => useModelStore.getState().rescanLocalModels()}
        disabled={rescanning}
        aria-label={t("settings.models.rescan.tooltip")}
        className="ms-[6px] grid size-[22px] cursor-pointer place-items-center rounded-full text-ink-3 hover:bg-wash hover:text-text disabled:cursor-default focus:outline-none focus-visible:ring-1 focus-visible:ring-logo-primary"
      >
        <RefreshCw
          className={`size-[12px] ${rescanning ? "animate-spin" : ""}`}
          aria-hidden="true"
        />
      </button>
    </Tooltip>
  );
};

/** The label of each value of the dictation acceleration setting. */
const DEVICE_KEYS = {
  auto: "settings.advanced.acceleration.gpuDevice.auto",
  cpu: "models.runOn.cpu",
  gpu: "models.runOn.gpu",
} as const;

const CHIP_TAGS = ["live", "translates", "nativeWords"] as const;

interface ModelsSettingsProps {
  /** Where the languages are changed (General). */
  onChangeLanguages?: () => void;
}

/** Models, Dictation: the manager table over the app's models, graded for your languages. */
export const ModelsSettings: React.FC<ModelsSettingsProps> = ({
  onChangeLanguages,
}) => {
  const { t, i18n } = useTranslation();
  const loading = useModelStore((s) => s.loading);
  const { facts, lists } = useModelEntries();
  const { getSetting } = useSettings();
  const switching = useSwitching();
  // A file transcription starting re-renders the page, so the question prunes.
  useModelsLocked();
  const sources = useModelStore(
    useShallow((s) => ({
      models: s.models,
      downloadingModels: s.downloadingModels,
      verifyingModels: s.verifyingModels,
      downloadProgress: s.downloadProgress,
      currentModel: s.currentModel,
    })),
  );
  const [query, setQuery] = useState("");
  const [pressed, setPressed] = useState<ReadonlySet<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [more, setMore] = useState(false);

  // The question as asked: its model, whether it was selected, and its words.
  const asked = useRef<(DeleteAsk & { message: string }) | null>(null);
  const question = useRowConfirm<string>(
    deleteChecks({
      asked: () => asked.current,
      now: (id) => ({
        place: placeNow(id),
        selected: useModelStore.getState().currentModel === id,
        locked: areModelsLocked(),
      }),
      remove: (id) => void useModelStore.getState().deleteModel(id),
    }),
  );

  if (loading) {
    return (
      <p
        role="status"
        className="px-[12px] py-16 text-center text-small text-ink-3"
      >
        {t("settings.jobModel.loading")}
      </p>
    );
  }

  const runOnText = t("models.runOn.dictation", {
    device: t(DEVICE_KEYS[getSetting("transcribe_accelerator") ?? "auto"]),
  });
  const infoById = new Map(sources.models.map((info) => [info.id, info]));
  const modelOf = (e: Entry): ManagerModel =>
    dictationModel(e, infoById.get(e.id), {
      place: placeOf(e.id, { ...sources, switching }),
      percent: sources.downloadProgress[e.id]?.percentage ?? 0,
      tier: facts.tier,
      runOnText,
      t,
    });
  const shown = {
    yours: lists.yours.map(modelOf),
    fits: lists.fits.map(modelOf),
    partial: lists.partial.map(modelOf),
    untested: lists.untested.map(modelOf),
  };
  const entryById = new Map(
    [...lists.yours, ...lists.fits, ...lists.partial, ...lists.untested].map(
      (e) => [e.id, e],
    ),
  );

  const chips: Chip[] = CHIP_TAGS.map((tag) => ({
    key: tag,
    label: t(`models.tags.${tag}`),
    test: (m: ManagerModel) => m.tags.includes(tag),
  }));
  const toggleChip = (key: string) =>
    setPressed((on) => {
      const next = new Set(on);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const searched = query.trim() !== "";
  const searching = searched || pressed.size > 0;
  const keep = (models: ManagerModel[]) =>
    applyChips(models, pressed, chips).filter((m) =>
      matchesQuery(m, query, { t, language: i18n.language, languageName }),
    );

  const moreButton = !searching && shown.yours.length > YOURS_LIMIT && (
    <button
      type="button"
      onClick={() => setMore((m) => !m)}
      className="ms-[40px] mt-[2px] flex h-[28px] cursor-pointer items-center gap-[8px] rounded-[7px] px-[2px] text-small font-medium text-ink-2 hover:text-text focus:outline-none focus-visible:ring-1 focus-visible:ring-logo-primary"
    >
      {more
        ? t("settings.models.showFewer")
        : t("settings.models.showMore", {
            count: shown.yours.length - YOURS_LIMIT,
          })}
      <span
        aria-hidden="true"
        className={`inline-block size-[6px] shrink-0 border-e-[1.5px] border-b-[1.5px] border-current ${more ? "mt-[3px] -rotate-[135deg]" : "-mt-[3px] rotate-45"}`}
      />
    </button>
  );

  const sections: ManagerSection[] = searching
    ? [
        {
          key: "yours",
          label: t("settings.models.sections.yours"),
          rows: keep(shown.yours),
        },
        {
          key: "fits",
          label: t("settings.models.sections.fits"),
          rows: keep(shown.fits),
        },
        {
          key: "partial",
          label: t("modelTable.missingLanguage"),
          rows: keep(shown.partial),
        },
        {
          key: "untested",
          label: t("settings.models.sections.untested"),
          rows: searched ? keep(shown.untested) : [],
          after: <Note>{t("settings.models.untestedNote")}</Note>,
        },
      ]
    : [
        {
          key: "yours",
          label: (
            <>
              {t("settings.models.sections.yours")}
              <Rescan />
            </>
          ),
          rows: more ? shown.yours : shown.yours.slice(0, YOURS_LIMIT),
          after: shown.yours.length ? (
            moreButton
          ) : (
            <Note>{t("settings.models.emptyYours")}</Note>
          ),
        },
        {
          key: "fits",
          label: t("settings.models.sections.fits"),
          rows: shown.fits,
        },
        {
          key: "partial",
          label: t("modelTable.missingLanguage"),
          rows: shown.partial,
        },
      ];
  // "Yours" always shows at rest; a search hides empty sections.
  const listed = sections.filter(
    (s) => s.rows.length || (s.key === "yours" && !searching),
  );
  const lastIndex = listed.length - 1;
  if (lastIndex >= 0 && !searching && shown.untested.length > 0) {
    const last = listed[lastIndex];
    listed[lastIndex] = {
      ...last,
      after: (
        <>
          {last.after}
          <Note>
            {t("settings.models.untestedHidden", {
              count: shown.untested.length,
            })}
          </Note>
        </>
      ),
    };
  }

  const ask = (m: ManagerModel) => {
    const selected = useModelStore.getState().currentModel === m.id;
    asked.current = {
      id: m.id,
      selected,
      message: deleteMessage(
        t,
        {
          name: m.name,
          size: m.sizeBytes === null ? null : formatBytes(m.sizeBytes),
          selected,
          role: "dictation",
        },
        i18n.language,
      ),
    };
    question.ask(m.id);
  };

  return (
    <div className="w-full max-w-3xl min-w-0">
      <div className="mx-[12px] mb-[16px] empty:hidden">
        <RetiredModelsNotice />
      </div>
      <div ref={question.rowsRef}>
        <ManagerTable
          role="dictation"
          sections={listed}
          query={query}
          setQuery={setQuery}
          chips={chips}
          pressed={pressed}
          toggleChip={toggleChip}
          heads={<Codes langs={facts.langs} />}
          legend={<Legend tier={facts.tier} />}
          aside={
            onChangeLanguages && (
              <button
                type="button"
                onClick={onChangeLanguages}
                className="shrink-0 cursor-pointer text-sm text-text underline decoration-line-strong underline-offset-[3px] hover:decoration-text focus:outline-none focus-visible:ring-1 focus-visible:ring-logo-primary"
              >
                {t("settings.models.changeLanguages")}
              </button>
            )
          }
          openId={openId}
          onOpenChange={setOpenId}
          renderRow={(m, open, toggle) => {
            const entry = entryById.get(m.id);
            return (
              entry && (
                <ModelRow
                  model={m}
                  entry={entry}
                  grading={facts}
                  open={open}
                  toggle={toggle}
                  asking={
                    question.asking === m.id && asked.current
                      ? asked.current.message
                      : null
                  }
                  ask={() => ask(m)}
                  cancel={question.cancel}
                  confirm={question.confirm}
                />
              )
            );
          }}
        />
      </div>
    </div>
  );
};
