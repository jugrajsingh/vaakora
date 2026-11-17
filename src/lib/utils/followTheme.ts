import { listen } from "@tauri-apps/api/event";
import type { Theme } from "@/bindings";
import { applyTheme, getStoredTheme, syncThemeFromSettings } from "./theme";

interface FollowThemeDeps {
  apply: (theme: Theme) => void;
  stored: () => Theme;
  sync: () => void;
  listen: (
    event: "theme-changed",
    cb: (event: { payload: Theme }) => void,
  ) => void;
}

const defaults: FollowThemeDeps = {
  apply: applyTheme,
  stored: getStoredTheme,
  sync: () => void syncThemeFromSettings(),
  listen: (event, cb) => void listen<Theme>(event, cb),
};

/** Mirror the app theme in a separate webview: stored theme before render, the persisted setting next, then live changes. */
export function followTheme(deps: FollowThemeDeps = defaults): void {
  deps.apply(deps.stored());
  deps.sync();
  deps.listen("theme-changed", (event) => deps.apply(event.payload));
}
