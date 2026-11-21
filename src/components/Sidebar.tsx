import React, { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Cog, Cpu, Mic, Volume2, type LucideIcon } from "lucide-react";
import HandyTextLogo from "./icons/HandyTextLogo";
import {
  DESTINATIONS,
  labelKey,
  rovingTarget,
  type Destination,
} from "@/lib/navigation";

const ICONS: Record<Destination, LucideIcon> = {
  dictation: Mic,
  readAloud: Volume2,
  models: Cpu,
  settings: Cog,
};

export interface SidebarProps {
  active: Destination;
  navigate: (destination: Destination) => void;
}

/** Moves focus between the destination buttons; Enter and Space stay with the button. */
export function sidebarKey(
  key: string,
  current: number,
  focus: (index: number) => void,
): boolean {
  const target = rovingTarget(
    DESTINATIONS.length,
    current,
    key,
    "vertical",
    false,
  );
  if (target === null) return false;
  focus(target);
  return true;
}

export const Sidebar: React.FC<SidebarProps> = ({ active, navigate }) => {
  const { t } = useTranslation();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  return (
    <nav className="flex w-[160px] shrink-0 flex-col border-e border-line px-2">
      <HandyTextLogo width={100} className="mx-auto my-4" />
      <div className="flex flex-col gap-1 border-t border-line pt-2">
        {DESTINATIONS.map((destination, index) => {
          const Icon = ICONS[destination];
          const isActive = active === destination;
          return (
            <button
              type="button"
              key={destination}
              ref={(element) => {
                buttons.current[index] = element;
              }}
              aria-current={isActive ? "page" : undefined}
              className={`flex min-h-9 w-full items-center gap-2 rounded-lg px-2 py-1 text-sm text-start cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-logo-primary ${
                isActive ? "bg-logo-primary/30 font-semibold" : "hover:bg-wash"
              }`}
              onClick={() => navigate(destination)}
              onKeyDown={(event) => {
                if (
                  sidebarKey(event.key, index, (target) =>
                    buttons.current[target]?.focus(),
                  )
                ) {
                  event.preventDefault();
                }
              }}
            >
              <Icon size={18} aria-hidden="true" className="shrink-0" />
              <span className="min-w-0 break-normal leading-tight">
                {t(labelKey(destination))}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
};
