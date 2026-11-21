import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type {
  AcronymStyleRow,
  EntryRow,
  Section,
  TermMatch,
  TtsModelInfo,
} from "@/bindings";
import { Button } from "@/components/ui/Button";
import { Dropdown } from "@/components/ui/Dropdown";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { EditorDialog, type Removal } from "@/components/shared/EditorDialog";
import type { Failure } from "./actions";
import {
  entryEdits,
  toggleScope,
  type EntryDraft,
  type EntryRefusal,
} from "./entryPlan";
import {
  EDITOR_MATCHES,
  SECTIONS,
  appliesToChoices,
  checkText,
  entryDraft,
  formComplete,
  initialForm,
  type EntryForm,
} from "./form";
import type { RowGroup } from "./groups";
import { kindLabel, modelName, termMatchLabel } from "./labels";
import { useVoiceCheck, VoiceCheckPanel } from "./VoiceCheckPanel";
import {
  checkedModels,
  passedModels,
  saveOptions,
  voiceTexts,
} from "./voiceCheck";

const CHECKBOX = "flex items-center gap-2 text-sm";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <span className="block text-xs font-medium text-ink-3">{label}</span>
      {children}
    </div>
  );
}

/** The line a refused plan shows under Applies to; none for an empty list, which Save already shows. */
export function refusalLine(reason: EntryRefusal): string | null {
  switch (reason) {
    case "empty":
      return null;
    case "gone":
      return "tts.vocabulary.dialog.refused";
    case "taken":
    case "builtin-scope":
      return "tts.vocabulary.dialog.scopeRefused";
  }
}

/** The form with its scopes in a fixed order, so checking a model off and on again is no change. */
const comparable = (form: EntryForm) =>
  JSON.stringify({ ...form, scopes: form.scopes.map(String).sort() });

