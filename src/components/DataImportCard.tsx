import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands, type DataImportReport } from "@/bindings";
import { Button } from "@/components/ui/Button";
import { formatBytes } from "@/lib/utils/format";

interface DataImportCardViewProps {
  report: DataImportReport;
  /** Whether this app starts at login now (the copy turns it off). */
  startsAtLogin: boolean;
  onStartAtLogin: () => void;
  onDismiss: () => void;
}

/**
 * The one-time result of the first-start data copy: what was copied and from
 * which folder (named by path only), or what failed and how to retry.
 */
export const DataImportCardView: React.FC<DataImportCardViewProps> = ({
  report,
  startsAtLogin,
  onStartAtLogin,
  onDismiss,
}) => {
  const { t } = useTranslation();
  const copied = report.status === "copied";
  return (
    <div
      role="status"
      className="w-full rounded-lg border border-line bg-surface px-4 py-3"
    >
      <p className="text-sm font-semibold text-text">
        {t(copied ? "dataImport.copiedTitle" : "dataImport.failedTitle")}
      </p>
      {copied ? (
        <div className="mt-1 flex flex-col gap-1 text-sm text-ink-2">
          <p>
            {t("dataImport.copiedBody", {
              size: formatBytes(report.bytesTotal) ?? "0 MB",
              from: report.from,
            })}
          </p>
          <p>{t("dataImport.shared")}</p>
          <p>{t("dataImport.oldAutostart")}</p>
        </div>
      ) : (
        <p className="mt-1 text-sm text-ink-2">
          {t("dataImport.failedBody", {
            error: report.error ?? "",
            from: report.from,
            to: report.to,
          })}
        </p>
      )}
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        {copied && !startsAtLogin && (
          <Button variant="secondary" size="sm" onClick={onStartAtLogin}>
            {t("dataImport.startAtLogin")}
          </Button>
        )}
        <Button size="sm" surface="surface" onClick={onDismiss}>
          {t("dataImport.ok")}
        </Button>
      </div>
    </div>
  );
};

/**
 * Loads the report once; renders nothing when there is none or it was
 * dismissed. The start-at-login state comes from the caller's settings store
 * (this module stays free of the store so its view renders in tests).
 */
const DataImportCard: React.FC<
  Pick<DataImportCardViewProps, "startsAtLogin" | "onStartAtLogin">
> = ({ startsAtLogin, onStartAtLogin }) => {
  const [report, setReport] = useState<DataImportReport | null>(null);

  useEffect(() => {
    commands
      .getDataImportReport()
      .then(setReport)
      .catch((e) => console.warn("Failed to read the data import report:", e));
  }, []);

  if (report === null) {
    return null;
  }

  return (
    <DataImportCardView
      report={report}
      startsAtLogin={startsAtLogin}
      onStartAtLogin={onStartAtLogin}
      onDismiss={async () => {
        const result = await commands.dismissDataImportReport();
        if (result.status === "error") {
          console.warn(
            "Failed to dismiss the data import report:",
            result.error,
          );
        }
        setReport(null);
      }}
    />
  );
};

export default DataImportCard;
