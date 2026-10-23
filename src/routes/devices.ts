import type { FastifyPluginAsync } from "fastify";
import type { FfmpegAvfoundationAdapter, CaptureFormat } from "../device/ffmpeg-adapter.js";
import { postprocessDocument } from "../device/doc-postprocess.js";
import { AppError } from "../errors.js";

type DeviceRoutesOpts = {
  adapter: FfmpegAvfoundationAdapter;
};

function wantsJson(acceptHeader: string | undefined): boolean {
  if (!acceptHeader) return false;
  const accept = acceptHeader.toLowerCase();
  if (accept.includes("application/json")) return true;
  if (accept.includes("image/")) return false;
  return false;
}

function parseFormat(raw: unknown): CaptureFormat {
  if (raw === undefined || raw === null || raw === "") return "jpeg";
  if (raw === "jpeg" || raw === "jpg") return "jpeg";
  if (raw === "png") return "png";
  throw new AppError(400, "INVALID_FORMAT", "format must be jpeg or png");
}

function parseOptionalPositiveInt(raw: unknown, field: string): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new AppError(400, "INVALID_DIMENSION", `${field} must be a positive integer`);
  }
  return Math.trunc(n);
}

function parseBool(raw: unknown, defaultValue = false): boolean {
  if (raw === undefined || raw === null || raw === "") return defaultValue;
  if (typeof raw === "boolean") return raw;
  const s = String(raw).toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  throw new AppError(400, "INVALID_BOOLEAN", `expected boolean, got '${String(raw)}'`);
}

export const deviceRoutes: FastifyPluginAsync<DeviceRoutesOpts> = async (
  app,
  opts,
) => {
  const { adapter } = opts;

  app.get("/api/v1/devices", async () => {
    const devices = await adapter.listDevices();
    return { devices };
  });

  app.get<{ Params: { serial: string } }>(
    "/api/v1/devices/:serial",
    async (req) => {
      return adapter.getDevice(req.params.serial);
    },
  );

  app.post<{
    Params: { serial: string };
    Querystring: {
      format?: string;
      width?: string;
      height?: string;
      autoCrop?: string;
      deskew?: string;
      autoLevel?: string;
      warmupMs?: string;
    };
    Body:
      | {
          format?: string;
          width?: number;
          height?: number;
          autoCrop?: boolean;
          deskew?: boolean;
          autoLevel?: boolean;
          warmupMs?: number;
          /** Not settable on macOS AVFoundation — accepted and ignored. */
          brightness?: number;
          exposure?: number;
        }
      | undefined;
  }>("/api/v1/devices/:serial/capture", async (req, reply) => {
    const body = req.body ?? {};
    const format = parseFormat(body.format ?? req.query.format);
    const width = parseOptionalPositiveInt(
      body.width ?? req.query.width,
      "width",
    );
    const height = parseOptionalPositiveInt(
      body.height ?? req.query.height,
      "height",
    );
    const autoCrop = parseBool(body.autoCrop ?? req.query.autoCrop, false);
    const deskew = parseBool(body.deskew ?? req.query.deskew, false);
    const autoLevel = parseBool(body.autoLevel ?? req.query.autoLevel, false);
    const warmupMsRaw = body.warmupMs ?? req.query.warmupMs;
    let warmupMs: number | undefined;
    if (warmupMsRaw !== undefined && warmupMsRaw !== null && warmupMsRaw !== "") {
      const n =
        typeof warmupMsRaw === "number"
          ? warmupMsRaw
          : Number.parseInt(String(warmupMsRaw), 10);
      if (!Number.isFinite(n) || n < 0) {
        throw new AppError(400, "INVALID_WARMUP", "warmupMs must be >= 0");
      }
      warmupMs = Math.trunc(n);
    }

    // brightness/exposure: probed — not available via ffmpeg avfoundation / no uvc-util on brew.
    if (body.brightness !== undefined || body.exposure !== undefined) {
      reply.header("X-Uvc-Controls", "unsupported");
    }

    let captured = await adapter.capture({
      serial: req.params.serial,
      format,
      width,
      height,
      warmupMs,
    });

    let post:
      | {
          applied: boolean;
          method: string;
          confidence: number;
          reason: string;
          sourceWidth: number;
          sourceHeight: number;
        }
      | undefined;

    if (autoCrop || deskew || autoLevel) {
      const processed = await postprocessDocument(captured.buffer, {
        autoCrop,
        deskew,
        autoLevel,
        format,
      });
      captured = {
        ...captured,
        buffer: processed.buffer,
        width: processed.width,
        height: processed.height,
      };
      post = {
        applied: processed.applied,
        method: processed.method,
        confidence: processed.confidence,
        reason: processed.reason,
        sourceWidth: processed.sourceWidth,
        sourceHeight: processed.sourceHeight,
      };
    }

    if (wantsJson(req.headers.accept)) {
      return {
        format: captured.format,
        contentType: captured.contentType,
        width: captured.width,
        height: captured.height,
        serial: captured.device.serial,
        encoding: "base64",
        data: captured.buffer.toString("base64"),
        capture: {
          warmupMs: captured.warmupMs,
          warmupFrames: captured.warmupFrames,
          meanLuminance: captured.meanLuminance,
        },
        postprocess: post,
      };
    }

    return reply
      .header("Content-Type", captured.contentType)
      .header("X-Device-Serial", captured.device.serial)
      .header("X-Image-Width", String(captured.width))
      .header("X-Image-Height", String(captured.height))
      .header("X-Capture-Warmup-Ms", String(captured.warmupMs))
      .header("X-Capture-Warmup-Frames", String(captured.warmupFrames))
      .header(
        "X-Capture-Mean-Luminance",
        captured.meanLuminance != null ? String(captured.meanLuminance) : "",
      )
      .header("X-Postprocess-Applied", post ? String(post.applied) : "false")
      .header("X-Postprocess-Method", post?.method ?? "none")
      .header(
        "X-Postprocess-Confidence",
        post ? String(post.confidence) : "",
      )
      .header("X-Postprocess-Reason", post?.reason ?? "")
      .send(captured.buffer);
  });

  /**
   * Camera LED / lamp control.
   * On macOS UVC path this is unsupported (vendor Set_Light_A/B is Windows OCX only).
   */
  app.post<{
    Params: { serial: string };
    Body: { on?: boolean; mode?: string } | undefined;
  }>("/api/v1/devices/:serial/light", async (req) => {
    // Ensure device exists / is resolvable
    await adapter.getDevice(req.params.serial);

    const body = req.body ?? {};
    const modeRaw = body.mode;
    const on = body.on;

    if (modeRaw !== undefined && modeRaw !== null && modeRaw !== "") {
      const mode = String(modeRaw).toUpperCase();
      if (!["A", "B", "OFF", "ON"].includes(mode)) {
        throw new AppError(
          400,
          "INVALID_LIGHT_MODE",
          "mode must be A, B, ON, or OFF (vendor OCX naming)",
        );
      }
    } else if (on === undefined) {
      throw new AppError(
        400,
        "INVALID_LIGHT_REQUEST",
        'provide { "on": true|false } or { "mode": "A"|"B"|"off" }',
      );
    }

    throw new AppError(
      501,
      "LIGHT_UNSUPPORTED",
      "Camera LED/lamp control is not available on the macOS UVC path. " +
        "Vendor APIs Set_Light_A / Set_Light_B exist only in Windows OCX (Cam_OcxTwo). " +
        "See internal design note for a Windows sidecar option.",
    );
  });
};
