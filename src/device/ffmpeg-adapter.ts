import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AppConfig } from "../config.js";
import { AppError } from "../errors.js";

const execFileAsync = promisify(execFile);

export type VideoDevice = {
  index: number;
  name: string;
  /** Canonical API serial (label / DEVICE_SERIAL when matched). */
  serial: string;
  /** USB iSerial from IOKit when available. */
  usbSerial: string | null;
  vendorId: number | null;
  productId: number | null;
  uniqueId: string | null;
  isTarget: boolean;
  supportedModes: CaptureMode[];
};

export type CaptureMode = {
  width: number;
  height: number;
  fps: number;
};

export type CaptureFormat = "jpeg" | "png";

export type CaptureResult = {
  buffer: Buffer;
  contentType: string;
  width: number;
  height: number;
  format: CaptureFormat;
  device: VideoDevice;
  warmupMs: number;
  warmupFrames: number;
  /** Mean gray luminance of the kept frame (0–255), when measurable. */
  meanLuminance: number | null;
};

type UsbCameraInfo = {
  productName: string;
  usbSerial: string | null;
  vendorId: number | null;
  productId: number | null;
  locationId: number | null;
};

type SystemCameraInfo = {
  name: string;
  modelId: string | null;
  uniqueId: string | null;
};

function parseVendorProduct(modelId: string | null): {
  vendorId: number | null;
  productId: number | null;
} {
  if (!modelId) return { vendorId: null, productId: null };
  const m = modelId.match(/VendorID_(\d+)\s+ProductID_(\d+)/i);
  if (!m) return { vendorId: null, productId: null };
  return {
    vendorId: Number.parseInt(m[1], 10),
    productId: Number.parseInt(m[2], 10),
  };
}

async function listUsbCameras(): Promise<UsbCameraInfo[]> {
  try {
    const { stdout } = await execFileAsync(
      "ioreg",
      ["-p", "IOUSB", "-l", "-w", "0"],
      { maxBuffer: 20 * 1024 * 1024 },
    );
    const blocks = stdout.split(/^\s*\+-o\s+/m).slice(1);
    const cameras: UsbCameraInfo[] = [];
    for (const block of blocks) {
      const nameMatch = block.match(/^([^\s@<]+)/);
      const product =
        block.match(/"USB Product Name"\s*=\s*"([^"]+)"/)?.[1] ??
        block.match(/"kUSBProductString"\s*=\s*"([^"]+)"/)?.[1] ??
        nameMatch?.[1] ??
        "";
      const classHint = block.match(/"bDeviceClass"\s*=\s*(\d+)/)?.[1];
      const looksCamera =
        /camera|uvc|neor|nw\s*500/i.test(product) ||
        /camera|uvc/i.test(block.slice(0, 200)) ||
        classHint === "239";
      if (!looksCamera && !/USB Camera/i.test(product)) continue;

      const usbSerial =
        block.match(/"USB Serial Number"\s*=\s*"([^"]+)"/)?.[1] ??
        block.match(/"kUSBSerialNumberString"\s*=\s*"([^"]+)"/)?.[1] ??
        null;
      const vendorIdRaw = block.match(/"idVendor"\s*=\s*(\d+)/)?.[1];
      const productIdRaw = block.match(/"idProduct"\s*=\s*(\d+)/)?.[1];
      const locationIdRaw = block.match(/"locationID"\s*=\s*(\d+)/)?.[1];

      cameras.push({
        productName: product || "USB Camera",
        usbSerial,
        vendorId: vendorIdRaw ? Number.parseInt(vendorIdRaw, 10) : null,
        productId: productIdRaw ? Number.parseInt(productIdRaw, 10) : null,
        locationId: locationIdRaw ? Number.parseInt(locationIdRaw, 10) : null,
      });
    }
    return cameras;
  } catch {
    return [];
  }
}

