import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect, type Page, type Request } from "@playwright/test";

import {
  DRUPAL_BASE,
  SEL,
  WP_BASE,
  loginDrupal,
  loginWordPress,
  openWidget,
  readSeed,
  sendPrompt,
} from "./helpers";

// ---------------------------------------------------------------------------
// THE PASSIVE PARENT-SURFACE HARNESS (cinatra#2674 S8e AC-2, reworked by
// cinatra#2708).
//
// WHAT IT PROVES: no Cinatra credential reaches a PARENT-ORIGIN SURFACE. Six
// classes, each asserted separately, each with its OWN unique credential canary
// and its OWN positive control proving the check can see that class of thing:
//
//   1. NETWORK   — not one request issued from the parent origin carries a
//                  credential in its URL, headers or body. Two positive controls:
//                  a canary-bearing parent request the recorder must catch, AND
//                  the FRAME's real credential-bearing requests, which prove the
//                  matcher matches a REAL credential in REAL traffic and not only
//                  a synthetic string.
//   2. DOM       — `page.content()` on the parent document.
//   3. STORAGE   — parent-origin `localStorage` + `sessionStorage`.
//   4. COOKIES   — parent-origin cookies, read through the CONTEXT (so HttpOnly
//                  cookies, invisible to `document.cookie`, are covered too).
//   5. URL/HISTORY — every main-frame navigation recorded during the run, plus
//                  the final URL.
//   6. CONSOLE   — every console message and page error the parent emitted.
//
// ============================ WHY IT IS PASSIVE =============================
// AN EARLIER FORM OF THIS HARNESS WAS ACTIVE, AND IT BROKE WHAT IT OBSERVED.
// DO NOT REINTRODUCE IT. The measurements, from the host2 lane at 862cd5ddc
// (cinatra#2708):
//
//   • The original harness installed an `addInitScript` in EVERY frame that
//     wrapped `Window.postMessage`, wrapped `MessagePort.prototype.postMessage`,
//     and REPLACED the `MessageChannel` constructor to attach its own `message`
//     listener to both endpoints. Protocol 2 negotiates the widget session over
//     exactly that transport. With the harness installed, the frame-owned
//     sign-in NEVER reached `active`: it stalled after the popup closed and
//     timed out at 180s on BOTH CMSes, against 19.7s for the identical
//     uninstrumented ceremony (matrix-chromium, same page, same plugin).
//   • A REWRITE was attempted and measured: instead of adding a listener, it
//     wrapped the application's own handler
//     (`MessagePort.prototype.addEventListener` + the `onmessage` setter). It
//     STILL perturbed — one ceremony ran 120s and stalled at the same point, the
//     port handover after popup-close — while its own positive control proved the
//     recorder worked. That attempt is preserved as
//     `s8e/harness-rewrite-attempt.patch` on the host2 lane checkout and is NOT
//     committed here: it is a recorded dead end, not a starting point.
//
// An instrument that breaks the mechanism proves nothing about it. So the
// postMessage/MessagePort limb is DESCOPED (tracked in cinatra#2708) and every
// instrument in this file is passive: out-of-process request/console recorders,
// and post-hoc reads of the parent's own surfaces. Nothing is installed into a
// page before it runs, and no browser API is patched anywhere.
//
// ========================= WHAT PASSIVE CANNOT SEE ==========================
// STATED, NOT ABSORBED. "Zero parent-origin network egress" is NOT "the parent
// never sees the credential": a parent could in principle RECEIVE a value over
// postMessage and never transmit, store, render or log it, and nothing here
// would observe that. That residual gap is exactly the descoped limb, and it is
// tracked in cinatra#2708 rather than quietly folded into a green run. What
// stands independently of this harness: the widget's parent shell composes no
// bearer at all at protocol 2 (`cwu_`/`cit_` do not appear in plugin code), the
// credential lives in a closure on the Cinatra origin, and the bridge guard
// refuses bearer-shaped payloads in BOTH directions — properties proven by the
// plugins' own unit suites, not by a browser watching from outside.
// ---------------------------------------------------------------------------

