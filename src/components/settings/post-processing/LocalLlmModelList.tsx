import React from "react";
import { useTranslation } from "react-i18next";
import type { LocalLlmModelInfo } from "@/bindings";
import { Button } from "../../ui/Button";
import { InlineConfirm } from "@/components/shared/InlineConfirm";
import { formatModelSize } from "@/lib/utils/format";
import { createLocalLlmRowActions } from "./localLlmRowActions";

export interface LocalLlmModelListProps {
  models: LocalLlmModelInfo[];
  selectedId: string | null;
  downloadId: string | null;
  percentage: number | null;
  deletingId: string | null;
  /** The model whose Delete was pressed: its row shows the question instead of its buttons. */
  askingId: string | null;
  onDownload: (id: string) => void;
  /** Asks; only `onConfirmDelete` deletes. */
  onDelete: (id: string) => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  onSelect: (id: string) => void;
}
export function LocalLlmModelList({
  models,
  selectedId,
  downloadId,
  percentage,
  deletingId,
  askingId,
  onDownload,
  onDelete,
  onConfirmDelete,
  onCancelDelete,
  onSelect,
}: LocalLlmModelListProps) {
  const { t } = useTranslation();
  return (
    <div className="divide-y divide-line">
      {models.map((model) => {
        const size = formatModelSize(model.size_bytes / 1e6);
        const actions = createLocalLlmRowActions(
          model,
          { selectedId, downloadId, deletingId },
          { onSelect, onDelete, onDownload },
        );
        return (
          <div
            key={model.id}
            data-confirm-row={model.id}
            className="px-4 py-3 flex flex-wrap items-center justify-between gap-2"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium">{model.display_name}</p>
              <p className="text-xs text-ink-3">{size}</p>
              {model.downloaded && (
                <span className="text-xs">
                  {t("settings.postProcessing.localLlm.downloaded")}
                </span>
              )}
              {actions.isActive && (
                <span className="text-xs ms-2">
                  {t("modelSelector.active")}
                </span>
              )}
            </div>
            {askingId === model.id && model.downloaded ? (
              <InlineConfirm
                message={t("settings.postProcessing.localLlm.deleteConfirm", {
                  name: model.display_name,
                  size,
                })}
                action={t(
                  "settings.postProcessing.localLlm.deleteConfirmAction",
                )}
                onCancel={onCancelDelete}
                onConfirm={onConfirmDelete}
              />
            ) : (
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!actions.canUse}
                  onClick={actions.use}
                >
                  {t("settings.postProcessing.localLlm.use")}
                </Button>
                {model.downloaded ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!actions.canDelete}
                    onClick={actions.delete}
                  >
                    {t("settings.postProcessing.localLlm.delete")}
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={!actions.canDownload}
                    onClick={actions.download}
                  >
                    {actions.isDownloading
                      ? t("settings.postProcessing.localLlm.downloading", {
                          percent: Math.round(percentage ?? 0),
                        })
                      : t("settings.postProcessing.localLlm.download")}
                  </Button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