async function listSystemCameras(): Promise<SystemCameraInfo[]> {
  try {
    const { stdout } = await execFileAsync(
      "system_profiler",
      ["SPCameraDataType", "-json"],
      { maxBuffer: 5 * 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout) as {
      SPCameraDataType?: Array<Record<string, string>>;
    };
    return (parsed.SPCameraDataType ?? []).map((cam) => ({
      name: cam._name ?? "Unknown",
      modelId: cam["spcamera_model-id"] ?? null,
      uniqueId: cam["spcamera_unique-id"] ?? null,
    }));
  } catch {
    return [];
  }
}

/** Approximate mean gray luminance via ffmpeg raw gray downsample. */
async function meanLuminanceOfImage(
  ffmpegPath: string,
  imagePath: string,
): Promise<number | null> {
  try {
    const result = await runFfmpeg(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        imagePath,
        "-vf",
        "scale=160:-1,format=gray",
        "-f",
        "rawvideo",
        "-",
      ],
      8_000,
    );
    if (result.code !== 0 || !result.stdoutBinary?.length) return null;
    const buf = result.stdoutBinary;
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i]!;
    return Math.round((sum / buf.length) * 100) / 100;
  } catch {
    return null;
  }
}

async function runFfmpeg(
  ffmpegPath: string,
  args: string[],
  timeoutMs: number,
): Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  stdoutBinary?: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}` },
    });
    const stdoutChunks: Buffer[] = [];
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new AppError(
          504,
          "CAPTURE_TIMEOUT",
          `FFmpeg timed out after ${timeoutMs}ms (check macOS Camera permission for Terminal/Node)`,
        ),
      );
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      stdoutChunks.push(d);
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdoutBinary = Buffer.concat(stdoutChunks);
      resolve({
        stdout: stdoutBinary.toString("utf8"),
        stderr,
        code,
        stdoutBinary,
      });
    });
  });
}

function parseAvfoundationDevices(stderr: string): Array<{ index: number; name: string }> {
  const lines = stderr.split(/\r?\n/);
  const devices: Array<{ index: number; name: string }> = [];
  let inVideo = false;
  for (const line of lines) {
    if (/AVFoundation video devices:/i.test(line)) {
      inVideo = true;
      continue;
    }
    if (/AVFoundation audio devices:/i.test(line)) {
      inVideo = false;
      continue;
    }
    if (!inVideo) continue;
    const m = line.match(/\[(\d+)\]\s+(.+)$/);
    if (m) {
      devices.push({ index: Number.parseInt(m[1], 10), name: m[2].trim() });
    }
  }
  return devices;
}

function parseSupportedModes(stderr: string): CaptureMode[] {
  const modes: CaptureMode[] = [];
  const re = /(\d+)x(\d+)@\[([0-9.]+)\s+[0-9.]+\]fps/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr)) !== null) {
    modes.push({
      width: Number.parseInt(m[1], 10),
      height: Number.parseInt(m[2], 10),
      fps: Number.parseFloat(m[3]),
    });
  }
  // de-dupe by width/height keeping max fps
  const map = new Map<string, CaptureMode>();
  for (const mode of modes) {
    const key = `${mode.width}x${mode.height}`;
    const prev = map.get(key);
    if (!prev || mode.fps > prev.fps) map.set(key, mode);
  }
  return [...map.values()].sort(
    (a, b) => b.width * b.height - a.width * a.height || b.fps - a.fps,
  );
}

function pickBestMode(
  modes: CaptureMode[],
  preferredWidth: number,
  preferredHeight: number,
  preferredFps: number,
): CaptureMode {
  if (modes.length === 0) {
    return {
      width: preferredWidth,
      height: preferredHeight,
      fps: preferredFps,
    };
  }
  const exact = modes.find(
    (m) => m.width === preferredWidth && m.height === preferredHeight,
  );
  if (exact) return exact;
  // Prefer largest mode that is not the known-flaky 2592x1944 still mode.
  const stable = modes.filter((m) => !(m.width === 2592 && m.height === 1944));
  return (stable[0] ?? modes[0])!;
}

function dedupeSizes(sizes: CaptureMode[]): CaptureMode[] {
  const seen = new Set<string>();
  const out: CaptureMode[] = [];
  for (const s of sizes) {
    const key = `${s.width}x${s.height}@${s.fps}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function isScreenDevice(name: string): boolean {
  return /capture screen|screen/i.test(name);
}

function isBuiltinFaceTime(name: string): boolean {
  return /facetime/i.test(name);
}

function matchesTarget(
  config: AppConfig,
  opts: {
    name: string;
    usbSerial: string | null;
    vendorId: number | null;
  },
): boolean {
  if (opts.usbSerial) {
    if (
      opts.usbSerial === config.deviceSerial ||
      (config.deviceUsbSerial && opts.usbSerial === config.deviceUsbSerial)
    ) {
      return true;
    }
  }
  if (
    config.deviceNameMatch &&
    opts.name.toLowerCase().includes(config.deviceNameMatch.toLowerCase()) &&
    !isBuiltinFaceTime(opts.name) &&
    !isScreenDevice(opts.name)
  ) {
    return true;
  }
  // NEOR NW 500 observed as VendorID 48149 (0xBC15)
  if (opts.vendorId === 48149) return true;
  return false;
}

