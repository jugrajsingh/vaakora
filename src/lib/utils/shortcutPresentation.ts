import type { TFunction } from "i18next";

export type ShortcutRow =
  | "transcribe"
  | "transcribe_with_post_process"
  | "activation"
  | "cancel"
  | "cancelHelp"
  | "read_aloud";

export function generalShortcutRows(
  cleanup: boolean,
  linux: boolean,
): ShortcutRow[] {
  const rows: ShortcutRow[] = ["transcribe"];
  if (cleanup) rows.push("transcribe_with_post_process");
  rows.push("activation");
  rows.push(linux ? "cancelHelp" : "cancel");
  rows.push("read_aloud");
  return rows;
}

const NAME_KEYS: Record<string, string> = {
  transcribe: "settings.shortcuts.dictate",
  transcribe_with_post_process: "settings.shortcuts.dictateWithCleanup",
  cancel: "settings.shortcuts.cancel",
  read_aloud: "settings.shortcuts.readAloud",
};

export function shortcutNameKey(id: string): string {
  return NAME_KEYS[id] ?? `settings.general.shortcut.bindings.${id}.name`;
}

export function canClearShortcut(id: string, enabled: boolean): boolean {
  if (id === "read_aloud") return true;
  return (
    enabled && (id === "transcribe" || id === "transcribe_with_post_process")
  );
}

export function clearButtonState({
  enabled,
  id,
  isRecording,
  isUpdating,
  disabled,
  bound,
}: {
  enabled: boolean;
  id: string;
  isRecording: boolean;
  isUpdating: boolean;
  disabled: boolean;
  bound: boolean;
}): { visible: boolean; disabled: boolean } {
  return {
    visible: canClearShortcut(id, enabled) && bound,
    disabled: disabled || isRecording || isUpdating,
  };
}

/** Clears a shortcut; `onCleared` runs only after it was cleared, `onError` only when it was refused. */
export async function clearShortcut({
  clear,
  onCleared,
  onError,
}: {
  clear: () => Promise<void>;
  onCleared: () => void;
  onError: (error: unknown) => void;
}): Promise<void> {
  try {
    await clear();
  } catch (error: unknown) {
    onError(error);
    return;
  }
  onCleared();
}

const IN_USE = /shortcut\.in_use:([A-Za-z0-9_-]+)/;
const CANNOT_CLEAR = /shortcut\.cannot_clear:([A-Za-z0-9_-]+)/;

function shortcutName(id: string, t: TFunction): string {
  return t(shortcutNameKey(id), { defaultValue: id });
}

/**
 * A shortcut refusal as a translated sentence. The backend ends its refusals in
 * `(shortcut.in_use:<id>)` or `(shortcut.cannot_clear:<id>)` (src-tauri/src/shortcut/policy.rs);
 * other text, with or without the "Error: " prefix of `String(error)`, passes through.
 */
export function shortcutErrorText(error: string, t: TFunction): string {
  const inUse = IN_USE.exec(error);
  if (inUse) {
    return t("settings.shortcuts.inUse", { name: shortcutName(inUse[1], t) });
  }
  const cannotClear = CANNOT_CLEAR.exec(error);
  if (cannotClear) {
    return t("settings.shortcuts.cannotClear", {
      name: shortcutName(cannotClear[1], t),
    });
  }
  return error;
}
