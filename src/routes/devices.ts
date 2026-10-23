import type { FastifyPluginAsync } from "fastify";
import type { FfmpegAvfoundationAdapter, CaptureFormat } from "../device/ffmpeg-adapter.js";
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
    Querystring: { format?: string; width?: string; height?: string };
    Body: { format?: string; width?: number; height?: number } | undefined;
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

    const captured = await adapter.capture({
      serial: req.params.serial,
      format,
      width,
      height,
    });

    if (wantsJson(req.headers.accept)) {
      return {
        format: captured.format,
        contentType: captured.contentType,
        width: captured.width,
        height: captured.height,
        serial: captured.device.serial,
        encoding: "base64",
        data: captured.buffer.toString("base64"),
      };
    }

    return reply
      .header("Content-Type", captured.contentType)
      .header("X-Device-Serial", captured.device.serial)
      .header("X-Image-Width", String(captured.width))
      .header("X-Image-Height", String(captured.height))
      .send(captured.buffer);
  });
};
