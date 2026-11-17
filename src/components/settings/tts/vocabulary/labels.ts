import type { TFunction } from "i18next";
import type {
  Matching,
  Origin,
  Problem,
  Section,
  TermMatch,
  TtsModelInfo,
  Unreachable,
} from "@/bindings";

const UNREACHABLE: Record<Unreachable, string> = {
  contains_space: "containsSpace",
  ends_with_punctuation: "endsWithPunctuation",
  not_one_character: "notOneCharacter",
  extension_not_alphanumeric: "extensionNotAlphanumeric",
  never_matches: "neverMatches",
};

export const kindLabel = (t: TFunction, section: Section) =>
  t(`tts.vocabulary.kinds.${section}`);

export const originLabel = (t: TFunction, origin: Origin) =>
  t(`tts.vocabulary.origins.${origin}`);

export const termMatchLabel = (t: TFunction, matching: TermMatch) =>
  t(`tts.vocabulary.match.${matching}`);

/** The voice model's display name, or its raw id when the catalog has no such model. */
export const modelName = (models: readonly TtsModelInfo[], id: string) =>
  models.find((model) => model.id === id)?.display_name ?? id;

export const matchLabel = (t: TFunction, matching: Matching) =>
  typeof matching === "string"
    ? t(`tts.vocabulary.match.${matching}`)
    : termMatchLabel(t, matching.term.matching);

export const isCaseSensitive = (matching: Matching) =>
  typeof matching !== "string" && matching.term.case;

export function problemLabel(t: TFunction, problem: Problem) {
  if (problem === "disabled") return t("tts.vocabulary.problems.disabled");
  if ("shadowed" in problem) return t("tts.vocabulary.problems.shadowed");
  return t("tts.vocabulary.problems.unreachable", {
    reason: t(
      `tts.vocabulary.unreachable.${UNREACHABLE[problem.unreachable.reason]}`,
    ),
  });
}