/** Everything Cinatra mints that must never cross into a parent-origin context. */
export const CREDENTIAL_PREFIXES = ["cwu_", "cit_", "cnx_"] as const;

/**
 * A credential-SHAPED match: prefix PLUS a real token body.
 *
 * Never match the bare prefix. The shipped plugin's own source and the suite's
 * own comments say "cwu_" and "cit_" in prose, and a bare-prefix matcher reds on
 * that — a false failure that teaches a reader to distrust the check. A token
 * body of 8+ characters is present in every credential this product mints and in
 * no sentence about them.
 */
export const CREDENTIAL_TOKEN = /\b(?:cwu|cit|cnx)_[A-Za-z0-9._~+/=-]{8,}/g;

/** Every credential-shaped value in `text`, redacted — safe to print. */
export function credentialHits(text: string): string[] {
  const found = text.match(CREDENTIAL_TOKEN) ?? [];
  return [...new Set(found)].map(redactCredentials);
}

/** Never write a credential to disk or a report, even inside a failure record. */
export function redactCredentials(text: string): string {
  return text.replace(/\b(cwu|cit|cnx)_[A-Za-z0-9._~+/=-]{8,}/g, "$1_<REDACTED>");
}

/**
 * A UNIQUE, credential-SHAPED canary for one surface class.
 *
 * Credential-shaped so the very matcher the real assertion uses is the one the
 * positive control exercises — a control that a different matcher could see
 * would prove nothing about the check that matters. Unique per surface so a
 * canary leaking from one class into another is visible rather than confusing,
 * and unique per RUN so a stale value left behind by an earlier run cannot make
 * a control pass.
 */
export function credentialCanary(surface: string): string {
  return `cwu_CANARY-${surface}-${randomUUID().replace(/-/g, "")}`;
}

export type SurfaceProof = {
  surface: string;
  /** Redacted credential-shaped values found on the surface (must be empty). */
  hits: string[];
  /** Whether the surface's own positive control was observed. */
  controlSeen: boolean;
  /** Free-form scale of what was inspected, for the evidence record. */
  scale: string;
  /**
   * The EXACT content that was inspected, as read. Kept so a caller can run
   * further structural checks over the same bytes the credential assertion saw
   * (see `assertRetiredEnvelopeAbsent`) instead of re-reading a surface that may
   * have moved on. It is deliberately NOT part of the evidence record —
   * `writeEgressEvidence` strips it — because it can contain a live credential.
   */
  raw: string;
};

/** One recorded request, reduced to what the proof needs (already redacted). */
type SeenRequest = {
  frameOrigin: string;
  isParent: boolean;
  method: string;
  url: string;
  carriesCredential: boolean;
  carriesCanary: boolean;
};

/**
 * Passive recorders for the surfaces that can only be captured AS THEY HAPPEN.
 *
 * `page.on(...)` subscriptions only: they observe the browser from outside the
 * page and cannot alter what the page does. Install before navigating so nothing
 * is missed; there is no init script and no patched API, so "before navigating"
 * is about coverage, never about winning a race with application code.
 */
export function installPassiveRecorders(page: Page): {
  requests: Request[];
  consoleLines: string[];
  navigations: string[];
} {
  const requests: Request[] = [];
  const consoleLines: string[] = [];
  const navigations: string[] = [];

  page.on("request", (req) => requests.push(req));
  page.on("console", (msg) => consoleLines.push(`${msg.type()}: ${msg.text()}`));
  page.on("pageerror", (err) => consoleLines.push(`pageerror: ${String(err)}`));
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations.push(frame.url());
  });

  return { requests, consoleLines, navigations };
}

