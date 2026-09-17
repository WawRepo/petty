/**
 * Phase 17: write .gz and .br next to every static asset so @fastify/static
 * (`preCompressed: true`) serves compressed bytes without compressing at request
 * time. The main bundle goes from 536 KB to ~140 KB on the wire.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const exts = new Set([".js", ".css", ".html", ".svg", ".json", ".webmanifest"]);
let n = 0;
function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (!exts.has(name.slice(name.lastIndexOf(".")))) continue;
    const src = readFileSync(p);
    if (src.length < 1024) continue;
    writeFileSync(p + ".gz", gzipSync(src, { level: 9 }));
    writeFileSync(p + ".br", brotliCompressSync(src, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: src.length } }));
    n++;
  }
}
walk(dist);
process.stdout.write(`precompress: ${n} assets\n`);
