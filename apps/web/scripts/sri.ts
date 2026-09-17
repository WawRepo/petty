/** Post-build: add Subresource Integrity to the scripts and stylesheets index.html loads. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const html = readFileSync(dist + "index.html", "utf8");
let count = 0;
const withSri = html.replace(/<(script|link)([^>]*?)(src|href)="(\/[^"]+\.(?:js|css))"([^>]*)>/g, (tag, el, pre, attr, url, post) => {
  if (/integrity=/.test(tag)) return tag;
  const body = readFileSync(dist + url.slice(1));
  const digest = createHash("sha384").update(body).digest("base64");
  count += 1;
  const cross = /crossorigin/.test(tag) ? "" : ' crossorigin="anonymous"';
  return `<${el}${pre}${attr}="${url}"${post} integrity="sha384-${digest}"${cross}>`;
});
writeFileSync(dist + "index.html", withSri);
process.stdout.write(`sri: ${count} assets pinned\n`);
