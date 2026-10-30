// A stand-in OTLP/HTTP receiver for 19-otlp (PETTY-401): it keeps every push in memory and lists them
// at GET /captured. The OTLP/HTTP exporters Petty uses send JSON.
import { Buffer } from "node:buffer";
import http from "node:http";

const seen = [];
http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/captured") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(seen));
    return;
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not JSON: kept as null */ }
    seen.push({ path: req.url, header: req.headers["x-petty-it"] ?? null, body });
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
}).listen(4318, "0.0.0.0");
