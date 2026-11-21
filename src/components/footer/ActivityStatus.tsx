import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import {
  commands,
  events,
  type DictationActivity,
  type PlaybackState,
  type SessionView,
} from "@/bindings";
import { LANGUAGE_DETECTOR_ID } from "@/hooks/useLanguageDetector";
import type { Link } from "@/lib/navigation";
import { useModelStore } from "@/stores/modelStore";
import { useTranscriptionJobsStore } from "@/stores/transcriptionJobsStore";
import {
  connectActivity,
  downloadInput,
  downloadName,
  fileJobInput,
  footerActivity,
} from "./activity";
import { ActivityView } from "./ActivityView";

/** What Handy is doing now; a file transcription or a download opens its page. */
export function ActivityStatus({
  navigate,
}: {
  navigate: (link: Link) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [dictation, setDictation] = useState<DictationActivity>("ready");
  const [reading, setReading] = useState<PlaybackState | null>(null);
  const jobs = useTranscriptionJobsStore((state) => state.jobs);
  const progress = useModelStore((state) => state.downloadProgress);
  const verifying = useModelStore((state) => state.verifyingModels);
  const models = useModelStore((state) => state.models);

  useEffect(
    () =>
      connectActivity({
        listenDictation: (apply) =>
          events.dictationActivityEvent.listen(({ payload }) =>
            apply(payload.activity),
          ),
        listenReader: (apply) =>
          listen<SessionView>("read-aloud-state", ({ payload }) =>
            apply(payload.snapshot.state),
          ),
        queryReader: async () => {
          const result = await commands.getReadAloudState();
          return result.status === "ok" ? result.data.snapshot.state : null;
        },
        setDictation,
        setReader: setReading,
      }),
    [],
  );

  const activity = footerActivity({
    dictation,
    reading,
    fileJob: fileJobInput(jobs),
    download: downloadInput(progress, verifying, (id) =>
      downloadName(id, models, LANGUAGE_DETECTOR_ID, t),
    ),
  });
  const link = activity.link;
  return (
    <ActivityView
      activity={activity}
      text={t(activity.key, activity.values)}
      onOpen={link ? () => navigate(link) : undefined}
    />
  );
}
