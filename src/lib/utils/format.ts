/** Bytes in a megabyte (MiB), as upstream model sizes (`size_mb`) and download speeds count them. */
export const BYTES_PER_MB = 1024 * 1024;

const BYTES_PER_DECIMAL_GB = 1e9;

/** Decimal size: MB under 1 GB (no decimals from 100), else GB (no decimals from 10); null when unknown. */
export const formatBytes = (bytes: number): string | null => {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return null;
  }

  const gb = bytes >= BYTES_PER_DECIMAL_GB;
  const value = gb ? bytes / BYTES_PER_DECIMAL_GB : bytes / 1e6;
  const digits = value >= (gb ? 10 : 100) ? 0 : 1;
  const formatter = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${formatter.format(value)} ${gb ? "GB" : "MB"}`;
};

export const UNKNOWN_SIZE = "Unknown size";

export const formatModelSize = (sizeMb: number | null | undefined): string =>
  (sizeMb ? formatBytes(sizeMb * BYTES_PER_MB) : null) ?? UNKNOWN_SIZE;
