import React from "react";
import { Trans, useTranslation } from "react-i18next";
import type { OSType } from "@/lib/utils/keyboard";
import { Keycaps } from "../shared/Keycaps";
import { TextLink } from "../ui/TextLink";

/** All set's last line: the Read aloud shortcut, and a way on to its models. */
export function ReadAloudLine({
  binding,
  os,
  onChooseModel,
}: {
  binding: string | null;
  os: OSType;
  onChooseModel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <p data-read-aloud-line className="mt-[8px] mb-0 text-ink-2 text-pretty">
      {binding ? (
        <Trans
          i18nKey="onboarding.done.readAloud"
          components={{
            keys: (
              <Keycaps
                className="try-sub-keys"
                binding={binding}
                osType={os}
                size="line"
              />
            ),
          }}
        />
      ) : (
        t("onboarding.done.readAloudUnbound")
      )}{" "}
      <TextLink
        className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-logo-primary"
        onClick={onChooseModel}
      >
        {t("onboarding.done.chooseReadAloudModel")}
      </TextLink>
    </p>
  );
}
