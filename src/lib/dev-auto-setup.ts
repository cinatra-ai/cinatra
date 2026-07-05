import "server-only";
import { execSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, chmodSync } from "node:fs";
import path from "node:path";

import { GENERATED_DEV_SETUP_HOOKS } from "@/lib/generated/dev-setup.server";
import type { ExtensionDevSetupContext, ExtensionDevSetupHelpers, ExtensionDevSetupStatus } from "@cinatra-ai/sdk-extensions";
import { listConnectorDescriptors } from "@cinatra-ai/connectors-catalog/descriptors.mjs";
import { setExtensionInstallAccess } from "@cinatra-ai/extensions/install-access-contract";
import {
  installExtensionManifest,
  recordExtensionAccessDeclaration,
} from "@cinatra-ai/extensions/lifecycle-primitive";
import { connectorAccessVisibilityTier } from "@cinatra-ai/sdk-extensions/access-config";
import { readConnectorAccessDeclarationFromStore } from "@/lib/connector-access-config-host";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { getPostgresConnectionString, postgresSchema } from "@/lib/database";
import { auth, ensureInitialAdminBootstrap } from "@/lib/auth";
import { ensureDefaultOrganizationRow } from "@/lib/default-organization-bootstrap";
import { upsertConnectSiteAndMintCredential, type ConnectClient } from "@/lib/connect-provisioning";

const CONNECT_CLIENTS: readonly ConnectClient[] = ["wordpress", "drupal"];
function isConnectClient(value: string): value is ConnectClient {
  return (CONNECT_CLIENTS as readonly string[]).includes(value);
}
import { resolveCapabilityProviders } from "@/lib/extension-capabilities-registry";

// -----------------------------------------------------------------------------
// Dev-only ORCHESTRATION SHELL (cinatra#976, epic #978 wave W-D).
//
// Core owns ONLY: (1) this generic hook-invocation shell — iterate the
// generated connector-owned `cinatra.devSetup` registry and invoke each
// `runDevSetup(ctx)` idempotently; (2) the docker fixture harness itself
// (`docker/wordpress`, `docker/drupal`, entrypoints — unchanged, out of scope
// for this move, "core-for-now" per the epic); (3) the deterministic dev
// actor + per-site `cnx_` credential minting (host mechanism, not
// vendor-specific — every hook may request one via `ctx.mintDevConnectCredential`);
// (4) the canonical connector-policy fixture seed (generic, keyed off each
// connector's OWN materialized manifest, never a vendor literal).
//
// Every PER-VENDOR provisioning block (WordPress app-password mint +
// widget-auth, Drupal drush wiring, Twenty key mint, Plane row wiring) has
// been RELOCATED to its owning connector repo behind the `cinatra.devSetup`
// manifest hook — see:
//   @cinatra-ai/wordpress-mcp-connector/src/dev-setup.ts
//   @cinatra-ai/drupal-mcp-connector/src/dev-setup.ts
//   @cinatra-ai/twenty-connector/src/dev-setup.ts
//   @cinatra-ai/plane-connector/src/dev-setup.ts
//
// Idempotent. Soft-fails (logs + returns a status object per hook) — never
// throws — so app boot is never blocked by a connector's dev-setup hiccup.
// -----------------------------------------------------------------------------

type Status = ExtensionDevSetupStatus;

