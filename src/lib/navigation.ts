export const NAV = {
  dictation: ["history", "settings", "cleanup"],
  readAloud: ["history", "settings", "vocabulary"],
  models: ["dictation", "readAloud"],
  settings: ["general", "advanced", "about", "debug"],
} as const;

export type Destination = keyof typeof NAV;
export type TabOf<D extends Destination> = (typeof NAV)[D][number];
export type Location = {
  [D in Destination]: { destination: D; tab: TabOf<D> };
}[Destination];

/** Sidebar order. */
export const DESTINATIONS: readonly Destination[] = [
  "dictation",
  "readAloud",
  "models",
  "settings",
];

export const FIRST_LOCATION: Location = {
  destination: "dictation",
  tab: "history",
};

/** A settings group a link can scroll into view; never persisted. */
export type GroupId = "languages" | "dictationHistory" | "readAloudHistory";

export type Link = Location & { group?: GroupId };

/** The element id a page gives a group a link can reveal. */
export function groupAnchor(group: GroupId): string {
  return `group-${group}`;
}

/** Cross-link targets used by pages. */
export const LINKS = {
  dictationHistory: { destination: "dictation", tab: "history" },
  cleanup: { destination: "dictation", tab: "cleanup" },
  readAloudModels: { destination: "models", tab: "readAloud" },
  dictationModels: { destination: "models", tab: "dictation" },
  languages: { destination: "dictation", tab: "settings", group: "languages" },
  dictationRetention: {
    destination: "dictation",
    tab: "settings",
    group: "dictationHistory",
  },
  readAloudRetention: {
    destination: "readAloud",
    tab: "settings",
    group: "readAloudHistory",
  },
} as const satisfies Record<string, Link>;

export function visibleTabs<D extends Destination>(
  destination: D,
  debug: boolean,
): readonly TabOf<D>[] {
  const tabs: readonly string[] = NAV[destination];
  return tabs.filter((tab) => debug || tab !== "debug") as TabOf<D>[];
}

export function firstTab(destination: Destination, debug: boolean): Location {
  return {
    destination,
    tab: visibleTabs(destination, debug)[0],
  } as Location;
}

export function normalizeLocation(raw: unknown, debug: boolean): Location {
  if (typeof raw !== "object" || raw === null) return FIRST_LOCATION;
  const { destination, tab } = raw as { destination?: unknown; tab?: unknown };
  if (
    typeof destination !== "string" ||
    !Object.prototype.hasOwnProperty.call(NAV, destination)
  ) {
    return FIRST_LOCATION;
  }
  const known = destination as Destination;
  const tabs: readonly unknown[] = visibleTabs(known, debug);
  if (!tabs.includes(tab)) return firstTab(known, debug);
  return { destination: known, tab } as Location;
}

export const LOCATION_KEY = "handy.navigation";

export function defaultStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** Debug is kept here; the shell drops it once it knows the debug flag is off. */
export function loadLocation(
  storage: Pick<Storage, "getItem"> | undefined,
): Location {
  try {
    if (!storage) return FIRST_LOCATION;
    const parsed: unknown = JSON.parse(storage.getItem(LOCATION_KEY) ?? "null");
    return normalizeLocation(parsed, true);
  } catch {
    return FIRST_LOCATION;
  }
}

export function createNavigator(deps: {
  storage: Pick<Storage, "setItem"> | undefined;
  set: (location: Location) => void;
  reveal: (group: GroupId | null) => void;
}): { navigate(to: Link): void } {
  return {
    navigate(to) {
      const location = { destination: to.destination, tab: to.tab } as Location;
      deps.set(location);
      deps.reveal(to.group ?? null);
      try {
        deps.storage?.setItem(LOCATION_KEY, JSON.stringify(location));
      } catch {
        // Storage is best-effort UI state; the session still navigates.
      }
    },
  };
}

/** Scrolls a link's group into view, or the page to its top when there is none. */
export function revealGroup(
  group: GroupId | null,
  deps: {
    find: (
      anchorId: string,
    ) => { scrollIntoView(options?: ScrollIntoViewOptions): void } | null;
    top: () => void;
  },
): void {
  const found = group === null ? null : deps.find(groupAnchor(group));
  if (found) found.scrollIntoView({ block: "start" });
  else deps.top();
}

export function rovingTarget(
  count: number,
  current: number,
  key: string,
  axis: "horizontal" | "vertical",
  rtl: boolean,
): number | null {
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  const next =
    axis === "vertical" ? "ArrowDown" : rtl ? "ArrowLeft" : "ArrowRight";
  const previous =
    axis === "vertical" ? "ArrowUp" : rtl ? "ArrowRight" : "ArrowLeft";
  if (key === next) return (current + 1) % count;
  if (key === previous) return (current - 1 + count) % count;
  return null;
}

export function labelKey(id: Destination | string): string {
  return `nav.${id}`;
}
