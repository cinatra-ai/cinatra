#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ISOLATED headless render for the pinned CMS preview capture (cinatra#2044 S6,
// sub-lane L-B).
//
// #2044 requires the capture to be produced by "isolated server-side capture
// execution", with no scripts, event handlers, or live remote documents ever
// entering cinatra's realm. This script IS that isolation boundary: it runs in
// its own OS process, is spawned by `src/lib/artifacts/cms-preview-capture.ts`,
// and is the ONLY place a browser is ever launched on the capture path.
//
// Why a subprocess rather than an in-process `import("playwright")`:
//   * The app's server graph never gains a browser dependency — nothing to
//     bundle, nothing to trace, no route-graph edge (the app spawns a FILE, it
//     does not import a module).
//   * A crashed/hung/OOM renderer kills a child, never the request handler; the
//     parent enforces its own wall-clock kill.
//   * The browser runs with no access to the host's process state, env secrets
//     (a scrubbed env is passed), or credentials — the AUTHENTICATED fetch
//     already happened in the parent, and only the sanitized HTML crosses here.
//
// The render itself is confined three ways:
//   1. `javaScriptEnabled: false` — no page script can run even if the sanitizer
//      were bypassed.
//   2. The document is FULFILLED from the piped HTML at the site's own preview
//      URL (never navigated to). The browser therefore issues no request for the
//      document itself — the signed request stays in the parent — while relative
//      subresource URLs still resolve against the real site origin so the page
//      renders with its real theme.
//   3. Every subresource request is matched against a single allowed origin;
//      anything else (third-party CDNs, analytics, fonts, any internal address)
//      is ABORTED and counted. Non-GET is aborted unconditionally.
//
// Protocol (stdin/stdout JSON, so nothing sensitive lands in argv or a temp file):
//   stdin  {html, documentUrl, allowedOrigin, viewport:{width,height}, timeoutMs}
//   stdout {ok:true, screenshotBase64, regions[], blockedRequests, allowedRequests,
//           viewport, contentHeight}
//        | {ok:false, reason, detail}
//   exit 0 on a produced capture, 1 otherwise. Every failure is a DEGRADE the
//   caller records on the gate — it never blocks the review.
// ---------------------------------------------------------------------------

const MAX_HTML_BYTES = 8 * 1024 * 1024;

function fail(reason, detail) {
  process.stdout.write(JSON.stringify({ ok: false, reason, detail: String(detail ?? "") }));
  process.exit(1);
}

