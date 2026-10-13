import { config } from "./config.js";
import { startTracing } from "./lib/tracing.js";
import { otelResource } from "./lib/otel-resource.js";
import { startOtlpMetrics, startOtlpLogs } from "./lib/otel-push.js";

const version = process.env["PETTY_VERSION"];
// Tracing hooks node:http as Fastify requires it, and the pino instrumentation must patch pino before
// Fastify creates the logger, so the app is imported only after all telemetry is set up.
const otlpOn = config.otlpPush && config.otlpEndpoint !== "";
const tracing = startTracing({ endpoint: config.otlpEndpoint, apiPrefix: config.apiPrefix, version, deploymentEnv: config.deploymentEnv, logs: otlpOn });
// OTLP push for metrics and logs alongside the traces above; gated so it never fires at a traces-only endpoint.
const otlpResource = otelResource(version ?? "dev", config.deploymentEnv);
const push = otlpOn
  ? { metrics: startOtlpMetrics({ endpoint: config.otlpEndpoint, resource: otlpResource }), logs: startOtlpLogs({ endpoint: config.otlpEndpoint, resource: otlpResource }) }
  : { metrics: false, logs: false };
const { buildApp } = await import("./app.js");
const { startMetricsServer } = await import("./lib/metrics.js");
const { startMaintenance } = await import("./lib/maintenance.js");

const app = buildApp();
app.listen({ port: config.port, host: config.host }).then(async () => {
  app.log.info({ tracing, endpoint: tracing ? config.otlpEndpoint : null, otlpPush: push, env: config.deploymentEnv || null }, "tracing");
  if (config.metricsPort > 0) {
    await startMetricsServer(config.metricsPort, config.host);
    app.log.info({ port: config.metricsPort }, "metrics listening");
  }
  // Expired sessions and 30-day-old vault history are removed (SR-13, SR-2): hourly while the database is in use, else daily (PETTY-355).
  startMaintenance(app.log);
}).catch((err: unknown) => {
  app.log.error({ err }, "api failed to start");
  process.exit(1);
});
