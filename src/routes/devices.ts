import type { FastifyPluginAsync } from "fastify";
import type { FfmpegAvfoundationAdapter, CaptureFormat } from "../device/ffmpeg-adapter.js";
import {
  postprocessDocument,
  type RotateMode,
} from "../device/doc-postprocess.js";
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

function parseRotate(raw: unknown, defaultValue: RotateMode): RotateMode {
  if (raw === undefined || raw === null || raw === "") return defaultValue;
  const s = String(raw).toLowerCase();
  if (s === "auto" || s === "none" || s === "0" || s === "90" || s === "180" || s === "270") {
    return s;
  }
  throw new AppError(
    400,
    "INVALID_ROTATE",
    "rotate must be auto|0|90|180|270|none",
  );
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
      enhance?: string;
      autoLevel?: string;
      raw?: string;
      rotate?: string;
      warmupMs?: string;
    };
    Body:
      | {
          format?: string;
          width?: number;
          height?: number;
          autoCrop?: boolean;
          deskew?: boolean;
          enhance?: boolean;
          /** Alias of enhance (legacy). */
          autoLevel?: boolean;
          raw?: boolean;
          rotate?: string;
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
    const raw = parseBool(body.raw ?? req.query.raw, false);
    const enhanceExplicit = body.enhance ?? req.query.enhance ?? body.autoLevel ?? req.query.autoLevel;
    const enhance =
      enhanceExplicit === undefined || enhanceExplicit === null || enhanceExplicit === ""
        ? undefined
        : parseBool(enhanceExplicit, true);
    const rotate = parseRotate(
      body.rotate ?? req.query.rotate,
      autoCrop || deskew ? "auto" : "none",
    );
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
          enhanced: boolean;
          rotation: number;
          rotationDetected: number;
          rotationConfidence: number;
          rotationMethod: string;
          sharpness: number;
          focusNote: string;
          sourceWidth: number;
          sourceHeight: number;
        }
      | undefined;

    const wantsProcess =
      autoCrop ||
      deskew ||
      enhance === true ||
      (enhance !== false && !raw && (autoCrop || deskew));

    if (wantsProcess || (raw && (autoCrop || deskew))) {
      const processed = await postprocessDocument(captured.buffer, {
        autoCrop,
        deskew,
        enhance,
        raw,
        rotate,
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
        enhanced: processed.enhanced,
        rotation: processed.rotation,
        rotationDetected: processed.rotationDetected,
        rotationConfidence: processed.rotationConfidence,
        rotationMethod: processed.rotationMethod,
        sharpness: processed.sharpness,
        focusNote: processed.focusNote,
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
          backend: captured.backend,
          pixelFormat: captured.pixelFormat,
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
      .header("X-Capture-Backend", captured.backend)
      .header("X-Capture-Pixel-Format", captured.pixelFormat ?? "")
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
      .header("X-Postprocess-Enhanced", post ? String(post.enhanced) : "false")
      .header("X-Postprocess-Rotation", post ? String(post.rotation) : "0")
      .header(
        "X-Postprocess-Sharpness",
        post ? String(post.sharpness) : "",
      )
      .header("X-Postprocess-Focus", post?.focusNote ?? "")
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
