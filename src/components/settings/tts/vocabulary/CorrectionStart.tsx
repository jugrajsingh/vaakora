import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

/** Asks for the written text to correct, then opens the correction box with all of it selected. */
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
  const [written, setWritten] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const spoken = await speak(written);
    setBusy(false);
    if (spoken !== null) open(written, spoken);
  };
  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="bg-background border border-line rounded-lg p-4 space-y-4"
    >
      <h2 className="text-sm font-medium">{t("tts.correction.start")}</h2>
      <Input
        variant="compact"
        className="w-full"
        aria-label={t("tts.correction.writtenText")}
        placeholder={t("tts.correction.writtenText")}
        value={written}
        onChange={(event) => setWritten(event.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={cancel}>
          {t("tts.vocabulary.buttons.cancel")}
        </Button>
        <Button type="submit" disabled={busy || written.trim() === ""}>
          {t("tts.correction.next")}
        </Button>
      </div>
    </form>
  );
}
