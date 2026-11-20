import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { EditorDialog } from "@/components/shared/EditorDialog";
import { Input } from "@/components/ui/Input";
import { settleNext } from "./correction";

/** Asks for the written text to correct, then opens the correction dialog with all of it selected. */
export function CorrectionStart({
  speak,
  open,
  cancel,
}: {
  speak: (written: string) => Promise<string | null>;
  open: (written: string, spokenAs: string) => void;
  cancel: () => void;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const field = useRef<HTMLElement | null>(null);
  const [written, setWritten] = useState("");
  const [busy, setBusy] = useState(false);
  const blank = written.trim() === "";
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const close = () => {
    mounted.current = false;
    cancel();
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || blank) return;
    setBusy(true);
    try {
      await settleNext(speak, written, { live: () => mounted.current, open });
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <EditorDialog
      title={t("tts.correction.title")}
      dirty={!blank}
      onClose={close}
      initialFocusRef={field}
      save={{
        label: t("tts.correction.next"),
        disabled: busy || blank,
        form: formId,
      }}
    >
      <form id={formId} onSubmit={(event) => void submit(event)}>
        {/* Input passes no ref, so the dialog focuses the input inside this wrapper. */}
        <div
          ref={(node) => {
            field.current = node?.querySelector("input") ?? null;
          }}
        >
          <Input
            variant="compact"
            className="w-full"
            aria-label={t("tts.correction.writtenText")}
            placeholder={t("tts.correction.writtenText")}
            value={written}
            onChange={(event) => setWritten(event.target.value)}
          />
        </div>
      </form>
    </EditorDialog>
  );
}
