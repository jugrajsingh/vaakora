import type { OverlayPosition } from "@/bindings";

export interface StagePlacement {
  edge: "top" | "bottom";
  column: "left" | "center" | "right";
}

const BOTTOM_CENTER: StagePlacement = { edge: "bottom", column: "center" };

const CELLS: Record<OverlayPosition, StagePlacement> = {
  top_left: { edge: "top", column: "left" },
  top: { edge: "top", column: "center" },
  top_right: { edge: "top", column: "right" },
  center_left: { edge: "bottom", column: "left" },
  center: BOTTOM_CENTER,
  center_right: { edge: "bottom", column: "right" },
  bottom_left: { edge: "bottom", column: "left" },
  bottom: BOTTOM_CENTER,
  bottom_right: { edge: "bottom", column: "right" },
};

// Only the top row flows from the window's top edge; the centre and bottom rows
// keep the bottom flow. A legacy "none" or any unknown value is bottom centre.
export function stagePlacement(
  position: OverlayPosition | string | null | undefined,
): StagePlacement {
  const known = Object.keys(CELLS).includes(position ?? "");
  return { ...(known ? CELLS[position as OverlayPosition] : BOTTOM_CENTER) };
}

export function listeningStatusKey(
  captureReady: boolean,
): "overlay.starting" | "overlay.recording" {
  return captureReady ? "overlay.recording" : "overlay.starting";
}
