import pg from "pg";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { SpanKind, SpanStatusCode, context, trace, type Span } from "@opentelemetry/api";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { PinoInstrumentation } from "@opentelemetry/instrumentation-pino";
import { BatchSpanProcessor, SimpleSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { otelResource } from "./otel-resource.js";

/**
 * Traces (Phase 15b follow-up, PETTY-34). One trace per API request, pushed
 * straight to Tempo over OTLP/HTTP; no collector in between.
 *
 * What a span may carry: the route TEMPLATE, the method, the status, ids, the
 * SQL text with $n placeholders. What it never carries: request bodies, cookies,
 * query parameters (there are none), the values bound to a query, or a URL
 * path that holds a secret token (CLAUDE.md rule 2). `startTracing` MUST run
 * before Fastify is imported — the http instrumentation patches `node:http` as
 * Fastify requires it — which is why index.ts imports the app dynamically.
 */
export interface TracingOptions { exporter?: SpanExporter | null; endpoint?: string | undefined; apiPrefix: string; version?: string | undefined; deploymentEnv?: string | undefined; logs?: boolean }

let provider: NodeTracerProvider | null = null;

export function startTracing(opts: TracingOptions): boolean {
  const exporter = opts.exporter !== undefined ? opts.exporter : opts.endpoint ? new OTLPTraceExporter({ url: `${opts.endpoint.replace(/\/$/, "")}/v1/traces` }) : null;
  if (!exporter) return false;
  provider = new NodeTracerProvider({
    resource: otelResource(opts.version ?? "dev", opts.deploymentEnv ?? ""),
    // Simple = synchronous export, for tests that read spans right after a request.
    spanProcessors: [opts.exporter ? new SimpleSpanProcessor(exporter) : new BatchSpanProcessor(exporter)],
  });
  provider.register();
  const prefix = opts.apiPrefix;
  registerInstrumentations({
    instrumentations: [
      new HttpInstrumentation({
        // API calls only: not the health probes (three every few seconds), not the static files of the web app.
        ignoreIncomingRequestHook: (req) => {
          const url = req.url ?? "";
          if (/\/health(\?|$)/.test(url)) return true;
          return prefix !== "" && !url.startsWith(`${prefix}/`);
        },
        // The metrics port and the SMTP transport are not HTTP; nothing outgoing is worth a span here.
        ignoreOutgoingRequestHook: () => true,
      }),
      // Feeds each pino log record to the global OTLP logger provider (lib/otel-push.ts) with its trace
      // context, so logs and traces correlate. Only when OTLP log push is on; it must be registered
      // before Fastify creates the pino logger, which is why index.ts imports the app after this.
      ...(opts.logs ? [new PinoInstrumentation()] : []),
    ],
  });
  patchPg();
  return true;
}

export async function stopTracing(): Promise<void> {
  await provider?.shutdown();
  provider = null;
}

/** Every pg query becomes a child span: statement with placeholders, never the values. */
let pgPatched = false;
function patchPg(): void {
  if (pgPatched) return;
  pgPatched = true;
  const tracer = trace.getTracer("petty-pg");
  const original = pg.Client.prototype.query as (...args: unknown[]) => unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pg.Client.prototype as any).query = function (this: pg.Client, ...args: unknown[]) {
    const parent = trace.getSpan(context.active());
    if (!parent) return original.apply(this, args);
    const first = args[0];
    const text = typeof first === "string" ? first : (first as { text?: string } | undefined)?.text ?? "";
    const op = text.trim().split(/\s+/)[0]?.toLowerCase() ?? "query";
    const span = tracer.startSpan(`pg ${op}`, { kind: SpanKind.CLIENT, attributes: { "db.system": "postgresql", "db.operation": op, "db.statement": text.replace(/\s+/g, " ").trim().slice(0, 300) } });
    const fail = (err: unknown) => { span.setStatus({ code: SpanStatusCode.ERROR }); span.setAttribute("exception.type", err instanceof Error ? err.name : "Error"); span.end(); };
    return context.with(trace.setSpan(context.active(), span), () => {
      // pg-pool always calls the client with a callback, even for the promise API.
      const last = args[args.length - 1];
      if (typeof last === "function") {
        const cb = last as (err: unknown, res?: unknown) => void;
        args[args.length - 1] = (err: unknown, res?: unknown) => { if (err) fail(err); else span.end(); cb(err, res); };
        return original.apply(this, args);
      }
      const out = original.apply(this, args) as Promise<unknown>;
      return Promise.resolve(out).then((v) => { span.end(); return v; }, (err: unknown) => { fail(err); throw err; });
    });
  };
}

const TOKEN_ROUTE = /:token\b/;
/** The URL as it may be logged or traced: a route that carries a secret in its path is reported as the template. */
export function safeUrl(req: FastifyRequest): string {
  const tpl = req.routeOptions.url;
  if (tpl) return TOKEN_ROUTE.test(tpl) ? tpl : req.url;
  // No template: the SPA shell or a 404. /join/<token> and /reset/<token> live here (SR-1),
  // so only the first path segment is reported.
  const segments = (req.url.split("?")[0] ?? "").split("/").filter(Boolean);
  return `/${segments[0] ?? ""}${segments.length > 1 ? "/…" : ""}`;
}

export function currentTraceId(): string | null {
  const span = trace.getSpan(context.active());
  const ctx = span?.spanContext();
  return ctx && ctx.traceId !== "00000000000000000000000000000000" ? ctx.traceId : null;
}

declare module "fastify" {
  interface FastifyRequest { traceId: string | null }
}

/**
 * Names the server span after the route template, pins the safe URL over the raw
 * one, and binds traceId into the request's logger so every log line of this
 * request links to its trace in Grafana.
 */
export function tracingHooks(app: FastifyInstance): void {
  app.decorateRequest("traceId", null);
  app.addHook("onRequest", async (req) => {
    const span: Span | undefined = trace.getSpan(context.active());
    const tpl = req.routeOptions.url;
    if (span?.isRecording()) {
      const url = safeUrl(req);
      span.updateName(`${req.method} ${tpl ?? "unmatched"}`);
      span.setAttributes({ "http.route": tpl ?? "unmatched", "http.target": url, "http.url": url, "url.path": url, "url.full": url });
    }
    req.traceId = currentTraceId();
    if (req.traceId) req.log = req.log.child({ traceId: req.traceId });
  });
  app.addHook("onResponse", async (req, reply) => {
    const span = trace.getSpan(context.active());
    if (!span?.isRecording()) return;
    if (req.user) span.setAttribute("user.id", req.user.id);
    if (reply.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
  });
}