/** Classify one recorded request against the parent origin + the canary. */
async function describeRequest(
  req: Request,
  parentOrigin: string,
  canary: string,
): Promise<SeenRequest> {
  let frameOrigin = "";
  try {
    frameOrigin = new URL(req.frame().url()).origin;
  } catch {
    // A request whose frame is already detached (or a worker's) has no origin we
    // can attribute. It is counted as NON-parent: attributing an unknown issuer
    // to the parent would manufacture violations, and the parent's own requests
    // are all attributable while their frame is alive.
    frameOrigin = "";
  }
  const url = req.url();
  let headerBlob: string;
  try {
    headerBlob = JSON.stringify(await req.allHeaders());
  } catch {
    headerBlob = JSON.stringify(req.headers());
  }
  const body = req.postData() ?? "";
  const blob = `${url}\n${headerBlob}\n${body}`;
  return {
    frameOrigin,
    isParent: frameOrigin === parentOrigin,
    method: req.method(),
    url: redactCredentials(url),
    carriesCredential: new RegExp(CREDENTIAL_TOKEN.source).test(blob),
    carriesCanary: blob.includes(canary),
  };
}

/**
 * NETWORK — no request issued from the parent origin carries a credential.
 *
 * TWO positive controls, because one of them is weak on its own:
 *   • the CANARY control: after the real window closes, the parent page issues
 *     one same-origin request carrying a credential-shaped canary, and the
 *     recorder must catch it. This proves the recorder is watching parent-origin
 *     traffic at the moment of the assertion — a recorder that silently detached
 *     would otherwise make the whole check pass.
 *   • the REAL-CREDENTIAL control: the FRAME's own requests must be seen
 *     carrying a real credential. This proves the matcher matches an actual
 *     minted token in actual traffic, and that a credential existed to leak at
 *     all — the check cannot pass merely because the ceremony never happened.
 */
export async function proveNetworkSurface(
  page: Page,
  requests: Request[],
  parentOrigin: string,
): Promise<SurfaceProof> {
  const canary = credentialCanary("network");

  // The REAL window: everything recorded up to now, before any canary exists.
  const realWindow = requests.slice();
  const seen: SeenRequest[] = [];
  for (const req of realWindow) seen.push(await describeRequest(req, parentOrigin, canary));

  const fromParent = seen.filter((s) => s.isParent);
  const fromFrames = seen.filter((s) => !s.isParent);
  const parentCarrying = fromParent.filter((s) => s.carriesCredential);
  const frameCarrying = fromFrames.filter((s) => s.carriesCredential);

  expect(
    fromParent.length,
    "the parent origin must have issued requests at all — a silent recorder would " +
      "otherwise make 'no parent request carried a credential' vacuously true",
  ).toBeGreaterThan(0);
  expect(
    frameCarrying.length,
    "the FRAME must have been seen issuing credential-bearing requests (positive " +
      "control): it proves a real credential existed and that this matcher matches " +
      "it, so the parent-side silence below is a finding and not an artefact",
  ).toBeGreaterThan(0);
  expect(
    parentCarrying.map((s) => `${s.method} ${s.url}`),
    "a request issued from the PARENT ORIGIN carried a Cinatra credential",
  ).toEqual([]);

  // CANARY CONTROL, after the real window: one same-origin GET carrying a
  // credential-shaped value. Harmless (a read of the CMS root with a query the
  // CMS ignores) and issued only once the assertion above has already been made.
  await page.evaluate(async (probe) => {
    await fetch(`${location.origin}/?cinatra-egress-canary=${probe}`, {
      method: "GET",
      credentials: "omit",
    }).catch(() => {
      /* the CMS's answer is irrelevant — the RECORDER seeing the request is the control */
    });
  }, canary);

  let controlSeen = false;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !controlSeen) {
    for (const req of requests.slice(realWindow.length)) {
      const described = await describeRequest(req, parentOrigin, canary);
      if (described.isParent && described.carriesCanary) {
        controlSeen = true;
        break;
      }
    }
    if (!controlSeen) await page.waitForTimeout(200);
  }
  expect(
    controlSeen,
    "the network recorder did not catch its own parent-origin canary request — its " +
      "silence about credentials proves nothing",
  ).toBe(true);

  return {
    surface: "network",
    hits: parentCarrying.map((s) => `${s.method} ${s.url}`),
    controlSeen,
    scale:
      `${seen.length} requests recorded — ${fromParent.length} from the parent origin ` +
      `(${parentOrigin}), ${fromFrames.length} from Cinatra frames, of which ` +
      `${frameCarrying.length} carried a real credential`,
    // Already redacted per request (URLs only) — the header/body blobs are never
    // retained, so this is safe to carry and safe to write.
    raw: fromParent.map((s) => `${s.method} ${s.url}`).join("\n"),
  };
}

