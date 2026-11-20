export type TtsDevice = "cpu" | "gpu" | "npu";
export type TtsRunOn = "auto" | TtsDevice;
export interface DeviceRating {
  supported: boolean;
  placement: Record<string, TtsDevice>;
  first_audio_p95_s: number | null;
  rtf_1x: number | null;
  rtf_2x: number | null;
  load_s_cold: number | null;
  load_s_cached: number | null;
  speed_score: number | null;
  recommended: boolean;
}
export interface ModelRating {
  quality: number;
  devices: Record<TtsDevice, DeviceRating>;
}
export function runOnChoices(available: readonly TtsDevice[]): TtsRunOn[] {
  return ["auto", ...available];
}
