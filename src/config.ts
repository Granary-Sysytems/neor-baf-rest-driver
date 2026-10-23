export type AppConfig = {
  host: string;
  port: number;
  deviceSerial: string;
  deviceUsbSerial: string | null;
  deviceNameMatch: string;
  ffmpegPath: string;
  captureDefaultWidth: number;
  captureDefaultHeight: number;
  captureFramerate: number;
  captureTimeoutMs: number;
  /** Discard frames for this long so UVC auto-exposure can converge. */
  captureWarmupMs: number;
};

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid integer for ${name}: ${raw}`);
  }
  return n;
}

export function loadConfig(): AppConfig {
  return {
    host: process.env.HOST ?? "127.0.0.1",
    port: intEnv("PORT", 8787),
    deviceSerial: process.env.DEVICE_SERIAL ?? "DK50P30000422",
    deviceUsbSerial: process.env.DEVICE_USB_SERIAL?.trim() || "SN0001",
    deviceNameMatch: process.env.DEVICE_NAME_MATCH ?? "USB",
    ffmpegPath: process.env.FFMPEG_PATH ?? "ffmpeg",
    // 2592x1944 is advertised but hangs on this NW 500 via AVFoundation; 2560x1440 works.
    captureDefaultWidth: intEnv("CAPTURE_DEFAULT_WIDTH", 2560),
    captureDefaultHeight: intEnv("CAPTURE_DEFAULT_HEIGHT", 1440),
    captureFramerate: intEnv("CAPTURE_FRAMERATE", 10),
    captureTimeoutMs: intEnv("CAPTURE_TIMEOUT_MS", 30_000),
    // ~1.8s at 10fps ≈ 18 frames; cold-start AE climbs for ~2–3s on this UVC unit.
    captureWarmupMs: intEnv("CAPTURE_WARMUP_MS", 1800),
  };
}