/**
 * The shared shape of the five READ-THEN-PLANT surface proofs.
 *
 * ORDER IS THE WHOLE DESIGN: read the surface and assert it credential-free
 * FIRST, then plant the canary and prove the reader sees it, then clean up. The
 * canary is deliberately credential-shaped, so planting it before the real read
 * would make the real assertion fail on the harness's own value — and a harness
 * that has to subtract itself from its evidence is one refactor away from
 * subtracting a real leak.
 */
async function proveReadableSurface(args: {
  surface: string;
  read: () => Promise<string>;
  plant: (canary: string) => Promise<void>;
  cleanup: () => Promise<void>;
  describe: (content: string) => string;
}): Promise<SurfaceProof> {
  const canary = credentialCanary(args.surface);
  const before = await args.read();
  const hits = credentialHits(before);
  expect(
    hits,
    `a Cinatra credential reached the parent-origin ${args.surface} surface`,
  ).toEqual([]);

  await args.plant(canary);
  const after = await args.read();
  const controlSeen = after.includes(canary);
  try {
    expect(
      controlSeen,
      `the ${args.surface} check could not see its own canary — this surface class is ` +
        `unobserved, so its silence proves nothing`,
    ).toBe(true);
  } finally {
    await args.cleanup();
  }

  return { surface: args.surface, hits, controlSeen, scale: args.describe(before), raw: before };
}

/** DOM — the parent document's own markup. */
export function proveDomSurface(page: Page): Promise<SurfaceProof> {
  const NODE_ID = "cinatra-egress-canary-node";
  return proveReadableSurface({
    surface: "dom",
    read: () => page.content(),
    plant: (canary) =>
      page.evaluate(
        ([id, value]) => {
          const el = document.createElement("span");
          el.id = id;
          el.textContent = value;
          el.style.display = "none";
          document.body.appendChild(el);
        },
        [NODE_ID, canary],
      ),
    cleanup: () => page.evaluate((id) => document.getElementById(id)?.remove(), NODE_ID),
    describe: (content) => `${content.length} chars of parent DOM`,
  });
}

/** STORAGE — parent-origin localStorage + sessionStorage. */
export function proveStorageSurface(page: Page): Promise<SurfaceProof> {
  const KEY = "cinatra-egress-canary";
  const dump = () =>
    page.evaluate(() => {
      const read = (store: Storage) => {
        const out: Record<string, string> = {};
        for (let i = 0; i < store.length; i += 1) {
          const key = store.key(i);
          if (key) out[key] = store.getItem(key) ?? "";
        }
        return out;
      };
      return JSON.stringify({ local: read(localStorage), session: read(sessionStorage) });
    });
  return proveReadableSurface({
    surface: "storage",
    read: dump,
    plant: (canary) =>
      page.evaluate(
        ([key, value]) => {
          localStorage.setItem(key, value);
          sessionStorage.setItem(key, value);
        },
        [KEY, canary],
      ),
    cleanup: () =>
      page.evaluate((key) => {
        localStorage.removeItem(key);
        sessionStorage.removeItem(key);
      }, KEY),
    describe: (content) => `${content.length} chars of parent local+sessionStorage`,
  });
}

/**
 * COOKIES — parent-origin cookies read through the CONTEXT, not `document.cookie`.
 *
 * `document.cookie` cannot see an HttpOnly cookie, so a credential parked in one
 * would be invisible to a page-side read while being sent on every request to
 * the parent origin. The context API returns them, which is why the read is done
 * there; the canary is planted through `document.cookie` because a page-settable
 * cookie is the surface a widget could actually reach.
 */
