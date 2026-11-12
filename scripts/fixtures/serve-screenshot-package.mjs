// Read-only, loopback fixture registry. It serves exactly the committed private
// test package; it has no publish endpoint and contacts no external registry.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

if (process.env.CINATRA_RUNTIME_MODE !== "development") throw new Error("Development runtime required");
const root = fileURLToPath(new URL("../../tests/fixtures/screenshot-producer-agent/codex-widget-proof/screenshot-proof/", import.meta.url));
const manifest = JSON.parse(readFileSync(`${root}/package.json`, "utf8"));
const port = Number(process.env.SCREENSHOT_FIXTURE_REGISTRY_PORT ?? 4877);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid fixture registry port");
const tarball = execFileSync("tar", ["-czf", "-", "-C", `${root}/..`, "screenshot-proof"], { maxBuffer: 1024 * 1024 });
const dist = {
  tarball: `http://127.0.0.1:${port}/screenshot-proof.tgz`,
  integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
  shasum: createHash("sha1").update(tarball).digest("hex"),
};
const document = JSON.stringify({
  name: manifest.name, "dist-tags": { latest: manifest.version },
  versions: { [manifest.version]: { ...manifest, dist } },
});
createServer((request, response) => {
  if (request.method !== "GET") { response.writeHead(405).end(); return; }
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url, `http://127.0.0.1:${port}`).pathname); }
  catch { response.writeHead(400).end(); return; }
  if (pathname === `/${manifest.name}`) {
    response.writeHead(200, { "content-type": "application/json" }).end(document);
  } else if (pathname === "/screenshot-proof.tgz") {
    response.writeHead(200, { "content-type": "application/octet-stream" }).end(tarball);
  } else response.writeHead(404).end();
}).listen(port, "127.0.0.1", () => console.log(`Private screenshot fixture registry ready on 127.0.0.1:${port}`));
