/** Models, Dictation row rules: what the mark does, when a model can be deleted, and the delete question. */
import type { TFunction } from "i18next";
import type { ModelRole } from "@/components/shared/modelTable/roles";
import type { Place } from "./modelEntries";

export interface DictationRow {
  mark: "select" | "selected" | "download" | "cancel" | "loading";
  deletable: boolean;
  /** Ready but locked by a file transcription: the mark says why it does nothing. */
  inert: boolean;
}

const MARKS: Record<Place, DictationRow["mark"]> = {
  active: "selected",
  loading: "loading",
  ready: "select",
  downloading: "cancel",
  checking: "cancel",
  remote: "download",
};

/** The row's mark and delete for a place; while a file transcribes, the model in use cannot be deleted. */
export function dictationRow(
  place: Place,
  ctx: { locked: boolean },
): DictationRow {
  const onDisk = place === "active" || place === "ready" || place === "loading";
  return {
    mark: MARKS[place],
    deletable: onDisk && !(ctx.locked && place === "active"),
    inert: ctx.locked && place === "ready",
  };
}

/** What pressing the mark does: select or download picks it, cancel stops its download, the rest do nothing. */
export function markPress(
  mark: DictationRow["mark"],
  id: string,
  deps: { pick: (id: string) => void; cancel: (id: string) => void },
): (() => void) | null {
  switch (mark) {
    case "select":
    case "download":
      return () => deps.pick(id);
    case "cancel":
      return () => deps.cancel(id);
    case "selected":
    case "loading":
      return null;
  }
}

/** The delete question: what goes and what it frees, the consequence when it is the selected model, and what is kept. */
export function deleteMessage(
  t: TFunction,
  m: { name: string; size: string | null; selected: boolean; role: ModelRole },
): string {
  return [
    m.size === null
      ? t("models.delete.askUnknownSize", { name: m.name })
      : t("models.delete.ask", { name: m.name, size: m.size }),
    ...(m.selected ? [t(`models.delete.selected.${m.role}`)] : []),
    t(`models.delete.kept.${m.role}`),
  ].join(" ");
}

/** A delete question as asked: the model, and whether it was the selected one. */
export interface DeleteAsk {
  id: string;
  selected: boolean;
}

/** The question stays only while its model is deletable and its selected flag is as asked; Confirm checks again. */
export function deleteChecks(deps: {
  asked: () => DeleteAsk | null;
  now: (id: string) => { place: Place; selected: boolean; locked: boolean };
  remove: (id: string) => void;
}): { present: (id: string) => boolean; apply: (id: string) => void } {
  const present = (id: string) => {
    const asked = deps.asked();
    if (asked === null || asked.id !== id) return false;
    const now = deps.now(id);
    return (
      dictationRow(now.place, { locked: now.locked }).deletable &&
      now.selected === asked.selected
    );
  };
  return {
    present,
    apply: (id) => {
      if (present(id)) deps.remove(id);
    },
  };
}