async function readStdin() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_HTML_BYTES) throw new Error("input exceeds the capture size cap");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch (err) {
    fail("bad-input", err instanceof Error ? err.message : err);
    return;
  }

  const html = typeof input.html === "string" ? input.html : "";
  const documentUrl = String(input.documentUrl ?? "");
  const allowedOrigin = String(input.allowedOrigin ?? "");
  const pinnedAddresses = Array.isArray(input.pinnedAddresses)
    ? input.pinnedAddresses.filter((a) => typeof a === "string" && a.length > 0)
    : [];
  const width = Number(input.viewport?.width) || 1280;
  const height = Number(input.viewport?.height) || 900;
  const timeoutMs = Number(input.timeoutMs) || 15000;
  if (html === "" || documentUrl === "" || allowedOrigin === "") {
    fail("bad-input", "html, documentUrl and allowedOrigin are all required");
    return;
  }
  // FAIL CLOSED without pinned addresses: this browser resolves DNS itself, so
  // an unpinned run could reach an address the parent's egress guard rejected.
  if (pinnedAddresses.length === 0) {
    fail("bad-input", "pinnedAddresses is required — refusing to render unpinned");
    return;
  }

  let allowedHost;
  try {
    allowedHost = new URL(allowedOrigin).hostname;
  } catch {
    fail("bad-input", "allowedOrigin is not a URL");
    return;
  }

  // `playwright` is not a direct dependency; the browser driver rides
  // `@playwright/test` (a devDependency), so a production install without it
  // simply has no renderer — a clean, named degrade rather than a crash.
  let chromium;
  try {
    ({ chromium } = await import("@playwright/test"));
  } catch (err) {
    fail("renderer-unavailable", err instanceof Error ? err.message : err);
    return;
  }

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--disable-dev-shm-usage",
        "--no-sandbox",
        "--disable-gpu",
        // RESOLVER PINNING — the second half of the SSRF boundary. The parent
        // validated the site's addresses through the shared egress guard, but
        // THIS browser does its own DNS: without pinning, a name that resolved
        // publicly for the signed fetch could re-resolve to an internal address
        // for a subresource (classic DNS rebind) and the URL-origin check below
        // would happily allow it. The first rule maps the site's hostname to an
        // address the guard already approved; the catch-all makes every OTHER
        // hostname unresolvable, so nothing in the page can name a new host.
        `--host-resolver-rules=MAP ${allowedHost} ${pinnedAddresses[0]},MAP * ~NOTFOUND`,
      ],
    });
  } catch (err) {
    fail("browser-launch-failed", err instanceof Error ? err.message : err);
    return;
  }

  try {
    const context = await browser.newContext({
      viewport: { width, height },
      // No page script may execute — the second layer under the sanitizer.
      javaScriptEnabled: false,
      // Deterministic capture: no animation timing, no locale drift.
      reducedMotion: "reduce",
      locale: "en-US",
      timezoneId: "UTC",
      // The capture must never carry a credential; the signed fetch was the
      // parent's, and nothing is stored between runs.
      storageState: undefined,
      acceptDownloads: false,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);

    let blockedRequests = 0;
    let allowedRequests = 0;
    let documentFulfilled = 0;

    // ONE handler for EVERY request. Deliberately not two routes: Playwright
    // matches handlers in reverse registration order, so a separate catch-all
    // registered after a document-specific route silently wins the document
    // request — which would send the browser to fetch the preview URL itself,
    // UNSIGNED (it gets a 401 page, and the whole "the authenticated fetch never
    // leaves the parent" property is lost). A single ordered branch makes that
    // impossible.
    await page.route("**/*", (route) => {
      const request = route.request();
      // 1. The DOCUMENT is served from the piped, sanitized HTML at the site's
      //    own URL, so relative subresources resolve — while no request for the
      //    document ever leaves this process.
      if (request.url() === documentUrl) {
        // ONCE. A second request for the document means the page tried to
        // NAVIGATE (a refresh instruction, a redirect) — serving the piped HTML
        // again would loop, and serving nothing would capture whatever the
        // browser fetched. Abort instead: what is captured is always the ONE
        // document the parent fetched and sanitized.
        if (documentFulfilled > 0) {
          blockedRequests += 1;
          return route.abort();
        }
        documentFulfilled += 1;
        return route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: html,
        });
      }
      // Any OTHER top-level document request is a navigation away from the
      // captured page. Never followed.
      if (request.isNavigationRequest()) {
        blockedRequests += 1;
        return route.abort();
      }
      // 2. Subresources: same-origin GET only.
      let sameOrigin = false;
      try {
        sameOrigin = new URL(request.url()).origin === allowedOrigin;
      } catch {
        sameOrigin = false;
      }
      if (!sameOrigin || request.method() !== "GET") {
        blockedRequests += 1;
        return route.abort();
      }
      allowedRequests += 1;
      return route.continue();
    });

    await page.goto(documentUrl, { waitUntil: "load", timeout: timeoutMs });
    if (documentFulfilled === 0) {
      // The page was NOT served from the piped HTML — fail rather than capture
      // whatever the browser fetched on its own.
      throw new Error("the document was not served from the piped capture");
    }
    // Let same-origin stylesheets/images settle; a site that never idles must
    // not fail the capture, so the wait is best-effort.
    await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});

    const shot = await page.screenshot({ fullPage: true, type: "png" });
    // Image dimensions straight from the PNG's IHDR — the capture's own pixel
    // box, so the region percentages the reviewer sees are computed against
    // exactly the image being overlaid (no scroll-height/DPR guesswork).
    const imageWidth = shot.readUInt32BE(16);
    const imageHeight = shot.readUInt32BE(20);

    // Adapter-supplied region anchors ONLY (#2044: reviewer-side CSS guessing is
    // forbidden). Read through Playwright's own box model rather than page
    // script, so geometry works with page JavaScript disabled. The page is never
    // scrolled, so a box is already in full-document coordinates.
    const anchors = page.locator("[data-cinatra-region]");
    const anchorCount = await anchors.count();
    const regions = [];
    for (let i = 0; i < anchorCount; i++) {
      const node = anchors.nth(i);
      const box = await node.boundingBox();
      if (!box) continue;
      regions.push({
        region: (await node.getAttribute("data-cinatra-region")) || "",
        postId: await node.getAttribute("data-cinatra-post"),
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
      });
    }

    process.stdout.write(
      JSON.stringify({
        ok: true,
        screenshotBase64: shot.toString("base64"),
        regions,
        contentHeight: imageHeight,
        viewport: { width: imageWidth, height },
        blockedRequests,
        allowedRequests,
      }),
    );
    await context.close();
  } catch (err) {
    fail("render-failed", err instanceof Error ? err.message : err);
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((err) => fail("render-failed", err instanceof Error ? err.message : err));
