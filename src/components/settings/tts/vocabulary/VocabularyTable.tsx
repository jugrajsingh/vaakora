import { useTranslation } from "react-i18next";
import type { TtsModelInfo } from "@/bindings";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import {
  InlineConfirm,
  useFocusReturn,
} from "@/components/shared/InlineConfirm";
import type { RowGroup, VoiceOption } from "./groups";
import {
  isCaseSensitive,
  kindLabel,
  matchLabel,
  modelName,
  originLabel,
  problemLabel,
} from "./labels";
import { VoiceChips } from "./VoiceChips";

const COLUMNS = ["written", "spoken", "kind", "voices", "match"] as const;

export interface VocabularyTableProps {
  groups: readonly RowGroup[];
  models: readonly TtsModelInfo[];
  /** The file has an error: every change is off, Listen still works. */
  readOnly: boolean;
  /** An editor or correction is open: Edit is off so its typed changes are not replaced. */
  editLocked: boolean;
  voiceOptions: (group: RowGroup) => VoiceOption[];
  /** Adds or removes a voice (`null` is all voices) from a row. */
  changeVoice: (group: RowGroup, voice: string | null) => void;
  toggle: (group: RowGroup) => void;
  edit: (group: RowGroup) => void;
  listen: (group: RowGroup) => void;
  remove: (group: RowGroup) => void;
  /** Asks; only `confirmReset` resets. */
  reset: (group: RowGroup) => void;
  /** The key of the row whose Reset to default was pressed; the question shows below it. */
  resetting: string | null;
  confirmReset: () => void;
  cancelReset: () => void;
}

export function VocabularyTable({
  groups,
  models,
  readOnly,
  editLocked,
  voiceOptions,
  changeVoice,
  toggle,
  edit,
  listen,
  remove,
  reset,
  resetting,
  confirmReset,
  cancelReset,
}: VocabularyTableProps) {
  const { t } = useTranslation();
  const tableRef = useFocusReturn<HTMLDivElement>(resetting);
  return (
    <div
      ref={tableRef}
      className="bg-background border border-line rounded-lg overflow-x-auto"
    >
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-ink-3 uppercase tracking-wide">
            {COLUMNS.map((column) => (
              <th key={column} scope="col" className="px-3 py-2 text-start">
                {t(`tts.vocabulary.columns.${column}`)}
              </th>
            ))}
            <th scope="col" className="px-3 py-2 text-start">
              {t("tts.vocabulary.columns.enabled")}
            </th>
            <th scope="col" className="px-3 py-2">
              <span className="sr-only">
                {t("tts.vocabulary.columns.actions")}
              </span>
            </th>
          </tr>
        </thead>
        {groups.map((group) => {
          const owner = group.origin === "owner";
          const partial = group.overriding.length < group.members.length;
          const words = (spoken: string, skip: boolean) =>
            skip ? t("tts.vocabulary.skipped") : spoken;
          return (
            <tbody
              key={group.key}
              data-confirm-row={group.key}
              className="border-t border-line"
            >
              <tr className="align-top">
                <td className="px-3 py-2 font-mono break-all">
                  {group.written}
                </td>
                <td className="px-3 py-2">
                  {words(group.spoken, group.skip)}
                  {owner && (
                    <span className="block text-xs text-logo-primary">
                      {originLabel(t, "owner")}
                    </span>
                  )}
                  {group.defaults.map((fallback) => (
                    <span
                      key={`${fallback.spoken}|${fallback.skip}`}
                      className="block text-xs text-ink-3"
                    >
                      {partial || group.defaults.length > 1
                        ? t("tts.vocabulary.defaultLabelFor", {
                            voices: fallback.models
                              .map((model) =>
                                model === null
                                  ? t("tts.vocabulary.voices.all")
                                  : modelName(models, model),
                              )
                              .join(", "),
                          })
                        : t("tts.vocabulary.defaultLabel")}{" "}
                      <s>{words(fallback.spoken, fallback.skip)}</s>
                    </span>
                  ))}
                </td>
                <td className="px-3 py-2">{kindLabel(t, group.section)}</td>
                <td className="px-3 py-2">
                  <VoiceChips
                    group={group}
                    models={models}
                    options={voiceOptions(group)}
                    readOnly={readOnly}
                    change={(voice) => changeVoice(group, voice)}
                  />
                </td>
                <td className="px-3 py-2">
                  {matchLabel(t, group.matching)}
                  {isCaseSensitive(group.matching) && (
                    <span className="block text-xs text-ink-3">
                      {t("tts.vocabulary.match.caseSensitive")}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <Switch
                    checked={group.enabled}
                    disabled={readOnly}
                    ariaLabel={t("tts.vocabulary.toggle", {
                      written: group.written,
                    })}
                    onChange={() => toggle(group)}
                  />
                </td>
                <td className="px-3 py-2">
                  <div className="flex justify-end gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={readOnly || editLocked}
                      onClick={() => edit(group)}
                    >
                      {t("tts.vocabulary.buttons.edit")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => listen(group)}
                    >
                      {t("tts.vocabulary.buttons.listen")}
                    </Button>
                    {group.overriding.length > 0 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={readOnly}
                        onClick={() => reset(group)}
                      >
                        {t("tts.vocabulary.buttons.reset")}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="danger-ghost"
                      disabled={readOnly || !owner}
                      onClick={() => remove(group)}
                    >
                      {t("tts.vocabulary.buttons.delete")}
                    </Button>
                  </div>
                </td>
              </tr>
              {resetting === group.key && (
                <tr>
                  <td colSpan={COLUMNS.length + 2} className="px-3 pb-2">
                    <InlineConfirm
                      message={t("tts.vocabulary.resetConfirm", {
                        written: group.written,
                      })}
                      action={t("tts.vocabulary.buttons.reset")}
                      onCancel={cancelReset}
                      onConfirm={confirmReset}
                    />
                  </td>
                </tr>
              )}
              {group.problems.length > 0 && (
                <tr>
                  <td
                    colSpan={COLUMNS.length + 2}
                    className="px-3 pb-2 text-xs text-warning"
                  >
                    {group.problems.map((problem) => (
                      <p key={problemLabel(t, problem)}>
                        {problemLabel(t, problem)}
                      </p>
                    ))}
                  </td>
                </tr>
              )}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}
