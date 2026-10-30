import { describe, expect, it } from "vitest";

/**
 * PETTY-401: the image pushes traces, metrics and logs over OTLP/HTTP with the names homelab's Grafana
 * alerts read (petty_*, service_name, deployment_environment). The second instance of the stack pushes to
 * a stand-in receiver (otlp/capture.mjs). Before this file, an OpenTelemetry update could stop all three
 * with every check green: the unit tests only see an in-memory exporter.
 */
const SECOND = "http://127.0.0.1:3402/api";
const RECEIVER = process.env["PETTY_IT_OTLP"] ?? "http://127.0.0.1:3404";

interface KeyValue { key: string; value: { stringValue?: string } }
interface Push { path: string; header: string | null; body: Record<string, Array<Record<string, unknown>>> | null }
const pushes = async (): Promise<Push[]> => (await fetch(`${RECEIVER}/captured`)).json() as Promise<Push[]>;
const attr = (attrs: KeyValue[] | undefined, key: string) => attrs?.find((a) => a.key === key)?.value.stringValue;

/** Every item of one signal (spans, metrics or log records), each with its resource's attributes. */
/** The request-duration histogram of one metrics push, if it has a point for GET …/config. */
const configDuration = ({ item }: { item: Record<string, unknown> }) => item["name"] === "petty_http_request_duration_seconds"
  && (item["histogram"] as { dataPoints: Array<{ attributes: KeyValue[] }> }).dataPoints.some((p) => attr(p.attributes, "route")?.endsWith("/config"));

function items(all: Push[], path: string, resourceKey: string, scopeKey: string, itemKey: string) {
  return all.filter((p) => p.path === path).flatMap((p) => (p.body?.[resourceKey] ?? []).flatMap((r) => {
    const resource = (r["resource"] as { attributes?: KeyValue[] } | undefined)?.attributes;
    return ((r[scopeKey] ?? []) as Array<Record<string, unknown>>).flatMap((s) => ((s[itemKey] ?? []) as Array<Record<string, unknown>>).map((item) => ({ resource, item })));
  }));
}

describe("OTLP push (PETTY-401)", () => {
  it("traces, metrics and logs arrive with the names the alerts read, and a trace links its log lines", async () => {
    const traceId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    const res = await fetch(`${SECOND}/config`, { headers: { traceparent: `00-${traceId}-b7ad6b7169203331-01` } });
    expect(res.status).toBe(200);

    // Spans and log records leave in batches every few seconds, metrics every 30 s. Earlier files already
    // made app2 push, so wait for this request's own span and log line, not for any push.
    const mine = (all: Push[]) => ({
      span: items(all, "/v1/traces", "resourceSpans", "scopeSpans", "spans").some(({ item }) => item["traceId"] === traceId),
      log: items(all, "/v1/logs", "resourceLogs", "scopeLogs", "logRecords").some(({ item }) => item["traceId"] === traceId),
      metrics: items(all, "/v1/metrics", "resourceMetrics", "scopeMetrics", "metrics").some(configDuration),
    });
    await expect.poll(async () => mine(await pushes()), { timeout: 45_000, interval: 2_000 }).toEqual({ span: true, log: true, metrics: true });
    const all = await pushes();
    expect(all.every((p) => p.header === "yes"), "OTEL_EXPORTER_OTLP_HEADERS is sent with every push").toBe(true);

    const spans = items(all, "/v1/traces", "resourceSpans", "scopeSpans", "spans");
    // the request's own span (OTLP kind 2 = server); its database queries share the trace id
    const server = spans.find(({ item }) => item["traceId"] === traceId && item["kind"] === 2);
    expect(server, "the request continues the caller's trace").toBeDefined();
    expect(server!.item["name"]).toMatch(/^GET \S*\/config$/);
    expect(attr(server!.resource, "service.name")).toBe("petty");
    expect(attr(server!.resource, "deployment.environment")).toBe("it");
    // PETTY-341: who called is never on a span
    const keys = spans.flatMap(({ item }) => ((item["attributes"] ?? []) as KeyValue[]).map((a) => a.key));
    expect(keys).not.toContain("client.address");
    expect(keys).not.toContain("user_agent.original");

    const metrics = items(all, "/v1/metrics", "resourceMetrics", "scopeMetrics", "metrics");
    const duration = metrics.find(configDuration)!;
    expect(attr(duration.resource, "service.name")).toBe("petty");
    expect(attr(duration.resource, "deployment.environment")).toBe("it");

    const logs = items(all, "/v1/logs", "resourceLogs", "scopeLogs", "logRecords");
    expect(logs.some(({ item }) => item["traceId"] === traceId), "the request's log line carries its trace id").toBe(true);
    expect(attr(logs[0]!.resource, "service.name")).toBe("petty");
  }, 60_000);
});
