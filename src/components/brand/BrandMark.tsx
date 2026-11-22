import React from "react";
import { appName, brand } from "@/lib/brand";
import dark16 from "../../../brand/mark/vaakora-16-dark.svg?raw";
import dark22 from "../../../brand/mark/vaakora-22-dark.svg?raw";
import dark24 from "../../../brand/mark/vaakora-24-dark.svg?raw";
import darkLarge from "../../../brand/mark/vaakora-large-dark.svg?raw";

/** The master a pixel size draws from: 16 and 32 use the 16 px one (32 is 2x),
 * 22 and 24 have fitted ones, 48 and up the large one, anything else the 16. */
function masterFor(size: number): string {
  if (size <= 16 || size === 32) return dark16;
  if (size === 22) return dark22;
  if (size === 24) return dark24;
  return size < 48 ? dark16 : darkLarge;
}

/**
 * One master as an inline svg. The masters carry the keyline for dark grounds;
 * its stroke becomes a token that is transparent in light themes, so one
 * markup serves both. The other colours are the master's own (brand.mark).
 */
function inner(master: string): { viewBox: string; body: string } {
  const viewBox = /viewBox="([^"]+)"/.exec(master)?.[1] ?? "";
  const body = master
    .replace(/^<svg\b[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "")
    .replace(
      `stroke="${brand.mark.keyline}"`,
      'style="stroke:var(--color-mark-keyline,transparent)"',
    );
  return { viewBox, body };
}

export interface BrandMarkProps {
  size: number;
  className?: string;
}

/** The Voice cursor mark at `size` px. */
export const BrandMark: React.FC<BrandMarkProps> = ({ size, className }) => {
  const { viewBox, body } = inner(masterFor(size));
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={viewBox}
      width={size}
      height={size}
      role="img"
      aria-label={appName}
      className={className}
      dangerouslySetInnerHTML={{ __html: body }}
    />
  );
};
