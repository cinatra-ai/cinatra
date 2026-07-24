import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";

import { request as playwrightRequest } from "@playwright/test";

// ---------------------------------------------------------------------------
// Idempotent seed for the WordPress + Drupal assistant UATs.
//
// Creates one WordPress page + one Drupal node with deterministic content (a
// known title marker) so the assistant action-round-trip scenarios assert
// against fixed values. Idempotent: removes any prior UAT content by marker,
// then creates fresh. Seeded IDs are written to .uat/seed.json for the specs.
//
// Containers: cinatra-wordpress-1 (wp-cli) + cinatra-drupal-1 (drush). If a
// container is unreachable the setup throws with a clear message — the UAT
// suite must NOT silently pass against an unseeded stack.
//
// cinatra#410 — the shipped widget streams behind a REAL per-site
// `cnx_` connect-site credential + a per-user hosted-PKCE `cwu_` login. This
// setup ALSO (1) asserts dev-auto-setup pushed a real `cnx_` (not a legacy UUID)
// into the CMS widget config, and (2) signs the deterministic dev UAT user in
// and saves a storageState so the hosted-login popup lands directly on consent.
// ---------------------------------------------------------------------------

export const WP_CONTAINER = process.env.UAT_WP_CONTAINER ?? "cinatra-wordpress-1";
export const DRUPAL_CONTAINER = process.env.UAT_DRUPAL_CONTAINER ?? "cinatra-drupal-1";
export const WP_TITLE = "Cinatra UAT Page";
export const DRUPAL_TITLE = "Cinatra UAT Article";
export const SEED_FILE = path.join(__dirname, ".uat", "seed.json");
// dev-auto-setup writes the deterministic dev UAT user creds here (gitignored).
export const DEV_ACTOR_FILE = path.join(__dirname, ".uat", "dev-actor.json");
// Saved Cinatra session for the dev UAT user (used by the hosted-login popup).
export const STORAGE_STATE_FILE = path.join(__dirname, ".auth", "state.json");

const CINATRA_BASE = process.env.E2E_WP_DRUPAL_BASE_URL ?? `http://localhost:${process.env.E2E_WP_DRUPAL_PORT ?? "3000"}`;

export type UatSeed = {
  wordpress: { pageId: string; title: string; editUrl: string; adminConfigUrl: string };
  drupal: { nodeId: string; title: string; viewUrl: string; adminConfigUrl: string };
};

function sleepSeconds(seconds: number): void {
  // Blocking wait without a CPU spin (global-setup is sequential).
  execFileSync("sleep", [String(seconds)], { stdio: "ignore" });
}

function dockerExec(container: string, argv: string[], retries = 5): string {
  // The CMS entrypoints bootstrap in the background; a freshly-started container
  // may not have wp-cli/drush ready yet. Retry transient failures so the seed
  // doesn't race the bootstrap (CI also gates on readiness before this runs).
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return execFileSync("docker", ["exec", container, ...argv], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).toString().trim();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) sleepSeconds(3);
    }
  }
  throw lastErr;
}

function seedWordPress(): UatSeed["wordpress"] {
  const wp = (args: string[]) => dockerExec(WP_CONTAINER, ["wp", ...args, "--allow-root"]);
  // Idempotent: delete any prior UAT page(s) by title, then create one.
  const existing = wp(["post", "list", "--post_type=page", `--title=${WP_TITLE}`, "--field=ID", "--format=ids"]);
  for (const id of existing.split(/\s+/).filter(Boolean)) {
    wp(["post", "delete", id, "--force"]);
  }
  const pageId = wp([
    "post", "create",
    "--post_type=page",
    `--post_title=${WP_TITLE}`,
    "--post_content=Seeded deterministic content for the Cinatra UAT.",
    "--post_status=publish",
    "--porcelain",
  ]);
  return {
    pageId,
    title: WP_TITLE,
    editUrl: `/wp-admin/post.php?post=${pageId}&action=edit`,
    adminConfigUrl: "/wp-admin/options-general.php?page=cinatra",
  };
}

