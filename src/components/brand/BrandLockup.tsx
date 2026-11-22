import React from "react";
import { appName } from "@/lib/brand";
import wordmark from "../../../brand/generated/wordmark-latin.json";
import { BrandMark } from "./BrandMark";

/** The word's cap height is this fraction of the mark. */
const CAP_RATIO = 0.537;

export interface BrandLockupProps {
  size: number;
}

/** The mark and the outlined Anek wordmark, cap-centred on the mark. */
export const BrandLockup: React.FC<BrandLockupProps> = ({ size }) => {
  const [, minY, vbWidth, vbHeight] = wordmark.viewBox.split(" ").map(Number);
  const scale = (size * CAP_RATIO) / wordmark.cap;
  // The viewBox spans more than the cap (ascenders, descenders, padding), so
  // lift the box until the cap's centre meets the mark's centre.
  const lift = (minY + vbHeight / 2 + wordmark.cap / 2) * scale;
  return (
    <span
      role="img"
      aria-label={appName}
      className="inline-flex items-center"
      style={{ gap: `${size / 4}px` }}
    >
      <span aria-hidden="true" className="inline-flex">
        <BrandMark size={size} />
      </span>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox={wordmark.viewBox}
        width={(vbWidth * scale).toFixed(2)}
        height={(vbHeight * scale).toFixed(2)}
        aria-hidden="true"
        className="text-wordmark"
        style={{ transform: `translateY(${lift.toFixed(2)}px)` }}
      >
        <g fill="currentColor">
          {wordmark.paths.map((d) => (
            <path key={d} d={d} />
          ))}
        </g>
      </svg>
    </span>
  );
};
