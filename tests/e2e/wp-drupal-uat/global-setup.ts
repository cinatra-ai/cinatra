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
// cinatra#410 / eng#230 — the shipped widget streams behind a REAL per-site
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
    const signIn = await ctx.post("/api/auth/sign-in/email", {
      data: { email: actor.email, password: actor.password },
      headers: { Origin: CINATRA_BASE },
      failOnStatusCode: false,
    });
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
}
