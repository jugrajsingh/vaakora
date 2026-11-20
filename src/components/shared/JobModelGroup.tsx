import React from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { SettingContainer } from "@/components/ui/SettingContainer";
import { SettingsGroup } from "@/components/ui/SettingsGroup";

export type JobModelState = "loading" | "empty" | "ready" | "failed";

/** `null` while the model list loads, `0` when none is downloaded. */
export function jobModelState(downloaded: number | null): JobModelState {
  if (downloaded === null) return "loading";
  return downloaded === 0 ? "empty" : "ready";
}

export interface JobModelGroupProps {
  role: "dictation" | "readAloud" | "cleanup";
  /** The group heading; the model group's own by default. */
  title?: string;
  state: JobModelState;
  manage: () => void;
  select: React.ReactNode;
  children?: React.ReactNode;
}

export function JobModelGroup({
  role,
  title: heading,
  state,
  manage,
  select,
  children,
}: JobModelGroupProps): React.JSX.Element {
  const { t } = useTranslation();
  const title = heading ?? t("settings.groups.model");
  if (state === "empty") {
    return (
      <div className="space-y-2">
        <h2 className="px-4 text-xs font-medium text-ink-3 uppercase tracking-wide">
          {title}
        </h2>
        <div className="flex flex-col items-center gap-3 px-4 py-6 text-center">
          <p className="text-sm text-ink-2">
            {t(`settings.jobModel.empty.${role}`)}
          </p>
          <Button variant="primary" onClick={manage}>
            {t("settings.jobModel.choose")}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <SettingsGroup title={title}>
      {state === "failed" ? (
        <div role="alert">
          <Alert>
            {role === "cleanup"
              ? t("settings.jobModel.failed.cleanup")
              : t("tts.errors.generic")}
          </Alert>
        </div>
      ) : state === "loading" ? (
        <p role="status" className="px-4 py-3 text-sm text-ink-2">
          {t("settings.jobModel.loading")}
        </p>
      ) : (
        <>
          <SettingContainer
            title={t("tts.model")}
            description={t(`settings.jobModel.help.${role}`)}
            grouped
          >
            <div className="flex items-center gap-2">
              {select}
              <Button variant="ghost" size="sm" onClick={manage}>
                {t("settings.jobModel.manage")}
              </Button>
            </div>
          </SettingContainer>
          {children}
        </>
      )}
    </SettingsGroup>
  );
}