export function proveCookieSurface(page: Page, parentOrigin: string): Promise<SurfaceProof> {
  const NAME = "cinatra_egress_canary";
  const read = async () => {
    const cookies = await page.context().cookies([parentOrigin]);
    const inline = await page.evaluate(() => document.cookie);
    return JSON.stringify({ context: cookies, documentCookie: inline });
  };
  return proveReadableSurface({
    surface: "cookies",
    read,
    plant: (canary) =>
      page.evaluate(
        ([name, value]) => {
          document.cookie = `${name}=${value}; path=/; SameSite=Lax`;
        },
        [NAME, canary],
      ),
    cleanup: () =>
      page.evaluate((name) => {
        document.cookie = `${name}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
      }, NAME),
    describe: (content) => `${content.length} chars of parent-origin cookie state`,
  });
}

/**
 * URL / HISTORY — every main-frame navigation recorded during the run, plus the
 * URL the page ended on.
 *
 * The canary is planted with `history.pushState`, which is the way a script
 * could put a value into the address bar and the session history WITHOUT a
 * navigation — the quiet variant this class is really about. It is undone with
 * `replaceState` back to the original URL, so the page is left exactly where the
 * proof found it and no reload is provoked.
 */
export function proveUrlHistorySurface(
  page: Page,
  navigations: string[],
): Promise<SurfaceProof> {
  let original = "";
  const read = async () => JSON.stringify({ navigations, current: page.url() });
  return proveReadableSurface({
    surface: "url-history",
    read,
    plant: async (canary) => {
      original = page.url();
      await page.evaluate((probe) => {
        history.pushState({}, "", `?cinatra-egress-canary=${probe}`);
      }, canary);
    },
    cleanup: async () => {
      if (!original) return;
      await page.evaluate((url) => history.replaceState({}, "", url), original);
    },
    describe: () => `${navigations.length} main-frame navigations + the final URL`,
  });
}

/** CONSOLE — every console message and page error the parent emitted. */
export function proveConsoleSurface(
  page: Page,
  consoleLines: string[],
): Promise<SurfaceProof> {
  return proveReadableSurface({
    surface: "console",
    read: async () => consoleLines.join("\n"),
    plant: async (canary) => {
      await page.evaluate((probe) => console.log(probe), canary);
      // The console event is delivered out-of-process; give it a moment to land
      // in the recorder before the control reads it back.
      await expect
        .poll(() => consoleLines.join("\n").includes(canary), { timeout: 10_000 })
        .toBe(true);
    },
    cleanup: async () => {
      /* nothing to undo — a console line cannot be unsaid, and it is the canary */
    },
    describe: (content) => `${consoleLines.length} console lines (${content.length} chars)`,
  });
}

/**
 * The retired credential ENVELOPE must not be present at any protocol version.
 *
 * Distinct from the credential checks above and kept: these are the STRUCTURE
 * names of the protocol-1 bootstrap. Their absence says the site-mediated
 * ceremony is not merely credential-free but gone — a parent that still composed
 * the envelope (empty, or "temporarily" unpopulated) would be one line away from
 * filling it in again.
 */
export function assertRetiredEnvelopeAbsent(surfaces: string[]): void {
  const blob = surfaces.join("\n");
  for (const marker of ["cinatra.embed.bootstrap", "citToken", "cwuToken"]) {
    expect(
      blob.includes(marker),
      `the RETIRED protocol-1 credential envelope marker "${marker}" is present on a ` +
        `parent-visible surface — the site-mediated bootstrap must be gone, not empty`,
    ).toBe(false);
  }
}

/**
 * Write the run's evidence next to the other Playwright output.
 *
 * `raw` is STRIPPED, not redacted-and-kept: it is whole parent surfaces (the DOM,
 * the cookie jar) and the only reason to persist those would be to search them
 * later — which is what the assertions already did, in memory, at the moment
 * they were true. What remains is a summary that is redacted anyway, so a
 * credential cannot reach the artefact through either door.
 */
export function writeEgressEvidence(
  cms: string,
  summary: { proofs: SurfaceProof[] } & Record<string, unknown>,
): string {
  const dir = path.resolve(__dirname, "..", "..", "..", "test-results", "credential-egress");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${cms}.json`);
  // Built field by field rather than by spreading-minus-`raw`: an ALLOW-LIST
  // cannot leak a field a future edit adds to SurfaceProof, and a deny-list can.
  const safe = {
    ...summary,
    proofs: summary.proofs.map((proof) => ({
      surface: proof.surface,
      hits: proof.hits,
      controlSeen: proof.controlSeen,
      scale: proof.scale,
    })),
  };
  writeFileSync(file, redactCredentials(JSON.stringify(safe, null, 2)));
  return file;
}

/**
 * THE PROOF, end to end, on one CMS.
 *
 * It runs the REAL journey first and inspects afterwards, in that order, because
 * the property is about a credential that exists: sign in through the protocol-2
 * ceremony (the frame's own popup on the Cinatra origin), then take one turn —
 * the moment the credential is actually put on the wire — and only then read the
 * parent's surfaces. A proof taken before the turn would be silent about the one
 * instant that matters.
 *
 * Every instrument is passive (see this file's header for the measured reason).
 */
export async function proveNoCredentialReachesParentSurfaces(
  page: Page,
  cms: "wordpress" | "drupal",
): Promise<void> {
  const seed = readSeed();
  const base = cms === "wordpress" ? WP_BASE : DRUPAL_BASE;
  const target =
    cms === "wordpress"
      ? `${base}${seed.wordpress.editUrl}`
      : `${base}${seed.drupal.viewUrl}`;
  const parentOrigin = new URL(base).origin;

  // Passive recorders BEFORE any navigation, so the whole run is covered.
  const { requests, consoleLines, navigations } = installPassiveRecorders(page);

  if (cms === "wordpress") await loginWordPress(page);
  else await loginDrupal(page);
  // ABSOLUTE url. The suite's baseURL is the CINATRA dev server, so a relative
  // CMS path would silently navigate to the wrong origin and every parent-origin
  // assertion below would be about a page the widget never mounted on.
  await page.goto(target, { waitUntil: "domcontentloaded" });

  // THE FULL PROTOCOL-2 CEREMONY, inside its measured budget (cinatra#2708).
  const frame = await openWidget(page);
  await sendPrompt(page, "Hello, what can you do here?");
  await expect(frame.locator(SEL.embedAssistant).last()).toContainText("CINATRA_UAT_OK", {
    timeout: 60_000,
  });

  // ---- the six parent-surface classes, each with its own canary + control.
  const proofs: SurfaceProof[] = [
    await proveNetworkSurface(page, requests, parentOrigin),
    await proveDomSurface(page),
    await proveStorageSurface(page),
    await proveCookieSurface(page, parentOrigin),
    await proveUrlHistorySurface(page, navigations),
    await proveConsoleSurface(page, consoleLines),
  ];

  // The retired protocol-1 envelope, over the SAME bytes the checks above read.
  assertRetiredEnvelopeAbsent(proofs.map((p) => p.raw));

  const file = writeEgressEvidence(cms, {
    cms,
    capturedAt: new Date().toISOString(),
    parentOrigin,
    ceremony: "protocol-2 frame-owned sign-in (popup on the Cinatra origin) + one turn",
    postMessageLimb:
      "DESCOPED — cinatra#2708. Active Window/MessagePort instrumentation breaks the " +
      "protocol-2 ceremony (180s timeout on both CMSes vs 19.7s clean; a handler-wrapping " +
      "rewrite still stalled at 120s). The residual parent-VISIBILITY gap is tracked there.",
    proofs,
  });
  console.log(
    `[wp-drupal-uat][${cms}] parent-surface credential proof: ` +
      `${proofs.map((p) => `${p.surface}=${p.controlSeen ? "control-ok" : "CONTROL-BLIND"}`).join(" ")} ` +
      `— evidence ${file}`,
  );
}
