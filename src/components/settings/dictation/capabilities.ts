import type { ModelInfo } from "@/bindings";

/** Which capability rows the current dictation model offers. */
export function capabilityRows(
  model:
    | Pick<ModelInfo, "supports_language_selection" | "supports_translation">
    | undefined,
): { language: boolean; translate: boolean } {
  return {
    language: model?.supports_language_selection ?? false,
    translate: model?.supports_translation ?? false,
  };
}
