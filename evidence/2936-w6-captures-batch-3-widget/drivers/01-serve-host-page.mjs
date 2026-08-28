// THE THIRD-PARTY APPLICATION — a plain page on another SITE, served by a
// server this round runs, and the CMS BACKEND's own callback beside it.
//
// It is a third-party application, never one of the app's own pages: it is
// served on its own origin, it holds no credential, and the widget frame inside
// it runs the platform's own hosted sign-in. The callback path is the one the
// shipped connect contract names for this client
// (`CLIENT_CALLBACK_CONTRACT` in `src/lib/connect-provisioning.ts`), so the
// consent screen's redirect is answered by a backend on the site's own origin,
// exactly as a CMS backend answers it. Nothing about the platform is served
// here; every value comes from the environment.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOST = process.env.HOST_PAGE_HOST ?? "localhost";
const PORT = Number(process.env.HOST_PAGE_PORT ?? 5591);
const CALLBACK_OUT = process.env.HOST_CALLBACK_OUT;
if (!CALLBACK_OUT) throw new Error("the host-page server needs HOST_CALLBACK_OUT");

const here = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(here, "host-page.html"), "utf8");
mkdirSync(dirname(CALLBACK_OUT), { recursive: true });

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  if (url.pathname === "/wp-admin/admin-post.php") {
    // THE CMS BACKEND'S CALLBACK. The consent screen redirects the admin's
    // browser here with the authorization code and the state it was given; a
    // CMS backend then redeems the code server-to-server. This records what
    // arrived so the redemption can run as its own step, and nothing else.
    const received = {
      at: new Date().toISOString(),
      query: Object.fromEntries(url.searchParams.entries()),
    };
    writeFileSync(CALLBACK_OUT, `${JSON.stringify(received, null, 2)}\n`);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<!doctype html><meta charset=utf-8><title>Connected</title><p>The site received the authorization code.</p>");
    return;
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(page);
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
});
server.listen(PORT, HOST, () => {
  console.log(`the third-party application is served on ${HOST}:${PORT}`);
});