function seedDrupal(): UatSeed["drupal"] {
  const root = process.env.UAT_DRUPAL_ROOT ?? "/drupal/web";
  const drush = (args: string[]) => dockerExec(DRUPAL_CONTAINER, ["drush", `--root=${root}`, ...args]);

  // Disable Drupal JS/CSS AGGREGATION for the UAT (cinatra#2031). The Drupal
  // module attaches the widget bundle as a LOCAL library (`cinatra/bundle` →
  // `js/cinatra-widget.js`), so with aggregation ON — Drupal's install default in
  // a production-like container — core folds it into a hashed aggregate served
  // from `/sites/*/files/js/js_<hash>.js`, whose URL no longer contains
  // `cinatra-widget.js`. The drupal-fallback positive control aborts the bundle by
  // matching `/cinatra-widget\.js/`; under aggregation that glob never matches, so
  // the abort never fires (widgetBundleAborts == 0) even though the fallback
  // feature is correct — the exact CI-only anomaly the local (aggregation-OFF dev)
  // Drupal never reproduced. Serving the raw per-file asset makes the interception
  // deterministic across environments. Idempotent (config:set) + a cache rebuild so
  // no previously-aggregated markup/URL is served to the test.
  drush(["config:set", "system.performance", "js.preprocess", "0", "-y"]);
  drush(["config:set", "system.performance", "css.preprocess", "0", "-y"]);
  drush(["cache:rebuild"]);

  // Idempotent: delete prior UAT node(s) by title, then create one via the
  // entity API (drush ev returns the new nid).
  const php = `
    $storage = \\Drupal::entityTypeManager()->getStorage('node');
    $ids = $storage->getQuery()->condition('title', '${DRUPAL_TITLE}')->accessCheck(FALSE)->execute();
    if ($ids) { $storage->delete($storage->loadMultiple($ids)); }
    $node = $storage->create([
      'type' => 'article',
      'title' => '${DRUPAL_TITLE}',
      'body' => ['value' => 'Seeded deterministic content for the Cinatra UAT.', 'format' => 'basic_html'],
      'status' => 1,
    ]);
    $node->save();
    print $node->id();
  `.replace(/\s+/g, " ").trim();
  const nodeId = drush(["ev", php]);
  return {
    nodeId,
    title: DRUPAL_TITLE,
    viewUrl: `/node/${nodeId}`,
    adminConfigUrl: "/admin/config/services/cinatra",
  };
}

function readWpOption(key: string): string {
  try {
    return dockerExec(WP_CONTAINER, ["wp", "option", "get", key, "--allow-root"], 0);
  } catch {
    return "";
  }
}

function readDrupalSetting(key: string): string {
  const root = process.env.UAT_DRUPAL_ROOT ?? "/drupal/web";
  try {
    return dockerExec(
      DRUPAL_CONTAINER,
      ["drush", `--root=${root}`, "config:get", "cinatra.settings", key, "--format=string"],
      0,
    );
  } catch {
    return "";
  }
}

/**
 * Assert the CMS widget config was actually wired by `dev-auto-setup` (detached
 * on the webServer boot, so this POLLS). Asserts the EXACT browser-reachable
 * `cinatra_url` (not just non-empty — a container-only host.docker.internal
 * would let the bug pass) plus non-empty api_key + instance_id on both CMSs.
 * Fail-loud: the UAT must not run scenarios against an unwired widget.
 */
