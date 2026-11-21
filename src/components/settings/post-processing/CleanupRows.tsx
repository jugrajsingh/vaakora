import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { LocalLlmModelInfo, LocalLlmStatus } from "@/bindings";
import type { RowConfirm } from "@/components/shared/InlineConfirm";
import {
  ManagerRow,
  RoleCells,
  RoleHeads,
} from "@/components/shared/modelTable/ManagerRow";
import {
  ManagerTable,
  RoleLegend,
  type ManagerSection,
} from "@/components/shared/modelTable/ManagerTable";
import {
  cleanupModel,
  matchesQuery,
  type ManagerModel,
  type ModelState,
} from "@/components/shared/modelTable/roles";
import {
  deleteMessage,
  type DeleteAsk,
} from "@/components/settings/models/managerRows";
import { languageName } from "@/lib/constants/languages";
import { formatBytes } from "@/lib/utils/format";
import {
  createLocalLlmRowActions,
  rowActionState,
  type LocalLlmRowState,
} from "./localLlmRowActions";

type Runtime = "notLoaded" | "loading" | "ready" | "failed";

/** The runtime word of the selected model: the status of its own process, else not loaded. */
export function cleanupRuntime(
  status: LocalLlmStatus | null,
  selectedId: string | null,
): Runtime {
  if (status === null) return "notLoaded";
  if (status.model_id !== null && status.model_id !== selectedId)
    return "notLoaded";
  if (status.state === "ready") return "ready";
  if (status.state === "starting") return "loading";
  if (status.state === "failed" || status.error !== null) return "failed";
  return "notLoaded";
}

/** The leading mark of a row: select a downloaded model, download a missing one; a download in flight and the selected model have none. */
export function cleanupMark(
  model: Pick<LocalLlmModelInfo, "display_name">,
  kind: ModelState["kind"],
  actions: ReturnType<typeof createLocalLlmRowActions>,
  t: TFunction,
): React.ComponentProps<typeof ManagerRow>["mark"] {
  const name = model.display_name;
  switch (kind) {
    case "selected":
    case "downloading":
      return null;
    case "downloaded":
      return {
        label: t("models.mark.select", { name }),
        disabled: actions.canUse ? undefined : t("models.busy"),
        press: actions.use,
      };
    case "remote":
    case "failed":
      return {
        label: t("models.mark.download", { name }),
        disabled: actions.canDownload ? undefined : t("models.busy"),
        press: actions.download,
      };
  }
}

/** A delete question as asked: the model, whether it was the selected one, and its words. */
export type CleanupAsked = DeleteAsk & { message: string };

/** The delete question for a model: what goes, what it frees, the consequence when it is selected, what is kept. */
export function cleanupAskedFor(
  t: TFunction,
  info: Pick<LocalLlmModelInfo, "id" | "display_name" | "size_bytes">,
  selected: boolean,
  language: string,
): CleanupAsked {
  return {
    id: info.id,
    selected,
    message: deleteMessage(
      t,
      {
        name: info.display_name,
        size: formatBytes(info.size_bytes),
        selected,
        role: "cleanup",
      },
      language,
    ),
  };
}

/** What the delete question checks against: the rendered models, the selection, the download and the delete. */
export interface CleanupDeleteView extends LocalLlmRowState {
  asked: DeleteAsk | null;
  models: readonly LocalLlmModelInfo[];
}

/** The question stays only while its model can be deleted under today's row rules and is as selected as when asked. */
export function cleanupPresent(
  view: () => CleanupDeleteView,
): (id: string) => boolean {
  return (id) => {
    const now = view();
    const model = now.models.find((row) => row.id === id);
    if (now.asked === null || now.asked.id !== id || model === undefined)
      return false;
    const row = rowActionState(model, now);
    return row.canDelete && row.isActive === now.asked.selected;
  };
}

