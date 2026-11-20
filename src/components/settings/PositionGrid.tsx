import React from "react";
import type { OverlayPosition } from "@/bindings";

export const CELLS: readonly OverlayPosition[] = [
  "top_left",
  "top",
  "top_right",
  "center_left",
  "center",
  "center_right",
  "bottom_left",
  "bottom",
  "bottom_right",
];

const COLUMNS = 3;

/** The cell one step in the arrow's screen direction, or null for any other key. */
export function moveCell(
  cell: OverlayPosition,
  key: string,
): OverlayPosition | null {
  const index = CELLS.indexOf(cell);
  const row = Math.floor(index / COLUMNS);
  const column = index % COLUMNS;
  switch (key) {
    case "ArrowLeft":
      return CELLS[row * COLUMNS + Math.max(column - 1, 0)];
    case "ArrowRight":
      return CELLS[row * COLUMNS + Math.min(column + 1, COLUMNS - 1)];
    case "ArrowUp":
      return CELLS[Math.max(row - 1, 0) * COLUMNS + column];
    case "ArrowDown":
      return CELLS[Math.min(row + 1, COLUMNS - 1) * COLUMNS + column];
    default:
      return null;
  }
}

/** Handles one key on a cell; true when it was an arrow (the caller stops the default). */
export function handleCellKey({
  cell,
  key,
  onChange,
  focus,
}: {
  cell: OverlayPosition;
  key: string;
  onChange: (cell: OverlayPosition) => void;
  focus: (cell: OverlayPosition) => void;
}): boolean {
  const next = moveCell(cell, key);
  if (next === null) return false;
  if (next !== cell) onChange(next);
  focus(next);
  return true;
}

interface PositionGridProps {
  value: OverlayPosition;
  onChange: (cell: OverlayPosition) => void;
  label: string;
  cellLabel: (cell: OverlayPosition) => string;
}

export function PositionGrid({
  value,
  onChange,
  label,
  cellLabel,
}: PositionGridProps): React.JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      dir="ltr"
      data-position-grid
      className="grid grid-cols-3 gap-1"
    >
      {CELLS.map((cell) => {
        const checked = cell === value;
        const name = cellLabel(cell);
        return (
          <button
            key={cell}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={name}
            title={name}
            data-cell={cell}
            tabIndex={checked ? 0 : -1}
            onClick={() => {
              if (!checked) onChange(cell);
            }}
            onKeyDown={(event) => {
              const group = event.currentTarget.parentElement;
              const arrow = handleCellKey({
                cell,
                key: event.key,
                onChange,
                focus: (next) =>
                  group
                    ?.querySelector<HTMLElement>(`[data-cell="${next}"]`)
                    ?.focus(),
              });
              if (arrow) event.preventDefault();
            }}
            className={`h-4 w-6 cursor-pointer rounded-sm border focus:outline-none focus-visible:ring-2 focus-visible:ring-logo-primary ${
              checked
                ? "border-logo-primary bg-logo-primary"
                : "border-line-strong bg-wash hover:border-logo-primary"
            }`}
          />
        );
      })}
    </div>
  );
}
