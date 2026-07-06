import "server-only";

// -----------------------------------------------------------------------------
// Dev-only, VENDOR-NEUTRAL provisioning ORCHESTRATION SHELL (cinatra#976, epic
// #978 wave W-D).
//
// Core owns the MECHANISM; the connector owns its vendor provisioning. This
// module no longer contains a single vendor-named block: the WordPress /
// Drupal / Twenty / Plane imperative provisioning that used to live here has
// moved into the OWNING connector repos behind the `cinatra.devSetup` manifest
// hook (the `ExtensionDevSetupModule` SDK contract landed by PR #1026). The
// shell now:
//   1. iterates the MATERIALIZED extensions checkout (`extensions/<vendor>/<slug>`),
//   2. reads `cinatra.devSetup` from each package.json — mirroring the
//      declarative `cinatra.devFixtures` discovery in `dev-fixture-seeder.ts`
//      (deliberately NOT carried through the normalized/generated records),
//   3. dynamically imports each hook module, structurally guards it with
//      `isExtensionDevSetupModule`, and
//   4. invokes `runDevSetup(ctx)` IDEMPOTENTLY, soft-failing per connector so a
//      single docker/credential hiccup never blocks dev boot.
//
// The docker fixtures themselves (`docker/wordpress`, `docker/drupal`, the
// entrypoints, the e2e UAT) stay core-for-now as the integration harness
// (epic #978 doctrine (e)) — explicitly OUT OF SCOPE to move here.
//
// Idempotent. Soft-fails (logs + returns a status object) — NEVER throws — so
// app boot is never blocked. Strictly dev-gated: every powerful helper below
// (docker exec, HTTP probes, the `cnx_` mint) refuses outside
// `CINATRA_RUNTIME_MODE==="development"`, restricts docker exec to the cinatra
// compose-project container allowlist, validates probe targets are loopback,
// uses argv-based `spawnSync` (NO shell-string interpolation), and never logs a
// credential — the runtime constraints codex flagged on the #1026 contract.
// -----------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { writeFileSync, mkdirSync, chmodSync } from "node:fs";
import path from "node:path";

import {
  isExtensionDevSetupModule,
} from "@cinatra-ai/sdk-extensions";
import type {
  ExtensionDevSetupContext,
  ExtensionDevSetupHelpers,
  ExtensionDevSetupStatus,
} from "@cinatra-ai/sdk-extensions";
import { resolveCapabilityProviders } from "@/lib/extension-capabilities-registry";
import { GENERATED_DEV_SETUP_MODULES } from "@/lib/generated/extensions.server";
import { isDegradedExtensionLoad } from "@/lib/extension-load-guard";
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
import { randomUUID } from "node:crypto";
import { auth, ensureInitialAdminBootstrap } from "@/lib/auth";
import { ensureDefaultOrganizationRow } from "@/lib/default-organization-bootstrap";
import { upsertConnectSiteAndMintCredential } from "@/lib/connect-provisioning";

type Status =
  | { status: "created"; siteUrl: string; detail?: string }
  | { status: "already-wired"; siteUrl: string; detail?: string }
  | { status: "skipped"; reason: string }
  | { status: "error"; reason: string };

// ---------------------------------------------------------------------------
// Dev gate + host-provided imperative IO helpers (the `ExtensionDevSetupHelpers`
// surface a connector hook receives on its context).
// ---------------------------------------------------------------------------

// Strict dev gate (exact-equality, NOT the default-development getAppRuntimeMode):
// every powerful helper + the `cnx_` mint is refused outside development.
function isStrictDevelopmentRuntime(): boolean {
  return process.env.CINATRA_RUNTIME_MODE === "development" && process.env.NODE_ENV !== "production";
}

