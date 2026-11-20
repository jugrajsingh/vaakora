import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { LLMPrompt } from "@/bindings";
import { EditorDialog } from "@/components/shared/EditorDialog";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";

/** Both fields hold text; a prompt is saved trimmed. */
export const promptReady = (name: string, text: string) =>
  name.trim() !== "" && text.trim() !== "";

/** Whether the typed values differ from the prompt (or from nothing, for a new one). */
export const promptDirty = (
  prompt: LLMPrompt | null,
  name: string,
  text: string,
) =>
  name.trim() !== (prompt?.name.trim() ?? "") ||
  text.trim() !== (prompt?.prompt.trim() ?? "");

/** Runs a save or delete; a closed dialog is not touched, an open one closes on success or fails. */
export async function settlePrompt(
  run: () => Promise<boolean>,
  on: { live: () => boolean; done: () => void; failed: () => void },
): Promise<void> {
  let ok = false;
  try {
    ok = await run();
  } catch (error) {
    console.error("Prompt change failed:", error);
  }
  if (!on.live()) return;
  if (ok) on.done();
  else on.failed();
}

export interface PromptDialogProps {
  prompt: LLMPrompt | null;
  canDelete: boolean;
  save: (name: string, text: string) => Promise<boolean>;
  /** Absent for a new prompt, which has nothing to delete. */
  remove?: () => Promise<boolean>;
  close: () => void;
}

/** A cleanup prompt on the editor dialog: new (`prompt` null) or edited, with an inline Delete. */
export function PromptDialog({
  prompt,
  canDelete,
  save,
  remove,
  close,
}: PromptDialogProps) {
  const { t } = useTranslation();
  const formId = useId();
  const nameField = useRef<HTMLElement | null>(null);
  const mounted = useRef(true);
  const [name, setName] = useState(prompt?.name ?? "");
  const [text, setText] = useState(prompt?.prompt ?? "");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = async (action: () => Promise<boolean>) => {
    setBusy(true);
    setNotice(null);
    await settlePrompt(action, {
      live: () => mounted.current,
      done: close,
      failed: () => setNotice(t("settings.cleanup.prompt.saveFailed")),
    });
    if (mounted.current) setBusy(false);
  };
  const ready = promptReady(name, text);
  const send = (event: FormEvent) => {
    event.preventDefault();
    if (ready && !busy) void run(() => save(name.trim(), text.trim()));
  };

  return (
    <EditorDialog
      title={
        prompt
          ? t("settings.cleanup.prompt.editTitle", { name: prompt.name })
          : t("settings.cleanup.prompt.newTitle")
      }
      notice={notice}
      dirty={promptDirty(prompt, name, text)}
      busy={busy}
      onClose={close}
      removals={
        prompt && remove
          ? [
              {
                id: "delete",
                label: t("settings.cleanup.prompt.delete"),
                message: t("settings.cleanup.prompt.deleteConfirm", {
                  name: prompt.name,
                }),
                action: t("settings.cleanup.prompt.deleteAction"),
                disabledReason: canDelete
                  ? undefined
                  : t("settings.cleanup.prompt.lastPrompt"),
                apply: () => run(remove),
              },
            ]
          : []
      }
      initialFocusRef={nameField}
      save={{ label: t("editor.save"), disabled: !ready, form: formId }}
    >
      <form id={formId} onSubmit={send} className="space-y-4">
        <div className="space-y-1">
          <label className="block text-xs font-medium text-ink-3">
            {t("settings.postProcessing.prompts.promptLabel")}
            {/* Input passes no ref, so the dialog focuses the input inside this wrapper. */}
            <span
              className="mt-1 block"
              ref={(node) => {
                nameField.current = node?.querySelector("input") ?? null;
              }}
            >
              <Input
                type="text"
                variant="compact"
                className="w-full"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t(
                  "settings.postProcessing.prompts.promptLabelPlaceholder",
                )}
              />
            </span>
          </label>
        </div>
        <div className="space-y-1">
          <label className="block text-xs font-medium text-ink-3">
            {t("settings.postProcessing.prompts.promptInstructions")}
            <Textarea
              className="mt-1 w-full"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={t(
                "settings.postProcessing.prompts.promptInstructionsPlaceholder",
              )}
            />
          </label>
          <p className="text-xs text-ink-3">
            <Trans
              i18nKey="settings.postProcessing.prompts.promptTip"
              components={{ code: <code /> }}
            />
          </p>
        </div>
      </form>
    </EditorDialog>
  );
}