/** Add entry (`group` null) and Edit, on the editor dialog. */
export function EntryDialog({
  group,
  rows,
  modelIds,
  models,
  styles,
  notice,
  fileError,
  busy,
  save,
  remove,
  reset,
  close,
}: {
  group: RowGroup | null;
  /** The table's rows now, which Save is planned against. */
  rows: readonly EntryRow[];
  modelIds: readonly string[];
  models: readonly TtsModelInfo[];
  /** Each voice's acronym style, which an acronym entry is played and checked with. */
  styles: readonly AcronymStyleRow[];
  notice: Failure | null;
  /** The vocabulary file's error; Save is off while it has one. */
  fileError: string | null;
  /** A save, delete or reset of this dialog is pending. */
  busy: boolean;
  save: (draft: EntryDraft) => void;
  remove: () => void;
  reset: () => void;
  close: () => void;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const written = useRef<HTMLElement | null>(null);
  const [initial] = useState(() => initialForm(group, modelIds));
  const [form, setForm] = useState<EntryForm>(initial);
  const patch = (change: Partial<EntryForm>) =>
    setForm((current) => ({ ...current, ...change }));
  const opened = group ? initial.scopes : [];
  const isTerm = form.section === "term";
  const matches: TermMatch[] = EDITOR_MATCHES.includes(form.matching)
    ? EDITOR_MATCHES
    : [...EDITOR_MATCHES, form.matching];
  const spoken = checkText(form);
  const allModels = form.scopes.includes(null);
  const check = useVoiceCheck(
    voiceTexts(
      [
        ...new Set(
          form.scopes.flatMap((scope) => checkedModels(scope, models)),
        ),
      ],
      spoken,
      form.section === "acronym" ? form.written.trim() : null,
      styles,
    ),
    `${form.matching}:${form.caseSensitive}`,
  );
  const options = saveOptions(check.results ?? [], allModels ? null : "");
  const draft = entryDraft(form, opened);
  const plan = formComplete(form)
    ? entryEdits(rows, modelIds, group?.key ?? null, draft)
    : null;
  const refusal = typeof plan === "string" ? refusalLine(plan) : null;
  const locked = busy || fileError !== null;
  const send = (event: FormEvent) => {
    event.preventDefault();
    if (!locked && plan !== null && typeof plan !== "string") save(draft);
  };
  const shown: Failure | null =
    notice ??
    (fileError === null
      ? null
      : { key: "tts.vocabulary.errors.fileInvalid", message: fileError });
  const words = (text: string, skip: boolean) =>
    skip ? t("tts.vocabulary.skipped") : text;
  const removals: Removal[] = group
    ? [
        {
          id: "delete",
          label: t("tts.vocabulary.buttons.delete"),
          message: t("tts.vocabulary.dialog.deleteConfirm", {
            written: group.written,
          }),
          action: t("tts.vocabulary.dialog.deleteAction"),
          disabledReason:
            group.origin === "owner"
              ? undefined
              : t("tts.vocabulary.dialog.builtinDelete"),
          apply: remove,
        },
        ...(group.overriding.length > 0
          ? [
              {
                id: "reset" as const,
                label: t("tts.vocabulary.buttons.reset"),
                message: t("tts.vocabulary.resetConfirm", {
                  written: group.written,
                }),
                action: t("tts.vocabulary.buttons.reset"),
                apply: reset,
              },
            ]
          : []),
      ]
    : [];
  const choices = appliesToChoices(models, [...initial.scopes, ...form.scopes]);
  return (
    <EditorDialog
      title={
        group
          ? t("tts.vocabulary.dialog.editTitle", { written: group.written })
          : t("tts.vocabulary.buttons.add")
      }
      context={
        group ? (
          <>
            <span className="block">
              {t("tts.vocabulary.dialog.context", {
                written: group.written,
                spoken: words(group.spoken, group.skip),
              })}
            </span>
            {group.defaults.length > 0 && (
              <span className="block">
                {t("tts.vocabulary.dialog.overrides", {
                  default: group.defaults
                    .map((fallback) => words(fallback.spoken, fallback.skip))
                    .join(", "),
                })}
              </span>
            )}
          </>
        ) : undefined
      }
      notice={shown && t(shown.key, { message: shown.message })}
      dirty={comparable(form) !== comparable(initial)}
      busy={busy}
      onClose={close}
      removals={removals}
      initialFocusRef={written}
      actions={
        <Button
          type="button"
          variant="secondary"
          disabled={spoken === ""}
          onClick={check.playAndCheck}
        >
          {allModels || form.scopes.length > 1
            ? t("tts.vocabulary.check.playAll")
            : t("tts.vocabulary.buttons.listen")}
        </Button>
      }
      save={{
        label: t("editor.save"),
        disabled: locked || plan === null || typeof plan === "string",
        form: formId,
      }}
    >
      <form id={formId} onSubmit={send} className="space-y-4">
        <Field label={t("tts.vocabulary.columns.written")}>
          {/* Input passes no ref, so the dialog focuses the input inside this wrapper. */}
          <div
            ref={(node) => {
              written.current = node?.querySelector("input") ?? null;
            }}
          >
            <Input
              variant="compact"
              className="w-full"
              aria-label={t("tts.vocabulary.columns.written")}
              value={form.written}
              onChange={(event) => patch({ written: event.target.value })}
            />
          </div>
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
        <fieldset className="space-y-1">
          <legend className="text-xs font-medium text-ink-3">
            {t("tts.vocabulary.fields.appliesTo")}
          </legend>
          {[null, ...choices].map((scope) => (
            <label key={scope ?? ""} className={CHECKBOX}>
              <input
                type="checkbox"
                className="accent-logo-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-logo-primary"
                checked={form.scopes.includes(scope)}
                onChange={() =>
                  setForm((current) => ({
                    ...current,
                    scopes: toggleScope(current.scopes, scope),
                  }))
                }
              />
              {scope === null
                ? t("tts.vocabulary.models.all")
                : modelName(models, scope)}
            </label>
          ))}
          {refusal && <p className="text-xs text-ink-2">{t(refusal)}</p>}
        </fieldset>
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
              onSelect={(id) => patch({ scopes: [id] })}
            />
            {options.includes("save_passed_only") && (
              <Button
                type="button"
                variant="secondary"
                disabled={locked || !formComplete(form)}
                onClick={() => {
                  const passed = {
                    ...form,
                    scopes: passedModels(check.results ?? []),
                  };
                  setForm(passed);
                  save(entryDraft(passed, opened));
                }}
              >
                {t("tts.vocabulary.check.savePassedOnly")}
              </Button>
            )}
          </div>
        )}
      </form>
    </EditorDialog>
  );
}