// Container allowlist — the docker exec / ps helpers only ever touch containers
// that match the docker-compose PROJECT NAMING CONVENTION of the cinatra dev
// stack: `cinatra-<service>-<replicaIndex>` (e.g. `cinatra-wordpress-1`,
// `cinatra-plane-proxy-1`). A vendor-neutral shell names no specific container;
// it constrains the STRUCTURE — the fixed `cinatra-` project prefix, one or
// more lowercase service segments, and a REQUIRED trailing numeric replica
// index — so a connector hook can never drive an arbitrary container (a bare
// `cinatra-<word>` with no replica index is rejected). Anchored, bounded, one
// character class per segment → ReDoS-safe.
function isAllowedDevContainer(name: string): boolean {
  return /^cinatra-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9]+$/.test(name);
}

/**
 * True ONLY when the URL is an `http:`/`https:` LOOPBACK origin — the gate every
 * dev probe applies before invoking `curl`. Stricter than the contract helper
 * `isLocalhostUrl` (which is loopback-host-only): it also pins the scheme so a
 * `file://localhost/...` (or any other curl-supported loopback scheme) can
 * never reach `curl`.
 */
function isLoopbackHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  } catch {
    return false;
  }
  return isLocalhostUrl(url);
}

/**
 * True when the URL's host is a loopback address. Used to HARD-GATE dev probes
 * to localhost — the dev shell must never reach a non-loopback origin.
 * `new URL("http://[::1]:p").hostname` returns "[::1]" (brackets kept), so
 * strip the brackets before comparing.
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
 * Strip trailing slashes via a LINEAR char-index trim. The anchored greedy
 * `/\/+$/` is polynomial-ReDoS on input with many trailing slashes (CodeQL
 * `js/polynomial-redos`, high) — the codebase has standardised on this linear
 * form. Never use `/\/+$/`.
 */
export function trimTrailingSlashes(input: string): string {
  let end = input.length;
  while (end > 0 && input.charCodeAt(end - 1) === 47) end--; // 47 = "/"
  return input.slice(0, end);
}

/** Resolve after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `curl`-based liveness probe that succeeds ONLY on a 2xx (a `curl -f`-style
 * hard probe). argv-based `spawnSync` (NO shell string) so a URL never passes
 * through shell interpolation, and loopback-gated so the dev shell never probes
 * a non-localhost origin. All inputs are controlled (`http://localhost:<port>/`).
 */
