import React from "react";
import tray16 from "../../../brand/tray/tray-16.svg?raw";

export type TrayGlyphState = "idle" | "recording" | "transcribing";

/** The master's viewBox and contents: the bars group, then the cursor group,
 * both `fill="currentColor"`. */
const viewBox = /viewBox="([^"]+)"/.exec(tray16)?.[1] ?? "";
const body = tray16.replace(/^<svg\b[^>]*>/, "").replace(/<\/svg>\s*$/, "");
const cursorAt = body.lastIndexOf('fill="currentColor"');
/** While recording the cursor takes the brand colour, as the tray rasters
 * tint it; the bars keep the bar's text colour. */
const recordingBody =
  body.slice(0, cursorAt) +
  'style="fill:var(--color-logo-primary)"' +
  body.slice(cursorAt + 'fill="currentColor"'.length);

/** The tray's Voice cursor silhouette (brand/tray/tray-16.svg), drawn in the
 * onboarding desktop bar and panels. One silhouette for every state. */
export const TrayGlyph: React.FC<{ state: TrayGlyphState; size: number }> = ({
  state,
  size,
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox={viewBox}
    width={size}
    height={size}
    aria-hidden="true"
    dangerouslySetInnerHTML={{
      __html: state === "recording" ? recordingBody : body,
    }}
  />
);
