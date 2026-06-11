import "server-only";
import { execSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { saveDrupalInstance, listDrupalInstances } from "@/lib/drupal-api";
import {
  generateDrupalWidgetAuthConfig,
  readDrupalWidgetAuthConfig,
} from "@/lib/drupal-widget-auth";
import { saveWordPressInstance, listWordPressInstances } from "@/lib/wordpress-api";
import {
  generateWidgetAuthConfig,
  readWidgetAuthConfig,
} from "@/lib/wordpress-widget-auth";
import {
  isNangoConfigured,
  ensureNangoIntegration,
  importNangoConnection,
  getNangoCredentials,
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

function drushExec(args: string): void {
  execSync(`docker exec ${LOCAL_DRUPAL.containerName} drush --root=/drupal/web ${args}`, {
    stdio: "pipe",
  });
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

  // Cinatra-side: generate or reuse the UUID-pair api_key (lives in connector_config:drupal_widget_auth)
  const auth = readDrupalWidgetAuthConfig() ?? generateDrupalWidgetAuthConfig();

  // Ensure the cinatra-side instance exists (create on first run; reuse after).
  // saveDrupalInstance does the ensureIntegration → importNangoConnection →
  // readback dance internally.
  const existing = (await listDrupalInstances()).find((i) => i.siteUrl === LOCAL_DRUPAL.siteUrl);
  let instanceId: string;
  let created: boolean;
  if (existing) {
    instanceId = existing.id;
    created = false;
  } else {
    try {
      const saved = await saveDrupalInstance({
        name: LOCAL_DRUPAL.instanceName,
        siteUrl: LOCAL_DRUPAL.siteUrl,
        mcpApiKey: auth.apiKey,
      });
      instanceId = saved.id;
      created = true;
    } catch (err) {
      return {
        status: "error",
        reason: `saveDrupalInstance failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
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

  return created
    ? { status: "created", siteUrl: LOCAL_DRUPAL.siteUrl, detail: `instance ${instanceId}` }
    : { status: "already-wired", siteUrl: LOCAL_DRUPAL.siteUrl, detail: `instance ${instanceId} (config re-pushed)` };
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
  // The WP application password (cinatra→WP MCP direction) is created ONCE on
  // first wire — its plaintext is only shown at creation and re-creating one
  // every boot would litter the admin's application-password list.
  const existing = (await listWordPressInstances()).find((i) => i.siteUrl === LOCAL_WORDPRESS.siteUrl);
  let instanceId: string;
  let created: boolean;
  if (existing) {
    instanceId = existing.id;
    created = false;
  } else {
    let appPassword: string;
    try {
      const out = wpCli(
        `user application-password create ${LOCAL_WORDPRESS.adminUser} ${LOCAL_WORDPRESS.appPasswordLabel} --porcelain`,
      ).trim();
      if (!out || /Error/i.test(out)) {
        throw new Error(`wp-cli returned: ${out.slice(0, 200)}`);
      }
      appPassword = out;
    } catch (err) {
      return {
        status: "error",
        reason: `wp user application-password create failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    try {
      const saved = await saveWordPressInstance({
        siteUrl: LOCAL_WORDPRESS.siteUrl,
        username: LOCAL_WORDPRESS.adminUser,
        applicationPassword: appPassword,
      });
      instanceId = saved.id;
      created = true;
    } catch (err) {
      return {
        status: "error",
        reason: `saveWordPressInstance failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // WP-side: push the widget plugin options on EVERY run (create OR reuse) so a
  // fresh install (or a CMS-volume reset with the app DB retained) wires the
  // widget. cinatra_url is the BROWSER-reachable origin (localhost:PORT) — the
  // plugin enqueues the bundle + SSE from it. `wp option update` is idempotent.
  try {
    wpCli(`option update cinatra_url ${cinatraBrowserBaseUrl()}`);
    wpCli(`option update cinatra_api_key ${auth.apiKey}`);
    wpCli(`option update cinatra_instance_id ${instanceId}`);
  } catch (err) {
    return {
      status: "error",
      reason: `wp option update cinatra_* failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return created
    ? { status: "created", siteUrl: LOCAL_WORDPRESS.siteUrl, detail: `instance ${instanceId}` }
    : { status: "already-wired", siteUrl: LOCAL_WORDPRESS.siteUrl, detail: `instance ${instanceId} (config re-pushed)` };
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