export class FfmpegAvfoundationAdapter {
  constructor(private readonly config: AppConfig) {}

  async listDevices(): Promise<VideoDevice[]> {
    const [av, usb, sys] = await Promise.all([
      this.listAvfoundationVideoDevices(),
      listUsbCameras(),
      listSystemCameras(),
    ]);

    const devices: VideoDevice[] = [];
    for (const avDev of av) {
      if (isScreenDevice(avDev.name)) continue;

      const sysMatch =
        sys.find((s) => s.name === avDev.name) ??
        sys.find(
          (s) =>
            !isBuiltinFaceTime(avDev.name) &&
            /UVC Camera/i.test(s.modelId ?? "") &&
            !isBuiltinFaceTime(s.name),
        );

      const { vendorId: modelVid, productId: modelPid } = parseVendorProduct(
        sysMatch?.modelId ?? null,
      );

      const usbMatch =
        usb.find(
          (u) =>
            (modelVid !== null && u.vendorId === modelVid && u.productId === modelPid) ||
            (!isBuiltinFaceTime(avDev.name) &&
              /camera/i.test(u.productName) &&
              /usb/i.test(avDev.name)),
        ) ??
        (!isBuiltinFaceTime(avDev.name)
          ? usb.find((u) => /camera/i.test(u.productName))
          : undefined);

      const usbSerial = usbMatch?.usbSerial ?? null;
      const vendorId = usbMatch?.vendorId ?? modelVid;
      const productId = usbMatch?.productId ?? modelPid;
      const isTarget = matchesTarget(this.config, {
        name: avDev.name,
        usbSerial,
        vendorId,
      });

      const serial = isTarget
        ? this.config.deviceSerial
        : (usbSerial ?? `avfoundation-${avDev.index}`);

      devices.push({
        index: avDev.index,
        name: avDev.name,
        serial,
        usbSerial,
        vendorId,
        productId,
        uniqueId: sysMatch?.uniqueId ?? null,
        isTarget,
        // Modes are probed lazily on get/capture to avoid Camera TCC hangs on list.
        supportedModes: [],
      });
    }

    return devices;
  }

  async getDevice(serial: string): Promise<VideoDevice> {
    const devices = await this.listDevices();
    const found = devices.find(
      (d) =>
        d.serial === serial ||
        d.usbSerial === serial ||
        (serial === this.config.deviceSerial && d.isTarget),
    );
    if (!found) {
      throw new AppError(
        404,
        "DEVICE_NOT_FOUND",
        `Device with serial '${serial}' not found`,
      );
    }
    found.supportedModes = await this.probeModes(found.index);
    return found;
  }

