import type { LLMPrompt, LocalLlmModelInfo } from "@/bindings";

/** The server a dictation is sent to for cleanup; null when cleanup stays on the device or the URL is not http(s). */
export function cleanupHost(
  providerId: string,
  baseUrl: string,
): string | null {
  if (providerId === "local_llm" || providerId === "apple_intelligence") {
    return null;
  }
  try {
    const url = new URL(baseUrl);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.host
      : null;
  } catch {
    return null;
  }
}

export function promptControls(
  providerId: string | undefined,
  model: Pick<LocalLlmModelInfo, "prompt_style"> | null | undefined,
  prompts: LLMPrompt[],
  selectedPromptId: string | null,
): { hidePrompts: boolean; showS1Controls: boolean; missingPrompt: boolean } {
  const local = providerId === "local_llm";
  const s1 = local && model?.prompt_style === "s1_control_line";
  const selected = prompts.find((prompt) => prompt.id === selectedPromptId);
  return {
    hidePrompts: local && (model === undefined || s1),
    showS1Controls: s1,
    missingPrompt:
      local &&
      model?.prompt_style === "plain_system_prompt" &&
      !selected?.prompt.replace(/\$\{output\}/gu, "").trim(),
  };
}
