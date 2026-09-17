# Monitoring Petty

Petty needs no monitoring service to run. It gives you three signals to plug into your own
stack, for example Prometheus, Loki, Tempo and Grafana.

```
Petty ──metrics, pull, METRICS_PORT──▶ Prometheus (or any scraper)
Petty ──JSON logs, stdout────────────▶ your log collector
Petty ──traces, push, OTLP/HTTP──────▶ Tempo, Jaeger or any OTLP receiver
```

Nothing in these signals holds drawer content, amounts or line names: the server only has
ciphertext. There is no client-side analytics, and the Content-Security-Policy
(`connect-src 'self'`) prevents it.

## Metrics

Set `METRICS_PORT` (for example `9464`; `0` turns it off). The metrics are served on that
separate port, not on the app port, so a reverse proxy never exposes them. The code is in
`apps/api/src/lib/metrics.ts`.

| Metric | Labels | Meaning |
|---|---|---|
| `petty_http_request_duration_seconds` (histogram) | `method`, `route`, `status` | latency and count per route template (`/api/drawers/:id`), never per URL; non-API traffic is one `static` bucket |
| `petty_auth_events_total` | `event` = login_ok, login_fail, rate_limited, signup, forgot, reset, logout | sign-in events |
| `petty_entries_total` | `result` = created, duplicate | entry appends; duplicates are idempotent replays from the offline outbox |
| `petty_rotations_started_total` | none | drawer key rotations started |
| `petty_mail_total` | `result` = ok, failed | emails handed to SMTP |
| `petty_pg_pool_clients` | `pool` = api, maint; `state` = total, idle, waiting | database pool occupancy |
| `petty_users_total`, `petty_users_active{window}`, `petty_sessions_open`, `petty_drawers_total`, `petty_drawers_shared`, `petty_entries_stored` | `window` = 15m, 24h, 7d | usage counts from the database, refreshed at most every 30 seconds |
| `process_*`, `nodejs_*` | none | prom-client defaults |

No label carries content, an email address or a user id, and every label has a fixed set of
values.

"Active" means a session made a request in the window. The session timestamp is updated at
most every 5 minutes, so "active now" can lag by that much. Counters restart at 0 when the
app restarts.

## Logs

The API writes one JSON line per request to stdout (`msg="request"`: route, url, status,
duration in ms, user id), plus error lines with a typed error class and ids. `level` is a
word (`"error"`, `"info"`), so a query such as `| json | level="error"` works in Loki.
Health probes are not logged. Set the detail with `LOG_LEVEL`.

Errors never contain plaintext content (spec rule 2).

## Traces

Set `OTEL_EXPORTER_OTLP_ENDPOINT` to an OTLP/HTTP receiver (for example
`http://tempo:4318`); unset means no tracing. The code is in `apps/api/src/lib/tracing.ts`.

- One trace per API request: a server span named after the route template
  (`POST /api/drawers/:id/entries`), with one child span per SQL query.
- Spans carry the route, method, status, the user id and the SQL text with `$n` placeholders.
- Spans never carry request bodies, cookies, header values, bound SQL values, or a URL that
  holds a token (`/join-links/:token` is reported as the template).
- Every log line of a traced request carries `traceId`, so a log line can link to its trace.

Health probes and static files are not traced.

## Who can read these signals

Logs and traces hold user ids, routes and SQL shapes, but no content. Treat them as personal
data:

- Restrict access to your log and trace stores.
- Set a retention, for example 14 days for logs and 72 hours for traces.
- Do not publish the stores without authentication.

## Health endpoints

| Path | Meaning |
|---|---|
| `/api/health/live` | the process is up (use for liveness) |
| `/api/health` | the process is up and the database answers: `{"ok":true,"db":"up"}` |

## Suggested alerts

- **API down:** the scrape target has been missing for 2 minutes.
- **High error rate:** more than 1% of responses have a 5xx status for 5 minutes.
- **Slow requests:** p95 of `petty_http_request_duration_seconds` is above 1 second for 10 minutes.
- **Backup:** the last successful backup failed or is older than 26 hours, if you run the
  backup job from `deploy/backup`.
