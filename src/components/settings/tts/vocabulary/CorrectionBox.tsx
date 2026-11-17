import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Mic, Square } from "lucide-react";
import {
  commands,
  type TermMatch,
  type TtsModelInfo,
  type VocabularyTable,
  type VoiceText,
} from "@/bindings";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Dropdown } from "@/components/ui/Dropdown";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { unwrapTts } from "../ModelsPage";
import {
  applyCapture,
  canSave,
  chosenRule,
  correctionRequest,
  createCapture,
  createCorrectionActions,
  initialCorrection,
  savesAs,
  scopeModel,
  type CaptureState,
  type CorrectionDependencies,
  type Derived,
  type SaveOutcome,
  type Scope,
  voicesAfter,
} from "./correction";
import { EDITOR_MATCHES, scopeChoices } from "./form";
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
 * reaches, chooses All voices or one downloaded voice model, and saves.
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
  const patch = (change: Partial<typeof state>) =>
    setState((current) => ({ ...current, ...change }));
  const [microphone, setMicrophone] = useState<ReturnType<
    typeof createCapture
  > | null>(null);
  const [capture, setCapture] = useState<CaptureState>("idle");

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
  const finish = (outcome: SaveOutcome) => {
    if (outcome.saved) {
      onSaved(outcome.table);
      onClose();
      return;
    }
    setFailure(outcome.failure.key);
    if (outcome.reload) setReloads((count) => count + 1);
  };
  const save = async () => {
    if (!table || !rule) return;
    finish(await actions.save(table.revision, rule));
  };
  const savePassed = async () => {
    if (!table || !rule) return;
    finish(
      await actions.savePassed(
        table.revision,
        rule,
        passedModels(check.results ?? []),
      ),
    );
  };
  const scopeValue =
    state.scope.kind === "unset"
      ? null
      : state.scope.kind === "all"
        ? ALL
        : state.scope.id;
  const chooseScope = (value: string): Scope =>
    value === ALL ? { kind: "all" } : { kind: "model", id: value };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      className="bg-background border border-line rounded-lg p-4 space-y-4"
    >
      <h2 className="text-sm font-medium">{t("tts.correction.title")}</h2>
      {failure && (
        <div role="alert">
          <Alert>{t(failure)}</Alert>
        </div>
      )}
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
          <Input
            variant="compact"
            className="flex-grow"
            aria-label={t("tts.correction.shouldSay")}
            value={state.shouldSay}
            onChange={(event) => patch({ shouldSay: event.target.value })}
          />
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
            { value: ALL, label: t("tts.vocabulary.voices.all") },
            ...scopeChoices(models, null).map((id) => ({
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
          {t("tts.correction.scopeRequired")}
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
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("tts.vocabulary.buttons.cancel")}
        </Button>
        {options.includes("save_passed_only") && (
          <Button
            type="button"
            variant="secondary"
            disabled={!table || !rule}
            onClick={() => void savePassed()}
          >
            {t("tts.vocabulary.check.savePassedOnly")}
          </Button>
        )}
        <Button type="submit" disabled={!canSave(state, derived) || !table}>
          {options.includes("save_all_anyway")
            ? t("tts.vocabulary.check.saveAllAnyway")
            : t("tts.vocabulary.buttons.save")}
        </Button>
      </div>
    </form>
  );
}