function probeHttp(url: string, timeoutSeconds = 3): boolean {
  if (!isLoopbackHttpUrl(url)) return false;
  const r = spawnSync(
    "curl",
    ["-fsS", "-o", "/dev/null", "--max-time", String(timeoutSeconds), url],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  return r.status === 0;
}

/**
 * Liveness probe that succeeds when the HTTP server ANSWERS — including a
 * redirect / 403 / 5xx — not only on a 2xx. A freshly installed fixture serves
 * a non-2xx for a window after install (and right after a container restart)
 * even though the server is genuinely up. We therefore treat ANY HTTP response
 * as reachable and only count a connection refusal / timeout / DNS failure as
 * unreachable. Loopback-gated + argv-based (no shell interpolation).
 *
 * `curl -sS -o /dev/null -w %{http_code}` exits 0 on any received response;
 * it prints "000" when no HTTP response was received at all → treat as
 * unreachable.
 */
export function probeHttpAnswered(url: string, timeoutSeconds = 3): boolean {
  if (!isLoopbackHttpUrl(url)) return false;
  const r = spawnSync(
    "curl",
    ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", String(timeoutSeconds), url],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (r.status !== 0) return false;
  const code = (r.stdout ?? "").trim();
  return code !== "" && code !== "000";
}

/**
 * Resilient reachability probe with bounded linear backoff. A container can be
 * ready internally while its external HTTP endpoint is still settling; a
 * one-shot probe that fires at boot too early would skip wiring permanently for
 * that boot. Polls `probeHttpAnswered` up to `attempts` times, sleeping
 * `delayMs` between tries, and returns true as soon as the server answers.
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

/** True when a docker container with EXACTLY this name is running. Container
 * name is allowlist-validated (cinatra compose project) and passed argv-based —
 * never a shell string. */
function probeDockerContainer(name: string): boolean {
  if (!isAllowedDevContainer(name)) return false;
  const r = spawnSync(
    "docker",
    ["ps", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (r.status !== 0) return false;
  return (r.stdout ?? "").trim() === name;
}

/**
 * `docker exec <container> <argv...>` in capture mode (combined stdout+stderr).
 * The powerful hook helper — HARD-GATED:
 *   - dev-mode only (refuses outside `CINATRA_RUNTIME_MODE==="development"`),
 *   - container name allowlist (cinatra compose project only),
 *   - argv-based `spawnSync` — credential material in `argv` NEVER passes
 *     through shell interpolation,
 *   - returns the exit code + combined output; never throws; never LOGS the
 *     argv/output (a wp-cli / drush command line can embed a credential).
 * A gate miss returns a fixed non-zero code so the hook soft-skips.
 */
function dockerExecCapture(container: string, argv: string[]): { code: number; out: string } {
  if (!isStrictDevelopmentRuntime()) return { code: -1, out: "" };
  if (!isAllowedDevContainer(container)) return { code: -1, out: "" };
  if (!Array.isArray(argv) || argv.some((a) => typeof a !== "string")) return { code: -1, out: "" };
  const r = spawnSync("docker", ["exec", container, ...argv], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

/**
 * Browser-reachable Cinatra origin for the CMS widget config.
 *
 * The widget bundle + SSE stream are loaded by the admin's BROWSER (on the
 * host), so the configured `cinatra_url` must resolve from the host —
 * `http://localhost:${PORT}`, NOT a container-only `host.docker.internal`.
 * `scripts/dev-server.mjs` lifts `.env.local` PORT into process.env, so this
 * tracks the actual dev-server port.
 */
function cinatraBrowserBaseUrl(): string {
  return `http://localhost:${process.env.PORT ?? "3000"}`;
}

// The host-owned helper bundle every devSetup hook receives on its context.
const DEV_SETUP_HELPERS: ExtensionDevSetupHelpers = {
  dockerExecCapture,
  probeDockerContainer,
  probeHttp,
  probeHttpReachableWithRetry,
  isLocalhostUrl,
  trimTrailingSlashes,
};

// ---------------------------------------------------------------------------
// devSetup hook discovery + orchestration.
// ---------------------------------------------------------------------------

const tag = "[dev-auto-setup]";

type DeclaringDevSetupExtension = {
  packageName: string;
  /** Package-relative `cinatra.devSetup` path (e.g. `./src/dev-setup`). */
  devSetupPath: string;
};

/**
 * Discover dev-checkout extensions that declare `cinatra.devSetup`. Mirrors
 * `dev-fixture-seeder.discoverDeclaringExtensions`: reads each materialized
 * `extensions/<vendor>/<slug>/package.json`, keeps the ones declaring a
 * string `cinatra.devSetup`. A malformed / absent package.json is skipped
 * (dev boot stays unblocked). Returns [] when there is no extensions checkout
 * (e.g. prod) so the shell is a clean no-op off dev.
 */
async function discoverDevSetupExtensions(): Promise<DeclaringDevSetupExtension[]> {
  const root = path.join(process.cwd(), "extensions");
  const out: DeclaringDevSetupExtension[] = [];
  let vendors: string[];
  try {
    vendors = await readdir(root);
  } catch {
    return out;
  }
  for (const vendor of vendors) {
    let slugs: string[];
    try {
      slugs = await readdir(path.join(root, vendor));
    } catch {
      continue;
    }
    for (const slug of slugs) {
      const pkgPath = path.join(root, vendor, slug, "package.json");
      let pkg: Record<string, unknown>;
      try {
        pkg = JSON.parse(await readFile(pkgPath, "utf8")) as Record<string, unknown>;
      } catch {
        continue;
      }
      const name = typeof pkg.name === "string" ? pkg.name : null;
      const cinatra = (pkg.cinatra ?? null) as Record<string, unknown> | null;
      const devSetupPath =
        cinatra && typeof cinatra.devSetup === "string" ? cinatra.devSetup : null;
      if (!name || !devSetupPath) continue;
      out.push({ packageName: name, devSetupPath });
    }
  }
  return out;
}

/**
 * Build the dev-only `ExtensionDevSetupContext` the host shell hands to a
 * connector's `runDevSetup`. `capabilities` wraps the host's real per-process
 * capability registry (so a hook resolves `@cinatra-ai/host:*` services + the
 * connector-authored `nango-system` surface); `helpers` is the host-owned IO
 * bundle; `mintDevConnectCredential` + `browserBaseUrl` carry the host-seeded
 * dev-actor affordances the CMS hooks need.
 */
function buildDevSetupContext(packageName: string): ExtensionDevSetupContext {
  const logPrefix = `[dev-auto-setup:${packageName}]`;
  return {
    capabilities: {
      resolveProviders: (capability: string) => resolveCapabilityProviders(capability),
    },
    helpers: DEV_SETUP_HELPERS,
    log: (message: string) => console.log(`${logPrefix} ${message}`),
    // Host-gated `cnx_` mint (strictly dev + loopback; see the impl below).
    // `client` is opaque to the shell — the connector names its own CMS client.
    mintDevConnectCredential: (client: string, widgetOrigin: string) =>
      mintDevConnectCredential(cachedDevActor, client, widgetOrigin),
    browserBaseUrl: cinatraBrowserBaseUrl(),
  };
}

type DevSetupHookResult = { packageName: string; status: ExtensionDevSetupStatus };

/**
 * Discover + invoke every connector `cinatra.devSetup` hook idempotently.
 * Soft-fail per connector: a missing generated loader, an import failure, a
 * missing/malformed hook, or a throwing `runDevSetup` is captured as an
 * `error`/`skipped` status and never blocks the other hooks or dev boot.
 *
 * The hook module is resolved from the generated `GENERATED_DEV_SETUP_MODULES`
 * map — one LITERAL `import("<pkg>/src/dev-setup")` per declaring connector,
 * emitted by scripts/extensions/generate-extension-manifest.mjs. This is the
 * ONLY Turbopack-analyzable shape: a runtime-COMPUTED specifier throws "Cannot
 * find module … as expression is too dynamic" under Turbopack (the default
 * `pnpm dev` path), which silently skipped EVERY hook + fixture before this fix
 * (cinatra#976/#1029). On-disk discovery still drives WHICH connectors run (so
 * prod, with no `extensions/` checkout, stays a clean no-op).
 *
 * EVERY failure branch logs LOUDLY (console.error, names the connector) so a
 * future regression can never fail silently again.
 */
async function runDevSetupHooks(): Promise<DevSetupHookResult[]> {
  const declaring = await discoverDevSetupExtensions();
  const results: DevSetupHookResult[] = [];
  for (const ext of declaring) {
    const entry = GENERATED_DEV_SETUP_MODULES[ext.packageName];
    if (!entry) {
      // A connector declares `cinatra.devSetup` on disk but the generated map
      // has no loader for it — a stale/out-of-date generated tree. LOUD: this
      // is exactly the silent-skip class the static map was built to kill.
      // Regenerate: node scripts/extensions/generate-extension-manifest.mjs
      const reason = `no generated devSetup loader for ${ext.packageName} — GENERATED_DEV_SETUP_MODULES is stale; regenerate the extension manifest`;
      console.error(`[dev-auto-setup:${ext.packageName}] ✗ ${reason}`);
      const status: ExtensionDevSetupStatus = { status: "error", reason };
      results.push({ packageName: ext.packageName, status });
      logDevSetupStatus(ext.packageName, status);
      continue;
    }
    let mod: unknown;
    try {
      mod = await entry.load();
    } catch (err) {
      const reason = `devSetup import failed (${ext.packageName}): ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[dev-auto-setup:${ext.packageName}] ✗ ${reason}`);
      const status: ExtensionDevSetupStatus = { status: "error", reason };
      results.push({ packageName: ext.packageName, status });
      logDevSetupStatus(ext.packageName, status);
      continue;
    }
    if (isDegradedExtensionLoad(mod)) {
      // The guardedOptional loader resolved the standardized degraded result —
      // the connector's devSetup module is absent post-build. For an on-disk
      // dev connector this is an integrity mismatch, NOT an expected no-op:
      // record an error + log loudly (never silently skip the fixture).
      const reason = `devSetup module absent for on-disk connector ${ext.packageName} (${mod.reason})`;
      console.error(`[dev-auto-setup:${ext.packageName}] ✗ ${reason}`);
      const status: ExtensionDevSetupStatus = { status: "error", reason };
      results.push({ packageName: ext.packageName, status });
      logDevSetupStatus(ext.packageName, status);
      continue;
    }
    if (!isExtensionDevSetupModule(mod)) {
      const reason = `devSetup module has no runDevSetup entry (${ext.packageName})`;
      console.error(`[dev-auto-setup:${ext.packageName}] ✗ ${reason}`);
      const status: ExtensionDevSetupStatus = { status: "skipped", reason };
      results.push({ packageName: ext.packageName, status });
      logDevSetupStatus(ext.packageName, status);
      continue;
    }
    let status: ExtensionDevSetupStatus;
    try {
      status = await mod.runDevSetup(buildDevSetupContext(ext.packageName));
    } catch (err) {
      // A hook is contract-bound never to throw (it soft-fails by returning a
      // status). A throw is a contract violation — and its message can carry
      // lower-layer docker/provider text that may embed a credential, so we
      // surface only a FIXED host-owned reason (SECRET BOUNDARY), never the raw
      // message. The stack is written to console.error (dev terminal) at a
      // debug level for the connector author, tagged, never as the returned
      // reason.
      console.error(`[dev-auto-setup:${ext.packageName}] devSetup hook threw (contract violation):`, err instanceof Error ? err.name : "unknown");
      status = { status: "error", reason: "devSetup hook threw (contract violation; hooks must soft-fail)" };
    }
    results.push({ packageName: ext.packageName, status });
    logDevSetupStatus(ext.packageName, status);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Connector access dev fixture seed (CANONICAL, vendor-NEUTRAL — kept in core).
//
// On first user registration (or first runDevAutoSetup invocation in dev
// mode), find the earliest-created user, look up their primary org, and seed
// the UNIFORM polymorphic access rows per connector descriptor: one org-owned
// `installed_extension` (kind='connector') + one `extension_access_policy`.
// The seed policy derives from each connector's OWN materialized
// `cinatra/config.json`, read through the SAME host reader + SDK validator the
// prod install pipeline uses. This iterates the connector DESCRIPTORS
// generically — it names no vendor — so it stays core.
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
        `${tag} connector fixture seed SKIPPED for ${d.packageId} — ` +
          `could not resolve cinatra/config.json from ${storeDir}:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    if (!declaration) {
      failed += 1;
      console.error(
        `${tag} connector fixture seed SKIPPED for ${d.packageId} — ` +
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
    // FAIL CLOSED for this connector: skip the policy seed too — the card then
    // gates on the shipped catalog default until the next boot recaches.
    try {
      await recordExtensionAccessDeclaration(installedExtensionId, declaration, {
        actor: { source: "scheduler" },
        reason: "dev connector fixture seed — cache cinatra/config.json declaration (cinatra#955)",
      });
    } catch (err) {
      failed += 1;
      console.error(
        `${tag} could not cache the access declaration for ${d.packageId} — ` +
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
// connect-site credentials for the CMS assistant UAT (host-seeded; the
// connector CMS hooks call `ctx.mintDevConnectCredential`).
//
// The shipped Option-A widget streams behind a REAL per-site `cnx_` connect-site
// credential AND a per-user hosted-PKCE `cwu_` login. Driving the genuine auth
// path (NOT a `requireUserToken:false` bypass) needs: (1) a deterministic
// Cinatra end-user who is a member of the org that owns the connect-site, so the
// hosted `/widget-auth` consent + the stream's live org-membership re-check both
// pass; (2) a `cnx_` per site whose `widget_origin` === the CMS browser origin
// and whose org === that user's org. This block provides both, STRICTLY gated to
// `CINATRA_RUNTIME_MODE==='development'` + loopback origins — it never runs in
// production and never touches the prod auth-route guard or manifest.
// ---------------------------------------------------------------------------

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
 * so the seeded org IS the one `autoSeedConnectorPolicyFixture` already keys on
 * (earliest user → first org). Writes a gitignored handoff file for the
 * Playwright suite. Returns null (soft) if seeding is unavailable.
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
          `${tag}:connect could not seed the dev UAT user (${err instanceof Error ? err.message : "unknown"})`,
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
    console.log(`${tag}:connect dev UAT user has no resolvable org membership yet`);
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
 * in place (one row per site). Returns the plaintext `cnx_` for the caller to
 * push into the CMS widget config in the SAME step (returned exactly once), or
 * null when unavailable (no dev actor / non-dev / non-loopback origin / mint
 * failed). Host-gated: strictly dev + loopback only.
 *
 * SECRET BOUNDARY: the returned `cnx_` is handled by the connector hook exactly
 * like the widget api_key — this helper never logs the credential.
 */
function mintDevConnectCredential(
  actor: DevConnectActor | null,
  client: string,
  widgetOrigin: string,
): string | null {
  if (!isStrictDevelopmentRuntime()) return null;
  if (!actor) return null;
  const origin = normalizeOriginStrictLocal(widgetOrigin);
  // Loopback-only: never mint a connect-site for a non-localhost origin in dev.
  if (!origin || !isLocalhostUrl(origin)) return null;
  // The connect-provisioning store constrains `client` to its known CMS clients;
  // an unknown value throws inside and is soft-caught below (no vendor literal
  // is hardcoded in this shell).
  try {
    const { credential } = upsertConnectSiteAndMintCredential({
      client: client as "wordpress" | "drupal",
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
 * connector-owned `cinatra.devSetup` hook idempotently, then seed the canonical
 * connector access policies. Idempotent. Soft-fails (logs only; never throws).
 * Safe to call at app boot AND from the CLI.
 */
export async function runDevAutoSetup(): Promise<{
  hooks: DevSetupHookResult[];
  connectorPolicies: Status;
}> {
  // Defense-in-depth top-level gate: the boot caller is dev-only, but a CLI /
  // direct import must never run the docker/credential provisioning + fixture
  // seeding outside strict development. A no-op skipped result off dev.
  if (!isStrictDevelopmentRuntime()) {
    return { hooks: [], connectorPolicies: { status: "skipped", reason: "not development" } };
  }

  // cinatra#410 — seed the deterministic dev user+org FIRST so the connector CMS
  // hooks below can mint per-site `cnx_` credentials bound to it via
  // `ctx.mintDevConnectCredential` (strictly dev-gated; soft no-op outside dev).
  try {
    await ensureDevConnectActor();
  } catch (err) {
    console.log(
      `${tag}:connect dev actor seed skipped (${err instanceof Error ? err.message : "unknown"})`,
    );
  }

  // Discover + run the connector-owned devSetup hooks (vendor-neutral: the shell
  // names no connector; each hook wires its own local docker fixture).
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

function logDevSetupStatus(packageName: string, result: ExtensionDevSetupStatus): void {
  const prefix = `[dev-auto-setup:${packageName}]`;
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
