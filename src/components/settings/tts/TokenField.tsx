import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import type { TokenActions, TokenEntryState } from "./token";

/** The Hugging Face token field of a gated model's details; `present` is the session presence line. */
export function TokenField({
  state,
  actions,
  present,
}: {
  state: TokenEntryState;
  actions: TokenActions;
  present: boolean;
}) {
  const { t } = useTranslation();
  return (
    <form
      data-tts-token-field
      className="flex w-full min-w-0 flex-col gap-[8px] text-small text-ink-2"
      onSubmit={(event) => {
        event.preventDefault();
        void actions.save();
      }}
    >
      <label className="flex min-w-0 flex-col gap-[4px]">
        {t("models.token.label")}
        <Input
          className="w-full min-w-0"
          type={state.visible ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          value={state.draft}
          disabled={state.pending}
          onChange={(event) => actions.edit(event.target.value)}
        />
      </label>
      <p>{t("models.token.help")}</p>
      <p data-token-presence={present ? "set" : "required"}>
        {t(present ? "tts.tokenSet" : "tts.needsToken")}
      </p>
      {state.error && <p role="alert">{t(state.error)}</p>}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary-soft"
          size="sm"
          type="submit"
          disabled={state.pending}
        >
          {t("tts.saveToken")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          disabled={state.pending}
          onClick={() => void actions.clear()}
        >
          {t("tts.clearToken")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          disabled={state.pending}
          onClick={actions.show}
        >
          {t(state.visible ? "tts.hideToken" : "tts.showToken")}
        </Button>
      </div>
    </form>
  );
}
