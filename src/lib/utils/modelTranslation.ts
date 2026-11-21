import type { TFunction } from "i18next";
import { catalog } from "@handy-computer/models";
import type { ModelInfo } from "@/bindings";
import { repoIdOf } from "@/lib/models/retired";

/** A catalog id as an i18n key part: i18next splits keys on "." and ":". */
export const translationKeyId = (id: string): string =>
  id.replace(/[^A-Za-z0-9_-]/g, "_");

/** Catalog ids by repo, so every quant of a model shares its description. */
const CATALOG_ID_BY_REPO = new Map(
  catalog.models.map((m) => [m.repository, m.id] as const),
);

/**
 * Get the translated name for a model
 * @param model - The model info object
 * @param t - The translation function from useTranslation
 * @returns The translated model name, or the original name if no translation exists
 */
export function getTranslatedModelName(model: ModelInfo, t: TFunction): string {
  const translationKey = `onboarding.models.${model.id}.name`;
  const translated = t(translationKey, { defaultValue: "" });
  return translated !== "" ? translated : model.name;
}

/**
 * Get the translated description for a model
 * @param model - The model info object
 * @param t - The translation function from useTranslation
 * @returns The translated model description, or the original description if no translation exists
 */
export function getTranslatedModelDescription(
  model: ModelInfo,
  t: TFunction,
): string {
  // Custom models use a generic translation key
  if (model.is_custom) {
    return t("onboarding.customModelDescription");
  }
  const repo = repoIdOf(model);
  const keyId = translationKeyId(
    (repo && CATALOG_ID_BY_REPO.get(repo)) || model.id,
  );
  const translationKey = `onboarding.models.${keyId}.description`;
  const translated = t(translationKey, { defaultValue: "" });
  return translated !== "" ? translated : model.description;
}
