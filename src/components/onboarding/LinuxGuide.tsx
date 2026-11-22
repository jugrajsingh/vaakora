import React from "react";
import { Trans } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink } from "lucide-react";
import { TextLink } from "../ui/TextLink";
import { brand } from "@/lib/brand";

/**
 * Linux footer hint linking the setup guide; shortcuts and pasting vary by
 * desktop. Without a docs site (`docsUrl` null) the sentence stays and the
 * guide words are plain text.
 */
export const LinuxGuide: React.FC<{
  i18nKey: "onboarding.linux.tryIt" | "onboarding.linux.done";
  docsUrl?: string | null;
}> = ({ i18nKey, docsUrl = brand.links.docs }) => (
  <Trans
    i18nKey={i18nKey}
    components={{
      guide: docsUrl === null ? <span /> : <GuideLink url={docsUrl} />,
    }}
  />
);

const GuideLink: React.FC<{ url: string; children?: React.ReactNode }> = ({
  url,
  children,
}) => (
  <TextLink
    className="inline-flex items-center gap-[3px]"
    onClick={() => openUrl(url).catch(console.error)}
  >
    {children}
    <ExternalLink className="size-[11px]" aria-hidden="true" />
  </TextLink>
);
