import React from "react";
import { useTranslation } from "react-i18next";
import { labelKey, rovingTarget } from "@/lib/navigation";

export const PANEL_ID = "nav-panel";

export function tabId(tab: string): string {
  return `nav-tab-${tab}`;
}

export interface TabStripProps<T extends string> {
  label: string;
  tabs: readonly T[];
  active: T;
  select: (tab: T) => void;
  rtl: boolean;
}

export function stripKey<T extends string>(
  key: string,
  tabs: readonly T[],
  active: T,
  rtl: boolean,
  deps: { select: (tab: T) => void; focus: (index: number) => void },
): boolean {
  const target = rovingTarget(
    tabs.length,
    tabs.indexOf(active),
    key,
    "horizontal",
    rtl,
  );
  if (target === null) return false;
  deps.select(tabs[target]);
  deps.focus(target);
  return true;
}

export function TabStrip<T extends string>({
  label,
  tabs,
  active,
  select,
  rtl,
}: TabStripProps<T>): React.JSX.Element {
  const { t } = useTranslation();
  const focus = (index: number) =>
    document.getElementById(tabId(tabs[index]))?.focus();
  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex h-10 items-stretch gap-1"
    >
      {tabs.map((tab) => (
        <button
          key={tab}
          type="button"
          role="tab"
          id={tabId(tab)}
          aria-selected={tab === active}
          aria-controls={PANEL_ID}
          tabIndex={tab === active ? 0 : -1}
          className={`px-3 text-sm border-b-2 -mb-px cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-logo-primary ${
            tab === active
              ? "border-logo-primary text-text font-semibold"
              : "border-transparent text-ink-2 hover:text-text"
          }`}
          onClick={() => select(tab)}
          onKeyDown={(event) => {
            if (stripKey(event.key, tabs, active, rtl, { select, focus })) {
              event.preventDefault();
            }
          }}
        >
          {t(labelKey(tab))}
        </button>
      ))}
    </div>
  );
}
