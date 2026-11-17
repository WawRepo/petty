import { config } from "./config.js";
import { startTracing } from "./lib/tracing.js";
import { otelResource } from "./lib/otel-resource.js";
import { endpointForLog, startOtlpMetrics, startOtlpLogs } from "./lib/otel-push.js";

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
const { checkEmailKeys, EmailKeyError } = await import("./lib/email-seal.js");
const { bgPool } = await import("./db.js");

const app = buildApp();
// PETTY-418: the image starts this file as node itself, the container's first process, and Linux gives
// that process no default action for a signal. Without this, a stop would be ignored until the grace
// period is over and the container is killed. Stop taking requests, let the open ones finish, leave.
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, "stopping");
    setTimeout(() => process.exit(0), 8_000).unref(); // a request that never ends must not hold the stop
    void app.close().catch(() => undefined).then(() => process.exit(0));
  });
}

/**
 * PETTY-359: stored emails sealed with a key this instance does not have (EMAIL_KEY missing or wrong) stop
 * it: sign-in by address and every mail would fail. Checked before the API listens when the database
 * answers within a few seconds, else again every 5 s once it listens; housekeeping (which seals and
 * re-seals rows) starts only after the check passed. A bad EMAIL_KEY value stops it the same way.
 */
async function emailKeysChecked(): Promise<boolean> {
  try {
    await Promise.race([checkEmailKeys(bgPool), new Promise((_, no) => setTimeout(() => no(new Error("timeout")), 5_000).unref())]);
    return true;
  } catch (err) {
    if (err instanceof EmailKeyError) {
      app.log.error({ err: { name: err.name, message: err.message } }, "email key check failed");
      process.exit(1);
    }
    return false; // the database does not answer yet
  }
}
const emailKeysOk = await emailKeysChecked();

app.listen({ port: config.port, host: config.host }).then(async () => {
  app.log.info({ tracing, endpoint: tracing ? endpointForLog(config.otlpEndpoint) : null, otlpPush: push, env: config.deploymentEnv || null }, "tracing");
  if (config.metricsPort > 0) {
    await startMetricsServer(config.metricsPort, config.host);
    app.log.info({ port: config.metricsPort }, "metrics listening");
  }
  // Expired sessions and 30-day-old vault history are removed (SR-13, SR-2): hourly while the database is in use, else daily (PETTY-355).
  if (emailKeysOk) startMaintenance(app.log);
  else {
    app.log.warn("email key check waits for the database");
    const retry = setInterval(() => {
      void emailKeysChecked().then((ok) => { if (ok) { clearInterval(retry); startMaintenance(app.log); } });
    }, 5_000);
  }
}).catch((err: unknown) => {
  app.log.error({ err }, "api failed to start");
  process.exit(1);
});