function assertWidgetWired(): void {
  const expectedUrl = `http://localhost:${process.env.E2E_WP_DRUPAL_PORT ?? "3000"}`;
  const maxAttempts = 30; // ~90s — dev-auto-setup is detached on boot.
  let last = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const wpUrl = readWpOption("cinatra_url");
    const wpKey = readWpOption("cinatra_api_key");
    const wpInstance = readWpOption("cinatra_instance_id");
    const drUrl = readDrupalSetting("cinatra_url");
    const drKey = readDrupalSetting("api_key");
    const drInstance = readDrupalSetting("instance_id");
    // cinatra#410 — the pushed key MUST be a real `cnx_` connect-site credential
    // (the legacy widget UUID 401s the shipped broker). Fail loud on a UUID so a
    // regression in dev-auto-setup's `cnx_` mint surfaces here, not as a silent
    // "Thinking…"/401 timeout deep in a spec.
    const wpKeyIsCnx = wpKey.startsWith("cnx_");
    const drKeyIsCnx = drKey.startsWith("cnx_");
    if (
      wpUrl === expectedUrl && wpKeyIsCnx && wpInstance !== "" &&
      drUrl === expectedUrl && drKeyIsCnx && drInstance !== ""
    ) {
      console.log(`[wp-drupal-uat] widget config wired (cinatra_url=${expectedUrl}; cnx_ keys+instance present on WP+Drupal)`);
      return;
    }
    last =
      `expected cinatra_url=${expectedUrl}; api_key must be a cnx_ connect-site credential\n` +
      `  WP:     url=${JSON.stringify(wpUrl)} key=${wpKey ? (wpKeyIsCnx ? "cnx_" : "set-NOT-cnx_") : "EMPTY"} instance=${wpInstance ? "set" : "EMPTY"}\n` +
      `  Drupal: url=${JSON.stringify(drUrl)} key=${drKey ? (drKeyIsCnx ? "cnx_" : "set-NOT-cnx_") : "EMPTY"} instance=${drInstance ? "set" : "EMPTY"}`;
    if (attempt < maxAttempts) sleepSeconds(3);
  }
  throw new Error(
    `[wp-drupal-uat] widget config not wired after ${maxAttempts} attempts.\n  ${last}\n` +
      `  dev-auto-setup (src/lib/dev-auto-setup.ts) pushes cinatra_url/api_key/instance_id on each dev-server boot; ` +
      `the api_key MUST be a cnx_ connect-site credential (cinatra#410 dev mint).`,
  );
}

export type DevActor = { userId: string; orgId: string; email: string; password: string };

function readDevActor(): DevActor {
  let raw: string;
  try {
    raw = readFileSync(DEV_ACTOR_FILE, "utf8");
  } catch {
    throw new Error(
      `[wp-drupal-uat] dev UAT actor not found at ${DEV_ACTOR_FILE}. ` +
        `dev-auto-setup (ensureDevConnectActor) seeds it on the dev-server boot — ` +
        `ensure CINATRA_RUNTIME_MODE=development and the dev server booted before global-setup.`,
    );
  }
  return JSON.parse(raw) as DevActor;
}

/**
 * Sign the deterministic dev UAT user IN against the cinatra dev server and save
 * a storageState. Both Playwright projects load this state, so the widget's
 * hosted `/widget-auth` login popup inherits the Cinatra session and lands
 * directly on the consent step (no manual credentials in the popup) — exercising
 * the REAL #410 login gate deterministically. The user + org are seeded
 * server-side by dev-auto-setup; here we only sign in (never sign up).
 */
