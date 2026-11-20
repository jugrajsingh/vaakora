import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Mic, Square } from "lucide-react";
import {
  commands,
  type TermMatch,
  type TtsModelInfo,
  type VocabularyTable,
  type VoiceText,
} from "@/bindings";
import { EditorDialog } from "@/components/shared/EditorDialog";
import { Button } from "@/components/ui/Button";
import { Dropdown } from "@/components/ui/Dropdown";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { unwrapTts } from "../ModelsPage";
import {
  applyCapture,
  attemptSave,
  canSave,
  chosenRule,
  correctionRequest,
  createCapture,
  correctionDirty,
  correctionNotice,
  createCorrectionActions,
  initialCorrection,
  savesAs,
  settleSave,
  scopeModel,
  type CaptureState,
  type CorrectionDependencies,
  type Derived,
  type SaveOutcome,
  type Scope,
  voicesAfter,
} from "./correction";
import { appliesToChoices, EDITOR_MATCHES } from "./form";
import { modelName, termMatchLabel } from "./labels";
import { useVoiceCheck, VoiceCheckPanel } from "./VoiceCheckPanel";
import { checkedModels, passedModels, saveOptions } from "./voiceCheck";

const DERIVE_DELAY_MS = 250;
const ALL = "all";

const realDependencies: CorrectionDependencies = {
  load: async () => unwrapTts(await commands.getTtsVocabulary()),
  derive: async (request) => unwrapTts(await commands.deriveTtsRule(request)),
  listen: async (spoken, model) => {
    unwrapTts(await commands.listenTtsVocabulary({ spoken }, model));
  },
  voices: async (written, rule, models) =>
    unwrapTts(await commands.spokenTtsRule(written, rule, models)),
  saveRules: async (revision, rules) => {
    const result = await commands.saveTtsRules(revision, rules);
    return result.status === "ok" ? result.data : result.error;
  },
};

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <span className="block text-xs font-medium text-ink-3">{label}</span>
      {children}
    </div>
  );
}

/**
 * The owner edits how a chunk is spoken, listens, sees the rule that edit saves as and who it
 * reaches, chooses All models or one downloaded model, and saves.
 */
