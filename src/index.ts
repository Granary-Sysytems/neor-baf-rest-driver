import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

async function main() {
  const config = loadConfig();
  const app = await buildServer(config);
  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    `NEOR REST driver listening on http://${config.host}:${config.port} (target serial ${config.deviceSerial})`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
