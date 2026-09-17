import { config } from "./config.js";
import { startTracing } from "./lib/tracing.js";

// Tracing hooks node:http as Fastify requires it, so the app is imported only after it is set up.
const tracing = startTracing({ endpoint: config.otlpEndpoint, apiPrefix: config.apiPrefix, version: process.env["PETTY_VERSION"] });
const { buildApp } = await import("./app.js");
const { startMetricsServer } = await import("./lib/metrics.js");
const { runMaintenance } = await import("./lib/maintenance.js");

const app = buildApp();
app.listen({ port: config.port, host: config.host }).then(async () => {
  app.log.info({ tracing, endpoint: tracing ? config.otlpEndpoint : null }, "tracing");
  if (config.metricsPort > 0) {
    await startMetricsServer(config.metricsPort, config.host);
    app.log.info({ port: config.metricsPort }, "metrics listening");
  }
  // Expired sessions and 30-day-old vault history are removed once an hour (SR-13, SR-2).
  const tick = () => runMaintenance().then((r) => app.log.info(r, "maintenance")).catch((err: unknown) => app.log.warn({ err: { name: (err as Error).name } }, "maintenance failed"));
  void tick();
  setInterval(tick, 60 * 60_000).unref();
}).catch((err: unknown) => {
  app.log.error({ err }, "api failed to start");
  process.exit(1);
});