  async capture(opts: {
    serial: string;
    format: CaptureFormat;
    width?: number;
    height?: number;
    /** Override default CAPTURE_WARMUP_MS (UVC AE settle). */
    warmupMs?: number;
  }): Promise<CaptureResult> {
    const device = await this.getDevice(opts.serial);
    const modes =
      device.supportedModes.length > 0
        ? device.supportedModes
        : await this.probeModes(device.index);

    const preferredWidth = opts.width ?? this.config.captureDefaultWidth;
    const preferredHeight = opts.height ?? this.config.captureDefaultHeight;
    const mode = pickBestMode(
      modes,
      preferredWidth,
      preferredHeight,
      this.config.captureFramerate,
    );

    // If caller asked for specific size not in modes, still try requested size first
    const width = opts.width ?? mode.width;
    const height = opts.height ?? mode.height;
    const fps = mode.fps || this.config.captureFramerate;
    const warmupMs = Math.max(
      0,
      opts.warmupMs ?? this.config.captureWarmupMs,
    );
    // Grab N frames and keep the last (-update 1) so AE can converge.
    const warmupFrames = Math.max(1, Math.ceil((warmupMs / 1000) * fps) || 1);

    const dir = await mkdtemp(join(tmpdir(), "neor-capture-"));
    const ext = opts.format === "png" ? "png" : "jpg";
    const outPath = join(dir, `frame.${ext}`);
    const frameArgs =
      opts.format === "png"
        ? ["-frames:v", String(warmupFrames), "-update", "1", "-f", "image2", outPath]
        : [
            "-frames:v",
            String(warmupFrames),
            "-update",
            "1",
            "-q:v",
            "2",
            "-f",
            "image2",
            outPath,
          ];

    // Prefer AVFoundation device name — indices reorder; name is stable for UVC.
    const input = `${device.name}:none`;
    const sizeCandidates = dedupeSizes([
      { width, height, fps },
      { width: mode.width, height: mode.height, fps: mode.fps || this.config.captureFramerate },
      // Prefer landscape modes that actually capture on this unit; skip flaky 2592x1944.
      ...modes.filter((m) => !(m.width === 2592 && m.height === 1944)),
      { width: 2560, height: 1440, fps: 10 },
      { width: 1920, height: 1080, fps: 10 },
      { width: 1280, height: 720, fps: 10 },
      { width: 640, height: 480, fps: 10 },
    ]);

    try {
      let lastErr = "";
      for (const size of sizeCandidates) {
        const args = [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-f",
          "avfoundation",
          "-pixel_format",
          "uyvy422",
          "-framerate",
          String(size.fps),
          "-video_size",
          `${size.width}x${size.height}`,
          "-i",
          input,
          ...frameArgs,
        ];
        const timeoutMs = Math.min(
          this.config.captureTimeoutMs,
          Math.max(12_000, warmupMs + 10_000),
        );
        try {
          const result = await runFfmpeg(
            this.config.ffmpegPath,
            args,
            timeoutMs,
          );
          if (result.code === 0) {
            const buffer = await readFile(outPath);
            if (buffer.length === 0) {
              throw new AppError(500, "CAPTURE_EMPTY", "Captured image is empty");
            }
            const meanLuminance = await meanLuminanceOfImage(
              this.config.ffmpegPath,
              outPath,
            );
            return {
              buffer,
              contentType: opts.format === "png" ? "image/png" : "image/jpeg",
              width: size.width,
              height: size.height,
              format: opts.format,
              device,
              warmupMs,
              warmupFrames,
              meanLuminance,
            };
          }
          lastErr = result.stderr || `exit ${result.code}`;
        } catch (err) {
          if (err instanceof AppError && err.code === "CAPTURE_TIMEOUT") {
            lastErr = err.message;
            continue;
          }
          throw err;
        }
      }

      throw new AppError(
        500,
        "CAPTURE_FAILED",
        `FFmpeg capture failed: ${lastErr || "unknown error"}`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async listAvfoundationVideoDevices(): Promise<
    Array<{ index: number; name: string }>
  > {
    try {
      const result = await runFfmpeg(
        this.config.ffmpegPath,
        ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
        15_000,
      );
      return parseAvfoundationDevices(result.stderr);
    } catch (err) {
      if (err instanceof AppError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      if (/ENOENT|not found/i.test(message)) {
        throw new AppError(
          500,
          "FFMPEG_NOT_FOUND",
          `ffmpeg not found at '${this.config.ffmpegPath}'. Install via brew install ffmpeg.`,
        );
      }
      throw new AppError(500, "DEVICE_LIST_FAILED", message);
    }
  }

  private async probeModes(index: number): Promise<CaptureMode[]> {
    // Request an unsupported size so ffmpeg prints Supported modes
    try {
      const result = await runFfmpeg(
        this.config.ffmpegPath,
        [
          "-hide_banner",
          "-f",
          "avfoundation",
          "-framerate",
          "30",
          "-video_size",
          "3264x2448",
          "-i",
          `${index}:none`,
          "-frames:v",
          "1",
          "-f",
          "null",
          "-",
        ],
        12_000,
      );
      const modes = parseSupportedModes(result.stderr);
      if (modes.length > 0) return modes;
    } catch (err) {
      if (err instanceof AppError && err.code === "CAPTURE_TIMEOUT") {
        // Permission hang — return defaults without failing list
        return [
          {
            width: this.config.captureDefaultWidth,
            height: this.config.captureDefaultHeight,
            fps: this.config.captureFramerate,
          },
        ];
      }
    }
    return [
      {
        width: this.config.captureDefaultWidth,
        height: this.config.captureDefaultHeight,
        fps: this.config.captureFramerate,
      },
    ];
  }
}

/** Persist probe text for smoke artifacts (non-API helper). */
export async function writeTextArtifact(
  path: string,
  content: string,
): Promise<void> {
  await writeFile(path, content, "utf8");
}
