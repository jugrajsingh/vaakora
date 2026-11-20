import React, { useId } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import {
  InlineConfirm,
  useRowConfirm,
} from "@/components/shared/InlineConfirm";

export type Question = "discard" | "delete" | "reset";

export interface Removal {
  id: "delete" | "reset";
  label: string;
  /** The question asked before it applies. */
  message: string;
  /** The red action's label. */
  action: string;
  /** Why it is off; shown as a line before the disabled button. */
  disabledReason?: string;
  apply: () => Promise<void> | void;
}

export interface EditorDialogProps {
  title: string;
  context?: React.ReactNode;
  /** One line above the body, announced as an alert. */
  notice?: string | null;
  /** Whether the form holds changes; a close then asks first. */
  dirty: boolean;
  /** True while the host's save, delete or reset is pending. */
  busy?: boolean;
  onClose: () => void;
  removals?: readonly Removal[];
  actions?: React.ReactNode;
  save: { label: string; disabled: boolean; form: string };
  initialFocusRef?: React.RefObject<HTMLElement>;
  children: React.ReactNode;
}

/** The one editor dialog: a body, and a footer that becomes one inline question. */
export function EditorDialog({
  title,
  context,
  notice,
  dirty,
  busy = false,
  onClose,
  removals = [],
  actions,
  save,
  initialFocusRef,
  children,
}: EditorDialogProps): React.JSX.Element {
  const { t } = useTranslation();
  const reasonId = useId();
  const question = useRowConfirm<Question>({
    apply: (key) =>
      key === "discard"
        ? onClose()
        : removals.find((removal) => removal.id === key)?.apply(),
    present: (key) =>
      key === "discard" || removals.some((removal) => removal.id === key),
  });
  const requestClose = () => {
    if (dirty) question.ask("discard");
    else onClose();
  };
  const asked = removals.find((removal) => removal.id === question.asking);

  const footer = (
    <div
      ref={question.rowsRef}
      className="flex w-full flex-wrap items-center gap-2"
    >
      {question.asking === "discard" || asked ? (
        <div className="ml-auto">
          <InlineConfirm
            message={asked?.message ?? t("editor.discard.message")}
            action={asked?.action ?? t("editor.discard.action")}
            cancel={asked ? undefined : t("editor.discard.keep")}
            onCancel={question.cancel}
            onConfirm={question.confirm}
          />
        </div>
      ) : (
        <>
          {removals.map((removal) => (
            <div
              key={removal.id}
              data-confirm-row={removal.id}
              className="flex items-center gap-2"
            >
              {removal.disabledReason && (
                <span
                  id={`${reasonId}-${removal.id}`}
                  className="text-xs text-ink-2"
                >
                  {removal.disabledReason}
                </span>
              )}
              <Button
                type="button"
                variant={removal.id === "delete" ? "danger-ghost" : "secondary"}
                disabled={busy || removal.disabledReason !== undefined}
                aria-describedby={
                  removal.disabledReason
                    ? `${reasonId}-${removal.id}`
                    : undefined
                }
                onClick={() => question.ask(removal.id)}
              >
                {removal.label}
              </Button>
            </div>
          ))}
          <div className="ml-auto flex items-center gap-2">
            {actions}
            <div data-confirm-row="discard">
              <Button type="button" variant="secondary" onClick={requestClose}>
                {t("common.cancel")}
              </Button>
            </div>
            <Button
              type="submit"
              form={save.form}
              disabled={save.disabled || busy}
            >
              {save.label}
            </Button>
          </div>
        </>
      )}
    </div>
  );

  return (
    <Dialog
      open
      title={title}
      description={context}
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
      closeOnBackdrop={false}
      closeLabel={t("common.close")}
      className="max-w-[40rem]!"
      initialFocusRef={initialFocusRef}
      footer={footer}
    >
      <div
        onSubmitCapture={(event) => {
          if (save.disabled || busy || question.asking !== null) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
        {notice && (
          <div role="alert" className="mb-3">
            <Alert>{notice}</Alert>
          </div>
        )}
        {children}
      </div>
    </Dialog>
  );
}