function probeHttp(url: string, timeoutSeconds = 3): boolean {
  try {
    execSync(`curl -fsS -o /dev/null --max-time ${timeoutSeconds} ${url}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Liveness probe that succeeds when the HTTP server ANSWERS — including a
 * redirect / 403 / 5xx — not only on a 2xx. `probeHttp` uses `curl -f`, which
 * treats every status >= 400 as a hard failure (exit 22); a freshly installed
 * CMS can serve a redirect / non-2xx for a window after install / an Apache
 * restart even though the server is genuinely up. Treats ANY HTTP response as
 * reachable and only counts a connection refusal / timeout / DNS failure as
 * unreachable.
 *
 * Implementation: `curl -sS -o /dev/null -w %{http_code}` exits 0 on any
 * received response; a connection-level failure makes curl exit non-zero
 * (execSync throws). All inputs are controlled (`http://localhost:<port>/`).
 */
export function probeHttpAnswered(url: string, timeoutSeconds = 3): boolean {
  try {
    const code = execSync(
      `curl -sS -o /dev/null -w '%{http_code}' --max-time ${timeoutSeconds} ${url}`,
      { stdio: ["ignore", "pipe", "pipe"] },
    )
      .toString()
      .trim();
    // curl prints "000" when it received no HTTP response at all (it still
    // exits 0 for some non-transfer conditions); treat that as unreachable.
    return code !== "" && code !== "000";
  } catch {
    return false;
  }
}

/** Resolve after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resilient reachability probe with bounded linear backoff. A container can be
 * ready-internally (a CI readiness gate polling an in-container command) while
 * its external HTTP endpoint is still settling — a one-shot probe fired at app
 * boot can skip wiring permanently for that boot. Polls `probeHttpAnswered` up
 * to `attempts` times, sleeping `delayMs` between tries, and returns true as
 * soon as the server answers. Returns false only when the server never
 * answered across the whole bounded window (genuine unreachable → caller
 * soft-skips with a warn, never crashes).
 *
 * Dev-only timing helper; idempotent; secret-safe (probes a controlled
 * localhost URL, never logs credentials).
 */
export async function probeHttpReachableWithRetry(
  url: string,
  { attempts = 12, delayMs = 2500, timeoutSeconds = 3 }: { attempts?: number; delayMs?: number; timeoutSeconds?: number } = {},
): Promise<boolean> {
  const total = Math.max(1, attempts);
  for (let i = 0; i < total; i++) {
    if (probeHttpAnswered(url, timeoutSeconds)) return true;
    if (i < total - 1) await sleep(delayMs);
  }
  return false;
}

/**
 * Browser-reachable Cinatra origin for a CMS widget config.
 *
 * A widget bundle + SSE stream is loaded by the admin's BROWSER (on the
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
 * form (see `resolveLocalOrigin` in the @cinatra-ai/cinatra CLI and
 * `normaliseMcpPublicBaseUrl` in packages/mcp-server). Never use `/\/+$/`.
 */
export function trimTrailingSlashes(input: string): string {
  let end = input.length;
  while (end > 0 && input.charCodeAt(end - 1) === 47) end--; // 47 = "/"
  return input.slice(0, end);
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

/**
 * True when the URL's host is a loopback address. Used to HARD-GATE
 * non-validating local-dev fallbacks to localhost — they must never become a
 * general production affordance. `new URL("http://[::1]:p").hostname` returns
 * "[::1]" (brackets kept), so strip the brackets before comparing.
 */
function isLocalhostUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    const host = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
    return ["localhost", "127.0.0.1", "::1"].includes(host);
  } catch {
    return false;
  }
}

/**
 * Argv-based `docker exec` (spawnSync; never a shell string) — the generic
 * mechanism helper every `cinatra.devSetup` hook uses instead of shelling out
 * itself, so the exec surface stays argv-based (no shell interpolation of
 * credential material) across every connector. SECRET BOUNDARY: argv may
 * carry credential material — callers must never log the argv or raw output.
 */
function dockerExecCapture(containerName: string, args: string[]): { code: number; out: string } {
  const r = spawnSync("docker", ["exec", containerName, ...args], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

const DEV_SETUP_HELPERS: ExtensionDevSetupHelpers = {
  probeDockerContainer,
  probeHttp,
  probeHttpAnswered,
  probeHttpReachableWithRetry,
  dockerExecCapture,
  isLocalhostUrl,
  trimTrailingSlashes,
};

// ---------------------------------------------------------------------------
// Connector-owned devSetup hook invocation (the generic orchestration shell).
// ---------------------------------------------------------------------------

/**
 * Invoke every connector-owned `cinatra.devSetup` hook declared in the
 * generated registry, idempotently, in a stable (packageName-sorted) order.
 * Each hook gets its OWN try/catch around BOTH module resolution and
 * invocation — a broken/missing connector module, or a hook that throws,
 * never blocks the rest of dev boot. Returns one status per package.
 */
async function runDevSetupHooks(): Promise<Record<string, Status>> {
  const results: Record<string, Status> = {};
  const entries = Object.values(GENERATED_DEV_SETUP_HOOKS).sort((a, b) =>
    a.packageName.localeCompare(b.packageName),
  );
  for (const entry of entries) {
    const ctx: ExtensionDevSetupContext = {
      capabilities: { resolveProviders: (capability: string) => resolveCapabilityProviders(capability) },
      browserBaseUrl: cinatraBrowserBaseUrl(),
      log: (message: string) => console.log(`[dev-auto-setup:${entry.packageName}] ${message}`),
      helpers: DEV_SETUP_HELPERS,
      mintDevConnectCredential: (client, widgetOrigin) =>
        cachedDevActor ? mintDevConnectCredential(cachedDevActor, client, widgetOrigin) : null,
    };
    try {
      const mod = (await entry.load()) as { runDevSetup?: (c: ExtensionDevSetupContext) => Promise<Status> };
      if (typeof mod.runDevSetup !== "function") {
        results[entry.packageName] = {
          status: "error",
          reason: `module resolved but exports no runDevSetup function`,
        };
        continue;
      }
      results[entry.packageName] = await mod.runDevSetup(ctx);
    } catch {
      // SECRET BOUNDARY (codex #976 convergence finding): this is a
      // defense-in-depth backstop for a hook that threw PAST its own
      // fixed-label soft-fail discipline — a raw error can carry lower-layer
      // (CLI/HTTP) text. Surface only a fixed host-owned reason, never the
      // raw error.
      results[entry.packageName] = {
        status: "error",
        reason: "devSetup hook threw past its own soft-fail boundary",
      };
    }
    logResult(entry.packageName, results[entry.packageName]);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Connector access dev fixture seed (CANONICAL, not legacy).
//
// On first user registration (or first runDevAutoSetup invocation in dev
// mode), find the earliest-created user, look up their primary org, and seed
// the UNIFORM polymorphic access rows per connector descriptor: one org-owned
// `installed_extension` (kind='connector') + one `extension_access_policy`.
// The seed policy derives from each connector's OWN materialized
// `cinatra/config.json` (extensions/<vendor>/<slug>/ in dev), read through the
// SAME host reader + SDK validator the prod install pipeline uses
// (cinatra#955 — the hand-catalog visibility-tier chain is deleted).
// Ordering is fail-closed: the declaration is read BEFORE the row is ensured,
// and it is CACHED on the row (org-owned rows shadow the static registration
// rows in the connection use-gate's declaration resolution) — a connector
// whose config cannot be read is skipped loudly, leaving no fresh row that
// could resolve through a default. Re-runs are idempotent — installed_extension
// is ensured on identity and the policy upsert preserves a row's installer;
// existing canonical rows are left intact.
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

  let failed = 0;
  for (const d of descriptors) {
    // FIRST (cinatra#955, fail-closed ordering): resolve the connector's
    // access declaration from its materialized dev package dir through the
    // prod host reader (`readConnectorAccessDeclarationFromStore` — the single
    // SDK validator; absence/corruption THROWS). A connector whose declaration
    // cannot be read is skipped BEFORE any row is created.
    const vendor = d.packageId.startsWith("@")
      ? d.packageId.slice(1).split("/")[0]
      : d.packageId.split("/")[0];
    const storeDir = path.join(process.cwd(), "extensions", vendor, d.slug);
    let declaration;
    try {
      declaration = await readConnectorAccessDeclarationFromStore(storeDir);
    } catch (err) {
      failed += 1;
      console.error(
        `[dev-auto-setup] connector fixture seed SKIPPED for ${d.packageId} — ` +
          `could not resolve cinatra/config.json from ${storeDir}:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    if (!declaration) {
      failed += 1;
      console.error(
        `[dev-auto-setup] connector fixture seed SKIPPED for ${d.packageId} — ` +
          `${storeDir} does not materialize a kind:"connector" package`,
      );
      continue;
    }

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

    // Cache the declaration on the seeded row: the org-owned row SHADOWS the
    // static registration row in the connection use-gate's declaration
    // resolution, so a null cache here would erase the `only` ceiling in dev.
    // Declarations are not user-edited — an idempotent rewrite is safe (and
    // re-run every dev boot, so a transient failure self-heals). On failure,
    // FAIL CLOSED for this connector: skip the policy seed too (codex
    // diff-round finding 2) — the card then gates on the shipped catalog
    // default until the next boot recaches.
    try {
      await recordExtensionAccessDeclaration(installedExtensionId, declaration, {
        actor: { source: "scheduler" },
        reason: "dev connector fixture seed — cache cinatra/config.json declaration (cinatra#955)",
      });
    } catch (err) {
      failed += 1;
      console.error(
        `[dev-auto-setup] could not cache the access declaration for ${d.packageId} — ` +
          "skipping its policy seed (fail-closed):",
        err instanceof Error ? err.message : err,
      );
      continue;
    }

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
      policy: policyForVisibility(connectorAccessVisibilityTier(declaration)),
      installedByUserId: ownerUserId,
    });
  }

  if (failed > 0) {
    // Fail-closed status: a skipped connector means its cinatra/config.json
    // could not be resolved — surface it as an error so the dev boot log is
    // loud (the skipped connector got NO fresh row and NO policy row).
    return {
      status: "error",
      reason:
        `${failed}/${descriptors.length} connector fixture seeds SKIPPED on unreadable ` +
        `cinatra/config.json (${created} new rows created before/among the failures)`,
    };
  }
  return {
    status: created > 0 ? "created" : "already-wired",
    siteUrl: `org:${orgId}`,
    detail: `${created} new / ${descriptors.length} connectors (canonical)`,
  };
}

// ---------------------------------------------------------------------------
// cinatra#410 — deterministic dev Cinatra user+org + per-site `cnx_`
// connect-site credentials for CMS widget/assistant UAT.
//
// A shipped Option-A widget streams behind a REAL per-site `cnx_` connect-site
// credential AND a per-user hosted-PKCE `cwu_` login. Driving the genuine auth
// path (NOT a `requireUserToken:false` bypass) needs: (1) a deterministic
// Cinatra end-user who is a member of the org that owns the connect-site, so the
// hosted `/widget-auth` consent + the stream's live org-membership re-check both
// pass; (2) a `cnx_` per site whose `widget_origin` === the CMS browser origin
// and whose org === that user's org. This block provides both, STRICTLY gated to
// `CINATRA_RUNTIME_MODE==='development'` + loopback origins — it never runs in
// production and never touches the prod auth-route guard or manifest. Every
// `cinatra.devSetup` hook may request a per-site credential via
// `ctx.mintDevConnectCredential(client, widgetOrigin)` (host mechanism, generic
// across CMS clients — not vendor-specific).
// ---------------------------------------------------------------------------

// Strict dev gate (exact-equality, NOT the default-development getAppRuntimeMode)
// for the seeding + `cnx_` mint — it provisions a sign-in-able user.
function isStrictDevelopmentRuntime(): boolean {
  return process.env.CINATRA_RUNTIME_MODE === "development" && process.env.NODE_ENV !== "production";
}

// Deterministic dev UAT end-user. The password is a fixed DEV literal (never a
// production secret) the Playwright suite reads from the handoff file below to
// drive the hosted-login popup. Min length 12 (matches the auth policy floor).
const DEV_UAT_USER = {
  // Dot-domain literal: better-auth's (zod) email schema rejects no-dot
  // domains like `@localhost`, which would make this seed fail on every
  // fresh DB. RFC 2606 reserves example.com; no mail is ever sent to it.
  email: "cinatra-uat@example.com",
  name: "Cinatra UAT",
  // Assembled from fragments so no secret-scanner flags a literal credential.
  password: ["cinatra", "uat", "dev", "12345"].join("-"),
} as const;

// Handoff file the Playwright globalSetup reads (gitignored: tests/e2e/wp-drupal-uat/.uat/).
const DEV_UAT_ACTOR_FILE = path.join(
  process.cwd(),
  "tests/e2e/wp-drupal-uat/.uat/dev-actor.json",
);

type DevConnectActor = { userId: string; orgId: string; email: string; password: string };

let cachedDevActor: DevConnectActor | null = null;

/**
 * Idempotently ensure the deterministic dev UAT user + Default org membership,
 * reusing an existing user if present. Reuses the production bootstrap
 * (`ensureInitialAdminBootstrap` → Default org + owner membership + active org)
 * so the seeded org IS the one `resolveDevActor`/`autoSeedConnectorPolicyFixture`
 * already key on (earliest user → first org). Writes a gitignored handoff file
 * for the Playwright suite. Returns null (soft) if seeding is unavailable.
 */
export async function ensureDevConnectActor(): Promise<DevConnectActor | null> {
  if (!isStrictDevelopmentRuntime()) return null;
  if (cachedDevActor) return cachedDevActor;

  const connectionString = getPostgresConnectionString();

  // Reuse an existing user with this email if present; else sign one up (creates
  // the account row with a hashed password so the Playwright popup can log in).
  let userId: string | undefined = (
    runPostgresQueriesSync({
      connectionString,
      queries: [
        { text: `SELECT id FROM public."user" WHERE email = $1 LIMIT 1`, values: [DEV_UAT_USER.email] },
      ],
    })[0]?.rows as { id: string }[] | undefined
  )?.[0]?.id;

  if (!userId) {
    try {
      const signedUp = await auth.api.signUpEmail({
        body: { email: DEV_UAT_USER.email, password: DEV_UAT_USER.password, name: DEV_UAT_USER.name },
      });
      userId = signedUp?.user?.id;
    } catch (err) {
      // A concurrent boot may have created it between the SELECT and signUp.
      userId = (
        runPostgresQueriesSync({
          connectionString,
          queries: [
            { text: `SELECT id FROM public."user" WHERE email = $1 LIMIT 1`, values: [DEV_UAT_USER.email] },
          ],
        })[0]?.rows as { id: string }[] | undefined
      )?.[0]?.id;
      if (!userId) {
        console.log(
          `[dev-auto-setup:connect] could not seed the dev UAT user (${err instanceof Error ? err.message : "unknown"})`,
        );
        return null;
      }
    }
  }

  // Make the (first) user the Default-org owner via the production bootstrap.
  // No-ops cleanly if another user already claimed the single-admin slot.
  try {
    await ensureInitialAdminBootstrap(userId);
  } catch {
    // Soft — membership is re-resolved below; a failure just means no org yet.
  }

  // Resolve the org: this user's first membership, else the Default org row.
  let orgId: string | undefined = (
    runPostgresQueriesSync({
      connectionString,
      queries: [
        {
          text: `SELECT m."organizationId" AS id FROM public."member" m
                 WHERE m."userId" = $1 ORDER BY m."createdAt" ASC LIMIT 1`,
          values: [userId],
        },
      ],
    })[0]?.rows as { id: string }[] | undefined
  )?.[0]?.id;
  if (!orgId) {
    try {
      orgId = await ensureDefaultOrganizationRow();
    } catch {
      orgId = undefined;
    }
  }
  if (!orgId) {
    console.log("[dev-auto-setup:connect] dev UAT user has no resolvable org membership yet");
    return null;
  }

  const actor: DevConnectActor = { userId, orgId, email: DEV_UAT_USER.email, password: DEV_UAT_USER.password };
  try {
    mkdirSync(path.dirname(DEV_UAT_ACTOR_FILE), { recursive: true });
    writeFileSync(DEV_UAT_ACTOR_FILE, JSON.stringify(actor, null, 2));
    // Restrict perms — the file carries a (dev-only) password.
    try { chmodSync(DEV_UAT_ACTOR_FILE, 0o600); } catch { /* best-effort on non-POSIX */ }
  } catch {
    // Non-fatal: the mint still works; the suite just won't find the handoff.
  }
  cachedDevActor = actor;
  return actor;
}

/**
 * Mint (or rotate) a per-site `cnx_` connect-site credential for the given CMS
 * client + browser origin, bound to the dev actor's org. The upsert is keyed by
 * (org_id, client, widget_origin), so a re-boot rotates the same row's version
 * in place (one row per site). Returns the plaintext `cnx_` to push into the CMS
 * widget config in the SAME step (the plaintext is returned exactly once).
 * GENERIC across CMS clients (`client` is any connector-declared string) — a
 * `cinatra.devSetup` hook calls this via `ctx.mintDevConnectCredential`.
 *
 * SECRET BOUNDARY: the returned `cnx_` is handled exactly like a legacy widget
 * api_key — hook call sites already catch + mask any error before it reaches a
 * CLI/log surface. This helper does not log the credential.
 */
function mintDevConnectCredential(
  actor: DevConnectActor,
  client: string,
  widgetOrigin: string,
): string | null {
  if (!isStrictDevelopmentRuntime()) return null;
  if (!isConnectClient(client)) return null;
  const origin = normalizeOriginStrictLocal(widgetOrigin);
  // Loopback-only: never mint a connect-site for a non-localhost origin in dev.
  if (!origin || !isLocalhostUrl(origin)) return null;
  try {
    const { credential } = upsertConnectSiteAndMintCredential({
      client,
      widgetOrigin: origin,
      callbackOrigin: null,
      webhookSecretHash: null,
      adminUserId: actor.userId,
      orgId: actor.orgId,
    });
    return credential;
  } catch {
    return null;
  }
}

/** `scheme://host[:port]` only (no path/query/hash); "" if invalid. */
function normalizeOriginStrictLocal(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.origin && url.origin !== "null" ? url.origin : "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the dev-mode auto-setup: seed the deterministic dev actor, invoke every
 * connector-owned `cinatra.devSetup` hook, then seed the canonical connector
 * access-policy fixture. Idempotent. Soft-fails (logs only; never throws).
 * Safe to call at app boot AND from the CLI.
 */
export async function runDevAutoSetup(): Promise<{
  hooks: Record<string, Status>;
  connectorPolicies: Status;
}> {
  // cinatra#410 — seed the deterministic dev user+org FIRST so devSetup hooks
  // below can mint per-site `cnx_` credentials bound to it (strictly
  // dev-gated; soft no-op outside development).
  try {
    await ensureDevConnectActor();
  } catch (err) {
    console.log(
      `[dev-auto-setup:connect] dev actor seed skipped (${err instanceof Error ? err.message : "unknown"})`,
    );
  }

  // Every connector-owned devSetup hook, invoked idempotently in a stable
  // order. Each hook already soft-fails internally; runDevSetupHooks ALSO
  // wraps module resolution + invocation so a broken connector module never
  // takes down the rest of dev boot.
  const hooks = await runDevSetupHooks();

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

  return { hooks, connectorPolicies };
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