/** Confirm: delete the asked model only when the question still holds. */
export function cleanupApply(
  view: () => CleanupDeleteView,
  remove: (id: string) => void,
): (id: string) => void {
  const present = cleanupPresent(view);
  return (id) => {
    if (present(id)) remove(id);
  };
}

export interface CleanupRowsProps extends LocalLlmRowState {
  models: readonly LocalLlmModelInfo[];
  /** The download's progress, 0 to 100, or null before the first event. */
  percentage: number | null;
  /** The runtime word of the selected model. */
  runtime: Runtime;
  deletion: RowConfirm<string>;
  asked: CleanupAsked | null;
  openId: string | null;
  onOpenChange: (id: string | null) => void;
  act: {
    select: (id: string) => void;
    download: (id: string) => void;
    ask: (asked: CleanupAsked) => void;
  };
}

/** Models, Cleanup: the manager table over the local cleanup models, with plain props. */
export function CleanupRows({
  models,
  selectedId,
  downloadId,
  deletingId,
  percentage,
  runtime,
  deletion,
  asked,
  openId,
  onOpenChange,
  act,
}: CleanupRowsProps): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState("");
  const state: LocalLlmRowState = { selectedId, downloadId, deletingId };
  const infoById = new Map(models.map((info) => [info.id, info]));
  const modelOf = (info: LocalLlmModelInfo): ManagerModel =>
    cleanupModel(info, {
      selectedId,
      downloadId,
      percent: downloadId === info.id ? percentage : null,
      error: null,
      runtime,
      t,
    });
  const keep = (list: readonly LocalLlmModelInfo[]) =>
    list
      .map(modelOf)
      .filter((m) =>
        matchesQuery(m, query, { t, language: i18n.language, languageName }),
      );
  const sections: ManagerSection[] = [
    {
      key: "downloaded",
      label: t("settings.models.sections.yours"),
      rows: keep(models.filter((info) => info.downloaded)),
    },
    {
      key: "available",
      label: t("models.sections.available"),
      rows: keep(models.filter((info) => !info.downloaded)),
    },
  ].filter((section) => section.rows.length > 0);

  const renderRow = (m: ManagerModel, open: boolean, toggle: () => void) => {
    const info = infoById.get(m.id);
    if (info === undefined) return null;
    const ask = () =>
      act.ask(
        cleanupAskedFor(
          t,
          info,
          info.downloaded && info.id === selectedId,
          i18n.language,
        ),
      );
    const row = createLocalLlmRowActions(info, state, {
      onSelect: act.select,
      onDownload: act.download,
      onDelete: ask,
    });
    const question =
      deletion.asking === info.id && asked?.id === info.id
        ? {
            message: asked.message,
            confirm: deletion.confirm,
            cancel: deletion.cancel,
          }
        : undefined;
    return (
      <ManagerRow
        model={m}
        open={open}
        toggle={toggle}
        cells={<RoleCells model={m} />}
        mark={cleanupMark(info, m.state.kind, row, t)}
        remove={
          row.canDelete
            ? {
                label: t("models.remove", { name: info.display_name }),
                press: row.delete,
              }
            : undefined
        }
        question={question}
        onKeyDown={(event) => {
          if (event.key === "Escape" && question !== undefined) {
            event.preventDefault();
            event.stopPropagation();
            deletion.cancel();
            return;
          }
          if (event.target !== event.currentTarget) return;
          if (
            (event.key === "Delete" || event.key === "Backspace") &&
            row.canDelete
          ) {
            event.preventDefault();
            row.delete();
          }
        }}
      />
    );
  };

  return (
    <ManagerTable
      role="cleanup"
      sections={sections}
      query={query}
      setQuery={setQuery}
      chips={[]}
      pressed={new Set()}
      toggleChip={() => {}}
      heads={<RoleHeads />}
      legend={<RoleLegend role="cleanup" measuredOn={null} />}
      openId={openId}
      onOpenChange={onOpenChange}
      renderRow={renderRow}
    />
  );
}