async function establishCinatraSession(actor: DevActor): Promise<void> {
  const ctx = await playwrightRequest.newContext({ baseURL: CINATRA_BASE });
  try {
    // The dev server is still churning through first-compile + background
    // extension registration when global-setup starts (a first GET can take
    // >40s on a CI runner), and a request landing in that window can die with
    // a socket-level ECONNRESET before any HTTP status exists (ci#61 — both
    // on-demand nightly proofs failed exactly here). Retry TRANSPORT errors
    // with a backoff; an HTTP response (any status) ends the retry loop and
    // is judged by the existing status check below.
    const maxAttempts = 10;
    let signIn: Awaited<ReturnType<typeof ctx.post>> | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        signIn = await ctx.post("/api/auth/sign-in/email", {
          data: { email: actor.email, password: actor.password },
          headers: { Origin: CINATRA_BASE },
          failOnStatusCode: false,
        });
        break;
      } catch (err) {
        if (attempt === maxAttempts) throw err;
        console.log(
          `[wp-drupal-uat] sign-in POST transport error (attempt ${attempt}/${maxAttempts}): ${String(err)} — retrying in 6s`,
        );
        sleepSeconds(6);
      }
    }
    if (!signIn) throw new Error("[wp-drupal-uat] sign-in POST never produced a response (unreachable)");
    if (!signIn.ok()) {
      throw new Error(
        `[wp-drupal-uat] dev UAT user sign-in failed (HTTP ${signIn.status()}). ` +
          `The user is seeded by dev-auto-setup (ensureDevConnectActor) — verify the dev server is on CINATRA_RUNTIME_MODE=development.`,
      );
    }
    // Pin the active org so the hosted page resolves membership against it.
    await ctx.post("/api/auth/organization/set-active", {
      data: { organizationId: actor.orgId },
      headers: { Origin: CINATRA_BASE },
      failOnStatusCode: false,
    });
    mkdirSync(path.dirname(STORAGE_STATE_FILE), { recursive: true });
    await ctx.storageState({ path: STORAGE_STATE_FILE });
    console.log(`[wp-drupal-uat] Cinatra session established for ${actor.email} (org ${actor.orgId}); storageState saved`);
  } finally {
    await ctx.dispose();
  }
}

/**
 * Warm every dev-server route on the widget's dual-token path BEFORE the specs
 * run, so Next.js dev-mode first-compile latency is absorbed here instead of
 * inside a spec's assertion window.
 *
 * Why this exists (observed on the 2026-07-11 dispatch run): under dev
 * cold-compile the first `POST /api/agents/{slug}/token` took 10.0s — at/over
 * the WP plugin broker's 10s server-to-server HTTP timeout — so the broker
 * returned its generic 502 and the widget surfaced "Could not obtain a Cinatra
 * session token (Could not reach the Cinatra instance…)" (spec 4, attempt 1).
 * On the retry the token minted fine but the FIRST CORS preflight
 * `OPTIONS /api/agents/{slug}/stream` took 26.9s (route first-compile), pushing
 * the sentinel render just past the 30s expect window (spec 4, retry). Both are
 * dev-compile artifacts, not plugin/product defects — production runs a built
 * server where these routes respond in well under a second, so the fix belongs
 * in the harness, not in the shipped plugin's timeout.
 *
 * Every warm request is side-effect-free: OPTIONS is a bare CORS preflight, the
 * POSTs carry no/invalid credentials so they terminate at auth (4xx) AFTER the
 * route module has compiled, and the GETs are read-only. Statuses are logged
 * but never asserted — compile warmth is the only goal; real behavior stays
 * proven by the specs.
 */
