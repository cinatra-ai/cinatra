import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

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
// ---------------------------------------------------------------------------

export const WP_CONTAINER = process.env.UAT_WP_CONTAINER ?? "cinatra-wordpress-1";
export const DRUPAL_CONTAINER = process.env.UAT_DRUPAL_CONTAINER ?? "cinatra-drupal-1";
export const WP_TITLE = "Cinatra UAT Page";
export const DRUPAL_TITLE = "Cinatra UAT Article";
export const SEED_FILE = path.join(__dirname, ".uat", "seed.json");

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
    if (
      wpUrl === expectedUrl && wpKey !== "" && wpInstance !== "" &&
      drUrl === expectedUrl && drKey !== "" && drInstance !== ""
    ) {
      // eslint-disable-next-line no-console
      console.log(`[wp-drupal-uat] widget config wired (cinatra_url=${expectedUrl}; keys+instance present on WP+Drupal)`);
      return;
    }
    last =
      `expected cinatra_url=${expectedUrl}\n` +
      `  WP:     url=${JSON.stringify(wpUrl)} key=${wpKey ? "set" : "EMPTY"} instance=${wpInstance ? "set" : "EMPTY"}\n` +
      `  Drupal: url=${JSON.stringify(drUrl)} key=${drKey ? "set" : "EMPTY"} instance=${drInstance ? "set" : "EMPTY"}`;
    if (attempt < maxAttempts) sleepSeconds(3);
  }
  throw new Error(
    `[wp-drupal-uat] widget config not wired after ${maxAttempts} attempts.\n  ${last}\n` +
      `  dev-auto-setup (src/lib/dev-auto-setup.ts) pushes cinatra_url/api_key/instance_id on each dev-server boot.`,
  );
}

export default async function globalSetup(): Promise<void> {
  const seed: UatSeed = {
    wordpress: seedWordPress(),
    drupal: seedDrupal(),
  };
  mkdirSync(path.dirname(SEED_FILE), { recursive: true });
  writeFileSync(SEED_FILE, JSON.stringify(seed, null, 2));
  // eslint-disable-next-line no-console
  console.log(`[wp-drupal-uat] seeded WP page #${seed.wordpress.pageId} + Drupal node #${seed.drupal.nodeId}`);
  assertWidgetWired();
}