export function CorrectionBox({
  written,
  spokenAs,
  readingModel,
  models,
  onSaved,
  onClose,
}: {
  written: string;
  spokenAs: string;
  readingModel: string;
  models: readonly TtsModelInfo[];
  onSaved: (table: VocabularyTable) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const actions = useMemo(() => createCorrectionActions(realDependencies), []);
  const [state, setState] = useState(() => initialCorrection(spokenAs));
  const [derived, setDerived] = useState<Derived>({ status: "pending" });
  const [table, setTable] = useState<VocabularyTable | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const [saving, setSaving] = useState(false);
  const formId = useId();
  const mounted = useRef(true);
  const close = () => {
    mounted.current = false;
    onClose();
  };
  const shouldSay = useRef<HTMLElement | null>(null);
  const patch = (change: Partial<typeof state>) =>
    setState((current) => ({ ...current, passed: null, ...change }));
  const [microphone, setMicrophone] = useState<ReturnType<
    typeof createCapture
  > | null>(null);
  const [capture, setCapture] = useState<CaptureState>("idle");

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const created = createCapture({
      start: async () => {
        unwrapTts(await commands.startTtsCapture());
      },
      stop: async () => unwrapTts(await commands.stopTtsCapture()),
      cancel: async () => {
        unwrapTts(await commands.cancelTtsCapture());
      },
      update: setCapture,
      heard: (words) =>
        setState((current) => ({
          ...current,
          shouldSay: applyCapture(current.shouldSay, words),
          passed: null,
        })),
      fail: setFailure,
    });
    setMicrophone(created);
    return () => created.close();
  }, []);

  useEffect(() => {
    let current = true;
    actions
      .load()
      .then((loaded) => current && setTable(loaded))
      .catch(() => current && setFailure("tts.errors.generic"));
    return () => {
      current = false;
    };
  }, [actions, reloads]);

  useEffect(() => {
    let current = true;
    setDerived({ status: "pending" });
    const timer = setTimeout(() => {
      void actions
        .derive(correctionRequest(written, readingModel, state))
        .then((result) => current && setDerived(result));
    }, DERIVE_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [actions, written, readingModel, state, reloads]);

  const exact = derived.status === "ready" ? derived.derivation.exact : null;
  const rule =
    derived.status === "ready"
      ? chosenRule(derived.derivation, state.exact)
      : null;
  const matches: TermMatch[] = EDITOR_MATCHES;
  const targets = (
    state.scope.kind === "unset"
      ? []
      : checkedModels(scopeModel(state.scope), models)
  ).join("\n");
  const [voices, setVoices] = useState<VoiceText[]>([]);
  const next = voicesAfter(derived, targets !== "");
  useEffect(() => {
    let current = true;
    if (next === "clear") setVoices([]);
    if (next === "prepare" && rule) {
      actions
        .voices(written, rule, targets.split("\n"))
        .then((spoken) => current && setVoices(spoken))
        .catch(() => current && setVoices([]));
    }
    return () => {
      current = false;
    };
  }, [actions, written, rule, targets, next]);
  const check = useVoiceCheck(
    voices,
    `${state.matching}:${state.caseSensitive}`,
  );
  const options = saveOptions(check.results ?? [], scopeModel(state.scope));
  const listen = async () => {
    try {
      await actions.listen(state.shouldSay, scopeModel(state.scope));
      setFailure(null);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "";
      setFailure(
        message.startsWith("tts.errors.") ? message : "tts.errors.generic",
      );
    }
  };
  const finish = (outcome: SaveOutcome) =>
    settleSave(outcome, {
      live: () => mounted.current,
      saved: onSaved,
      close,
      failed: (failed) => {
        setFailure(correctionNotice(failed).key);
        if (failed.reload) setReloads((count) => count + 1);
      },
    });
  /** Saves the shown rule, or for `passed` voices only; a pending save blocks another. */
  const save = async (passed: readonly string[] | null) => {
    if (saving) return;
    setSaving(true);
    try {
      const outcome = await attemptSave(
        actions,
        { table, rule, state, derived },
        passed,
      );
      if (outcome) finish(outcome);
    } finally {
      if (mounted.current) setSaving(false);
    }
  };
  const scopeValue =
    state.scope.kind === "unset"
      ? null
      : state.scope.kind === "all"
        ? ALL
        : state.scope.id;
  const chooseScope = (value: string): Scope =>
    value === ALL ? { kind: "all" } : { kind: "model", id: value };
  const saveLabel =
    state.passed !== null
      ? t("tts.vocabulary.check.savePassedOnly")
      : options.includes("save_all_anyway")
        ? t("tts.vocabulary.check.saveAllAnyway")
        : t("editor.save");
  return (
    <EditorDialog
      title={t("tts.correction.title")}
      notice={failure && t(failure)}
      dirty={correctionDirty(state, spokenAs)}
      busy={saving}
      onClose={close}
      initialFocusRef={shouldSay}
      actions={
        <>
          <Button
            type="button"
            variant="secondary"
            disabled={
              state.shouldSay.trim() === "" ||
              rule === null ||
              (state.scope.kind !== "unset" && voices.length === 0)
            }
            onClick={() =>
              state.scope.kind === "unset"
                ? void listen()
                : check.playAndCheck()
            }
          >
            {state.scope.kind === "all"
              ? t("tts.vocabulary.check.playAll")
              : t("tts.vocabulary.buttons.listen")}
          </Button>
          {options.includes("save_passed_only") && state.passed === null && (
            <Button
              type="button"
              variant="secondary"
              disabled={saving || !table || !rule}
              onClick={() => {
                const passed = passedModels(check.results ?? []);
                patch({ passed });
                void save(passed);
              }}
            >
              {t("tts.vocabulary.check.savePassedOnly")}
            </Button>
          )}
        </>
      }
      save={{
        label: saveLabel,
        disabled: !canSave(state, derived) || !table,
        form: formId,
      }}
    >
      <form
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          void save(state.passed);
        }}
        className="space-y-4"
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label={t("tts.correction.selected")}>
            <p className="text-sm font-mono break-words">{written}</p>
          </Field>
          <Field label={t("tts.correction.spokenAs")}>
            <p className="text-sm break-words">{spokenAs}</p>
          </Field>
        </div>
        <Field label={t("tts.correction.shouldSay")}>
          <div className="flex items-center gap-2">
            {/* Input passes no ref, so the dialog focuses the input inside this wrapper. */}
            <div
              className="flex-grow"
              ref={(node) => {
                shouldSay.current = node?.querySelector("input") ?? null;
              }}
            >
              <Input
                variant="compact"
                className="w-full"
                aria-label={t("tts.correction.shouldSay")}
                value={state.shouldSay}
                onChange={(event) => patch({ shouldSay: event.target.value })}
              />
            </div>
            <Button
              type="button"
              variant="secondary"
              aria-label={t(`tts.correction.microphone.${capture}`)}
              title={t(`tts.correction.microphone.${capture}`)}
              aria-pressed={capture === "recording"}
              disabled={!microphone || capture === "transcribing"}
              onClick={() => void microphone?.press()}
            >
              {capture === "recording" ? (
                <Square className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Mic className="h-4 w-4" aria-hidden="true" />
              )}
            </Button>
          </div>
        </Field>
        <Field label={t("tts.correction.savesAs")}>
          {derived.status === "error" ? (
            <p role="alert" className="text-sm text-error">
              {t(derived.key, { detail: derived.detail })}
            </p>
          ) : rule ? (
            <p className="text-sm">{savesAs(rule, t)}</p>
          ) : (
            <p className="text-sm text-ink-3">{t("tts.correction.deriving")}</p>
          )}
        </Field>
        {exact && (
          <label className="flex items-center gap-3 text-sm">
            <Switch
              checked={state.exact}
              onChange={(value) => patch({ exact: value })}
            />
            {t("tts.correction.exactOnly", { text: written })}
          </label>
        )}
        {rule?.reach.kind === "term" && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label={t("tts.vocabulary.columns.match")}>
              <Dropdown
                options={matches.map((matching) => ({
                  value: matching,
                  label: termMatchLabel(t, matching),
                }))}
                selectedValue={state.matching}
                onSelect={(matching) =>
                  patch({ matching: matching as TermMatch })
                }
              />
            </Field>
            <label className="flex items-center gap-3 text-sm">
              <Switch
                checked={state.caseSensitive}
                onChange={(caseSensitive) => patch({ caseSensitive })}
              />
              {t("tts.vocabulary.match.caseSensitive")}
            </label>
          </div>
        )}
        <Field label={t("tts.vocabulary.fields.appliesTo")}>
          <Dropdown
            placeholder={t("tts.correction.chooseScope")}
            options={[
              { value: ALL, label: t("tts.vocabulary.models.all") },
              ...appliesToChoices(models, []).map((id) => ({
                value: id,
                label: modelName(models, id),
              })),
            ]}
            selectedValue={scopeValue}
            onSelect={(value) => patch({ scope: chooseScope(value) })}
          />
        </Field>
        {state.scope.kind === "unset" && (
          <p className="text-xs text-ink-3">
            {t("tts.correction.scopeRequiredModels")}
          </p>
        )}
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
              onSelect={(id) => patch({ scope: { kind: "model", id } })}
            />
          </div>
        )}
      </form>
    </EditorDialog>
  );
}
