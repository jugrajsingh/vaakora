import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type {
  AcronymStyleRow,
  EntryKey,
  EntryRow,
  Rule,
  Section,
  TermMatch,
  TtsModelInfo,
} from "@/bindings";
import { Button } from "@/components/ui/Button";
import { Dropdown } from "@/components/ui/Dropdown";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import {
  EDITOR_MATCHES,
  SECTIONS,
  checkText,
  formComplete,
  formSubmission,
  initialForm,
  membersModels,
  membersSubmission,
  scopeChoices,
  type EntryForm,
} from "./form";
import { kindLabel, modelName, termMatchLabel } from "./labels";
import { useVoiceCheck, VoiceCheckPanel } from "./VoiceCheckPanel";
import {
  checkedModels,
  passedModels,
  saveOptions,
  voiceTexts,
} from "./voiceCheck";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <span className="block text-xs font-medium text-ink-3">{label}</span>
      {children}
    </div>
  );
}

/** Scrolls the editor into view and focuses its first field. */
export function revealEditor(
  root: Pick<HTMLElement, "scrollIntoView" | "querySelector">,
): void {
  root.scrollIntoView({ block: "nearest" });
  root.querySelector("input")?.focus();
}

export function RowEditor({
  initial,
  members,
  models,
  styles,
  submit,
  cancel,
}: {
  initial: EntryRow | null;
  /**
   * Every table row that shows as the edited row. Several: the edit applies to each one's voice
   * (the Voices column changes them) and the scope field is not offered.
   */
  members: readonly EntryRow[];
  models: readonly TtsModelInfo[];
  /** Each voice's acronym style, which an acronym entry is played and checked with. */
  styles: readonly AcronymStyleRow[];
  /** Saves the rule at every entry given, in one save. */
  submit: (
    entries: EntryKey[],
    rule: Rule,
    previous: (EntryKey | null)[],
  ) => void;
  cancel: () => void;
}) {
  const { t } = useTranslation();
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (formRef.current) revealEditor(formRef.current);
  }, []);
  const [form, setForm] = useState<EntryForm>(() => initialForm(initial));
  const patch = (change: Partial<EntryForm>) =>
    setForm((current) => ({ ...current, ...change }));
  const isTerm = form.section === "term";
  const matches: TermMatch[] = EDITOR_MATCHES.includes(form.matching)
    ? EDITOR_MATCHES
    : [...EDITOR_MATCHES, form.matching];
  const several = members.length > 1;
  const everyVoice = several || form.model === null;
  const spoken = checkText(form);
  const check = useVoiceCheck(
    voiceTexts(
      several
        ? membersModels(members, models)
        : checkedModels(form.model, models),
      spoken,
      form.section === "acronym" ? form.written.trim() : null,
      styles,
    ),
    `${form.matching}:${form.caseSensitive}`,
  );
  const options = saveOptions(check.results ?? [], several ? "" : form.model);
  const send = (event: FormEvent) => {
    event.preventDefault();
    if (several) {
      const { entries, rule, previous } = membersSubmission(form, members);
      submit(entries, rule, previous);
      return;
    }
    const { entry, rule, previous } = formSubmission(form, initial);
    submit([entry], rule, [previous]);
  };
  const savePassed = () => {
    const { entry, rule, previous } = formSubmission(form, initial);
    submit(
      passedModels(check.results ?? []).map((model) => ({ ...entry, model })),
      rule,
      [previous],
    );
  };
  return (
    <form
      ref={formRef}
      onSubmit={send}
      className="bg-background border border-line rounded-lg p-4 space-y-4"
    >
      <h2 className="text-sm font-medium">
        {initial
          ? t("tts.vocabulary.editTitle")
          : t("tts.vocabulary.buttons.add")}
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label={t("tts.vocabulary.columns.written")}>
          <Input
            variant="compact"
            className="w-full"
            aria-label={t("tts.vocabulary.columns.written")}
            value={form.written}
            onChange={(event) => patch({ written: event.target.value })}
          />
        </Field>
        <Field label={t("tts.vocabulary.columns.kind")}>
          <Dropdown
            options={SECTIONS.map((section: Section) => ({
              value: section,
              label: kindLabel(t, section),
            }))}
            selectedValue={form.section}
            onSelect={(section) => patch({ section: section as Section })}
          />
        </Field>
        {form.section !== "acronym" && !(isTerm && form.skip) && (
          <Field label={t("tts.vocabulary.columns.spoken")}>
            <Input
              variant="compact"
              className="w-full"
              aria-label={t("tts.vocabulary.columns.spoken")}
              value={form.spoken}
              onChange={(event) => patch({ spoken: event.target.value })}
            />
          </Field>
        )}
        {!several && (
          <Field label={t("tts.vocabulary.fields.appliesTo")}>
            <Dropdown
              options={[
                { value: "", label: t("tts.vocabulary.voices.all") },
                ...scopeChoices(models, initial?.id.entry.model ?? null).map(
                  (id) => ({ value: id, label: modelName(models, id) }),
                ),
              ]}
              selectedValue={form.model ?? ""}
              onSelect={(id) => patch({ model: id || null })}
            />
          </Field>
        )}
        {isTerm && (
          <>
            <Field label={t("tts.vocabulary.columns.match")}>
              <Dropdown
                options={matches.map((matching) => ({
                  value: matching,
                  label: termMatchLabel(t, matching),
                }))}
                selectedValue={form.matching}
                onSelect={(matching) =>
                  patch({ matching: matching as TermMatch })
                }
              />
            </Field>
            <label className="flex items-center gap-3 text-sm">
              <Switch
                checked={form.caseSensitive}
                onChange={(caseSensitive) => patch({ caseSensitive })}
              />
              {t("tts.vocabulary.match.caseSensitive")}
            </label>
            <label className="flex items-center gap-3 text-sm">
              <Switch
                checked={form.skip}
                onChange={(skip) => patch({ skip })}
              />
              {t("tts.vocabulary.fields.skip")}
            </label>
          </>
        )}
      </div>
      <VoiceCheckPanel run={check} models={models} />
      {options.includes("pick_one") && (
        <div className="space-y-2">
          <p className="text-sm">{t("tts.vocabulary.check.advisory")}</p>
          <Dropdown
            placeholder={t("tts.vocabulary.check.pickOne")}
            options={(check.results ?? []).map((result) => ({
              value: result.model_id,
              label: modelName(models, result.model_id),
            }))}
            selectedValue={null}
            onSelect={(id) => patch({ model: id })}
          />
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="secondary"
          disabled={spoken === ""}
          onClick={check.playAndCheck}
        >
          {everyVoice
            ? t("tts.vocabulary.check.playAll")
            : t("tts.vocabulary.buttons.listen")}
        </Button>
        <Button type="button" variant="secondary" onClick={cancel}>
          {t("tts.vocabulary.buttons.cancel")}
        </Button>
        {options.includes("save_passed_only") && (
          <Button
            type="button"
            variant="secondary"
            disabled={!formComplete(form)}
            onClick={savePassed}
          >
            {t("tts.vocabulary.check.savePassedOnly")}
          </Button>
        )}
        <Button type="submit" disabled={!formComplete(form)}>
          {options.includes("save_all_anyway")
            ? t("tts.vocabulary.check.saveAllAnyway")
            : t("tts.vocabulary.buttons.save")}
        </Button>
      </div>
    </form>
  );
}