async function warmDevRoutes(): Promise<void> {
  const ctx = await playwrightRequest.newContext({ baseURL: CINATRA_BASE });
  try {
    const targets: Array<{ label: string; run: () => Promise<{ status(): number }> }> = [];
    // Shared widget-auth surface (init route, hosted page, redeem route).
    targets.push(
      { label: "POST /api/widget-auth/init", run: () => ctx.post("/api/widget-auth/init", { data: {}, failOnStatusCode: false, timeout: 120_000 }) },
      { label: "GET /widget-auth", run: () => ctx.get("/widget-auth", { failOnStatusCode: false, timeout: 120_000 }) },
      { label: "POST /api/widget-auth/token", run: () => ctx.post("/api/widget-auth/token", { data: {}, failOnStatusCode: false, timeout: 120_000 }) },
    );
    // S5 unified assistant-broker surface (cinatra#1221/#1998/#2029) — the routes
    // the cutover widget actually drives. Warm the client-side negotiate GET, the
    // turn POST + its CORS preflight (broker-auth branch), and the /embed/assistant
    // page the widget frames (also the fallback's reachability-probe target). These
    // are single compiled modules (not per-[agentSlug]), so warm them ONCE. The
    // legacy per-agent /capabilities + /stream warms are dropped: those routes were
    // deleted (cinatra#1991).
    const uatWpOrigin = process.env.UAT_WP_BASE_URL ?? "http://localhost:8080";
    targets.push(
      { label: "GET /api/assistants/chat/capabilities", run: () => ctx.get("/api/assistants/chat/capabilities", { failOnStatusCode: false, timeout: 120_000 }) },
      {
        label: "OPTIONS /api/assistants/chat",
        run: () =>
          ctx.fetch("/api/assistants/chat", {
            method: "OPTIONS",
            headers: {
              Origin: uatWpOrigin,
              "Access-Control-Request-Method": "POST",
              "Access-Control-Request-Headers": "authorization,content-type,x-cinatra-widget-user-token",
            },
            failOnStatusCode: false,
            timeout: 120_000,
          }),
      },
      {
        label: "POST /api/assistants/chat",
        run: () =>
          ctx.post("/api/assistants/chat", {
            headers: {
              Authorization: "Bearer cit_warmup-invalid",
              "X-Cinatra-Widget-User-Token": "cwu_warmup-invalid",
              Origin: uatWpOrigin,
            },
            data: { threadId: "warmup", messages: [{ role: "user", content: "warm" }], assistant: "wordpress" },
            failOnStatusCode: false,
            timeout: 120_000,
          }),
      },
      { label: "GET /embed/assistant", run: () => ctx.get("/embed/assistant?assistant=wordpress&instanceId=warmup", { failOnStatusCode: false, timeout: 120_000 }) },
    );
    // Per-agent surface. Only the short-lived cit_ MINT survives on the per-agent
    // route family (POST /api/agents/{slug}/token — unchanged by the S5 cutover,
    // cinatra#1221). The dynamic [agentSlug] segments share one compiled module,
    // but warm both slugs anyway: first-hit per-agent work (extension service
    // registration) also shows up as multi-second latency in run logs.
    for (const slug of ["wordpress-content-editor", "drupal-content-editor"] as const) {
      targets.push(
        {
          label: `POST /api/agents/${slug}/token`,
          run: () =>
            ctx.post(`/api/agents/${slug}/token`, {
              headers: { Authorization: "Bearer warmup-invalid", Origin: CINATRA_BASE },
              data: { contractVersion: "v1" },
              failOnStatusCode: false,
              timeout: 120_000,
            }),
        },
      );
    }
    for (const target of targets) {
      const startedAt = Date.now();
      try {
        const res = await target.run();
        console.log(`[wp-drupal-uat] warm ${target.label} -> HTTP ${res.status()} in ${Date.now() - startedAt}ms`);
      } catch (err) {
        // A transport failure here must not fail the suite setup — the specs
        // will surface any real breakage. Log it: a warm miss explains a later
        // cold-compile latency spike.
        console.log(`[wp-drupal-uat] warm ${target.label} FAILED after ${Date.now() - startedAt}ms: ${String(err)}`);
      }
    }
  } finally {
    await ctx.dispose();
  }
}

export default async function globalSetup(): Promise<void> {
  const seed: UatSeed = {
    wordpress: seedWordPress(),
    drupal: seedDrupal(),
  };
  mkdirSync(path.dirname(SEED_FILE), { recursive: true });
  writeFileSync(SEED_FILE, JSON.stringify(seed, null, 2));
  console.log(`[wp-drupal-uat] seeded WP page #${seed.wordpress.pageId} + Drupal node #${seed.drupal.nodeId}`);
  assertWidgetWired();
  // The hosted-login popup needs a logged-in Cinatra session (member of the
  // connect-site's org). Sign the dev UAT user in + save the storageState.
  await establishCinatraSession(readDevActor());
  // Absorb dev-server first-compile latency BEFORE any spec's timing window.
  await warmDevRoutes();
}
