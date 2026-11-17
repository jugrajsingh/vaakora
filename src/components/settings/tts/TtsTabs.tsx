import { useTranslation } from "react-i18next";
import type { TtsTab } from "./tabs";

export function TtsTabs({
  tabs,
  active,
  select,
}: {
  tabs: readonly TtsTab[];
  active: TtsTab;
  select: (tab: TtsTab) => void;
}) {
  const { t } = useTranslation();
  return (
    <div role="tablist" className="flex gap-1 border-b border-line">
      {tabs.map((tab) => (
        <button
          key={tab}
          type="button"
          role="tab"
          aria-selected={tab === active}
          onClick={() => select(tab)}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors cursor-pointer ${
            tab === active
              ? "border-logo-primary text-text"
              : "border-transparent text-ink-3 hover:text-text"
          }`}
        >
          {t(`tts.tabs.${tab}`)}
        </button>
      ))}
    </div>
  );
}
