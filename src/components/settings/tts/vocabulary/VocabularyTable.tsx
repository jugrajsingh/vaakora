import { useTranslation } from "react-i18next";
import type { TtsModelInfo } from "@/bindings";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import type { RowGroup } from "./groups";
import {
  isCaseSensitive,
  kindLabel,
  matchLabel,
  modelName,
  originLabel,
  problemLabel,
} from "./labels";
import { VoiceChips } from "./VoiceChips";

export interface VocabularyTableProps {
  groups: readonly RowGroup[];
  models: readonly TtsModelInfo[];
  /** The file has an error: every change is off, Listen still works. */
  readOnly: boolean;
  toggle: (group: RowGroup) => void;
  /** Opens the entry dialog, which holds Applies to, Delete and Reset to default. */
  edit: (group: RowGroup) => void;
  listen: (group: RowGroup) => void;
}

export function VocabularyTable({
  groups,
  models,
  readOnly,
  toggle,
  edit,
  listen,
}: VocabularyTableProps) {
  const { t } = useTranslation();
  const words = (spoken: string, skip: boolean) =>
    skip ? t("tts.vocabulary.skipped") : spoken;
  return (
    <ul className="bg-background border border-line rounded-lg">
      {groups.map((group) => {
        const owner = group.origin === "owner";
        const partial = group.overriding.length < group.members.length;
        return (
          <li
            key={group.key}
            className="space-y-1 border-t border-line px-3 py-2 first:border-t-0"
          >
            <div className="flex items-center gap-2 text-sm">
              <Switch
                checked={group.enabled}
                disabled={readOnly}
                ariaLabel={t("tts.vocabulary.toggle", {
                  written: group.written,
                })}
                onChange={() => toggle(group)}
              />
              <span className="min-w-0 font-mono break-all">
                {group.written}
              </span>
              <span aria-hidden="true" className="text-ink-3">
                →
              </span>
              <span className="min-w-0 break-words">
                {words(group.spoken, group.skip)}
              </span>
              <span
                className={`text-xs ${owner ? "text-logo-primary" : "text-ink-2"}`}
              >
                {originLabel(t, group.origin)}
              </span>
              <div className="ms-auto flex shrink-0 gap-1">
                <Button size="sm" variant="ghost" onClick={() => listen(group)}>
                  {t("tts.vocabulary.buttons.listen")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={readOnly}
                  onClick={() => edit(group)}
                >
                  {t("tts.vocabulary.buttons.edit")}
                </Button>
              </div>
            </div>
            {group.defaults.map((fallback) => (
              <p
                key={`${fallback.spoken}|${fallback.skip}`}
                className="text-xs text-ink-3"
              >
                {partial || group.defaults.length > 1
                  ? t("tts.vocabulary.defaultLabelFor", {
                      voices: fallback.models
                        .map((model) =>
                          model === null
                            ? t("tts.vocabulary.models.all")
                            : modelName(models, model),
                        )
                        .join(", "),
                    })
                  : t("tts.vocabulary.defaultLabel")}{" "}
                <s>{words(fallback.spoken, fallback.skip)}</s>
              </p>
            ))}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
              <span>
                {[
                  kindLabel(t, group.section),
                  matchLabel(t, group.matching),
                  ...(isCaseSensitive(group.matching)
                    ? [t("tts.vocabulary.match.caseSensitive")]
                    : []),
                ].join(" · ")}
              </span>
              <VoiceChips group={group} models={models} />
            </div>
            {group.problems.length > 0 && (
              <div className="text-xs text-warning">
                {group.problems.map((problem) => (
                  <p key={problemLabel(t, problem)}>
                    {problemLabel(t, problem)}
                  </p>
                ))}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
