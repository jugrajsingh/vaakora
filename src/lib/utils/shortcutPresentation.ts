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
}: {
  enabled: boolean;
  id: string;
  isRecording: boolean;
  isUpdating: boolean;
  disabled: boolean;
}): { visible: boolean; disabled: boolean } {
  return {
    visible: canClearShortcut(id, enabled),
    disabled: disabled || isRecording || isUpdating,
  };
}
