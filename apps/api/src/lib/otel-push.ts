import { metrics } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import type { Resource } from "@opentelemetry/resources";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { LoggerProvider, BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";

/**
 * OTLP push for metrics and logs (PETTY-92). Traces already push (lib/tracing.ts); this adds the other
 * two so one instance speaks OTLP for all three to a single endpoint, and two deployments can differ
 * only by that endpoint. It runs alongside the existing paths (Prometheus /metrics scrape, stdout
 * JSON logs), which stay the source of truth until parity is proven — nothing here removes them.
 *
 * Gated by `otlpPush`: while the endpoint still points at a traces-only receiver (Tempo), pushing metrics
 * or logs there would 404, so both stay off until the operator moves the endpoint to a full collector.
 */
const base = (endpoint: string, signal: string): string => `${endpoint.replace(/\/$/, "")}/v1/${signal}`;

let meterProvider: MeterProvider | null = null;
let loggerProvider: LoggerProvider | null = null;

/** Push the OTel metrics (see lib/metrics.ts) every 30 s. Returns false when disabled. */
export function startOtlpMetrics(opts: { endpoint: string; resource: Resource; intervalMs?: number }): boolean {
  if (!opts.endpoint) return false;
  const exporter = new OTLPMetricExporter({ url: base(opts.endpoint, "metrics") });
  meterProvider = new MeterProvider({
    resource: opts.resource,
    readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: opts.intervalMs ?? 30_000 })],
  });
  metrics.setGlobalMeterProvider(meterProvider);
  return true;
}

/** Ship log records over OTLP. The pino instrumentation (lib/tracing.ts) feeds this provider. */
export function startOtlpLogs(opts: { endpoint: string; resource: Resource }): boolean {
  if (!opts.endpoint) return false;
  const exporter = new OTLPLogExporter({ url: base(opts.endpoint, "logs") });
  loggerProvider = new LoggerProvider({ resource: opts.resource, processors: [new BatchLogRecordProcessor({ exporter })] });
  logs.setGlobalLoggerProvider(loggerProvider);
  return true;
}

/** Force any buffered metrics/logs out now (tests, and a clean shutdown). */
export async function flushOtlpPush(): Promise<void> {
  await meterProvider?.forceFlush().catch(() => {});
  await loggerProvider?.forceFlush().catch(() => {});
}

export async function stopOtlpPush(): Promise<void> {
  await meterProvider?.shutdown().catch(() => {});
  await loggerProvider?.shutdown().catch(() => {});
  meterProvider = null;
  loggerProvider = null;
}
