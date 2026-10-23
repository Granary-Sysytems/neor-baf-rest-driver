export type AppConfig = {
  host: string;
  port: number;
  deviceSerial: string;
  deviceUsbSerial: string | null;
  deviceNameMatch: string;
  ffmpegPath: string;
  imagesnapPath: string;
  /** auto = prefer imagesnap (correct color @ 2592x1944), else ffmpeg */
  captureBackend: "auto" | "imagesnap" | "ffmpeg";
  capturePixelFormat: string;
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
    imagesnapPath: process.env.IMAGESNAP_PATH ?? "imagesnap",
    captureBackend: (() => {
      const raw = (process.env.CAPTURE_BACKEND ?? "auto").toLowerCase();
      if (raw === "imagesnap" || raw === "ffmpeg" || raw === "auto") return raw;
      throw new Error(`Invalid CAPTURE_BACKEND: ${raw}`);
    })(),
    // nv12 avoids the green-cast uyvy422 path on this UVC unit; imagesnap preferred for color.
    capturePixelFormat: process.env.CAPTURE_PIXEL_FORMAT ?? "nv12",
    // 2592x1944 hangs via ffmpeg AVFoundation; imagesnap captures it correctly.
    // FFmpeg fallback default: 1280x720 — much better AE/color than 2560x1440 uyvy.
    captureDefaultWidth: intEnv("CAPTURE_DEFAULT_WIDTH", 1280),
    captureDefaultHeight: intEnv("CAPTURE_DEFAULT_HEIGHT", 720),
    captureFramerate: intEnv("CAPTURE_FRAMERATE", 10),
    captureTimeoutMs: intEnv("CAPTURE_TIMEOUT_MS", 30_000),
    // ~1.8s at 10fps ≈ 18 frames; cold-start AE climbs for ~2–3s on this UVC unit.
    captureWarmupMs: intEnv("CAPTURE_WARMUP_MS", 1800),
  };
}
