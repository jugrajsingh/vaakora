import type { GridBlock, SessionSnapshot, SessionView } from "@/bindings";
import { createPopupActions, type PopupDependencies } from "./actions";

export type PopupView = SessionSnapshot & {
  text: string;
  grid_blocks: GridBlock[];
};

export type PopupEvent = Omit<SessionView, "text"> & { text: string | null };

export interface PopupAdapterDependencies
  extends Omit<PopupDependencies, "replaceText"> {
  replaceText: (text: string, clientRevision: number) => Promise<void>;
}

export function createPopupAdapter(
  getSnapshot: () => PopupView,
  apply: (snapshot: PopupView) => void,
  dependencies: PopupAdapterDependencies,
) {
  let revision = 0;
  let pendingRevision: number | null = null;
  let acknowledged = 0;
  let documentId: number | null = null;
  let epoch = getSnapshot().epoch;
  const actions = createPopupActions(
    getSnapshot,
    (next) => apply({ ...getSnapshot(), ...next }),
    {
      ...dependencies,
      replaceText: (text) => dependencies.replaceText(text, revision),
    },
  );
  return {
    ...actions,
    edit(text: string) {
      pendingRevision = ++revision;
      apply({
        ...getSnapshot(),
        text,
        grid_blocks: [],
        state: "waiting",
        source_start: 0,
        source_end: 0,
        elapsed_seconds: 0,
        remaining_seconds: 0,
        progress: 0,
        error: null,
        queued_audio_seconds: 0,
        head_start_seconds: null,
      });
      return actions.edit(text);
    },
    event(payload: PopupEvent) {
      if (documentId !== null && payload.document_id < documentId) return;
      if (payload.snapshot.epoch < epoch) return;
      epoch = payload.snapshot.epoch;
      const newDocument =
        documentId === null
          ? pendingRevision === null
          : payload.document_id > documentId;
      documentId = payload.document_id;
      if (newDocument) {
        pendingRevision = null;
        acknowledged = 0;
        if (payload.client_revision === null && payload.text !== null) {
          const view: PopupView = {
            ...payload.snapshot,
            text: payload.text,
            grid_blocks: payload.grid_blocks,
          };
          actions.reopen(view);
          return;
        }
      }
      const appliedRevision = payload.client_revision;
      if (appliedRevision !== null) {
        revision = Math.max(revision, appliedRevision);
        acknowledged = Math.max(acknowledged, appliedRevision);
      }
      const dirty = pendingRevision !== null && pendingRevision > acknowledged;
      const next: PopupView = dirty
        ? { ...getSnapshot(), epoch: payload.snapshot.epoch }
        : {
            ...payload.snapshot,
            text: payload.text ?? getSnapshot().text,
            grid_blocks: payload.grid_blocks,
          };
      actions.event(next);
    },
  };
}
