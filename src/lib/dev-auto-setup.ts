import "server-only";
import { execSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { Buffer } from "node:buffer";
import path from "node:path";

import { saveDrupalInstance, listDrupalInstances } from "@/lib/drupal-api";
import {
  generateDrupalWidgetAuthConfig,
  readDrupalWidgetAuthConfig,
} from "@/lib/drupal-widget-auth";
import {
  probeDrupalMcpWithBearer,
  invalidateDrupalMcpProbeCache,
} from "@/lib/drupal-mcp-connection";
import {
  saveWordPressInstance,
  persistLocalDevWordPressInstanceUnvalidated,
  listWordPressInstances,
  readWordPressInstanceById,
} from "@/lib/wordpress-api";
import { invalidateWordPressMcpProbeCache } from "@/lib/wordpress-mcp-connection";
import {
  generateWidgetAuthConfig,
  readWidgetAuthConfig,
} from "@/lib/wordpress-widget-auth";
import {
  isNangoConfigured,
  ensureNangoIntegration,
  importNangoConnection,
  getNangoCredentials,
  CINATRA_NANGO_PROVIDER_CONFIG_KEYS,
} from "@/lib/nango-system";
import { listConnectorDescriptors } from "@cinatra-ai/connectors-catalog/descriptors.mjs";
import { setExtensionInstallAccess } from "@cinatra-ai/extensions/install-access-contract";
import { installExtensionManifest } from "@cinatra-ai/extensions/lifecycle-primitive";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { getPostgresConnectionString, postgresSchema } from "@/lib/database";
import { randomUUID } from "node:crypto";
import {
  getExternalMcpServerById,
  upsertExternalMcpServer,
  resolveExternalMcpServerBearer,
  EXTERNAL_MCP_NANGO_PROVIDER_CONFIG_KEY,
} from "@/lib/external-mcp-registry";
import {
  buildSeedDevArgs,
  buildGenerateApiKeyArgs,
  parseTwentyApiKey,
  probeTwentyBearer,
} from "@/lib/twenty-keygen.mjs";

// -----------------------------------------------------------------------------
// Dev auto-setup for the local docker WordPress + Drupal containers.
//
// Goal: after first `pnpm dev` (or `cinatra setup dev`), the assistant can
// read/write the local Drupal + WordPress without ANY manual configuration on
// either side.
//
// Idempotent. Safe to call repeatedly. Soft-fails (logs + returns a status
// object) — never throws — so app boot is never blocked by a wp-cli or drush
// hiccup.
// -----------------------------------------------------------------------------

const LOCAL_DRUPAL = {
  containerName: "cinatra-drupal-1",
  siteUrl: "http://localhost:8082",
  instanceName: "Local Drupal (dev auto)",
} as const;

const LOCAL_WORDPRESS = {
  containerName: "cinatra-wordpress-1",
  siteUrl: "http://localhost:8080",
  adminUser: "admin",
  appPasswordLabel: "cinatra-dev-auto",
} as const;

const LOCAL_TWENTY = {
  containerName: "cinatra-twenty-1",
  serverUrl: "http://localhost:3300",
  mcpUrl: "http://localhost:3300/mcp",
  rowId: "twenty-workspace",
  rowLabel: "Twenty CRM (local dev)",
  // Layer B catalog allowlist — read tools only at first. Write verbs
  // (`create_person`, `update_company`, ...) land with the agent-rewrite
  // cutover. Native MCP tools (`execute_tool`, `get_tool_catalog`,
  // `learn_tools`, `load_skills`, `search_help_center`) are controlled by
  // Layer A `allowedTools`, NOT Layer B — never include them here.
  allowedCatalogTools: [
    "find_companies",
    "find_people",
    "find_one_company",
    "find_one_person",
    "get_views",
  ] as string[],
} as const;

type Status =
  | { status: "created"; siteUrl: string; detail?: string }
  | { status: "already-wired"; siteUrl: string; detail?: string }
  | { status: "skipped"; reason: string }
  | { status: "error"; reason: string };

function probeHttp(url: string, timeoutSeconds = 3): boolean {
  try {
    execSync(`curl -fsS -o /dev/null --max-time ${timeoutSeconds} ${url}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Browser-reachable Cinatra origin for the CMS widget config.
 *
 * The widget bundle + SSE stream are loaded by the admin's BROWSER (on the
 * host), so the configured `cinatra_url` must resolve from the host —
 * `http://localhost:${PORT}`, NOT a container-only `host.docker.internal`.
 * `scripts/dev-server.mjs` lifts `.env.local` PORT into process.env, and the
 * WP/Drupal UAT sets PORT, so this tracks the actual dev-server port.
 */
function cinatraBrowserBaseUrl(): string {
  return `http://localhost:${process.env.PORT ?? "3000"}`;
}

/**
 * Strip trailing slashes via a LINEAR char-index trim. The anchored greedy
 * `/\/+$/` is polynomial-ReDoS on input with many trailing slashes (CodeQL
 * `js/polynomial-redos`, high) — the codebase has standardised on this linear
 * form (see `resolveLocalOrigin` in packages/cli and
 * `normaliseMcpPublicBaseUrl` in packages/mcp-server). Never use `/\/+$/`.
 */
export function trimTrailingSlashes(input: string): string {
  let end = input.length;
  while (end > 0 && input.charCodeAt(end - 1) === 47) end--; // 47 = "/"
  return input.slice(0, end);
}

function drushExec(args: string): void {
  execSync(`docker exec ${LOCAL_DRUPAL.containerName} drush --root=/drupal/web ${args}`, {
    stdio: "pipe",
  });
}

/** Capture-mode drush exec (combined stdout+stderr) for porcelain reads. */
function drushExecCapture(args: string[]): { code: number; out: string } {
  const r = spawnSync(
    "docker",
    ["exec", LOCAL_DRUPAL.containerName, "drush", "--root=/drupal/web", ...args],
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  );
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

const DRUPAL_REMOTE_KEY_LABEL = "cinatra-dev";

/**
 * Extract the Bearer remote key from `drush mcp-tools:remote-key-create` output.
 *
 * The command prints the key (often with surrounding log lines). We take the
 * last non-empty trimmed line and accept it only if it is a single opaque token
 * of plausible length. The validation regex is intentionally LINEAR (anchored
 * both ends, one character class, no nested quantifier) — `js/polynomial-redos`
 * safe. Returns null when no token-shaped line is present (caller soft-skips —
 * a failed mint must NEVER overwrite a working key).
 *
 * SECRET BOUNDARY: the returned value is the Bearer; callers must never log it.
 */
export function parseDrupalRemoteKey(out: string): string | null {
  const lines = out.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    // A valid remote key is a single opaque token (no whitespace), reasonable
    // length. `[A-Za-z0-9._=+/-]` is a single character class; the bounded
    // quantifier `{16,512}` is anchored and non-nested → linear, ReDoS-safe.
    if (/^[A-Za-z0-9._=+/-]{16,512}$/.test(line)) return line;
    // First non-empty line from the bottom that isn't token-shaped (e.g. a
    // human log line) means the porcelain token wasn't the last line — stop:
    // we only trust a clean trailing token.
    return null;
  }
  return null;
}

/**
 * Mint a fresh Drupal `mcp_tools_remote` Bearer via drush, returning the opaque
 * key or null on any failure. Never throws; never logs the key.
 */
function mintDrupalRemoteKey(): string | null {
  try {
    const r = drushExecCapture([
      "mcp-tools:remote-key-create",
      `--label=${DRUPAL_REMOTE_KEY_LABEL}`,
      "--scopes=read,write",
    ]);
    if (r.code !== 0) return null;
    return parseDrupalRemoteKey(r.out);
  } catch {
    return null;
  }
}

type DrupalReconcileOutcome = {
  // The reconcile reached a state where the stored Nango Bearer should
  // authenticate against Drupal `/_mcp_tools` (reused-OK, kept-on-transient, or
  // freshly minted + readback-verified). False = the connector will 401.
  working: boolean;
  rotated: boolean;
  note?: string;
};

/**
 * Reconcile the Drupal Nango connection's stored credential to the value
 * Drupal's `mcp_tools_remote` actually validates — the
 * `drush mcp-tools:remote-key-create` Bearer — NOT the cinatra widget UUID
 * (`drupal_widget_auth.apiKey`) the connection stored historically (split-brain).
 *
 * Reuse-first / probe-then-rotate, mirroring `ensureTwentyBearerAttached`:
 *   1. Resolve the stored Bearer from Nango (forceRefresh — bypass the cred
 *      cache so a prior rotate is reflected). If unresolved (null/throw) →
 *      TRANSIENT: keep, soft-skip (never mint on a transient Nango blip).
 *   2. Legacy split-brain: if the stored value is EXACTLY the widget UUID, the
 *      connection holds the wrong secret → rotate.
 *   3. Otherwise probe HEAD `${siteUrl}/_mcp_tools` with the stored Bearer
 *      (live, cache-bypassing). Rotate ONLY on a definite `auth_error`
 *      (401/403). `registered` → reuse; `not_installed`/`unreachable` →
 *      keep + soft-skip (NEVER rotate on transient/unreachable).
 *   4. Rotate = mint a fresh key, then re-import via `saveDrupalInstance`
 *      (which readback-verifies the new key in Nango BEFORE it persists, so a
 *      failed mint/import can never overwrite the working stored key). On
 *      success, invalidate the URL-keyed probe cache.
 *
 * Soft-fails: never throws. SECRET BOUNDARY: only statuses/booleans surfaced.
 */
export async function ensureDrupalRemoteKeyReconciled(input: {
  instanceId: string;
  instanceName: string;
  siteUrl: string;
  widgetApiKey: string;
}): Promise<DrupalReconcileOutcome> {
  const providerConfigKey = CINATRA_NANGO_PROVIDER_CONFIG_KEYS.drupal;

  const rotate = async (reason: string): Promise<DrupalReconcileOutcome> => {
    const minted = mintDrupalRemoteKey();
    if (!minted) {
      // Mint failed — keep the existing stored credential untouched.
      return { working: false, rotated: false, note: `mint-failed (${reason}; kept existing)` };
    }
    try {
      // saveDrupalInstance does ensure → import → forceRefresh readback-verify
      // (throws on mismatch) → persist → saveNangoConnectionRecord. The
      // readback gate means a bad key never lands in the local row/pointer.
      await saveDrupalInstance({
        id: input.instanceId,
        name: input.instanceName,
        siteUrl: input.siteUrl,
        mcpApiKey: minted,
      });
    } catch {
      // SECRET BOUNDARY: do NOT forward the raw error message — saveDrupalInstance
      // errors can carry lower-layer (Nango import / readback) text. Surface only
      // a fixed host-owned label. The detail is recoverable from app logs at the
      // throwing layer if needed.
      return { working: false, rotated: false, note: `re-import-failed (${reason})` };
    }
    // Rotation succeeded: evict the URL-keyed probe cache so the next
    // UI/injection probe re-evaluates against the fresh Bearer.
    invalidateDrupalMcpProbeCache(input.siteUrl);
    return { working: true, rotated: true, note: `rotated (${reason})` };
  };

  // 1. Resolve the stored Bearer (forceRefresh — bypass the cred cache).
  let storedBearer: string | null;
  try {
    const cred = await getNangoCredentials(providerConfigKey, input.instanceId, {
      forceRefresh: true,
    });
    storedBearer =
      cred && typeof cred === "object" && "apiKey" in cred
        ? ((cred as { apiKey?: unknown }).apiKey as string | undefined) ?? null
        : typeof cred === "string"
          ? cred
          : null;
  } catch {
    // Transient Nango read failure — keep, do NOT mint a duplicate.
    return { working: false, rotated: false, note: "credential-resolve-error (kept existing)" };
  }

  if (!storedBearer) {
    // Could be a transient null OR a genuinely missing credential. With an
    // existing instance present we mirror Twenty: do NOT mint on an
    // unresolved read (avoids minting a fresh key every boot on a Nango blip).
    return { working: false, rotated: false, note: "credential-unresolved (kept; not minting)" };
  }

  // 2. Legacy split-brain — the connection literally stores the widget UUID.
  //    Exact equality (NOT a UUID-shape regex): if the historical wrong value
  //    is present, it can never validate against `mcp_tools_remote` → rotate.
  if (storedBearer === input.widgetApiKey) {
    return rotate("split-brain: widget-uuid stored");
  }

  // 3. Probe live with the stored Bearer (cache-bypassing).
  const status = await probeDrupalMcpWithBearer(input.siteUrl, storedBearer);
  if (status === "registered") {
    return { working: true, rotated: false };
  }
  if (status === "auth_error") {
    // Definite 401/403 — the stored key is genuinely stale → rotate.
    return rotate("probe-401/403");
  }
  // not_installed (404) / unreachable (timeout/5xx/network): NEVER rotate on a
  // transient or non-auth condition — keep the existing key, soft-skip.
  return { working: false, rotated: false, note: `probe-${status} (kept existing; not rotating)` };
}

function probeDockerContainer(name: string): boolean {
  try {
    const out = execSync(`docker ps --filter name=^/${name}$ --format '{{.Names}}'`, {
      stdio: ["ignore", "pipe", "pipe"],
    })
      .toString()
      .trim();
    return out === name;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Drupal
// ---------------------------------------------------------------------------

async function autoSetupLocalDrupal(): Promise<Status> {
  if (!probeDockerContainer(LOCAL_DRUPAL.containerName)) {
    return { status: "skipped", reason: `${LOCAL_DRUPAL.containerName} not running (run docker compose --profile drupal up -d)` };
  }
  if (!probeHttp(LOCAL_DRUPAL.siteUrl + "/")) {
    return { status: "skipped", reason: `${LOCAL_DRUPAL.siteUrl} not reachable` };
  }

  // The Drupal module is consumed as a local clone of cinatra-ai/drupal-module
  // (synced by `cinatra setup dev`). Skip cleanly if it hasn't been cloned yet.
  if (!existsSync(path.join(process.cwd(), "dev/drupal-module/cinatra/cinatra.module"))) {
    return {
      status: "skipped",
      reason: "module clone missing at dev/drupal-module/cinatra/cinatra.module. Run `cinatra setup dev` first.",
    };
  }

  // saveDrupalInstance requires Nango; gracefully skip if not yet configured.
  if (!isNangoConfigured()) {
    return { status: "skipped", reason: "Nango not configured (run cinatra setup nango first)" };
  }

  // Cinatra-side: generate or reuse the UUID-pair api_key (lives in
  // connector_config:drupal_widget_auth). This is the WIDGET Bearer (the
  // browser→cinatra direction); it is NOT the credential Drupal's
  // `mcp_tools_remote` validates (that is the `drush mcp-tools:remote-key-create`
  // Bearer). The Nango `cinatra-drupal` connection must hold the LATTER.
  const auth = readDrupalWidgetAuthConfig() ?? generateDrupalWidgetAuthConfig();

  // Ensure the cinatra-side instance exists (create on first run; reuse after).
  // saveDrupalInstance does the ensureIntegration → importNangoConnection →
  // readback dance internally. On FIRST create, seed the Nango connection with a
  // freshly minted remote-key Bearer (NOT the widget UUID — that historical
  // value was the split-brain bug); if the mint is unavailable, soft-skip the
  // create this boot rather than persist a wrong credential.
  const existing = (await listDrupalInstances()).find((i) => i.siteUrl === LOCAL_DRUPAL.siteUrl);
  let instanceId: string;
  let created: boolean;
  if (existing) {
    instanceId = existing.id;
    created = false;
  } else {
    const seedBearer = mintDrupalRemoteKey();
    if (!seedBearer) {
      return {
        status: "skipped",
        reason:
          "Drupal mcp-tools:remote-key-create did not yield a key (module may still be installing). " +
          "Re-run once the drupal container has finished provisioning.",
      };
    }
    try {
      const saved = await saveDrupalInstance({
        name: LOCAL_DRUPAL.instanceName,
        siteUrl: LOCAL_DRUPAL.siteUrl,
        mcpApiKey: seedBearer,
      });
      instanceId = saved.id;
      created = true;
    } catch {
      // SECRET BOUNDARY: saveDrupalInstance errors can carry lower-layer (Nango
      // import / readback) text — surface only a fixed host-owned reason.
      return { status: "error", reason: "saveDrupalInstance failed (first wire)" };
    }
  }

  // Reconcile the stored Nango Bearer to the value Drupal validates — runs on
  // EVERY wire (create OR reuse). Reuse-first / probe-then-rotate; soft-fails.
  const reconcile = await ensureDrupalRemoteKeyReconciled({
    instanceId,
    instanceName: existing?.name ?? LOCAL_DRUPAL.instanceName,
    siteUrl: LOCAL_DRUPAL.siteUrl,
    widgetApiKey: auth.apiKey,
  });
  if (!reconcile.working) {
    console.log(
      `[dev-auto-setup:drupal] remote-key reconcile did not confirm a working Bearer (${reconcile.note ?? "unknown"}). ` +
        "Drupal MCP writes 401 until a valid remote key is stored; re-run once Drupal is fully up.",
    );
  }

  // Drupal-side: push the widget config on EVERY run (create OR reuse) so a
  // CMS-volume reset with the app DB retained still re-wires correctly.
  // `cinatra_url` is the BROWSER-reachable origin (localhost:PORT) — the widget
  // bundle + SSE load from it in the admin's browser; the server-side import
  // Drush command reads CINATRA_BASE_URL instead. config:set is a no-op when the
  // value is unchanged. All values are controlled (localhost:PORT + UUIDs).
  try {
    drushExec(`config:set cinatra.settings cinatra_url ${cinatraBrowserBaseUrl()} -y`);
    drushExec(`config:set cinatra.settings api_key ${auth.apiKey} -y`);
    drushExec(`config:set cinatra.settings instance_id ${instanceId} -y`);
    drushExec(`cr`);
  } catch (err) {
    return {
      status: "error",
      reason: `drush config:set cinatra.settings failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const reconcileNote = reconcile.rotated
    ? "remote-key rotated"
    : reconcile.working
      ? "remote-key valid"
      : `remote-key unconfirmed (${reconcile.note ?? "unknown"})`;

  return created
    ? { status: "created", siteUrl: LOCAL_DRUPAL.siteUrl, detail: `instance ${instanceId} (${reconcileNote})` }
    : {
        status: "already-wired",
        siteUrl: LOCAL_DRUPAL.siteUrl,
        detail: `instance ${instanceId} (config re-pushed; ${reconcileNote})`,
      };
}

// ---------------------------------------------------------------------------
// WordPress
// ---------------------------------------------------------------------------

function wpCli(args: string): string {
  return execSync(
    `docker exec ${LOCAL_WORDPRESS.containerName} wp ${args} --allow-root 2>&1`,
    { stdio: ["ignore", "pipe", "pipe"] },
  ).toString();
}

type WordPressAuthProbe = "ok" | "unauthorized" | "unreachable";

/**
 * Probe WordPress REST authentication for a username + application password.
 * Hits `/users/me?context=edit` (the same endpoint saveWordPressInstance
 * validates against) over the rest_route query form so it works without pretty
 * permalinks. Classifies the result conservatively:
 *   - 200             → "ok" (credential authenticates)
 *   - 401 / 403       → "unauthorized" (DEFINITE auth failure → rotate trigger)
 *   - anything else / network error / timeout → "unreachable" (transient — NEVER
 *     rotate; minting a fresh app-password on a blip would litter the list)
 * Never throws. SECRET BOUNDARY: builds the Basic header locally; never logs it.
 */
async function probeWordPressAuth(
  siteUrl: string,
  username: string,
  applicationPassword: string,
): Promise<WordPressAuthProbe> {
  const base = trimTrailingSlashes(siteUrl);
  const endpoint = `${base}/index.php?rest_route=/wp/v2/users/me&context=edit`;
  const authHeader = `Basic ${Buffer.from(`${username}:${applicationPassword}`).toString("base64")}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(endpoint, {
        method: "GET",
        headers: { Authorization: authHeader, Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      });
      if (res.status === 200) return "ok";
      if (res.status === 401 || res.status === 403) return "unauthorized";
      return "unreachable";
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return "unreachable";
  }
}

/** Mint a fresh WordPress application password via wp-cli (porcelain). */
function mintWordPressAppPassword(): string | null {
  try {
    const out = wpCli(
      `user application-password create ${LOCAL_WORDPRESS.adminUser} ${LOCAL_WORDPRESS.appPasswordLabel} --porcelain`,
    ).trim();
    if (!out || /Error/i.test(out)) return null;
    // The porcelain output is the bare application password (a single token).
    return out.split("\n").pop()?.trim() || null;
  } catch {
    return null;
  }
}

type WordPressReconcileOutcome = {
  // True when the instance's stored credential should authenticate against WP
  // REST (reused-OK, kept-on-transient, or freshly minted + both-halves-verified).
  working: boolean;
  rotated: boolean;
  note?: string;
};

/**
 * Reconcile a WordPress instance's stored application password — runs on EVERY
 * wire (reuse path included), replacing the old create-only-once branch.
 *
 * Reuse-first / probe-then-rotate, mirroring `ensureTwentyBearerAttached`:
 *   1. Resolve the stored Basic creds from Nango (forceRefresh — bypass the
 *      cred cache). If unresolved (null/throw) → TRANSIENT: keep, soft-skip.
 *   2. Probe WP REST auth. `ok` → reuse. `unreachable` → keep + soft-skip
 *      (NEVER mint on a transient/non-auth condition → no app-password churn).
 *   3. `unauthorized` (definite 401/403) ONLY → mint a fresh application
 *      password and re-save via `saveWordPressInstance` (re-validates over the
 *      network, then best-effort syncs Nango).
 *   4. BOTH-HALVES check (codex must-fix): saveWordPressInstance SWALLOWS a
 *      Nango-sync failure (wordpress-api.ts:472), so after the save we read the
 *      Nango credential back (forceRefresh) and equality-check username+password.
 *      A mismatch means connector-metadata and Nango diverged → report
 *      not-working (do NOT claim success). On a verified rotate, invalidate the
 *      URL-keyed probe cache.
 *
 * Soft-fails: never throws. SECRET BOUNDARY: only statuses/booleans surfaced.
 */
export async function ensureWordPressAppPasswordReconciled(input: {
  instanceId: string;
  siteUrl: string;
  username: string;
  providerConfigKey: string;
  connectionId: string;
}): Promise<WordPressReconcileOutcome> {
  // Read the Nango-resolved Basic credential the connector actually uses.
  let resolved: { username: string; password: string } | null;
  try {
    const cred = await getNangoCredentials(input.providerConfigKey, input.connectionId, {
      forceRefresh: true,
    });
    resolved =
      cred &&
      typeof cred === "object" &&
      "username" in cred &&
      "password" in cred &&
      typeof (cred as { username?: unknown }).username === "string" &&
      typeof (cred as { password?: unknown }).password === "string"
        ? {
            username: (cred as { username: string }).username,
            password: (cred as { password: string }).password,
          }
        : null;
  } catch {
    return { working: false, rotated: false, note: "credential-resolve-error (kept existing)" };
  }

  if (!resolved) {
    // Nango resolved to nothing. This is EITHER a transient Nango blip OR the
    // connection went fully missing (e.g. a prior rotate wrote a fresh local
    // password but its best-effort Nango sync never landed). We must NOT mint on
    // an unresolved read (a fresh mint every boot would litter the WP
    // app-password list). BUT if the LOCAL connector-metadata already holds a
    // usable password, re-sync Nango FROM it (idempotent, no mint) so a fully
    // missing Nango connection self-heals from the credential we already have.
    const localOnly = readWordPressInstanceById(input.instanceId);
    const localOnlyPw = localOnly?.applicationPassword?.trim() || "";
    if (localOnlyPw) {
      try {
        await saveWordPressInstance({
          id: input.instanceId,
          siteUrl: input.siteUrl,
          username: localOnly?.username ?? input.username,
          applicationPassword: localOnlyPw,
        });
      } catch {
        return { working: false, rotated: false, note: "credential-unresolved; re-sync-failed" };
      }
      const reSynced = await verifyWordPressNangoBothHalves(
        input,
        localOnly?.username ?? input.username,
        localOnlyPw,
      );
      if (!reSynced) {
        return { working: false, rotated: false, note: "credential-unresolved; re-sync did not land" };
      }
      invalidateWordPressMcpProbeCache(input.siteUrl);
      return { working: true, rotated: false, note: "nango-resynced-from-local (was unresolved; no mint)" };
    }
    // No local credential to repair from — keep, do not mint.
    return { working: false, rotated: false, note: "credential-unresolved (kept; not minting)" };
  }

  // Probe with the resolved credential.
  const probe = await probeWordPressAuth(input.siteUrl, resolved.username, resolved.password);
  if (probe === "ok") {
    return { working: true, rotated: false };
  }
  if (probe === "unreachable") {
    // Indeterminate — keep the existing app-password; NEVER mint on a blip.
    return { working: true, rotated: false, note: "probe-unreachable (kept existing)" };
  }

  // probe === "unauthorized" → definite 401/403.
  //
  // CHURN GUARD: before minting, check whether the LOCAL connector-metadata
  // password differs from the (stale) Nango-resolved one. If it does, a PRIOR
  // rotate already wrote a fresh password into the local row but its best-effort
  // Nango sync failed (saveWordPressInstance swallows that at wordpress-api.ts:472).
  // Minting again would litter the WP app-password list on every boot. Instead,
  // re-sync Nango FROM the existing local credential (idempotent, no mint) — this
  // breaks the loop. Only when local and Nango agree (both genuinely stale) do we
  // mint a fresh app-password.
  const local = readWordPressInstanceById(input.instanceId);
  const localPw = local?.applicationPassword?.trim() || "";
  if (localPw && localPw !== resolved.password) {
    // Re-push the local credential into Nango (no new mint). saveWordPressInstance
    // with the existing local password re-validates + re-runs the Nango sync.
    try {
      await saveWordPressInstance({
        id: input.instanceId,
        siteUrl: input.siteUrl,
        username: local?.username ?? input.username,
        applicationPassword: localPw,
      });
    } catch {
      return { working: false, rotated: false, note: "re-sync-failed" };
    }
    const reSynced = await verifyWordPressNangoBothHalves(input, local?.username ?? input.username, localPw);
    if (!reSynced) {
      return { working: false, rotated: false, note: "nango-sync-failed (re-sync of local credential did not land)" };
    }
    // Nango now matches the local fresh credential — the halves are back in sync
    // WITHOUT a new mint. Not a fresh rotate; evict the probe cache so the next
    // probe re-evaluates against the re-synced credential.
    invalidateWordPressMcpProbeCache(input.siteUrl);
    return { working: true, rotated: false, note: "nango-resynced-from-local (no mint)" };
  }

  // Local and Nango agree (or no local pw) → genuinely stale → mint fresh.
  const fresh = mintWordPressAppPassword();
  if (!fresh) {
    return { working: false, rotated: false, note: "mint-failed (kept existing)" };
  }

  try {
    await saveWordPressInstance({
      id: input.instanceId,
      siteUrl: input.siteUrl,
      username: input.username,
      applicationPassword: fresh,
    });
  } catch {
    // SECRET BOUNDARY: saveWordPressInstance re-validates over the network and
    // can throw with remote WordPress response-body text — never forward it into
    // a logged/returned note. Surface only a fixed host-owned label.
    return { working: false, rotated: false, note: "re-save-failed" };
  }

  // BOTH-HALVES verify — saveWordPressInstance swallows Nango-sync failure, so
  // confirm Nango now holds the fresh credential (connector metadata is already
  // written by the save). forceRefresh bypasses the cred cache so we see the
  // post-rotate value, not a stale one.
  const synced = await verifyWordPressNangoBothHalves(input, input.username, fresh);
  if (!synced) {
    // Connector metadata rotated but Nango did NOT — the two halves are out of
    // sync. The next boot's churn guard will re-sync from local (no re-mint).
    return {
      working: false,
      rotated: false,
      note: "nango-sync-failed (connector metadata + Nango out of sync)",
    };
  }

  // Verified rotate — evict the URL-keyed probe cache.
  invalidateWordPressMcpProbeCache(input.siteUrl);
  return { working: true, rotated: true, note: "rotated" };
}

/**
 * Confirm Nango now resolves to the expected username+password (both halves in
 * sync), bypassing the cred cache (forceRefresh). Never throws.
 */
async function verifyWordPressNangoBothHalves(
  input: { providerConfigKey: string; connectionId: string },
  expectedUsername: string,
  expectedPassword: string,
): Promise<boolean> {
  try {
    const after = await getNangoCredentials(input.providerConfigKey, input.connectionId, {
      forceRefresh: true,
    });
    return (
      !!after &&
      typeof after === "object" &&
      "password" in after &&
      (after as { password?: unknown }).password === expectedPassword &&
      "username" in after &&
      (after as { username?: unknown }).username === expectedUsername
    );
  } catch {
    return false;
  }
}

type WordPressFirstWireOutcome =
  | { ok: true; instanceId: string; reconcile: WordPressReconcileOutcome }
  | { ok: false; reason: string };

/**
 * First wire (no existing instance): mint an application password and land a
 * COMPLETE local WordPress instance row, then (the caller) push the browser
 * widget config.
 *
 * RESILIENCE (the #260 Step-7 fix): the happy path is the network-validated
 * `saveWordPressInstance`. But that validation also `GET`s `wp/v2/administration`
 * — a route the local dev WordPress plugin surface does NOT register (it 404s) —
 * so first-wire validation throws and historically returned a hard `error` BEFORE
 * the widget config (`cinatra_url`) was ever pushed, leaving the widget unwired.
 * The browser→cinatra widget direction does NOT depend on the cinatra→WP
 * application-password being fully validated, so on a `saveWordPressInstance`
 * throw we fall back to `persistLocalDevWordPressInstanceUnvalidated`, which lands
 * a complete instance row (all `requiredInstanceFields` non-empty, so widget
 * stream auth accepts it) + best-effort Nango import. The next boot's reuse-path
 * reconcile re-probes + re-validates.
 *
 * Returns `{ ok: false, reason }` (caller emits a hard error and does NOT push
 * the widget config) ONLY when a COMPLETE instance row could not be persisted at
 * all — the app-password mint failed, OR BOTH the validated save AND the
 * unvalidated fallback threw. Pushing `cinatra_instance_id` for an unpersisted
 * row would dangle: widget-stream auth has no configured instance to authorize.
 *
 * SECRET BOUNDARY: never logs the minted application password; failure reasons
 * are fixed host-owned labels (never a lower-layer error message).
 */
export async function firstWireWordPressInstance(): Promise<WordPressFirstWireOutcome> {
  const appPassword = mintWordPressAppPassword();
  if (!appPassword) {
    return { ok: false, reason: "wp user application-password create failed (no porcelain output)" };
  }

  const providerConfigKey = CINATRA_NANGO_PROVIDER_CONFIG_KEYS.wordpress;
  // Generate the instance id up-front so the validated-save and the unvalidated
  // fallback land the SAME id (no dangling/duplicated instance_id).
  const instanceId = randomUUID();

  let persistedId: string = instanceId;
  let connectionId: string = instanceId;
  let validated = false;
  try {
    const saved = await saveWordPressInstance({
      id: instanceId,
      siteUrl: LOCAL_WORDPRESS.siteUrl,
      username: LOCAL_WORDPRESS.adminUser,
      applicationPassword: appPassword,
    });
    persistedId = saved.id;
    connectionId = saved.connectionId ?? saved.id;
    validated = true;
  } catch {
    // SECRET BOUNDARY: saveWordPressInstance re-validates over the network and
    // can throw with remote WordPress response-body text — never forward it.
    // The validation also requires `wp/v2/administration` (404 on the local dev
    // plugin surface), so fall back to a complete local-dev persist rather than
    // abort the whole wire (which would leave the widget config unpushed).
    try {
      const persisted = await persistLocalDevWordPressInstanceUnvalidated({
        id: instanceId,
        siteUrl: LOCAL_WORDPRESS.siteUrl,
        username: LOCAL_WORDPRESS.adminUser,
        applicationPassword: appPassword,
      });
      persistedId = persisted.id;
      connectionId = persisted.connectionId ?? persisted.id;
    } catch {
      // Even the unvalidated local-dev persist failed — NO complete instance row
      // landed, so this is genuinely unrecoverable: the caller must hard-error
      // and NOT push the widget config (a `cinatra_instance_id` with no backing
      // configured-instance row would never authorize against widget-stream auth).
      // SECRET BOUNDARY: surface only a fixed host-owned reason.
      return { ok: false, reason: "saveWordPressInstance failed (first wire)" };
    }
    console.log(
      "[dev-auto-setup:wordpress] first-wire connection validation did not pass; persisted a local-dev instance + pushed the widget config anyway. " +
        "WordPress MCP writes 401 until the credential validates; the next boot re-probes and reconciles.",
    );
  }

  // BOTH-HALVES verify (codex refinement: compare username AND password) —
  // saveWordPressInstance / the local-dev persist sync Nango best-effort, so
  // confirm Nango actually holds the freshly minted credential.
  const synced = await verifyWordPressNangoBothHalves(
    { providerConfigKey, connectionId },
    LOCAL_WORDPRESS.adminUser,
    appPassword,
  );

  let reconcile: WordPressReconcileOutcome;
  if (validated && synced) {
    reconcile = { working: true, rotated: false, note: "first-wire minted + nango-synced" };
  } else if (validated) {
    reconcile = {
      working: false,
      rotated: false,
      note: "nango-sync-failed (connector metadata + Nango out of sync)",
    };
    console.log(
      "[dev-auto-setup:wordpress] first-wire app-password minted but Nango sync could not be confirmed. " +
        "WordPress MCP writes 401 until the credential is in Nango; re-run once Nango is reachable.",
    );
  } else if (synced) {
    reconcile = {
      working: false,
      rotated: false,
      note: "first-wire validation unconfirmed; instance persisted + nango-synced (re-validates on a later boot)",
    };
  } else {
    reconcile = {
      working: false,
      rotated: false,
      note: "first-wire validation unconfirmed; instance persisted (nango sync unconfirmed; re-validates on a later boot)",
    };
  }

  return { ok: true, instanceId: persistedId, reconcile };
}

async function autoSetupLocalWordPress(): Promise<Status> {
  if (!probeDockerContainer(LOCAL_WORDPRESS.containerName)) {
    return { status: "skipped", reason: `${LOCAL_WORDPRESS.containerName} not running (run docker compose --profile wordpress up -d)` };
  }
  if (!probeHttp(LOCAL_WORDPRESS.siteUrl + "/")) {
    return { status: "skipped", reason: `${LOCAL_WORDPRESS.siteUrl} not reachable` };
  }
  // The WordPress plugin is consumed as a local clone of cinatra-ai/wordpress-plugin
  // (synced by `cinatra setup dev`). Skip cleanly if it hasn't been cloned yet.
  if (!existsSync(path.join(process.cwd(), "dev/wordpress-plugin/cinatra.php"))) {
    return {
      status: "skipped",
      reason: "plugin clone missing at dev/wordpress-plugin/cinatra.php. Run `cinatra setup dev` first.",
    };
  }
  // WP install: if not installed yet, skip (we expect the operator to have run it once;
  // auto-install needs site admin email which we don't want to invent silently).
  try {
    execSync(
      `docker exec ${LOCAL_WORDPRESS.containerName} wp core is-installed --allow-root`,
      { stdio: "pipe" },
    );
  } catch {
    return { status: "skipped", reason: "WordPress not yet installed (run wp core install inside the container first)" };
  }

  // Cinatra-side: generate or reuse the UUID-pair widget api_key (lives in
  // connector_config:wordpress_widget_auth) — the Bearer the WP widget sends.
  const auth = readWidgetAuthConfig() ?? generateWidgetAuthConfig();

  // Ensure the cinatra-side instance exists (create on first run; reuse after).
  // The WP application password (cinatra→WP MCP direction) is minted ONCE on
  // first wire; on subsequent wires the reconcile (below) probes REST auth and
  // re-mints ONLY on a definite 401 — re-creating one every boot would litter
  // the admin's application-password list.
  const existing = (await listWordPressInstances()).find((i) => i.siteUrl === LOCAL_WORDPRESS.siteUrl);
  let instanceId: string;
  let created: boolean;
  let reconcile: WordPressReconcileOutcome;
  if (existing) {
    instanceId = existing.id;
    created = false;
    // Reuse-first / probe-then-rotate against the existing instance.
    reconcile = await ensureWordPressAppPasswordReconciled({
      instanceId: existing.id,
      siteUrl: LOCAL_WORDPRESS.siteUrl,
      username: existing.username,
      providerConfigKey: existing.providerConfigKey ?? CINATRA_NANGO_PROVIDER_CONFIG_KEYS.wordpress,
      connectionId: existing.connectionId ?? existing.id,
    });
    if (!reconcile.working) {
      console.log(
        `[dev-auto-setup:wordpress] app-password reconcile did not confirm a working credential (${reconcile.note ?? "unknown"}). ` +
          "WordPress MCP writes 401 until a valid application password is stored; re-run once WordPress is reachable.",
      );
    }
  } else {
    const firstWire = await firstWireWordPressInstance();
    if (!firstWire.ok) {
      // No COMPLETE instance row landed (mint failed, OR both the validated save
      // AND the unvalidated fallback threw). Hard-error and do NOT push the widget
      // config — a `cinatra_instance_id` with no backing configured-instance row
      // would never authorize against widget-stream auth. A mere validation
      // failure does NOT land here: it soft-proceeds via the unvalidated local-dev
      // persist inside the helper, which keeps the widget wiring resilient.
      return { status: "error", reason: firstWire.reason };
    }
    instanceId = firstWire.instanceId;
    created = true;
    reconcile = firstWire.reconcile;
  }

  // WP-side: push the widget plugin options on EVERY run (create OR reuse) so a
  // fresh install (or a CMS-volume reset with the app DB retained) wires the
  // widget. cinatra_url is the BROWSER-reachable origin (localhost:PORT) — the
  // plugin enqueues the bundle + SSE from it. `wp option update` is idempotent.
  try {
    wpCli(`option update cinatra_url ${cinatraBrowserBaseUrl()}`);
    wpCli(`option update cinatra_api_key ${auth.apiKey}`);
    wpCli(`option update cinatra_instance_id ${instanceId}`);
  } catch {
    // SECRET BOUNDARY: the wp-cli command line embeds the widget api_key
    // (`option update cinatra_api_key <key>`), and a wp-cli failure can echo the
    // failed command in its error message — surface only a fixed host-owned
    // reason, never the raw error.
    return { status: "error", reason: "wp option update cinatra_* failed" };
  }

  // Distinguish a POSITIVELY-confirmed credential (200 probe, no note) from a
  // kept-but-unconfirmed one (e.g. probe-unreachable: working stays true to
  // avoid a false 401 hint + churn, but we must NOT overstate it as "valid").
  const reconcileNote = reconcile.rotated
    ? "app-password rotated"
    : reconcile.working
      ? reconcile.note
        ? `app-password kept, unconfirmed (${reconcile.note})`
        : "app-password valid"
      : `app-password unconfirmed (${reconcile.note ?? "unknown"})`;

  return created
    ? { status: "created", siteUrl: LOCAL_WORDPRESS.siteUrl, detail: `instance ${instanceId} (${reconcileNote})` }
    : {
        status: "already-wired",
        siteUrl: LOCAL_WORDPRESS.siteUrl,
        detail: `instance ${instanceId} (config re-pushed; ${reconcileNote})`,
      };
}

// ---------------------------------------------------------------------------
// Twenty CRM
// ---------------------------------------------------------------------------

/**
 * Wire the local docker Twenty stack into cinatra:
 *   1. Probe the container is running and `/healthz` is reachable.
 *   2. Insert OR refresh the workspace-scope external_mcp_servers row,
 *      preserving any existing `nangoConnectionId` so a previously-attached
 *      bearer is NOT de-authed on subsequent boots.
 *
 * Bearer minting + attaching is the operator's job: run the bootstrap proof
 * (`extensions/cinatra-ai/twenty-connector/scripts/twenty-bootstrap/twenty-bootstrap-proof.mjs`,
 * cloned back from the twenty-connector repo) once to mint a JWT, then
 * attach it via the setup-page at `/connectors/cinatra-ai/twenty-connector/setup`
 * (which writes the Nango connection id back onto this row). Until that
 * happens, MCP calls fire without a bearer and Twenty returns 401 — which
 * surfaces in the UI as "Twenty not yet configured".
 *
 * Custom-field creation (cinatraObjectId, apolloPersonId, ...) also lives
 * in the bootstrap proof. Field absence is tolerated: the connector reads
 * those fields as nullable + writes them only when callers pass values.
 *
 * Soft-fails on any step.
 */
const TWENTY_DEV_API_KEY_NAME = "cinatra-dev-auto";

/** Capture-mode `docker exec` into the Twenty container (combined stdout+stderr). */
function twentyDockerExec(args: string[]): { code: number; out: string } {
  const r = spawnSync("docker", ["exec", LOCAL_TWENTY.containerName, ...args], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

type BearerOutcome = {
  nangoConnectionId: string | null;
  // True when a resolvable, authenticating bearer should exist after this call
  // (reused-OK, kept-on-transient-failure, or freshly minted + verified). False
  // means the connector will 401 — the caller surfaces a hint.
  working: boolean;
  minted: boolean;
  note?: string;
};

/**
 * Ensure the Twenty workspace row has a WORKING bearer, fully automatically:
 *   1. Reuse — if the row resolves to a bearer that authenticates ("ok"), keep
 *      it. On an INDETERMINATE probe ("unreachable": Twenty warming / 5xx /
 *      network) ALSO keep the existing key — do NOT mint (prevents key sprawl on
 *      transient failures). Only a DEFINITE "unauthorized" (401/403) or a missing
 *      credential falls through to minting a fresh key.
 *   2. If Nango is not configured we cannot persist a bearer the connector can
 *      resolve — leave the row as-is and report not-working (caller hints).
 *   3. Otherwise mint a fresh workspace API key via docker exec (seeding the
 *      Apple workspace first, both idempotent), import it into Nango under the
 *      external-MCP provider key, and readback-verify — mirroring the proven
 *      writeRegistryCredential import+readback flow.
 * Soft-fails: any failure returns the prior connection id + a note, never throws.
 */
async function ensureTwentyBearerAttached(
  existing: ReturnType<typeof getExternalMcpServerById>,
): Promise<BearerOutcome> {
  const prior = existing?.nangoConnectionId ?? null;

  // 1. Reuse — and crucially, NEVER mint a duplicate on a transient failure.
  //    Once a connection already exists, the ONLY trigger to mint a fresh key is
  //    a DEFINITE auth failure (probe 401/403). A null/throwing credential
  //    resolution or an indeterminate probe is treated as transient: keep the
  //    existing connection, do not mint.
  if (prior && existing && isNangoConfigured()) {
    try {
      const bearer = await resolveExternalMcpServerBearer(existing);
      if (bearer) {
        const probe = await probeTwentyBearer({ baseUrl: LOCAL_TWENTY.serverUrl, apiKey: bearer });
        if (probe === "ok") {
          return { nangoConnectionId: prior, working: true, minted: false };
        }
        if (probe === "unreachable") {
          // Indeterminate (Twenty warming / 5xx / network) — keep the existing
          // key rather than minting a duplicate; it is almost certainly valid.
          return { nangoConnectionId: prior, working: true, minted: false, note: "probe-indeterminate (kept existing key)" };
        }
        // probe === "unauthorized" → key is genuinely stale; fall through to rotate.
      } else {
        // resolve returned null — could be a TRANSIENT Nango error
        // (getNangoCredentials failures collapse to null) OR a genuinely missing
        // credential. With a prior connection present we must NOT mint: that would
        // create a duplicate Twenty key on a transient blip. Keep the connection
        // and report not-working so the operator is hinted.
        return {
          nangoConnectionId: prior,
          working: false,
          minted: false,
          note: "credential-unresolved (kept connection; not minting to avoid a duplicate)",
        };
      }
    } catch {
      // resolve threw (transient) → keep the connection; do NOT mint a duplicate.
      return {
        nangoConnectionId: prior,
        working: false,
        minted: false,
        note: "credential-resolve-error (kept connection)",
      };
    }
  }

  // 2. No Nango → cannot persist a resolvable bearer.
  if (!isNangoConfigured()) {
    return { nangoConnectionId: prior, working: false, minted: false, note: "nango-not-configured" };
  }

  // 3. Mint + attach.
  try {
    twentyDockerExec(buildSeedDevArgs()); // ensure the Apple workspace exists (idempotent)
    const minted = twentyDockerExec(buildGenerateApiKeyArgs({ keyName: TWENTY_DEV_API_KEY_NAME }));
    const jwt = parseTwentyApiKey(minted.out);
    if (!jwt) {
      return { nangoConnectionId: prior, working: false, minted: false, note: `mint-failed (exit ${minted.code})` };
    }
    const connectionId = prior ?? LOCAL_TWENTY.rowId;
    await ensureNangoIntegration({
      provider: "private-api-bearer",
      providerConfigKey: EXTERNAL_MCP_NANGO_PROVIDER_CONFIG_KEY,
      displayName: "Cinatra External MCP",
    });
    await importNangoConnection({
      providerConfigKey: EXTERNAL_MCP_NANGO_PROVIDER_CONFIG_KEY,
      connectionId,
      credentials: { type: "API_KEY", apiKey: jwt },
    });
    const readback = await getNangoCredentials(EXTERNAL_MCP_NANGO_PROVIDER_CONFIG_KEY, connectionId, {
      forceRefresh: true,
    });
    const readbackKey =
      readback && typeof readback === "object" && "apiKey" in readback
        ? (readback as { apiKey?: unknown }).apiKey
        : null;
    if (readbackKey !== jwt) {
      return { nangoConnectionId: prior, working: false, minted: false, note: "nango-readback-mismatch" };
    }
    return { nangoConnectionId: connectionId, working: true, minted: true };
  } catch (err) {
    return {
      nangoConnectionId: prior,
      working: false,
      minted: false,
      note: `attach-failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function autoSetupLocalTwenty(): Promise<Status> {
  if (!probeDockerContainer(LOCAL_TWENTY.containerName)) {
    return {
      status: "skipped",
      reason: `${LOCAL_TWENTY.containerName} not running (run docker compose --profile twenty up -d)`,
    };
  }
  if (!probeHttp(`${LOCAL_TWENTY.serverUrl}/healthz`)) {
    return {
      status: "skipped",
      reason: `${LOCAL_TWENTY.serverUrl}/healthz not reachable yet (Twenty still booting)`,
    };
  }

  const existing = getExternalMcpServerById(LOCAL_TWENTY.rowId);

  // Auto-mint + attach a working bearer (reuse-first, soft-fail). Replaces the
  // old operator-only "run the bootstrap proof + attach via the setup page" step.
  const bearer = await ensureTwentyBearerAttached(existing);

  try {
    upsertExternalMcpServer({
      id: LOCAL_TWENTY.rowId,
      label: LOCAL_TWENTY.rowLabel,
      serverUrl: LOCAL_TWENTY.mcpUrl,
      nangoConnectionId: bearer.nangoConnectionId,
      scope: "workspace",
      orgId: null,
      userId: null,
      enabled: true,
      // Layer A: leave native MCP tools unfiltered — `execute_tool`,
      // `get_tool_catalog`, `learn_tools`, `load_skills`, `search_help_center`
      // are all safe at this phase.
      allowedTools: null,
      // Layer B: curated catalog allowlist. The proxy at
      // /api/external-mcp/proxy/<rowId> enforces this on every execute_tool.
      allowedCatalogTools: [...LOCAL_TWENTY.allowedCatalogTools],
    });
  } catch (err) {
    return {
      status: "error",
      reason: `upsertExternalMcpServer failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Surface a hint whenever there is still no WORKING bearer (the connector
  // would 401) — including the case where a stale connection id is present but
  // unresolvable because Nango is not configured.
  if (!bearer.working) {
    console.log(
      bearer.note === "nango-not-configured"
        ? "[dev-auto-setup:twenty] row wired but no working bearer: Nango is not configured. " +
            "Run `cinatra setup nango`; the next dev boot auto-mints + attaches a Twenty API key."
        : `[dev-auto-setup:twenty] row wired but bearer auto-attach did not complete (${bearer.note ?? "unknown"}). ` +
            "Agents get 401 until a key attaches; re-run once Twenty has finished booting.",
    );
  }

  const bearerNote = bearer.minted
    ? "bearer auto-minted + attached"
    : bearer.working
      ? "bearer present"
      : `no working bearer (${bearer.note ?? "unknown"})`;

  return {
    status: existing ? "already-wired" : "created",
    siteUrl: LOCAL_TWENTY.serverUrl,
    detail:
      `row ${LOCAL_TWENTY.rowId} ${existing ? "refreshed" : "created"} ` +
      `(${LOCAL_TWENTY.allowedCatalogTools.length} catalog tools allowed; ${bearerNote})`,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the dev-mode auto-setup for the local docker Drupal + WordPress + Twenty.
 * Idempotent. Soft-fails (logs only; never throws). Safe to call at app boot
 * AND from the CLI.
 */
// ---------------------------------------------------------------------------
// Connector access dev fixture seed (CANONICAL, not legacy).
//
// On first user registration (or first runDevAutoSetup invocation in dev
// mode), find the earliest-created user, look up their primary org, and seed
// the UNIFORM polymorphic access rows per connector descriptor: one org-owned
// `installed_extension` (kind='connector') + one `extension_access_policy`
// using each descriptor's default visibility. This replaces the legacy
// `connector_access_policy` seed (writes to that table are now blocked). Re-runs
// are idempotent — installed_extension is ensured on identity and the policy
// upsert preserves a row's installer; existing canonical rows are left intact.
// ---------------------------------------------------------------------------

function policyForVisibility(visibility: "admin" | "workspace") {
  return {
    runListVisibility: visibility,
    runDataVisibility: visibility,
    runExecuteVisibility: visibility,
    allowRunSharing: false,
  };
}

async function autoSeedConnectorPolicyFixture(): Promise<Status> {
  const connectionString = getPostgresConnectionString();
  const userRows = runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `SELECT id FROM public."user" ORDER BY "createdAt" ASC LIMIT 1`,
      },
    ],
  })[0]?.rows as { id: string }[] | undefined;
  const ownerUserId = userRows?.[0]?.id;
  if (!ownerUserId) {
    return { status: "skipped", reason: "no users registered yet" };
  }

  const orgRows = runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `SELECT m."organizationId" AS id
               FROM public."member" m
               WHERE m."userId" = $1
               ORDER BY m."createdAt" ASC
               LIMIT 1`,
        values: [ownerUserId],
      },
    ],
  })[0]?.rows as { id: string }[] | undefined;
  const orgId = orgRows?.[0]?.id;
  if (!orgId) {
    return { status: "skipped", reason: `no org membership for user ${ownerUserId}` };
  }

  const connString = getPostgresConnectionString();
  const schemaQ = postgresSchema.replaceAll('"', '""');
  const descriptors = listConnectorDescriptors();
  let created = 0;

  const resolveConnectorId = (packageId: string): string | undefined =>
    (
      runPostgresQueriesSync({
        connectionString: connString,
        queries: [
          {
            text: `SELECT id FROM "${schemaQ}"."installed_extension"
                   WHERE organization_id = $2 AND owner_level = 'organization'
                     AND owner_id = $2 AND package_name = $1 AND kind = 'connector'
                   LIMIT 1`,
            values: [packageId, orgId],
          },
        ],
      })[0]?.rows as { id: string }[] | undefined
    )?.[0]?.id;

  for (const d of descriptors) {
    // Ensure the org-owned connector installed_extension row. Route the WRITE
    // through the canonical lifecycle primitive (installExtensionManifest) — NOT
    // raw SQL — so the canonical-gate-reach invariant holds and the manifest
    // stays the single write authority. Idempotent: only install when absent;
    // a concurrent insert (rare on a single boot) is caught + re-resolved.
    let installedExtensionId = resolveConnectorId(d.packageId);
    if (!installedExtensionId) {
      try {
        const installed = await installExtensionManifest(
          {
            id: randomUUID(),
            packageName: d.packageId,
            ownerLevel: "organization",
            ownerId: orgId,
            organizationId: orgId,
            kind: "connector",
            source: {
              type: "local",
              path: `connector:${d.packageId}`,
              resolvedCommitOrTreeHash: "dev-fixture",
            },
            requiredInProd: false,
            dependencies: [],
            manifestHash: null,
          },
          { actor: { source: "scheduler" }, reason: "dev connector fixture seed" },
        );
        installedExtensionId = installed.id;
        created += 1;
      } catch {
        // Concurrent insert (or transient) — re-resolve; skip if still absent.
        installedExtensionId = resolveConnectorId(d.packageId);
      }
    }
    if (!installedExtensionId) continue;

    // Only seed when NO access policy exists yet — never clobber a policy edited
    // in the UI after the first seed (setExtensionInstallAccess is ON CONFLICT
    // DO UPDATE, so an unconditional call would overwrite manual edits).
    const existingPolicy = runPostgresQueriesSync({
      connectionString: connString,
      queries: [
        {
          text: `SELECT 1 FROM "${schemaQ}"."extension_access_policy"
                 WHERE resource_kind = 'connector' AND resource_id = $1 LIMIT 1`,
          values: [installedExtensionId],
        },
      ],
    })[0]?.rows as unknown[] | undefined;
    if ((existingPolicy?.length ?? 0) > 0) continue;

    await setExtensionInstallAccess({
      kind: "connector",
      resourceId: installedExtensionId,
      policy: policyForVisibility(d.defaultVisibility),
      installedByUserId: ownerUserId,
    });
  }

  return {
    status: created > 0 ? "created" : "already-wired",
    siteUrl: `org:${orgId}`,
    detail: `${created} new / ${descriptors.length} connectors (canonical)`,
  };
}

export async function runDevAutoSetup(): Promise<{
  drupal: Status;
  wordpress: Status;
  twenty: Status;
  connectorPolicies: Status;
}> {
  // Run sequentially (not in parallel) so log output is deterministic + we
  // don't double-print docker-not-running warnings in interleaved order.
  let drupal: Status;
  try {
    drupal = await autoSetupLocalDrupal();
  } catch (err) {
    drupal = { status: "error", reason: err instanceof Error ? err.message : String(err) };
  }
  logResult("drupal", drupal);

  let wordpress: Status;
  try {
    wordpress = await autoSetupLocalWordPress();
  } catch (err) {
    wordpress = { status: "error", reason: err instanceof Error ? err.message : String(err) };
  }
  logResult("wordpress", wordpress);

  let twenty: Status;
  try {
    twenty = await autoSetupLocalTwenty();
  } catch (err) {
    twenty = { status: "error", reason: err instanceof Error ? err.message : String(err) };
  }
  logResult("twenty", twenty);

  let connectorPolicies: Status;
  try {
    connectorPolicies = await autoSeedConnectorPolicyFixture();
  } catch (err) {
    connectorPolicies = {
      status: "error",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  logResult("connector-policy", connectorPolicies);

  return { drupal, wordpress, twenty, connectorPolicies };
}

function logResult(name: string, result: Status): void {
  const prefix = `[dev-auto-setup:${name}]`;
  switch (result.status) {
    case "created":
      console.log(`${prefix} ✓ wired ${result.siteUrl}${result.detail ? ` (${result.detail})` : ""}`);
      break;
    case "already-wired":
      console.log(`${prefix} ✓ already wired ${result.siteUrl}${result.detail ? ` (${result.detail})` : ""}`);
      break;
    case "skipped":
      console.log(`${prefix} skipped: ${result.reason}`);
      break;
    case "error":
      console.warn(`${prefix} ⚠ ${result.reason}`);
      break;
  }
}
