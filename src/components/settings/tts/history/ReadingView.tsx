import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { snapSelection, type Token, type TokenSelection } from "./alignment";
import {
  beginDrag,
  extendDrag,
  releaseDrag,
  shownSelection,
  type Drag,
} from "./selection";

/**
 * A stored read word under word: each written word with the words that were said for it, changed
 * words tinted. Dragging over words selects whole tokens; the selection is reported on release.
 */
export function ReadingView({
  tokens,
  selection,
  onSelect,
}: {
  tokens: readonly Token[];
  selection: TokenSelection | null;
  onSelect: (selection: TokenSelection) => void;
}) {
  const { t } = useTranslation();
  const [drag, setDrag] = useState<Drag | null>(null);
  useEffect(() => {
    if (!drag) return;
    const release = () => setDrag(releaseDrag(drag, onSelect));
    window.addEventListener("pointerup", release);
    return () => window.removeEventListener("pointerup", release);
  }, [drag, onSelect]);
  const shown = shownSelection(drag, selection);
  return (
    <div
      role="group"
      aria-label={t("tts.history.reading")}
      className="flex flex-wrap items-start gap-x-2 gap-y-3 select-none"
    >
      {tokens.map((token, index) => {
        const skipped = token.spoken === "";
        const selected =
          shown !== null && index >= shown.start && index <= shown.end;
        return (
          <span
            key={index}
            role="button"
            tabIndex={0}
            aria-pressed={selected}
            data-changed={token.changed}
            className={`inline-flex flex-col rounded px-1 cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-logo-primary ${
              selected ? "bg-logo-primary/20 ring-2 ring-logo-primary" : ""
            }`}
            onPointerDown={(event) => {
              event.preventDefault();
              setDrag(beginDrag(index));
            }}
            onPointerEnter={() =>
              setDrag((current) => extendDrag(current, index))
            }
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(snapSelection(index, index));
              }
            }}
          >
            <span
              className={`text-sm font-mono rounded px-0.5 ${
                token.changed ? "bg-warning-wash" : ""
              } ${skipped ? "line-through opacity-60" : ""}`}
            >
              {token.written}
            </span>
            <span className="text-xs text-moss px-0.5">
              {skipped ? t("tts.vocabulary.skipped") : token.spoken}
            </span>
          </span>
        );
      })}
    </div>
  );
}
