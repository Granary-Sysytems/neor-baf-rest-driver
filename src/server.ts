import Fastify from "fastify";
import type { AppConfig } from "./config.js";
import { FfmpegAvfoundationAdapter } from "./device/ffmpeg-adapter.js";
import { AppError, toErrorBody } from "./errors.js";
import { buildOpenApi } from "./openapi.js";
import { deviceRoutes } from "./routes/devices.js";
import { healthRoutes } from "./routes/health.js";

export async function buildServer(config: AppConfig) {
  const app = Fastify({
    logger: true,
  });

  const adapter = new FfmpegAvfoundationAdapter(config);

  app.setErrorHandler((err, _req, reply) => {
    const status =
      err instanceof AppError
        ? err.statusCode
        : typeof (err as { statusCode?: number }).statusCode === "number"
          ? (err as { statusCode: number }).statusCode
          : 500;
    const body =
      err instanceof AppError
        ? err.toJSON()
        : toErrorBody(err);
    if (status >= 500) {
      app.log.error(err);
    }
    reply.status(status).send(body);
  });

  await app.register(healthRoutes);
  await app.register(deviceRoutes, { adapter });

  app.get("/openapi.json", async () =>
    buildOpenApi({ title: "NEOR BAF REST Driver", version: "1.0.0" }),
  );

  return app;
}
