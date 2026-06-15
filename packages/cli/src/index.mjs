import { randomBytes, randomUUID, createHash } from "node:crypto";
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import net from "node:net";
import pg from "pg";
import { resolveTeardownNames } from "./teardown-config.mjs";
import { runCoreMigrations, runNamespacedMigrations, isFreshCoreSchema } from "./core-migrations.mjs";
import { syncDevApps, readDevAppsConfig } from "./dev-apps.mjs";
import { syncCinatraDevExtensions } from "./cinatra-dev-extensions.mjs";
import { parseDevRefreshFlags, describeDockerDecision } from "./dev-refresh.mjs";
import {
  SEED_DB_NAME,
  cloneSlugFromBranch,
  cloneDbName,
  isProtectedDbName,
  defaultRegistryPath,
  readRegistry,
  requireUsableRegistry,
  writeRegistry,
  withRegistryLock,
  allocateSlot,
  markSlotReady,
  releaseSlot,
  getClone,
  listClones,
  canonicalizeWorktreePath,
  findCloneByWorktreePath,
  isWorktreePathStale,
} from "./clone-registry.mjs";
// Runtime helpers for clone pid lifecycle, log truncation, port-band guards,
// per-clone path layout, Tailscale-secret handling, and argv parsing.
import {
  CLONE_NEXTJS_PORT_LIMIT,
  CLONE_WAYFLOW_PORT_LIMIT,
  acquireRuntimeLock,
  assertPortBandOk,
  cloneComposePath,
  cloneComposeProjectName,
  cloneLogPath,
  clonePidPath,
  cloneRuntimeDir,
  cloneTailscaleHostname,
  cloneTailscaleServePath,
  cloneTailscaleStateDir,
  ensureCloneRuntimeDir,
  findPositionalSlug,
  isPidAlive,
  isRuntimeLockHeld,
  processCommandLineMatches,
  redactTailscaleAuthkey,
  rejectTailscaleAuthkeyFlag,
  releaseRuntimeLock,
  scrubTailscaleAuthkey,
  truncateCloneLog,
  validateTailscaleAuthkey,
} from "./clone-runtime.mjs";
// Pure URL-shape helper shared with the TS in-process MCP writer.
import { buildMcpPublicBaseUrlRow } from "../../mcp-server/src/mcp-public-base-url-shape.mjs";
// Manifest-driven dev-CLI module discovery (local leaf module — static import
// is extension-empty safe; the actual extension reach stays a lazy import()).
import { loadDevCliModule } from "./dev-cli-modules.mjs";
// Tailscale connector source lives in the gitignored `extensions/cinatra-ai/`
// clone-back target, ABSENT on a fresh checkout until `cinatra setup dev`
// populates it. `mintTailscaleAuthKey`, `TailscaleApiError`, and
// `deriveDevTailscaleHostname` are consumed ONLY by the post-config
// provisioning handlers (`runCloneStart`, `runDevTunnel`,
// `autoMintTailscaleAuthKeyFromNango`, `resolveCloneTailscaleHostname`) — never
// during `setup dev|branch|clone`. They are loaded lazily via `await import()`
// inside those handlers so the CLI module resolves on a fresh, extension-empty
// checkout.
// Pure write-vs-skip and hostname-collision decision boundary. Imported by
// runCloneStart so the optimistic
// publicBaseUrl write is decoupled from the racing /api/mcp/health probe
// and a MagicDNS collision fails loud. This LOCAL module is safe to import
// statically: its connector reach is now a dynamic import (see
// tailscale-provision.mjs), so it resolves with the extension absent.
import {
  shouldWritePublicBaseUrl,
  TailscaleProvisionError,
  verifyRegisteredHostnameMatchesPrediction,
} from "./tailscale-provision.mjs";

const { Client } = pg;

const AUTH_TABLES = [
  "user",
  "session",
  "account",
  "verification",
  "organization",
  "member",
  "invitation",
  "jwks",
  "oauthClient",
  "oauthAccessToken",
  "oauthRefreshToken",
  "oauthConsent",
  // Better Auth organization teams (enabled via teams: { enabled: true })
  "team",
  "teamMember",
];

const STORE_TABLES = [
  "metadata",
  "startups",
  "startup_overrides",
  "campaign_types",
  "campaigns",
  "drafts",
  "agent_campaign_overrides",
  "skill_packages",
  "skills",
  "notifications",
  "record_activities",
  "chat_threads",
  // Agent builder tables
  "agent_templates",
  "agent_versions",
  "agent_runs",
  "agent_run_messages",
  "agent_registry_entries",
  "agent_share_bindings",
  "agent_forks",
  "agent_template_versions",
  "planned_actions",
  "review_tasks",
  "audit_events",
  // Metrics
  "usage_events",
  "model_pricing",
  "legacy_costs",
  "external_mcp_servers",
  // OTel traces
  "traces",
  // Generic typed object store
  "objects",
];

// Operational tables in the `cinatra` schema that should NOT carry data from
// the source into a branch / clone — per-run state, audit trail, telemetry,
// chat history. Used by `runSetupBranch` (row-by-row seed skip) and
// `runRefreshSeed` (TRUNCATE in the seed DB). Extracted to module scope in
// module scope so both seed paths share one list.
const SEED_SKIP_TABLES = new Set([
  "agent_runs",          // per-run state
  "agent_run_messages",  // per-run state
  "audit_events",        // should be fresh per branch / clone
  "notifications",       // user-specific, fresh per branch / clone
  "traces",              // OTel traces, fresh per branch / clone
  "chat_threads",        // chat history, fresh per branch / clone
  "record_activities",   // activity log, fresh per branch / clone
  "planned_actions",     // obsolete agent workflow table, skipped if present
  "review_tasks",        // obsolete agent-review table, skipped if present
  "usage_events",        // metrics telemetry, fresh per branch / clone
]);

// Volatile Better Auth tables in the `public` schema that MUST be truncated in
// `cinatra_seed`. Browser session cookies are port-blind, so a
// copied `public.session` row would let a main-app cookie authenticate against
// a clone running on a different port. Mixed-case identifiers — every SQL site
// that names these MUST use `quoteIdentifier`. The identity tables
// (user / account / organization / member / team / teamMember / jwks /
// oauthClient) are intentionally kept so the operator can sign into a clone
// with the same credentials.
const SEED_AUTH_SCRUB_TABLES = [
  "session",
  "verification",
  "oauthAccessToken",
  "oauthRefreshToken",
  "oauthConsent",
];

// Rich (non-key-value) tables in the cinatra schema. These have their own
// column definitions and cannot be created by the placeholder `(id, payload)`
// shape ensureStoreSchema uses for STORE_TABLES. ensureRichSchemas creates
// them and adds any columns that have been introduced since this DB was first
// initialized — kept idempotent with `IF NOT EXISTS` so it's safe to re-run.
//
// Each entry mirrors the Drizzle definition in the package that owns the
// table (e.g. packages/objects/src/schema.ts). When a column is added there,
// add it here too.
const RICH_TABLES = [
  {
    name: "dynamic_object_types",
    create: `(
      type text primary key,
      display_name text not null,
      inferred_category text not null,
      slug text,
      json_schema jsonb,
      source text,
      confidence text,
      status text not null default 'proposed',
      created_at timestamptz not null default now(),
      created_by text,
      promoted_to_type text,
      origin_context jsonb,
      identity_key text
    )`,
    columns: {
      slug: "text",
      json_schema: "jsonb",
      source: "text",
      confidence: "text",
      status: "text not null default 'proposed'",
      created_at: "timestamptz not null default now()",
      created_by: "text",
      promoted_to_type: "text",
      origin_context: "jsonb",
      identity_key: "text",
    },
  },
  {
    name: "object_sync_adapter_configs",
    create: `(
      id text primary key,
      object_type text not null,
      adapter_id text not null,
      config jsonb not null,
      is_active boolean not null default true,
      created_by text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )`,
    columns: {
      is_active: "boolean not null default true",
      created_by: "text",
      created_at: "timestamptz not null default now()",
      updated_at: "timestamptz not null default now()",
    },
    indexes: [
      {
        name: "object_sync_adapter_configs_type_adapter_unique",
        sql: "(object_type, adapter_id)",
      },
    ],
  },
];

const SELF_MCP_CLIENT_ID = "cinatra-app-mcp-client";
const SELF_MCP_CLIENT_NAME = "Cinatra App MCP Client";
const SELF_MCP_CLIENT_SCOPES = ["openid", "profile", "email", "offline_access", "mcp:connect"];
const SELF_MCP_CLIENT_SCOPE = SELF_MCP_CLIENT_SCOPES.join(" ");
const MCP_SETTINGS_KEY = "connector_config:mcp_server";
const NANGO_SETTINGS_KEY = "connector_config:nango";
const APP_RUNTIME_MODE_ENV_KEYS = ["CINATRA_RUNTIME_MODE", "APP_RUNTIME_MODE"];
const DEFAULT_DATA_DIRECTORY = "data";
const DEFAULT_BACKUP_DIRECTORY = path.join(DEFAULT_DATA_DIRECTORY, "backups");
const DEFAULT_DOWNLOADS_DIRECTORY = path.join(DEFAULT_DATA_DIRECTORY, "downloads");
const DEFAULT_BACKUP_EXTENSION = ".tar.gz";
const DEFAULT_POSTGRES_CLIENT_IMAGE = "postgres:17-alpine";
const DEFAULT_LOCAL_NANGO_DB_URL = "postgresql://nango:nango@127.0.0.1:5435/nango";

function printHelp() {
  console.log(`Cinatra setup CLI

Usage:
  cinatra setup dev [--skip-dev-apps] [--force-dev-apps]
  cinatra setup prod
  cinatra setup nango
  cinatra setup branch [--worktree-path <path>] [--slug <slug>] [--port <port>]
                       [--source-env <path>] [--force]
                       [--skip-dev-apps] [--force-dev-apps]
  cinatra teardown branch [--worktree-path <path>] [--slug <slug>] --yes
  cinatra clone refresh-seed [--source-env <path>]
  cinatra setup clone [<name>] [--slug <name>] [--worktree-path <path>] [--source-env <path>] [--force]
                      [--skip-dev-apps] [--force-dev-apps]
  cinatra clone start [--slug <slug>] [--worktree-path <path>] [--rebuild-wayflow]
                      [--tailscale-host-network]
                      # TS_AUTHKEY is read from env (never a CLI arg, to keep
                      # the secret out of shell history + ps output).
  cinatra clone stop [--slug <slug>] [--worktree-path <path>]
  cinatra clone status [--slug <slug>] [--worktree-path <path>]
  cinatra clone slug-for-worktree --worktree-path <path>
  cinatra clone prune [--worktree-path <path>] [--slug <slug>] --yes
  cinatra clone list
  cinatra db migrate [--down] [--count=N] [--dir <abs> --namespace <ns>]
  cinatra dev refresh [--docker=auto|always|--no-docker]
  cinatra dev tunnel start
  cinatra dev tunnel stop
  cinatra dev tunnel status
  cinatra status
  cinatra backup create [--file <path>]
  cinatra backup import [--file <path>|<filename>] [--yes]
  cinatra backup export-api-configs [--file <path>]
  cinatra backup import-api-configs [--file <path>|<filename>] [--yes]
  cinatra reset dev --yes [--full] [--rebuild-env] [--backup|--no-backup]
                         [--purge-app-data|--keep-app-data] [--file <path>]
  cinatra skills reset-repo --yes [--app-url <url>]
  cinatra extensions purge <packageName> --confirm <packageName> --digest <d>
                          [--reason <r>] [--app-url <url>] --yes
  cinatra extensions submit <tarball.tgz> [--description "<text>"]
  cinatra extensions acquire-prod
  cinatra mcp llm-access setup
  cinatra mcp llm-access refresh
  cinatra doctor [--strict]
  cinatra agent export <id-or-name> [--file <output.zip>]
  cinatra agent import <file.zip> [--name <override-name>]
  cinatra agents install [<name>[@<range>]] [options]

Commands:
  dev refresh       Reconcile your local dev environment (dependencies + dev
                    database schema) to the code you have checked out. Run it
                    after a git pull or branch switch. Dev mode only; it never
                    touches git, extensions, or production — you manage git, this
                    only brings deps + the dev DB in sync with what is on disk.
                    --docker=auto     (default) start the bundled docker stack
                                      only when this checkout owns it; skip for
                                      isolated worktrees/clones + external infra.
                    --docker=always   force docker compose up -d (fatal on failure).
                    --no-docker       skip the docker step entirely.
                    Applies the additive schema bootstrap, then the versioned
                    core migration chain (migrations/core/, pgmigrations ledger).
  skills reset-repo Force-push the entire local skills store to the connected
                    GitHub skills repository (dev mode only). Replaces all repo
                    content with what is currently in data/skills/.
                    --yes             Required — confirms the destructive operation.
                    --app-url <url>   App base URL (default: http://localhost:3000).
  extensions purge  Fully remove an extension EVERYWHERE: every Verdaccio
                    version + DB rows + on-disk dir + WayFlow reload (dev mode
                    only; loopback). Quarantines tarballs+metadata to
                    data/extension-quarantine/ first. Refuses if active
                    dependents reference it. Plan it first via the
                    extensions_purge MCP tool to obtain --digest.
                    <packageName>     Scoped pkg, e.g. @cinatra-ai/foo-agent.
                    --confirm <pkg>   Required — must equal <packageName>.
                    --digest <d>      Required — from the extensions_purge dry-run; must match.
                    --reason <r>      Optional audit reason.
                    --yes             Required — confirms the destructive op.
                    --app-url <url>   App base URL (default: http://localhost:3000).

  extensions submit Submit a built extension tarball to the Cinatra Marketplace
                    for review. Reads the tarball's package.json to derive
                    namespace + extension name + version; computes sha256 +
                    size; base64-encodes; calls extension_submit_for_review
                    on the marketplace. Requires MARKETPLACE_INSTANCE_TOKEN
                    in the shell env.
                    <tarball.tgz>     Path to the built .tgz.
                    --description     Optional short description recorded on
                                      the submission row.

  extensions acquire-prod
                    Download the production required-extension set into
                    extensions/ from the committed
                    cinatra-required-extensions.lock.json: codeload tarballs
                    pinned to commit SHAs, hardened extraction, tree-hash +
                    package.json verification. No git/gh binary needed.
                    Idempotent; fails loud on any integrity mismatch. Run
                    \`corepack pnpm install\` afterwards to link the packages
                    (the Dockerfile and scripts/setup.sh prod flow do this).

  setup dev|prod    Prepare Better Auth, workspace schema, Nango administration, MCP
                    server, and OAuth clients. Leaves the app ready for first-user
                    registration. LLM MCP access is provisioned in dev mode only.
                    In dev mode, also clones/fast-forwards the WordPress plugin
                    + Drupal module (cinatra.devApps) into the tree.
                    --skip-dev-apps                    Do not clone/update them.
                    --force-dev-apps                   Stash + hard-reset a DIRTY
                                                       clone (never touches a clone
                                                       with the wrong origin/branch).
                    (Per-repo URL override: CINATRA_WORDPRESS_PLUGIN_REPO_URL,
                     CINATRA_DRUPAL_MODULE_REPO_URL — HTTPS or SSH.)

  setup branch      Provision an isolated dev environment for the current git worktree
                    (writes .env.local, creates & migrates cinatra_<slug> schema).
                    Runs a worktree-name collision guard before any side effect —
                    blocks if the proposed slug already names an existing worktree
                    or local branch.
                    --worktree-path <path>     Worktree directory (default: cwd).
                    --slug <slug>              Explicit slug (default: derived from branch).
                    --port <port>              Explicit port (default: auto-detect from 3001).
                    --source-env <path>        Source .env.local to copy (default: main repo).
                    --force                    Overwrite existing .env.local; bypass
                                               the collision guard.

  teardown branch   Remove the isolated Postgres schema for the current git worktree
                    (drops cinatra_<slug> schema). Requires --yes.
                    --worktree-path <path>  Worktree directory (default: cwd).
                    --slug <slug>           Explicit slug (default: derived from branch).

  clone refresh-seed
                    (Re)build the cinatra_seed template database — a scrubbed
                    snapshot of the live app DB that 'setup clone' templates from.
                    Run this once before the first 'setup clone', and again
                    whenever clones should pick up fresher data.
                    --source-env <path>     Source .env.local (default: main repo).

  setup clone       Create + provision a DORMANT deep-fork clone. Given a <name>
                    (positional or --slug), this CLI now CREATES the git worktree
                    itself at ../cinatra-ai-<name> on branch cinatra-ai-<name>
                    from origin/main, provisions a SEPARATE Postgres database
                    cinatra_clone_<name> from the cinatra_seed template + a
                    worktree .env.local on a dedicated port band (Next.js 3100+,
                    WayFlow 3200+), then auto-runs 'corepack pnpm install' in the
                    new worktree. This is the heavy isolation path and is fully
                    command-managed (no automatic EnterWorktree hook, no worktree- prefix);
                    'setup branch' remains the light schema-isolation path. With
                    NO name it falls back to no-name mode (provision an
                    already-existing worktree from the cwd branch; no creation,
                    no auto-install). The clone is created stopped — 'clone
                    start/stop' run it.
                    <name> | --slug <name>  Clone name (lowercase/digits/dashes,
                                            max 30). Triggers worktree creation.
                    --worktree-path <path>  No-name mode path only (default: cwd).
                    --source-env <path>     Source .env.local (default: main repo).
                    --force                 Overwrite an incompatible existing .env.local.

  clone prune       Destroy a clone: DROP its cinatra_clone_<slug> database, clean
                    its Redis queue keys, release its registry slot, and (for
                    command-managed heavy clones) also 'git worktree remove' the
                    ../cinatra-ai-<slug> worktree. Unmanaged worktree
                    entries are left untouched. Requires --yes.
                    --worktree-path <path>  Worktree directory (default: cwd).
                    --slug <slug>           Explicit slug (default: derived from branch).

  clone list        List registered clones (slug, ports, database, state, worktree).

  dev tunnel start            Provision a Tailscale Funnel for the local dev main (CINATRA_RUNTIME_MODE=development only).
  dev tunnel stop             Tear the dev-main Tailscale sidecar down and clear publicBaseUrl.
  dev tunnel status           Show predicted vs registered hostname + whether publicBaseUrl is set.

  status            Show current setup state (auth tables, user count, MCP config).

  backup create     Export a full backup bundle to data/backups/ (app DB, optional Nango DB,
                    and data directory files such as skills and logs).
                    --file <path>     Custom backup filename or path.

  backup import     Import a backup bundle. Destructive — requires --yes.
                    --file <path>     Backup file to import. When omitted, imports the
                                      most recent cinatra-backup-*.tar.gz from data/backups/.
                    --yes             Required confirmation flag.

  backup export-api-configs
                    Export all connector_config:* metadata keys and openai_connection
                    to a JSON file. Safe to run on a live instance.
                    --file <path>     Custom filename or path (default: cinatra-api-configs-<timestamp>.json in data/).

  backup import-api-configs
                    Import API configs from a JSON file exported by export-api-configs.
                    Upserts each entry — safe to run on a fresh or existing instance.
                    --file <path>     JSON file to import (required or auto-discovers latest).
                    --yes             Required confirmation flag.

  reset dev         Reset the development environment. Requires --yes. Dev mode only.
                    Without --full (soft reset):
                      Drops auth tables, optionally purges app data, flushes Redis,
                      then runs setup to rebuild schemas and connections.
                    --full            Full reset, equivalent to a fresh repo clone:
                                      removes Docker volumes, node_modules, .pnpm-store,
                                      .next, generated/, then rebuilds Docker containers,
                                      installs dependencies, runs setup, and builds the
                                      OpenAI shell Docker image.
                    --rebuild-env     Regenerate .env.local with a fresh BETTER_AUTH_SECRET
                                      and docker-compose Postgres connection. Requires --full.
                    --backup          Create a backup before resetting.
                    --no-backup       Skip the pre-reset backup.
                    --purge-app-data  Purge workspace data (soft reset only).
                    --keep-app-data   Keep workspace data (soft reset only).
                    --file <path>     Custom backup filename (used with --backup).

  mcp llm-access setup     Provision OAuth clients for OpenAI, Anthropic, and Gemini
                            with restricted MCP permissions (dev only).
  mcp llm-access refresh   Rotate all LLM provider client secrets.
  mcp llm-access verify    Alias for \`cinatra doctor\` (below).

  doctor            READ-ONLY content-editor write-path self-check (the "done"
                    gate). Asserts PASS/FAIL/SKIP, per assertion: LLM MCP access
                    (creds AND public URL, one AND), a token-mint smoke, local +
                    public /api/mcp tools/list (incl. a CMS-write tool), WordPress
                    + Drupal container/plugin readiness, and dev-app clone
                    presence. Mutates nothing; never prints a token/secret. A
                    check that cannot prove itself because a dependency is down
                    (app, CMS container, public URL) is SKIPPED, never passed —
                    re-run after \`pnpm dev\` is up. This is the authoritative
                    post-boot gate. It also runs (non-fatal) at the tail of
                    \`cinatra setup dev\`.
                    --strict          Exit non-zero on any SKIP (default: only FAIL).

  agent export <id-or-name>
                    Export an agent template to a portable ZIP archive.
                    Accepts a template ID (UUID) or the exact agent name.
                    --file <path>     Output filename (default: data/downloads/cinatra-agent-<slug>-<date>.zip).

  agent import <file.zip>
                    Import an agent template from a ZIP archive created by "agent export".
                    The agent is created in 'draft' status with a new ID.
                    --name <name>     Override the agent name on import.

  agents install [<name>[@<range>]] [options]
                    Resolve and install an agent package tree from Verdaccio.
                    Writes ./cinatra-agents.lock; per-package install delegates
                    to the shared installAgentFromPackage helper (no local fs
                    extraction, no global npm required).
                    --manifest <path>       Read root from a manifest file.
                    --lockfile <path>       Lockfile path (default ./cinatra-agents.lock).
                    --lockfile-only         Write lockfile, skip install side-effects.
                    --dry-run               Print resolved tree; write nothing.
                    --registry-url <url>    Verdaccio registry URL override.
                    --registry-token <tok>  Verdaccio token override.
`);
}

async function promptYesNo(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `${question} Unable to prompt in a non-interactive session. ` +
        `Re-run with --purge-app-data or --keep-app-data.`,
    );
  }

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      const answer = (await readline.question(`${question} [y/N] `)).trim().toLowerCase();
      if (answer === "y" || answer === "yes") {
        return true;
      }
      if (answer === "" || answer === "n" || answer === "no") {
        return false;
      }
    }
  } finally {
    readline.close();
  }
}

function parseEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return {};
  }

  const raw = readFileSync(filePath, "utf8");
  const env = {};

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    env[key] = value;
  }

  return env;
}

function normalizeRuntimeMode(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "production" || normalized === "prod" ? "production" : "development";
}

function normalizeOptionalUrl(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    if (!["http:", "https:"].includes(url.protocol)) {
      return null;
    }
    // Origin-only — getPublicMcpServerUrl() appends /api/mcp on read, so a
    // stored URL with a path would yield e.g. https://h/api/mcp/api/mcp.
    if (url.pathname !== "/" && url.pathname !== "") {
      return null;
    }
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

function getRepoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

function buildTimestampLabel() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sanitizeBackupFilename(value) {
  // Collapse runs of disallowed chars to a single "-", then strip leading/
  // trailing dashes via a LINEAR char-index trim. The previous `/^-+|-+$/g`
  // is an anchored greedy repetition that is polynomial-ReDoS on all-dash
  // input (CodeQL js/polynomial-redos, high) — pre-existing, surfaced here by
  // line-shift; remediated in place. Behavior is unchanged: collapse, then
  // trim only leading/trailing dashes (interior dashes preserved).
  const collapsed = String(value).trim().replace(/[^a-z0-9._-]+/gi, "-");
  let start = 0;
  let end = collapsed.length;
  while (start < end && collapsed.charCodeAt(start) === 45) start++; // 45 = "-"
  while (end > start && collapsed.charCodeAt(end - 1) === 45) end--;
  return collapsed.slice(start, end) || `cinatra-backup-${buildTimestampLabel()}${DEFAULT_BACKUP_EXTENSION}`;
}

function normalizeBackupFilename(value) {
  const sanitized = sanitizeBackupFilename(value);
  const lower = sanitized.toLowerCase();

  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz") || lower.endsWith(".sql")) {
    return sanitized;
  }

  return `${sanitized}${DEFAULT_BACKUP_EXTENSION}`;
}

function defaultBackupFilePath(repoRoot) {
  return path.join(repoRoot, DEFAULT_BACKUP_DIRECTORY, `cinatra-backup-${buildTimestampLabel()}${DEFAULT_BACKUP_EXTENSION}`);
}

function resolveBackupFilePath(repoRoot, value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return defaultBackupFilePath(repoRoot);
  }

  if (path.isAbsolute(trimmed)) {
    return trimmed;
  }

  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return path.resolve(repoRoot, trimmed);
  }

  return path.join(repoRoot, DEFAULT_BACKUP_DIRECTORY, normalizeBackupFilename(trimmed));
}

function readOptionValue(argv, flag) {
  // `--flag=value` form. Checked first so it is never silently ignored —
  // Without this form, a destructive `clone prune --slug=target --yes`
  // can fall through to the positional / current-branch slug and drop
  // the WRONG clone.
  const eqPrefix = `${flag}=`;
  const eqArg = argv.find((a) => typeof a === "string" && a.startsWith(eqPrefix));
  if (eqArg !== undefined) {
    const value = eqArg.slice(eqPrefix.length);
    if (!value) {
      throw new Error(`Missing value for ${flag}.`);
    }
    return value;
  }

  const index = argv.indexOf(flag);
  if (index === -1) {
    return null;
  }

  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`);
  }

  return value;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function requiredEnv(env, key) {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing ${key}. Configure it in the environment or .env.local before running the CLI.`);
  }
  return value;
}

function collectEnvironment(repoRoot) {
  const envPath = path.join(repoRoot, ".env.local");
  const fileEnv = parseEnvFile(envPath);

  return {
    ...fileEnv,
    ...process.env,
  };
}

function readConfiguredRuntimeMode(env) {
  for (const key of APP_RUNTIME_MODE_ENV_KEYS) {
    if (typeof env[key] === "string" && env[key].trim().length > 0) {
      return normalizeRuntimeMode(env[key]);
    }
  }

  return "development";
}

function createClient(connectionString) {
  return new Client({
    connectionString,
  });
}

function runCommandOrThrow(command, args, fallbackError, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(fallbackError);
  }
}

function commandExists(command, args = ["--version"]) {
  const result = spawnSync(command, args, {
    stdio: "ignore",
    env: process.env,
  });

  return result.status === 0;
}

function createTempDirectory(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removePathIfExists(targetPath) {
  rmSync(targetPath, { recursive: true, force: true });
}

function waitForService(repoRoot, service, readyCommand, readyArgs, label, maxAttempts = 30) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const result = spawnSync("docker", ["compose", "exec", "-T", service, ...readyCommand, ...readyArgs], {
      stdio: "ignore",
      cwd: repoRoot,
    });
    if (result.status === 0) {
      return;
    }
    spawnSync("sleep", ["1"]);
  }
  throw new Error(`${label} did not become ready within ${maxAttempts} seconds.`);
}

function waitForPostgres(repoRoot) {
  waitForService(repoRoot, "postgres", ["pg_isready", "-U", "postgres"], [], "Postgres");
}

function waitForRedis(repoRoot) {
  waitForService(repoRoot, "redis", ["redis-cli", "ping"], [], "Redis");
}

function waitForNango(repoRoot, maxAttempts = 60) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = spawnSync("curl", ["-sf", "http://127.0.0.1:3003/health"], {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
      });
      if (response.status === 0) {
        return;
      }
    } catch {
      // ignore
    }
    spawnSync("sleep", ["2"]);
  }
  throw new Error(`Nango server did not become ready within ${maxAttempts * 2} seconds.`);
}

function flushRedis(repoRoot) {
  const result = spawnSync("docker", ["compose", "exec", "-T", "redis", "redis-cli", "FLUSHALL"], {
    stdio: "inherit",
    cwd: repoRoot,
  });
  if (result.status !== 0) {
    console.log("Warning: Could not flush Redis. Is the Redis container running?");
  }
}

function cleanBuildArtifacts(repoRoot) {
  for (const dir of [".next", "generated"]) {
    const fullPath = path.join(repoRoot, dir);
    if (existsSync(fullPath)) {
      rmSync(fullPath, { recursive: true, force: true });
      console.log(`  Removed ${dir}/`);
    }
  }
}

function reinstallDependencies(repoRoot) {
  const script = `rm -rf node_modules .pnpm-store && echo "  Removed node_modules/ and .pnpm-store/" && pnpm install`;
  const result = spawnSync("sh", ["-c", script], {
    stdio: "inherit",
    cwd: repoRoot,
  });
  if (result.status !== 0) {
    throw new Error("Failed to reinstall dependencies.");
  }
}

// Discover a shell-runtime build context from the extensions tree WITHOUT
// hardcoding a specific extension instance (IoC: core resolves capabilities from
// what is installed, not by name). Any extension that ships a runtime/Dockerfile
// provides the sandbox image. Returns the first match's context dir, or null.
function findExtensionShellRuntimeContext(repoRoot) {
  const extRoot = path.join(repoRoot, "extensions");
  if (!existsSync(extRoot)) return null;
  for (const scope of readdirSync(extRoot, { withFileTypes: true })) {
    if (!scope.isDirectory()) continue;
    const scopeDir = path.join(extRoot, scope.name);
    for (const pkg of readdirSync(scopeDir, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      const ctx = path.join(scopeDir, pkg.name, "runtime");
      if (existsSync(path.join(ctx, "Dockerfile"))) return ctx;
    }
  }
  return null;
}

function buildOpenAiShellImage(repoRoot) {
  // Build the shell sandbox image from whichever extension ships a
  // runtime/Dockerfile (today the OpenAI connector). Skip (don't throw) when none
  // is present so a full reset never hard-fails on a missing build context.
  const runtimeContext = findExtensionShellRuntimeContext(repoRoot);
  if (!runtimeContext) {
    console.warn(
      "  Skipping OpenAI shell Docker image: no extension ships a runtime/Dockerfile yet (OpenAI shell tool unavailable until the runtime Dockerfile is restored to the OpenAI connector).",
    );
    return;
  }
  runCommandOrThrow(
    "docker",
    ["build", "-t", "cinatra/skill-shell:latest", runtimeContext],
    "Failed to build the OpenAI shell Docker image.",
    { cwd: repoRoot },
  );
}

function rebuildEnvLocal(repoRoot) {
  const secret = randomBytes(32).toString("hex");

  const lines = [
    "# Generated by: cinatra reset dev --full --rebuild-env",
    `# Date: ${new Date().toISOString()}`,
    "",
    "BETTER_AUTH_URL=http://localhost:3000",
    "NEXT_PUBLIC_BETTER_AUTH_URL=http://localhost:3000",
    `BETTER_AUTH_SECRET=${secret}`,
    "CINATRA_RUNTIME_MODE=development",
    "",
    "SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:5434/postgres",
    "",
    "NANGO_SERVER_URL=http://localhost:3003",
    "NANGO_DATABASE_URL=postgresql://nango:nango@127.0.0.1:5435/nango",
    "",
    "# Graphiti (Objects Layer). Matches docker-compose port 8000.",
    "GRAPHITI_URL=http://localhost:8000",
    "",
  ];

  const envPath = path.join(repoRoot, ".env.local");
  writeFileSync(envPath, lines.join("\n") + "\n");

  console.log("  .env.local rebuilt.");

  return envPath;
}

function isLegacySqlBackupPath(filePath) {
  return filePath.toLowerCase().endsWith(".sql");
}

function isArchiveBackupPath(filePath) {
  const lower = filePath.toLowerCase();
  return lower.endsWith(".tar.gz") || lower.endsWith(".tgz");
}

function getNangoDatabaseUrl(env) {
  const candidates = [
    env.NANGO_DATABASE_URL,
    env.NANGO_DB_URL,
  ];

  for (const candidate of candidates) {
    const value = String(candidate ?? "").trim();
    if (value) {
      return value;
    }
  }

  return DEFAULT_LOCAL_NANGO_DB_URL;
}

function readEnvFileIfPresent(filePath) {
  return existsSync(filePath) ? parseEnvFile(filePath) : {};
}

function normalizeUrlOrNull(value) {
  return normalizeOptionalUrl(value);
}

async function discoverBootstrapNangoSettings(env, runtimeMode) {
  const explicitSecretKey = String(env.NANGO_SECRET_KEY ?? "").trim();
  const explicitServerUrl = normalizeUrlOrNull(env.NANGO_SERVER_URL);

  // If both the secret key and server URL are explicitly set, use them directly.
  if (explicitSecretKey && explicitServerUrl) {
    return {
      secretKey: explicitSecretKey,
      serverUrl: explicitServerUrl,
      source: "environment",
    };
  }

  // Resolve server URL from env, local Nango .env, or default.
  const localEnv = readEnvFileIfPresent("/tmp/nango/.env");
  const serverUrl =
    explicitServerUrl ??
    normalizeUrlOrNull(localEnv.NANGO_SERVER_URL) ??
    normalizeUrlOrNull(localEnv.NANGO_PUBLIC_SERVER_URL) ??
    normalizeUrlOrNull("http://localhost:3003");

  // If the secret key is explicitly set, use it with the resolved server URL.
  if (explicitSecretKey) {
    return {
      secretKey: explicitSecretKey,
      serverUrl,
      source: "environment",
    };
  }

  // Try to discover the secret key from the Nango database.
  const nangoDatabaseUrl = getNangoDatabaseUrl(env);
  if (!nangoDatabaseUrl) {
    return {
      secretKey: null,
      serverUrl,
      source: serverUrl ? "local-env" : "none",
    };
  }

  const client = createClient(nangoDatabaseUrl);

  try {
    await client.connect();
    const environmentName = runtimeMode === "production" ? "prod" : "dev";
    const result = await client.query(
      `
        select secret_key, name
        from nango._nango_environments
        where deleted = false
          and name = $1
        order by account_id asc, id asc
        limit 1
      `,
      [environmentName],
    );

    const secretKey = typeof result.rows[0]?.secret_key === "string" ? result.rows[0].secret_key.trim() : "";

    return {
      secretKey: secretKey || null,
      serverUrl,
      source: secretKey ? "local-nango-db" : serverUrl ? "local-env" : "none",
    };
  } catch {
    return {
      secretKey: null,
      serverUrl,
      source: serverUrl ? "local-env" : "none",
    };
  } finally {
    await client.end().catch(() => null);
  }
}

function getPostgresClientImage(env) {
  const configured = String(env.CINATRA_POSTGRES_CLIENT_IMAGE ?? "").trim();
  return configured || DEFAULT_POSTGRES_CLIENT_IMAGE;
}

function rewriteConnectionStringForDocker(connectionString) {
  try {
    const parsed = new URL(connectionString);

    if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") {
      parsed.hostname = process.platform === "linux" ? "127.0.0.1" : "host.docker.internal";
    }

    return parsed.toString();
  } catch {
    return connectionString;
  }
}

// Rewrite a Postgres connection string to point at a different database on the
// SAME server. Used by the clone commands:
//   - `adminConnString(url)` → forces the db path to `/postgres` (the
//     maintenance DB) so CREATE/DROP/ALTER DATABASE never run while connected
//     to the database being mutated.
//   - `connStringForDatabase(url, name)` → arbitrary db (e.g. `/cinatra_seed`).
// Throws on an unparseable URL — the clone commands cannot proceed safely
// without a known-good connection string.
function connStringForDatabase(connectionString, databaseName) {
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error(
      `Could not parse SUPABASE_DB_URL as a connection URL. Clone commands require a ` +
        `postgresql:// URL so they can target a specific database.`,
    );
  }
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function adminConnString(connectionString) {
  return connStringForDatabase(connectionString, "postgres");
}

function runPostgresCommand(repoRoot, env, executable, args, fallbackError, options = {}) {
  if (commandExists(executable)) {
    runCommandOrThrow(executable, args, fallbackError, options);
    return;
  }

  if (!commandExists("docker")) {
    throw new Error(
      `${fallbackError} Neither ${executable} nor Docker is available. Install the Postgres CLI tools or make Docker available.`,
    );
  }

  const image = getPostgresClientImage(env);
  const dockerArgs = ["run", "--rm"];
  const patchedArgs = [...args];
  let mountDirectory = null;

  for (let index = 0; index < patchedArgs.length; index += 1) {
    const value = patchedArgs[index];

    if (value.startsWith("--file=")) {
      const absolutePath = path.resolve(options.cwd ?? repoRoot, value.slice("--file=".length));
      mountDirectory = path.dirname(absolutePath);
      patchedArgs[index] = `--file=/workspace/${path.basename(absolutePath)}`;
      continue;
    }

    if (value === "-f" && typeof patchedArgs[index + 1] === "string") {
      const absolutePath = path.resolve(options.cwd ?? repoRoot, patchedArgs[index + 1]);
      mountDirectory = path.dirname(absolutePath);
      patchedArgs[index + 1] = `/workspace/${path.basename(absolutePath)}`;
      index += 1;
      continue;
    }

    if (value.startsWith("postgresql://") || value.startsWith("postgres://")) {
      patchedArgs[index] = rewriteConnectionStringForDocker(value);
    }
  }

  if (mountDirectory) {
    dockerArgs.push("-v", `${mountDirectory}:/workspace`);
  }

  if (process.platform === "linux") {
    dockerArgs.push("--network", "host");
  }

  dockerArgs.push(image, executable, ...patchedArgs);
  runCommandOrThrow("docker", dockerArgs, fallbackError, { cwd: repoRoot });
}

async function readAuthTableState(client) {
  const result = await client.query(
    `
      select tablename
      from pg_tables
      where schemaname = 'public'
        and tablename = any($1::text[])
    `,
    [AUTH_TABLES],
  );

  const present = new Set(result.rows.map((row) => String(row.tablename)));
  const missing = AUTH_TABLES.filter((tableName) => !present.has(tableName));

  return {
    present: AUTH_TABLES.filter((tableName) => present.has(tableName)),
    missing,
  };
}

async function readUserCount(client) {
  const tableState = await readAuthTableState(client);
  if (!tableState.present.includes("user")) {
    return 0;
  }

  const result = await client.query(`select count(*)::text as count from public."user"`);
  return Number(result.rows[0]?.count ?? "0");
}

// DB-derived JWKS health for `gatherStatus` / `cinatra status`. This is a
// PRESENCE read only — it does NOT mint a token (status is a no-network read),
// so it cannot prove decryptability. The authoritative decrypt probe + self-
// heal lives in `ensureDecryptableJwks` (runSetup, dev). Returns the key count
// (or null when the jwks table is absent — fresh/unmigrated schema).
async function readJwksRowCount(client) {
  const tableState = await readAuthTableState(client);
  if (!tableState.present.includes("jwks")) {
    return null;
  }
  const result = await client.query(`select count(*)::text as count from public."jwks"`);
  return Number(result.rows[0]?.count ?? "0");
}

async function ensureStoreSchema(client, schemaName) {
  await client.query(`create schema if not exists ${quoteIdentifier(schemaName)}`);

  for (const tableName of STORE_TABLES) {
    const pkColumn = tableName === "metadata" ? "key" : "id";
    const definition =
      tableName === "metadata"
        ? "(key text primary key, value text not null)"
        : "(id text primary key, payload text not null)";
    await client.query(
      `create table if not exists ${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)} ${definition}`,
    );

    // Ensure the primary key exists (may be missing from legacy backup imports).
    const pkCheck = await client.query(
      `
        select 1 from information_schema.table_constraints
        where table_schema = $1 and table_name = $2 and constraint_type = 'PRIMARY KEY'
        limit 1
      `,
      [schemaName, tableName],
    );
    if (pkCheck.rows.length === 0) {
      await client.query(
        `alter table ${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)} add primary key (${quoteIdentifier(pkColumn)})`,
      );
    }
  }

  await ensureRichSchemas(client, schemaName);
}

// Creates RICH_TABLES with their full column definitions on a fresh DB, and
// idempotently adds any columns/indexes added in newer cinatra versions to
// existing DBs. Without this step, demos and prods initialized at an older
// version stay schema-drifted and the app blows up at runtime with 42703
// (column does not exist) — which on a server action surfaces as
// "An unexpected response was received from the server."
async function ensureRichSchemas(client, schemaName) {
  const qualifiedSchema = quoteIdentifier(schemaName);
  for (const table of RICH_TABLES) {
    const qualifiedTable = `${qualifiedSchema}.${quoteIdentifier(table.name)}`;
    await client.query(`create table if not exists ${qualifiedTable} ${table.create}`);
    for (const [column, definition] of Object.entries(table.columns ?? {})) {
      await client.query(
        `alter table ${qualifiedTable} add column if not exists ${quoteIdentifier(column)} ${definition}`,
      );
    }
    for (const index of table.indexes ?? []) {
      await client.query(
        `create unique index if not exists ${quoteIdentifier(index.name)} on ${qualifiedTable} ${index.sql}`,
      );
    }
  }
}

async function readMetadataValue(client, schemaName, key, fallback) {
  const result = await client.query(
    `select value from ${quoteIdentifier(schemaName)}.metadata where key = $1 limit 1`,
    [key],
  );
  const raw = result.rows[0]?.value;

  if (!raw) {
    return fallback;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeMetadataValue(client, schemaName, key, value) {
  await client.query(
    `
      insert into ${quoteIdentifier(schemaName)}.metadata (key, value)
      values ($1, $2)
      on conflict (key) do update
      set value = excluded.value
    `,
    [key, JSON.stringify(value)],
  );
}

function isLocalhostUrl(url) {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

async function ensureMcpSettings(client, schemaName, publicBaseUrl, options = {}) {
  const current = await readMetadataValue(client, schemaName, MCP_SETTINGS_KEY, {});
  const currentPublicBaseUrl = normalizeOptionalUrl(current?.publicBaseUrl);
  // Preserve any existing operator-supplied URL across a setup re-run. The only
  // dead source is "cli" (the retired cloudflared quick tunnel — that process
  // no longer runs); every other source ("manual" from the dev tab, plus
  // legacy "external" / "tailscale-funnel" / similar operator-managed rows) is
  // a live URL and must NOT be clobbered by a setup re-run.
  //
  // cinatra#260 Step 3 — OWNERSHIP-GATED preserve. When the later
  // `ensureDevPublicMcpUrl` step is the authority for the auto-provisioned
  // dev-main Funnel (dev mode + no operator URL), the "preserve existing"
  // branch must NOT carry forward an auto-provisioned URL whose liveness has
  // not yet been re-validated — a dead `tailscale-auto`/`tailscale-funnel`
  // hostname would otherwise survive the re-run. Those sources are released
  // here; the Step-3 helper re-validates by source/ownership and rewrites or
  // replaces. Operator-managed ("manual") + legacy sources still carry forward.
  const autoProvisionedSource =
    current?.publicBaseUrlSource === "tailscale-auto" ||
    current?.publicBaseUrlSource === "tailscale-funnel";
  const releaseForOwnershipReValidation =
    options.ownershipGated === true && autoProvisionedSource;
  const currentIsUsable =
    current?.publicBaseUrlSource !== "cli" &&
    !releaseForOwnershipReValidation &&
    Boolean(currentPublicBaseUrl);
  // Never auto-promote a localhost URL to "manual" — `publicBaseUrl` falls
  // back to BETTER_AUTH_URL which defaults to http://localhost:3000. Marking
  // localhost as the public MCP URL would point hosted LLM MCP clients at
  // 127.0.0.1, where they can never reach Cinatra.
  const incomingIsUsable = publicBaseUrl && !isLocalhostUrl(publicBaseUrl);
  const nextPublicBaseUrl = currentIsUsable
    ? currentPublicBaseUrl
    : incomingIsUsable
      ? publicBaseUrl
      : null;

  return {
    current,
    next: {
      publicBaseUrl: nextPublicBaseUrl,
      publicBaseUrlSource: nextPublicBaseUrl ? "manual" : "unknown",
      selfClient: current?.selfClient ?? null,
      updatedAt: new Date().toISOString(),
    },
  };
}

async function ensureNangoSettings(client, schemaName, input) {
  const current = await readMetadataValue(client, schemaName, NANGO_SETTINGS_KEY, {});
  const nextSecretKey =
    typeof input?.secretKey === "string" && input.secretKey.trim().length > 0
      ? input.secretKey.trim()
      : typeof current?.secretKey === "string" && current.secretKey.trim().length > 0
        ? current.secretKey.trim()
        : undefined;
  const nextServerUrl =
    normalizeUrlOrNull(input?.serverUrl) ??
    normalizeUrlOrNull(current?.serverUrl) ??
    undefined;

  if (!nextSecretKey && !nextServerUrl) {
    return {
      configured: false,
      source: input?.source ?? "none",
      administration: current,
    };
  }

  const next = {
    ...current,
    ...(nextSecretKey ? { secretKey: nextSecretKey } : {}),
    ...(nextServerUrl ? { serverUrl: nextServerUrl } : {}),
  };

  await writeMetadataValue(client, schemaName, NANGO_SETTINGS_KEY, next);

  return {
    configured: Boolean(next.secretKey || next.serverUrl),
    source: input?.source ?? "unknown",
    administration: next,
  };
}

function createClientSecret() {
  return randomBytes(24).toString("base64url");
}

// Better Auth's EXACT client-secret hash recipe (SHA-256, base64url). MUST stay
// byte-identical to the `clientSecretHashed` derivation in the oauthClient
// upserts below — the verify-before-reuse check (hashClientSecret(plaintext) ===
// row.clientSecret) compares against the SAME function the writer used, so a
// hash-recipe drift can never cause a false rotation.
function hashClientSecret(plaintext) {
  return createHash("sha256").update(plaintext, "utf8").digest("base64url");
}

// Normalize a stored jsonb array column (grantTypes / scopes) that pg may hand
// back as a parsed array OR (when stored as a json string) a string. Used by
// the verify-before-reuse checks so a metadata/row drift in either shape is
// compared apples-to-apples.
function asStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((v) => String(v));
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function sameUnorderedStringSet(a, b) {
  const sa = asStringArray(a);
  const sb = asStringArray(b);
  if (sa.length !== sb.length) return false;
  const setA = new Set(sa);
  return sb.every((v) => setA.has(v));
}

function sameExactStringArray(a, b) {
  const sa = asStringArray(a);
  const sb = asStringArray(b);
  if (sa.length !== sb.length) return false;
  return sa.every((v, i) => v === sb[i]);
}

/**
 * Verify-before-reuse predicate for a managed `client_credentials` OAuth client.
 *
 * Reuse the stored plaintext secret ONLY when ALL hold:
 *   - a `clientSecret` plaintext is present in metadata
 *   - the oauthClient row exists
 *   - hashClientSecret(plaintext) === row.clientSecret (Better Auth's exact
 *     recipe — same fn the writer uses, so no false rotation)
 *   - grantTypes === ["client_credentials"] (exact)
 *   - scopes match the expected set (unordered)
 *   - disabled === false
 *
 * Returns a boolean only; never logs/echoes the secret. The caller mints fresh
 * and rewrites BOTH halves (metadata plaintext + hashed row) in a transaction
 * when this returns false.
 *
 * @param {object} args
 * @param {string|null} args.plaintext           stored plaintext secret (metadata)
 * @param {object|undefined} args.row            oauthClient row { clientSecret, grantTypes, scopes, disabled }
 * @param {string[]} args.expectedScopes         the scopes this managed client must carry
 */
function canReuseClientCredentials({ plaintext, row, expectedScopes }) {
  if (typeof plaintext !== "string" || plaintext.length === 0) return false;
  if (!row) return false;
  if (typeof row.clientSecret !== "string" || row.clientSecret.length === 0) return false;
  if (hashClientSecret(plaintext) !== row.clientSecret) return false;
  if (!sameExactStringArray(row.grantTypes, ["client_credentials"])) return false;
  if (!sameUnorderedStringSet(row.scopes, expectedScopes)) return false;
  // `disabled` is a boolean column; treat any non-false value as disabled.
  if (row.disabled !== false) return false;
  return true;
}

async function ensureSelfMcpClient(client, schemaName, mcpSettings) {
  const existingClientResult = await client.query(
    `
      select "id", "clientSecret", "createdAt", "grantTypes", "scopes", "disabled"
      from public."oauthClient"
      where "clientId" = $1
      limit 1
    `,
    [SELF_MCP_CLIENT_ID],
  );

  const existingClient = existingClientResult.rows[0];
  // Read plaintext from metadata only — oauthClient stores hashed secrets (SHA-256 base64url),
  // so storedSecret from oauthClient cannot be reused as a plaintext secret.
  const configuredSecret =
    typeof mcpSettings.current?.selfClient?.clientSecret === "string" && mcpSettings.current.selfClient.clientSecret.length > 0
      ? mcpSettings.current.selfClient.clientSecret
      : null;
  // Verify-before-reuse: keep the stored plaintext ONLY when the metadata half
  // and the oauthClient row still agree (same secret hash + grant/scope/enabled
  // shape). Any drift between the two tables → mint fresh and rewrite both
  // halves in one transaction so they can never diverge again.
  const reuseSelfSecret = canReuseClientCredentials({
    plaintext: configuredSecret,
    row: existingClient,
    expectedScopes: SELF_MCP_CLIENT_SCOPES,
  });
  const clientSecret = reuseSelfSecret ? configuredSecret : createClientSecret();
  // Hash the secret before storing in oauthClient (Better Auth uses SHA-256 base64url).
  const clientSecretHashed = hashClientSecret(clientSecret);
  const now = new Date();
  const createdAt = existingClient?.createdAt instanceof Date ? existingClient.createdAt : now;
  const metadata = {
    managedBy: "cinatra-cli",
    purpose: "self-mcp-access",
  };

  const nextSettings = {
    ...mcpSettings.next,
    selfClient: {
      clientId: SELF_MCP_CLIENT_ID,
      clientSecret,
      clientName: SELF_MCP_CLIENT_NAME,
      scope: SELF_MCP_CLIENT_SCOPE,
      tokenEndpointAuthMethod: "client_secret_basic",
      grantTypes: ["client_credentials"],
      createdAt: createdAt.toISOString(),
      updatedAt: now.toISOString(),
      managedBy: "cli",
    },
    updatedAt: now.toISOString(),
  };

  // Write all three statements (legacy-row cleanup + hashed oauthClient row +
  // plaintext metadata) in ONE transaction so the two tables can never diverge:
  // the stale-row DELETE must roll back alongside the upsert/metadata write, or
  // a later failure could leave metadata pointing at a row already deleted.
  await client.query("begin");
  try {
    // Drop legacy/stale self-client rows that point at the old clientId / name
    // but are NOT the canonical self client we are about to (re)write.
    await client.query(
      `
        delete from public."oauthClient"
        where "clientId" <> $1
          and (
            "referenceId" = 'cinatra-app'
            or "name" = $2
            or "clientId" = $3
          )
      `,
      [SELF_MCP_CLIENT_ID, SELF_MCP_CLIENT_NAME, mcpSettings.current?.selfClient?.clientId ?? ""],
    );

    await client.query(
      `
        insert into public."oauthClient" (
          "id",
          "clientId",
          "clientSecret",
          "disabled",
          "skipConsent",
          "enableEndSession",
          "subjectType",
          "scopes",
          "userId",
          "createdAt",
          "updatedAt",
          "name",
          "redirectUris",
          "postLogoutRedirectUris",
          "tokenEndpointAuthMethod",
          "grantTypes",
          "responseTypes",
          "public",
          "type",
          "requirePKCE",
          "referenceId",
          "metadata"
        )
        values (
          $1,
          $2,
          $3,
          false,
          true,
          false,
          'public',
          $4::jsonb,
          null,
          $5,
          $6,
          $7,
          $8::jsonb,
          $9::jsonb,
          $10,
          $11::jsonb,
          $12::jsonb,
          false,
          'web',
          false,
          'cinatra-app',
          $13::jsonb
        )
        on conflict ("clientId") do update
        set
          "clientSecret" = excluded."clientSecret",
          "disabled" = excluded."disabled",
          "skipConsent" = excluded."skipConsent",
          "enableEndSession" = excluded."enableEndSession",
          "subjectType" = excluded."subjectType",
          "scopes" = excluded."scopes",
          "updatedAt" = excluded."updatedAt",
          "name" = excluded."name",
          "redirectUris" = excluded."redirectUris",
          "postLogoutRedirectUris" = excluded."postLogoutRedirectUris",
          "tokenEndpointAuthMethod" = excluded."tokenEndpointAuthMethod",
          "grantTypes" = excluded."grantTypes",
          "responseTypes" = excluded."responseTypes",
          "public" = excluded."public",
          "type" = excluded."type",
          "requirePKCE" = excluded."requirePKCE",
          "referenceId" = excluded."referenceId",
          "metadata" = excluded."metadata"
      `,
      [
        existingClient?.id ?? randomUUID(),
        SELF_MCP_CLIENT_ID,
        clientSecretHashed,
        JSON.stringify(SELF_MCP_CLIENT_SCOPES),
        createdAt,
        now,
        SELF_MCP_CLIENT_NAME,
        JSON.stringify([]),
        JSON.stringify([]),
        "client_secret_basic",
        JSON.stringify(["client_credentials"]),
        JSON.stringify([]),
        JSON.stringify(metadata),
      ],
    );

    await writeMetadataValue(client, schemaName, MCP_SETTINGS_KEY, nextSettings);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  }

  return nextSettings.selfClient;
}

// ---------------------------------------------------------------------------
// LLM MCP access — pre-configured OAuth clients for LLM providers (dev only)
// ---------------------------------------------------------------------------

const LLM_MCP_SETTINGS_KEY = "connector_config:llm_mcp_access";

const LLM_MCP_PROVIDERS = [
  { id: "openai", clientId: "cinatra-llm-openai", name: "Cinatra LLM (OpenAI)" },
  { id: "anthropic", clientId: "cinatra-llm-anthropic", name: "Cinatra LLM (Anthropic)" },
  { id: "gemini", clientId: "cinatra-llm-gemini", name: "Cinatra LLM (Gemini)" },
];

// Scopes for LLM provider MCP access. Deliberately narrower than the self-client.
const LLM_MCP_CLIENT_SCOPES = ["mcp:connect"];
const LLM_MCP_CLIENT_SCOPE = LLM_MCP_CLIENT_SCOPES.join(" ");

// MCP primitives that LLMs are explicitly blocked from calling.
// These protect auth, settings, permissions, background jobs, and system internals.
const LLM_MCP_BLOCKED_TOOL_PATTERNS = [
  "permissions.",       // org admin operations — role changes, member removal
  ".system.",           // system-level internals
  ".jobs.",             // background job runners
  "process_due",        // scheduled follow-up processors
  "apollo.jobs.",       // Apollo background jobs
];

/**
 * Provision (or refresh) OAuth clients for each LLM provider so they can
 * access the Cinatra MCP server. Each provider gets its own client with
 * restricted scopes and an explicit tool blocklist stored in metadata.
 *
 * Dev-only: this function is a no-op in production.
 */
async function ensureLlmMcpAccess(client, schemaName, mcpSettings, mode) {
  if (mode === "prod") {
    return null;
  }

  const existing = await readMetadataValue(client, schemaName, LLM_MCP_SETTINGS_KEY, {});
  const now = new Date();
  const providers = {};

  // Write BOTH halves (every provider's hashed oauthClient row + the plaintext
  // metadata index) in ONE transaction so the two tables can never diverge — a
  // partial write that rewrote a row but not the metadata (or vice versa) is
  // exactly the two-table drift this guards.
  await client.query("begin");
  try {
    for (const provider of LLM_MCP_PROVIDERS) {
      const existingProvider = existing?.providers?.[provider.id];
      const existingSecret =
        typeof existingProvider?.clientSecret === "string" && existingProvider.clientSecret.length > 0
          ? existingProvider.clientSecret
          : null;

      // Look up existing OAuth client row (widened for verify-before-reuse).
      const existingClientResult = await client.query(
        `select "id", "createdAt", "clientSecret", "grantTypes", "scopes", "disabled" from public."oauthClient" where "clientId" = $1 limit 1`,
        [provider.clientId],
      );
      const existingRow = existingClientResult.rows[0];

      // Verify-before-reuse: keep the stored plaintext ONLY when the metadata
      // half and the oauthClient row still agree (same secret hash + grant/
      // scope/enabled shape). Any drift → mint fresh and rewrite both halves.
      const reuseSecret = canReuseClientCredentials({
        plaintext: existingSecret,
        row: existingRow,
        expectedScopes: LLM_MCP_CLIENT_SCOPES,
      });
      const clientSecret = reuseSecret ? existingSecret : createClientSecret();
      // Hash the secret before storing in oauthClient (Better Auth uses SHA-256 base64url).
      const clientSecretHashed = hashClientSecret(clientSecret);

      const createdAt = existingRow?.createdAt instanceof Date ? existingRow.createdAt : now;
      const metadata = {
        managedBy: "cinatra-cli",
        purpose: "llm-mcp-access",
        provider: provider.id,
        blockedToolPatterns: LLM_MCP_BLOCKED_TOOL_PATTERNS,
      };

      await client.query(
        `
          insert into public."oauthClient" (
            "id", "clientId", "clientSecret", "disabled", "skipConsent", "enableEndSession",
            "subjectType", "scopes", "userId", "createdAt", "updatedAt", "name",
            "redirectUris", "postLogoutRedirectUris", "tokenEndpointAuthMethod",
            "grantTypes", "responseTypes", "public", "type", "requirePKCE",
            "referenceId", "metadata"
          )
          values (
            $1, $2, $3, false, true, false, 'public', $4::jsonb, null, $5, $6, $7,
            $8::jsonb, $9::jsonb, $10, $11::jsonb, $12::jsonb, false, 'web', false,
            $13, $14::jsonb
          )
          on conflict ("clientId") do update
          set
            "clientSecret" = excluded."clientSecret",
            "disabled" = excluded."disabled",
            "skipConsent" = excluded."skipConsent",
            "scopes" = excluded."scopes",
            "updatedAt" = excluded."updatedAt",
            "name" = excluded."name",
            "tokenEndpointAuthMethod" = excluded."tokenEndpointAuthMethod",
            "grantTypes" = excluded."grantTypes",
            "referenceId" = excluded."referenceId",
            "metadata" = excluded."metadata"
        `,
        [
          existingRow?.id ?? randomUUID(),
          provider.clientId,
          clientSecretHashed,
          JSON.stringify(LLM_MCP_CLIENT_SCOPES),
          createdAt,
          now,
          provider.name,
          JSON.stringify([]),
          JSON.stringify([]),
          "client_secret_basic",
          JSON.stringify(["client_credentials"]),
          JSON.stringify([]),
          `cinatra-llm-${provider.id}`,
          JSON.stringify(metadata),
        ],
      );

      providers[provider.id] = {
        clientId: provider.clientId,
        clientSecret,
        clientName: provider.name,
        scope: LLM_MCP_CLIENT_SCOPE,
        blockedToolPatterns: LLM_MCP_BLOCKED_TOOL_PATTERNS,
        createdAt: createdAt.toISOString(),
        updatedAt: now.toISOString(),
      };
    }

    const settings = {
      providers,
      updatedAt: now.toISOString(),
    };

    await writeMetadataValue(client, schemaName, LLM_MCP_SETTINGS_KEY, settings);
    await client.query("commit");
    return settings;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Self-healing decryptable JWKS (dev only) — cinatra#260 Step 1
// ---------------------------------------------------------------------------
//
// Better Auth encrypts each `public.jwks` private key with BETTER_AUTH_SECRET.
// If the secret rotated (or a stale row survived a reset) the key can no longer
// be decrypted, and EVERY `client_credentials` token mint fails with a 500 whose
// body carries the exact Better Auth message "Failed to decrypt private key".
// Because Better Auth's `signJWT` only ever reads the LATEST key
// (`getLatestKey` sorts createdAt DESC and takes [0]) and lazily regenerates via
// `createJwk` when no usable key exists, deleting the proven-bad latest row lets
// the next mint regenerate a fresh key under the ACTIVE secret.
//
// This is a self-heal, not a re-derivation: we never touch Better Auth's
// symmetric crypto. The probe is the authoritative source of truth — one real
// token mint at the local OAuth token endpoint. The DELETE fires ONLY on the
// definite decrypt error; transient/connection/other-status outcomes never
// delete anything (loud-but-non-fatal). Dev-only by call site.

const JWKS_DECRYPT_ERROR_MARKER = "Failed to decrypt private key";

// Resolve the local origin the dev app serves on. Mirrors
// packages/mcp-server/src/llm-credentials.ts getLocalTokenEndpointUrl WITHOUT
// importing it (CLI must not pull server-only modules) — same precedence so the
// token issuer matches what the MCP server expects.
function resolveLocalOrigin(env) {
  const raw =
    env.BETTER_AUTH_URL ??
    env.NEXT_PUBLIC_BETTER_AUTH_URL ??
    "http://localhost:3000";
  // strip trailing slashes via a LINEAR char-index trim — an anchored greedy
  // slash-repetition (`/\/+$/`) is polynomial-ReDoS on many trailing slashes
  // (CodeQL js/polynomial-redos, high).
  const s = String(raw).trim();
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) end--; // 47 = "/"
  return s.slice(0, end);
}

// Bounded timeout for the token-mint probe. A reachable-but-stalled token route
// must NOT hang `cinatra setup dev` — on timeout we classify "app-down" (the
// JWKS state is unknown, so we never heal/delete) and let setup continue.
const TOKEN_MINT_PROBE_TIMEOUT_MS = 5000;

// cinatra#260 Step 3 — finite safety bounds for the Docker steps invoked by
// the dev-tunnel auto-bring-up path (`cinatra setup dev` → ensureDevPublicMcpUrl
// → runDevTunnel("start")). These are NOT normal-case limits (a cold image
// build legitimately takes minutes); they exist so a HUNG docker can never
// block setup indefinitely. On timeout spawnSync kills the child and returns
// `error.code === "ETIMEDOUT"`, surfaced as a soft-failed bring-up.
const WAYFLOW_BUILD_TIMEOUT_MS = 600_000; // 10m — cold image build ceiling
const COMPOSE_UP_TIMEOUT_MS = 120_000; // 2m — `compose up -d tailscale` ceiling
// Per-`docker compose exec … tailscale status` ceiling. A single status read
// is sub-second; cap it so a HUNG exec is killed and the polling loop's
// `timeoutMs` deadline always stays reachable (a stuck exec must never make
// `waitForTailscaleFunnelUrl` — and thus setup — hang).
const TAILSCALE_STATUS_SPAWN_TIMEOUT_MS = 10_000; // 10s
// Ceiling for the fast docker-CLI metadata probes (`compose version`,
// `compose ps`, `image inspect`) that the setup auto-bring-up path now reaches
// before the build/up/status calls. Sub-second normally; a hung docker CLI is
// killed so `cinatra setup dev` can never block on these probes.
const DOCKER_CLI_PROBE_TIMEOUT_MS = 15_000; // 15s

/**
 * Mint one real `client_credentials` token at the local OAuth token endpoint
 * and classify the outcome. Pure HTTP — no server-only imports, no secret in
 * the returned value or any log.
 *
 * @returns {Promise<{ outcome: "ok" | "decrypt-error" | "app-down" | "error", status?: number }>}
 *   - "ok"            mint returned a real access_token → JWKS decryptable, nothing to heal
 *   - "decrypt-error" 5xx whose body carries the exact decrypt marker → heal
 *   - "app-down"      the local app / token endpoint is unreachable OR timed out → skip
 *   - "error"         any other non-2xx, a 2xx without access_token, or unexpected failure → warn, do NOT heal
 */
async function probeTokenMint({ origin, clientId, clientSecret, scope, timeoutMs = TOKEN_MINT_PROBE_TIMEOUT_MS }) {
  const tokenEndpoint = `${origin}/api/auth/oauth2/token`;
  const resource = `${origin}/api/mcp`;
  const controller = new AbortController();
  // The timer covers the ENTIRE operation — request AND body read — and is
  // cleared only at the very end. A server that sends headers then stalls the
  // body would otherwise hang `cinatra setup dev` indefinitely once the timer
  // was cleared after fetch() resolved. The abort signal propagates to the body
  // stream, so response.json()/text() reject with AbortError on a body stall.
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
      response = await fetch(tokenEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${basic}`,
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          scope,
          resource,
        }),
        signal: controller.signal,
      });
    } catch {
      // fetch threw → the endpoint is unreachable (app not running, DNS/connect
      // failure) OR the request phase timed out (AbortError). NEVER heal on a
      // transport failure or stall — the JWKS state is unknown, setup must not hang.
      return { outcome: "app-down" };
    }

    if (response.ok) {
      // An authoritative mint must return a real access_token. A misrouted 200
      // (HTML page, empty body, or a JSON without access_token) is NOT proof the
      // signing key is decryptable — treat it as a non-healing "error", not "ok".
      let tokenData = null;
      try {
        tokenData = await response.json();
      } catch (err) {
        // A body-read abort (the timer fired while the body stalled) is a stall,
        // not a malformed body → classify "app-down" (never heal/delete).
        if (err && (err.name === "AbortError" || controller.signal.aborted)) {
          return { outcome: "app-down" };
        }
        tokenData = null;
      }
      if (tokenData && typeof tokenData.access_token === "string" && tokenData.access_token.length > 0) {
        return { outcome: "ok", status: response.status };
      }
      return { outcome: "error", status: response.status };
    }

    let bodyText = "";
    try {
      bodyText = await response.text();
    } catch (err) {
      if (err && (err.name === "AbortError" || controller.signal.aborted)) {
        return { outcome: "app-down" };
      }
      bodyText = "";
    }

    // The ONE condition that authorizes a DELETE: a server error (5xx) whose body
    // carries Better Auth's exact decrypt message. A 4xx (bad/disabled client,
    // wrong scope) is NOT a JWKS problem and must never delete a key.
    if (response.status >= 500 && bodyText.includes(JWKS_DECRYPT_ERROR_MARKER)) {
      return { outcome: "decrypt-error", status: response.status };
    }

    return { outcome: "error", status: response.status };
  } finally {
    clearTimeout(timer);
  }
}

// Delete the LATEST jwks row (the only one Better Auth's signJWT reads). Scoped
// to the single proven-bad row by createdAt DESC, not a blanket truncate, so a
// concurrently-good key is never collateral. Returns the number of rows deleted.
async function deleteLatestJwksRow(client) {
  const result = await client.query(
    `
      delete from public."jwks"
      where "id" = (
        select "id" from public."jwks"
        order by "createdAt" desc
        limit 1
      )
    `,
  );
  return result.rowCount ?? 0;
}

/**
 * Idempotent self-heal for an undecryptable JWKS (dev only).
 *
 * Probes authoritatively via a real token mint. On the definite decrypt error
 * (and ONLY then) deletes the proven-bad latest jwks row so Better Auth's lazy
 * createJwk regenerates under the active BETTER_AUTH_SECRET on the next mint,
 * then re-probes once (bounded single retry). Loud-but-non-fatal: every failure
 * path warns and returns a status object — it NEVER aborts setup.
 *
 * Sequenced AFTER ensureSelfMcpClient (it needs a valid client_credentials
 * client to mint). Skips with a warning when the local app / token endpoint is
 * not running — `cinatra setup dev` does not guarantee the server is up.
 *
 * SECRET BOUNDARY: never logs the client secret or any minted token. Statuses
 * and counts only.
 *
 * @returns {Promise<{ status: string, deleted?: number, retriedOk?: boolean }>}
 */
async function ensureDecryptableJwks(client, env, selfClient) {
  const clientId = selfClient?.clientId;
  const clientSecret = selfClient?.clientSecret;
  const scope = selfClient?.scope ?? SELF_MCP_CLIENT_SCOPE;
  if (!clientId || !clientSecret) {
    console.warn(
      "⚠ JWKS self-heal skipped: no self MCP client credentials available to probe with.",
    );
    return { status: "skipped-no-client" };
  }

  const origin = resolveLocalOrigin(env);
  const probe = await probeTokenMint({ origin, clientId, clientSecret, scope });

  if (probe.outcome === "ok") {
    return { status: "healthy" };
  }

  if (probe.outcome === "app-down") {
    console.warn(
      `⚠ JWKS self-heal skipped: the local app/token endpoint at ${origin} is not reachable or timed out ` +
        "(setup does not start the server). Re-run `cinatra setup dev` once `pnpm dev` is up so the token-mint " +
        "probe can verify (and, if needed, self-heal) JWKS decryptability.",
    );
    return { status: "skipped-app-down" };
  }

  if (probe.outcome === "error") {
    console.warn(
      `⚠ JWKS self-heal: token mint returned HTTP ${probe.status} without the decrypt-error signature — ` +
        "not a JWKS-decrypt fault, leaving keys untouched. If MCP token mints keep failing, investigate the OAuth client/scope.",
    );
    return { status: "probe-error", deleted: 0 };
  }

  // outcome === "decrypt-error": the ONE case that authorizes a heal.
  console.warn(
    "⚠ JWKS self-heal: the local token endpoint reported \"Failed to decrypt private key\" — " +
      "the stored signing key cannot be decrypted under the active BETTER_AUTH_SECRET. " +
      "Deleting the proven-bad latest key so Better Auth regenerates it on the next mint.",
  );

  let deleted = 0;
  try {
    deleted = await deleteLatestJwksRow(client);
  } catch (err) {
    console.warn(
      `⚠ JWKS self-heal: failed to delete the undecryptable key: ${err && err.message ? err.message : err}. ` +
        "Leaving setup otherwise complete; remove the stale public.jwks row manually if MCP token mints keep failing.",
    );
    return { status: "delete-failed", deleted: 0 };
  }

  if (deleted === 0) {
    console.warn(
      "⚠ JWKS self-heal: decrypt error reported but no jwks row was present to delete — " +
        "leaving setup otherwise complete; re-run once the app is up.",
    );
    return { status: "decrypt-error-no-row", deleted: 0 };
  }

  // Bounded single retry: confirm regeneration produced a decryptable key.
  const retry = await probeTokenMint({ origin, clientId, clientSecret, scope });
  if (retry.outcome === "ok") {
    console.log(`- JWKS self-heal: removed ${deleted} undecryptable key; a fresh key was regenerated and verified.`);
    return { status: "healed", deleted, retriedOk: true };
  }

  console.warn(
    `⚠ JWKS self-heal: removed ${deleted} undecryptable key, but the verification mint did not succeed ` +
      `(outcome=${retry.outcome}${retry.status ? `, HTTP ${retry.status}` : ""}). ` +
      "Better Auth should regenerate on the next mint; re-run `cinatra setup dev` once the app has served a request to re-verify.",
  );
  return { status: "healed-unverified", deleted, retriedOk: false };
}

async function ensureDefaultOrganization(client) {
  const { rows } = await client.query(
    `SELECT id FROM public.organization WHERE slug = 'default' LIMIT 1`
  );
  if (rows.length > 0) {
    return { created: false, id: rows[0].id };
  }
  const { rows: inserted } = await client.query(
    `INSERT INTO public.organization (id, name, slug, "createdAt")
     VALUES (gen_random_uuid()::text, 'Default', 'default', NOW())
     RETURNING id`
  );
  return { created: true, id: inserted[0].id };
}

/**
 * Refresh LLM MCP access — regenerates all client secrets.
 */
async function refreshLlmMcpAccess(client, schemaName, mcpSettings) {
  // Clear existing secrets to force regeneration
  await writeMetadataValue(client, schemaName, LLM_MCP_SETTINGS_KEY, {});
  return ensureLlmMcpAccess(client, schemaName, mcpSettings, "dev");
}

async function runLlmMcpAccessSetup() {
  const repoRoot = getRepoRoot();
  const env = collectEnvironment(repoRoot);
  const runtimeMode = readConfiguredRuntimeMode(env);

  if (runtimeMode === "production") {
    throw new Error("LLM MCP access pre-configuration is only available in development mode.");
  }

  const connectionString = requiredEnv(env, "SUPABASE_DB_URL");
  const schemaName = env.SUPABASE_SCHEMA?.trim() || "cinatra";
  const client = createClient(connectionString);
  await client.connect();

  try {
    const mcpSettings = await readMetadataValue(client, schemaName, MCP_SETTINGS_KEY, {});
    const result = await ensureLlmMcpAccess(client, schemaName, { current: mcpSettings, next: mcpSettings }, "dev");

    if (!result) {
      console.log("LLM MCP access is not available in production mode.");
      return;
    }

    console.log("LLM MCP access configured for development:");
    for (const provider of LLM_MCP_PROVIDERS) {
      const p = result.providers[provider.id];
      console.log(`- ${provider.name}: client=${p.clientId}`);
    }
    console.log(`\nBlocked tool patterns: ${LLM_MCP_BLOCKED_TOOL_PATTERNS.join(", ")}`);
  } finally {
    await client.end();
  }
}

async function runLlmMcpAccessRefresh() {
  const repoRoot = getRepoRoot();
  const env = collectEnvironment(repoRoot);
  const runtimeMode = readConfiguredRuntimeMode(env);

  if (runtimeMode === "production") {
    throw new Error("LLM MCP access pre-configuration is only available in development mode.");
  }

  const connectionString = requiredEnv(env, "SUPABASE_DB_URL");
  const schemaName = env.SUPABASE_SCHEMA?.trim() || "cinatra";
  const client = createClient(connectionString);
  await client.connect();

  try {
    const mcpSettings = await readMetadataValue(client, schemaName, MCP_SETTINGS_KEY, {});
    const result = await refreshLlmMcpAccess(client, schemaName, { current: mcpSettings, next: mcpSettings });

    if (!result) {
      console.log("LLM MCP access is not available in production mode.");
      return;
    }

    console.log("LLM MCP access credentials refreshed:");
    for (const provider of LLM_MCP_PROVIDERS) {
      const p = result.providers[provider.id];
      console.log(`- ${provider.name}: client=${p.clientId} (secret rotated)`);
    }
  } finally {
    await client.end();
  }
}

async function runBetterAuthMigrate(repoRoot, authConfig) {
  // The bundled `better-auth migrate` CLI cannot load src/lib/auth.ts — that
  // module barrel-imports the whole Next.js app (server-only, React, app
  // aliases) and is not loadable outside the bundler. Apply the migration
  // programmatically via the standalone runner instead.
  //
  // Prefer the self-contained bundle when present (Docker/prod): the Next
  // standalone runtime image prunes better-auth (only the runner uses it, not
  // the server), so the loose .mts cannot resolve it there. The Docker build
  // emits scripts/better-auth-migrate.bundle.mjs with better-auth + pg inlined.
  // In dev the bundle is absent → fall back to the .mts (Node type-stripping).
  const bundlePath = path.join(repoRoot, "scripts", "better-auth-migrate.bundle.mjs");
  const runnerPath = existsSync(bundlePath)
    ? bundlePath
    : path.join(repoRoot, "scripts", "better-auth-migrate.mts");
  const { runBetterAuthMigration } = await import(pathToFileURL(runnerPath).href);
  await runBetterAuthMigration(authConfig);
}

function createBackupFile(repoRoot, env, connectionString, filePath, schemas) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const schemaArgs = Array.isArray(schemas) && schemas.length > 0
    ? schemas.map((s) => `--schema=${s}`)
    : [];
  runPostgresCommand(
    repoRoot,
    env,
    "pg_dump",
    [
      "--format=plain",
      "--clean",
      "--if-exists",
      "--no-owner",
      "--no-privileges",
      ...schemaArgs,
      `--file=${filePath}`,
      connectionString,
    ],
    "Backup creation failed. Make sure pg_dump is installed and the database is reachable.",
    { cwd: repoRoot },
  );
}

function importBackupFile(repoRoot, env, connectionString, filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Backup file not found: ${filePath}`);
  }

  runPostgresCommand(
    repoRoot,
    env,
    "psql",
    ["-v", "ON_ERROR_STOP=1", "-d", connectionString, "-f", filePath],
    "Backup import failed. Make sure psql is installed, the database is reachable, and the backup file is valid.",
    { cwd: repoRoot },
  );
}

function preCleanSchemas(repoRoot, env, connectionString, schemas) {
  const statements = schemas
    .map((s) => `DROP SCHEMA IF EXISTS ${quoteIdentifier(s)} CASCADE;`)
    .concat("CREATE SCHEMA IF NOT EXISTS public;")
    .join(" ");

  runPostgresCommand(
    repoRoot,
    env,
    "psql",
    ["-d", connectionString, "-c", statements],
    "Pre-import schema cleanup failed. Make sure psql is installed and the database is reachable.",
    { cwd: repoRoot },
  );
}

function readBackupManifest(extractedBundleRoot) {
  const manifestPath = path.join(extractedBundleRoot, "manifest.json");
  if (!existsSync(manifestPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

function copyDataDirectoryIntoBundle(repoRoot, bundleRoot) {
  const sourceDataDirectory = path.join(repoRoot, DEFAULT_DATA_DIRECTORY);
  if (!existsSync(sourceDataDirectory)) {
    return false;
  }

  const destinationDataDirectory = path.join(bundleRoot, "files", DEFAULT_DATA_DIRECTORY);
  cpSync(sourceDataDirectory, destinationDataDirectory, {
    recursive: true,
    filter(source) {
      const relativePath = path.relative(sourceDataDirectory, source);
      if (!relativePath || relativePath === ".") {
        return true;
      }

      const basename = path.basename(source);
      if (isBackupArtifactName(basename)) {
        return false;
      }

      return true;
    },
  });

  return true;
}

function isBackupArtifactName(filename) {
  const lower = String(filename).toLowerCase();
  const isArchive = lower.endsWith(".sql") || lower.endsWith(".tar.gz") || lower.endsWith(".tgz");
  if (!isArchive) {
    return false;
  }

  return lower.startsWith("cinatra-backup-") || lower.startsWith("data-only-backup-");
}

function findLatestBackupFile(repoRoot) {
  const backupDirectory = path.join(repoRoot, DEFAULT_BACKUP_DIRECTORY);
  if (!existsSync(backupDirectory)) {
    return null;
  }

  const candidates = readdirSync(backupDirectory)
    .filter((name) => {
      const lower = name.toLowerCase();
      return lower.startsWith("cinatra-backup-") && (lower.endsWith(".tar.gz") || lower.endsWith(".tgz"));
    })
    .sort()
    .reverse();

  return candidates.length > 0 ? path.join(backupDirectory, candidates[0]) : null;
}

function restoreDataDirectoryFromBundle(repoRoot, extractedBundleRoot) {
  const restoredDataDirectory = path.join(extractedBundleRoot, "files", DEFAULT_DATA_DIRECTORY);
  if (!existsSync(restoredDataDirectory)) {
    return false;
  }

  const destinationDataDirectory = path.join(repoRoot, DEFAULT_DATA_DIRECTORY);
  const preservedBackupFiles = [];

  if (existsSync(destinationDataDirectory)) {
    for (const entry of readdirSync(destinationDataDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !isBackupArtifactName(entry.name)) {
        continue;
      }

      const sourcePath = path.join(destinationDataDirectory, entry.name);
      const tempPath = path.join(extractedBundleRoot, "__preserved_backups__", entry.name);
      mkdirSync(path.dirname(tempPath), { recursive: true });
      cpSync(sourcePath, tempPath);
      preservedBackupFiles.push({ tempPath, filename: entry.name });
    }
  }

  removePathIfExists(destinationDataDirectory);
  cpSync(restoredDataDirectory, destinationDataDirectory, { recursive: true });

  for (const preserved of preservedBackupFiles) {
    cpSync(preserved.tempPath, path.join(destinationDataDirectory, preserved.filename));
  }

  return true;
}

function writeBackupManifest(bundleRoot, manifest) {
  writeFileSync(path.join(bundleRoot, "manifest.json"), JSON.stringify(manifest, null, 2));
}

function createBackupBundle(repoRoot, env, appConnectionString, filePath) {
  if (isLegacySqlBackupPath(filePath)) {
    throw new Error('Full backups now use a bundle archive. Please choose a filename ending in ".tar.gz" or ".tgz".');
  }

  mkdirSync(path.dirname(filePath), { recursive: true });

  const schemaName = env.SUPABASE_SCHEMA?.trim() || "cinatra";
  const appSchemas = [schemaName, "public"];

  const tempDirectory = createTempDirectory("cinatra-backup-");
  const postgresDirectory = path.join(tempDirectory, "postgres");
  mkdirSync(postgresDirectory, { recursive: true });

  try {
    const appDumpPath = path.join(postgresDirectory, "cinatra.sql");
    createBackupFile(repoRoot, env, appConnectionString, appDumpPath, appSchemas);

    const nangoDatabaseUrl = getNangoDatabaseUrl(env);
    let includesNangoDatabase = false;
    if (nangoDatabaseUrl) {
      createBackupFile(repoRoot, env, nangoDatabaseUrl, path.join(postgresDirectory, "nango.sql"));
      includesNangoDatabase = true;
    }

    const includesDataDirectory = copyDataDirectoryIntoBundle(repoRoot, tempDirectory);

    writeBackupManifest(tempDirectory, {
      format: "cinatra-backup-bundle",
      version: 1,
      createdAt: new Date().toISOString(),
      includes: {
        cinatraDatabase: true,
        cinatraDatabaseSchemas: appSchemas,
        nangoDatabase: includesNangoDatabase,
        dataDirectory: includesDataDirectory,
      },
    });

    runCommandOrThrow(
      "tar",
      ["-czf", filePath, "-C", tempDirectory, "."],
      "Backup creation failed. Make sure tar is installed and the backup path is writable.",
      { cwd: repoRoot },
    );
  } finally {
    removePathIfExists(tempDirectory);
  }
}

function importBackupBundle(repoRoot, env, appConnectionString, filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Backup file not found: ${filePath}`);
  }

  const tempDirectory = createTempDirectory("cinatra-backup-import-");

  try {
    runCommandOrThrow(
      "tar",
      ["-xzf", filePath, "-C", tempDirectory],
      "Backup import failed. Make sure tar is installed and the backup archive is valid.",
      { cwd: repoRoot },
    );

    // --- Pre-flight validation: check all prerequisites before touching any database ---

    const cinatraDumpPath = path.join(tempDirectory, "postgres", "cinatra.sql");
    if (!existsSync(cinatraDumpPath)) {
      throw new Error("Backup bundle is missing postgres/cinatra.sql.");
    }

    const nangoDumpPath = path.join(tempDirectory, "postgres", "nango.sql");
    let nangoDatabaseUrl = null;
    if (existsSync(nangoDumpPath)) {
      nangoDatabaseUrl = getNangoDatabaseUrl(env);
      if (!nangoDatabaseUrl) {
        throw new Error(
          "This backup bundle contains a Nango database dump, but NANGO_DATABASE_URL or NANGO_DB_URL is not configured. " +
            "Set one of these environment variables, or remove postgres/nango.sql from the bundle to skip the Nango import.",
        );
      }
    }

    // --- Determine schemas to pre-clean ---

    const manifest = readBackupManifest(tempDirectory);
    const schemaName = env.SUPABASE_SCHEMA?.trim() || "cinatra";
    const schemas = manifest?.includes?.cinatraDatabaseSchemas ?? [schemaName, "public"];

    // --- Import ---

    preCleanSchemas(repoRoot, env, appConnectionString, schemas);
    importBackupFile(repoRoot, env, appConnectionString, cinatraDumpPath);

    if (nangoDatabaseUrl) {
      importBackupFile(repoRoot, env, nangoDatabaseUrl, nangoDumpPath);
    }

    restoreDataDirectoryFromBundle(repoRoot, tempDirectory);
  } finally {
    removePathIfExists(tempDirectory);
  }
}

async function maybeRunBetterAuthMigrate(client, repoRoot, authConfig) {
  const tableState = await readAuthTableState(client);
  if (tableState.present.length === AUTH_TABLES.length) {
    return {
      action: "skipped",
      reason: "auth tables already present",
    };
  }

  if (tableState.present.length > 0) {
    throw new Error(
      `Better Auth appears partially initialized. Missing tables: ${tableState.missing.join(", ")}. ` +
        `Use "cinatra reset dev --yes" for a clean rebuild in development, or start from a clean production database.`,
    );
  }

  await runBetterAuthMigrate(repoRoot, authConfig);
  return {
    action: "ran",
    reason: "fresh auth schema created",
  };
}

async function resetDevelopmentData(client, schemaName, purgeAppData) {
  if (purgeAppData) {
    await client.query(`drop schema if exists ${quoteIdentifier(schemaName)} cascade`);
  }

  await client.query(
    `
      drop table if exists
        public."oauthAccessToken",
        public."oauthRefreshToken",
        public."oauthConsent",
        public."oauthClient",
        public."jwks",
        public."invitation",
        public."member",
        public."organization",
        public."verification",
        public."account",
        public."session",
        public."user"
      cascade
    `,
  );
}

async function resolveAppDataPurgePreference(argv) {
  const wantsPurge = argv.includes("--purge-app-data");
  const wantsKeep = argv.includes("--keep-app-data");

  if (wantsPurge && wantsKeep) {
    throw new Error('Choose only one of --purge-app-data or --keep-app-data.');
  }

  if (wantsPurge) {
    return true;
  }

  if (wantsKeep) {
    return false;
  }

  return promptYesNo(
    "Do you also want to purge app-generated workspace data such as campaigns, drafts, blog data, source data, skills, notifications, and related package-owned records?",
  );
}

async function resolveBackupPreference(argv) {
  const wantsBackup = argv.includes("--backup");
  const wantsSkipBackup = argv.includes("--no-backup");

  if (wantsBackup && wantsSkipBackup) {
    throw new Error("Choose only one of --backup or --no-backup.");
  }

  if (wantsBackup) {
    return true;
  }

  if (wantsSkipBackup) {
    return false;
  }

  return promptYesNo("Do you want to create a full backup first?");
}

async function gatherStatus(client, schemaName) {
  const authTableState = await readAuthTableState(client);
  const userCount = await readUserCount(client);
  const mcpSettings = await readMetadataValue(client, schemaName, MCP_SETTINGS_KEY, {});
  const jwksRowCount = await readJwksRowCount(client);

  // DB-presence health only (no network mint): "absent" = jwks table missing,
  // "no-keys" = table present but empty (Better Auth will lazily createJwk on
  // first sign), "present" = at least one key row. Decryptability is proven by
  // the live token-mint probe in `ensureDecryptableJwks` (runSetup), not here.
  const jwksHealth =
    jwksRowCount === null ? "absent" : jwksRowCount === 0 ? "no-keys" : "present";

  return {
    authTablesPresent: authTableState.present,
    authTablesMissing: authTableState.missing,
    userCount,
    mcpPublicBaseUrl: mcpSettings?.publicBaseUrl ?? null,
    selfMcpClientId: mcpSettings?.selfClient?.clientId ?? null,
    jwksHealth,
    jwksKeyCount: jwksRowCount,
  };
}

// ===========================================================================
// `cinatra doctor` — content-editor write-path self-check (cinatra#260 Step 5)
// ===========================================================================
//
// A READ-ONLY, idempotent self-check that proves the full LLM→CMS write path the
// other four steps provision piecemeal: token mint → public URL → provider
// reaches /api/mcp → CMS write. It mutates NOTHING (no rotate, no DDL, no
// credential writes) and never prints a token/secret/Bearer/app-password — only
// statuses, booleans, and HTTP status codes.
//
// Each assertion yields { id, label, verdict, detail, remediation }:
//   - "pass"  the chain link is PROVEN true.
//   - "fail"  the chain link is PROVEN false (a real provisioning gap).
//   - "skip"  the link could NOT be proven because a dependency is down (app
//             not running, CMS container down, public URL unreachable, docker
//             absent). A SKIP is NEVER a PASS — the operator is told to re-run
//             `cinatra doctor` once the relevant service is up. The standalone
//             subcommand is the authoritative post-boot gate.
//
// The CLI is a plain .mjs with no Next path aliases and no `server-only`
// runtime, so it CANNOT import the TS credential helpers in packages/llm/** or
// packages/mcp-server/** (forbidden to modify), nor the host-app TS probes in
// src/lib/**. The doctor therefore re-derives the same read-only logic over
// direct DB reads + HTTP/docker probes. Where a TS helper is the model, the
// behavior is mirrored (not imported) and the source is cited.

// Bounded timeout for every doctor HTTP probe. A reachable-but-stalled endpoint
// must never hang setup or the standalone command.
const DOCTOR_HTTP_TIMEOUT_MS = 5000;

// The content-editor CMS-write MCP tools the doctor requires in tools/list. An
// EXACT allowlist (not a `blog_post_publish_` prefix, which would false-pass on
// `blog_post_publish_linkedin_*` — codex must-fix). Presence of ANY one of these
// proves the CMS-write surface is exposed on the MCP server.
const DOCTOR_CMS_WRITE_TOOLS = ["blog_post_publish_wordpress_start", "blog_post_update"];

// Local CMS endpoints + the container names `src/lib/dev-auto-setup.ts` expects
// (default compose naming `<project>-<service>-<N>`; the boot auto-setup path
// hardcodes these, so the doctor mirrors that expectation rather than guessing).
const DOCTOR_WORDPRESS = {
  containerName: "cinatra-wordpress-1",
  siteUrl: "http://localhost:8080",
  // Routes probed WITHOUT a secret — pure reachability/route-presence (codex
  // must-fix: a bare /wp/v2 root would not catch the abilities-api/mcp-adapter
  // boot failure the uat-gate hit). `/mcp/mcp-adapter-default-server` is served
  // only when the mcp-adapter plugin is active (see src/lib/wordpress-mcp-connection.ts).
  restRootPath: "/index.php?rest_route=/wp/v2",
  mcpAdapterPath: "/index.php?rest_route=/mcp/mcp-adapter-default-server",
  // Plugins that must be ACTIVE for the WP MCP write path (codex must-fix).
  requiredPlugins: ["cinatra", "abilities-api", "mcp-adapter"],
};
const DOCTOR_DRUPAL = {
  containerName: "cinatra-drupal-1",
  siteUrl: "http://localhost:8082",
  // `/_mcp_tools` is served only when the cinatra mcp_tools route is installed
  // (see src/lib/drupal-mcp-connection.ts classifier).
  mcpToolsPath: "/_mcp_tools",
  requiredModule: "cinatra",
};

function makeAssertion(id, label, verdict, detail, remediation) {
  return { id, label, verdict, detail, remediation: remediation ?? null };
}

// Derive the configured public MCP server URL the SAME way the runtime read does
// (packages/mcp-server/src/llm-credentials.ts getMcpPublicBaseUrl + getPublicMcpServerUrl):
// drop source==="cli" (retired tunnel), URL-parse to origin-only (a legacy
// pathful row is normalized, NOT rejected — `normalizeOptionalUrl` would drift
// from runtime here, codex must-fix), then append /api/mcp. Returns null when no
// usable URL is configured. Pure; no network.
function deriveConfiguredPublicMcpUrl(mcpServerSettings) {
  const raw = mcpServerSettings ?? {};
  if (raw.publicBaseUrlSource === "cli") return null;
  const value = typeof raw.publicBaseUrl === "string" ? raw.publicBaseUrl.trim() : "";
  if (!value) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return `${parsed.protocol}//${parsed.host}/api/mcp`;
}

// Assertions 1+2 — creds provisioned AND public URL set, asserted as ONE AND
// (this IS hasLlmMcpAccess(): two independent green lines are the documented
// false-PASS trap — never repeat it). Pure DB reads.
async function doctorAssertLlmMcpAccess(client, schemaName) {
  const llmAccess = await readMetadataValue(client, schemaName, LLM_MCP_SETTINGS_KEY, {});
  const providerIds = Object.keys(llmAccess?.providers ?? {});
  const hasCredentials = providerIds.length > 0;

  const mcpServer = await readMetadataValue(client, schemaName, MCP_SETTINGS_KEY, {});
  const publicMcpUrl = deriveConfiguredPublicMcpUrl(mcpServer);
  const hasPublicUrl = Boolean(publicMcpUrl);

  // SINGLE AND. hasLlmMcpAccess === hasCredentials && hasPublicUrl.
  const ok = hasCredentials && hasPublicUrl;

  let detail;
  if (ok) {
    detail = `${providerIds.length} provider(s); public MCP URL configured`;
  } else if (hasCredentials && !hasPublicUrl) {
    detail = `${providerIds.length} provider(s) provisioned, but NO public MCP URL is set`;
  } else if (!hasCredentials && hasPublicUrl) {
    detail = "public MCP URL set, but NO LLM provider credentials are provisioned";
  } else {
    detail = "no LLM provider credentials and no public MCP URL";
  }

  return {
    assertion: makeAssertion(
      "llm-mcp-access",
      "LLM MCP access (creds AND public URL — single AND)",
      ok ? "pass" : "fail",
      detail,
      ok
        ? null
        : "Run `cinatra setup dev` (provisions provider creds), then `cinatra dev tunnel start` " +
          "(or paste a public URL at /configuration/development?tab=tunnel) to set the public MCP URL.",
    ),
    // Surfaced to later assertions; never logged.
    providers: llmAccess?.providers ?? {},
    publicMcpUrl,
  };
}

// Internal-only token mint that RETURNS the minted token so assertions 4+5 can
// reuse it. Kept private to gatherDoctorReport — the token is NEVER placed in an
// assertion object or any log (the public `probeTokenMint` deliberately returns
// no token; codex must-fix). Mirrors exchangeClientCredentials in
// src/app/configuration/mcp/llm-access/test/route.ts.
async function doctorMintToken({ origin, clientId, clientSecret, scope, fetchImpl }) {
  const tokenEndpoint = `${origin}/api/auth/oauth2/token`;
  const resource = `${origin}/api/mcp`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOCTOR_HTTP_TIMEOUT_MS);
  try {
    let response;
    try {
      const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
      response = await fetchImpl(tokenEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${basic}`,
        },
        body: new URLSearchParams({ grant_type: "client_credentials", scope, resource }),
        signal: controller.signal,
      });
    } catch {
      // Transport failure or request-phase timeout → app is down/unreachable.
      return { outcome: "app-down", token: null };
    }
    if (!response.ok) {
      return { outcome: "error", status: response.status, token: null };
    }
    let tokenData = null;
    try {
      tokenData = await response.json();
    } catch (err) {
      if (err && (err.name === "AbortError" || controller.signal.aborted)) {
        return { outcome: "app-down", token: null };
      }
      tokenData = null;
    }
    if (tokenData && typeof tokenData.access_token === "string" && tokenData.access_token.length > 0) {
      return { outcome: "ok", status: response.status, token: tokenData.access_token };
    }
    return { outcome: "error", status: response.status, token: null };
  } finally {
    clearTimeout(timer);
  }
}

// Assertion 3 — token-mint smoke. Reports HTTP status + token-present boolean
// ONLY. Returns the token privately for 4+5. SKIP (never PASS) when the app/token
// endpoint is unreachable.
async function doctorAssertTokenMint({ origin, providers, fetchImpl }) {
  // Pick the first provisioned provider with a usable client_credentials pair.
  const entry = Object.values(providers ?? {}).find(
    (p) => p && typeof p.clientId === "string" && typeof p.clientSecret === "string" && p.clientId && p.clientSecret,
  );
  if (!entry) {
    return {
      assertion: makeAssertion(
        "token-mint",
        "Token-mint smoke (client_credentials)",
        "skip",
        "no LLM provider credentials to mint with",
        "Run `cinatra setup dev` to provision LLM provider OAuth clients first.",
      ),
      token: null,
    };
  }
  const scope = typeof entry.scope === "string" && entry.scope ? entry.scope : LLM_MCP_CLIENT_SCOPE;
  const result = await doctorMintToken({
    origin,
    clientId: entry.clientId,
    clientSecret: entry.clientSecret,
    scope,
    fetchImpl,
  });
  if (result.outcome === "ok") {
    return {
      assertion: makeAssertion(
        "token-mint",
        "Token-mint smoke (client_credentials)",
        "pass",
        `HTTP ${result.status}; access_token present: true`,
      ),
      token: result.token,
    };
  }
  if (result.outcome === "app-down") {
    return {
      assertion: makeAssertion(
        "token-mint",
        "Token-mint smoke (client_credentials)",
        "skip",
        `local token endpoint at ${origin} unreachable or timed out`,
        "Start the app (`pnpm dev`), then re-run `cinatra doctor`.",
      ),
      token: null,
    };
  }
  return {
    assertion: makeAssertion(
      "token-mint",
      "Token-mint smoke (client_credentials)",
      "fail",
      `HTTP ${result.status ?? "?"}; access_token present: false`,
      "Token mint failed. Check the OAuth client/scope and JWKS decryptability " +
        "(`cinatra setup dev` self-heals JWKS once the app is up).",
    ),
    token: null,
  };
}

// POST a JSON-RPC tools/list with a Bearer and classify. Returns
// { outcome: "ok"|"unreachable"|"error", status?, tools?: string[] }. Bounded
// timeout. The Bearer + response body are NEVER logged.
async function doctorToolsList({ url, token, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOCTOR_HTTP_TIMEOUT_MS);
  try {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        signal: controller.signal,
      });
    } catch {
      return { outcome: "unreachable" };
    }
    if (!response.ok) {
      return { outcome: "error", status: response.status };
    }
    let data = null;
    try {
      data = await response.json();
    } catch (err) {
      if (err && (err.name === "AbortError" || controller.signal.aborted)) {
        return { outcome: "unreachable" };
      }
      return { outcome: "error", status: response.status };
    }
    const tools = Array.isArray(data?.result?.tools)
      ? data.result.tools.map((t) => (t && typeof t.name === "string" ? t.name : "")).filter(Boolean)
      : [];
    return { outcome: "ok", status: response.status, tools };
  } finally {
    clearTimeout(timer);
  }
}

// Assertion 4 — LOCAL /api/mcp tools/list incl. a CMS-write tool. SKIP when no
// token (depends on 3) or the endpoint is unreachable.
async function doctorAssertLocalToolsList({ origin, token, fetchImpl }) {
  if (!token) {
    return makeAssertion(
      "local-tools-list",
      "Local /api/mcp tools/list (incl. CMS-write tool)",
      "skip",
      "no minted token (token-mint did not succeed)",
      "Start the app (`pnpm dev`), then re-run `cinatra doctor`.",
    );
  }
  const result = await doctorToolsList({ url: `${origin}/api/mcp`, token, fetchImpl });
  if (result.outcome === "unreachable") {
    return makeAssertion(
      "local-tools-list",
      "Local /api/mcp tools/list (incl. CMS-write tool)",
      "skip",
      `local /api/mcp at ${origin} unreachable or timed out`,
      "Start the app (`pnpm dev`), then re-run `cinatra doctor`.",
    );
  }
  if (result.outcome === "error") {
    return makeAssertion(
      "local-tools-list",
      "Local /api/mcp tools/list (incl. CMS-write tool)",
      "fail",
      `tools/list returned HTTP ${result.status}`,
      "The MCP server rejected the minted Bearer. Re-run `cinatra setup dev` once the app is up.",
    );
  }
  const hasTools = result.tools.length > 0;
  const cmsWriteTool = result.tools.find((name) => DOCTOR_CMS_WRITE_TOOLS.includes(name));
  if (hasTools && cmsWriteTool) {
    return makeAssertion(
      "local-tools-list",
      "Local /api/mcp tools/list (incl. CMS-write tool)",
      "pass",
      `${result.tools.length} tool(s); CMS-write tool present (${cmsWriteTool})`,
    );
  }
  return makeAssertion(
    "local-tools-list",
    "Local /api/mcp tools/list (incl. CMS-write tool)",
    "fail",
    hasTools
      ? `${result.tools.length} tool(s) but no CMS-write tool (expected one of: ${DOCTOR_CMS_WRITE_TOOLS.join(", ")})`
      : "tools/list returned 0 tools",
    "Verify the content-publishing extension is installed/active and the MCP scope is correct.",
  );
}

// Assertion 5 — PUBLIC reachability (codex must-fix: a real e2e proof, not just
// local). POST the CONFIGURED public MCP URL with the minted Bearer. SKIP when no
// public URL (covered by the 1+2 FAIL) or no token, or when the hosted endpoint
// is unreachable. PASS requires the public endpoint to actually answer tools/list.
async function doctorAssertPublicReachability({ publicMcpUrl, token, fetchImpl }) {
  if (!publicMcpUrl) {
    return makeAssertion(
      "public-reachability",
      "Public MCP URL reachability (provider-facing tools/list)",
      "skip",
      "no public MCP URL configured (see the LLM-MCP-access assertion)",
      "Set a public MCP URL via `cinatra dev tunnel start` or the dev tunnel tab, then re-run `cinatra doctor`.",
    );
  }
  if (!token) {
    return makeAssertion(
      "public-reachability",
      "Public MCP URL reachability (provider-facing tools/list)",
      "skip",
      "no minted token (token-mint did not succeed)",
      "Start the app (`pnpm dev`), then re-run `cinatra doctor`.",
    );
  }
  const result = await doctorToolsList({ url: publicMcpUrl, token, fetchImpl });
  if (result.outcome === "unreachable") {
    return makeAssertion(
      "public-reachability",
      "Public MCP URL reachability (provider-facing tools/list)",
      "skip",
      "the configured public MCP URL is unreachable or timed out (DNS/cert may still be propagating)",
      "Confirm the public URL is live (`cinatra dev tunnel status`), then re-run `cinatra doctor`.",
    );
  }
  if (result.outcome === "error") {
    return makeAssertion(
      "public-reachability",
      "Public MCP URL reachability (provider-facing tools/list)",
      "fail",
      `public tools/list returned HTTP ${result.status}`,
      "The hosted endpoint rejected the minted Bearer (origin/audience mismatch). " +
        "Re-run `cinatra setup dev` so the public URL + trusted origins reconcile.",
    );
  }
  // Require the SAME exact CMS-write tool as the local check (codex must-fix: a
  // stale/wrong public endpoint exposing only generic tools must NOT pass the
  // provider-facing half of the content-editor gate).
  const cmsWriteTool = result.tools.find((name) => DOCTOR_CMS_WRITE_TOOLS.includes(name));
  if (result.tools.length > 0 && cmsWriteTool) {
    return makeAssertion(
      "public-reachability",
      "Public MCP URL reachability (provider-facing tools/list)",
      "pass",
      `public endpoint answered tools/list with ${result.tools.length} tool(s); CMS-write tool present (${cmsWriteTool})`,
    );
  }
  return makeAssertion(
    "public-reachability",
    "Public MCP URL reachability (provider-facing tools/list)",
    "fail",
    result.tools.length === 0
      ? "public tools/list returned 0 tools"
      : `public tools/list has ${result.tools.length} tool(s) but no CMS-write tool (expected one of: ${DOCTOR_CMS_WRITE_TOOLS.join(", ")}) — the public endpoint may be stale/wrong`,
    "Confirm the public MCP URL points at THIS instance and the content-publishing extension is active; re-run `cinatra setup dev`.",
  );
}

// Run a docker read (`docker ps` / `docker exec ... <read-only command>`) via the
// injected runner. Returns { ok, stdout } — never throws. Read-only only.
function doctorDockerRun(dockerImpl, args) {
  try {
    const r = dockerImpl(args);
    return { ok: (r?.status ?? -1) === 0, stdout: typeof r?.stdout === "string" ? r.stdout : "" };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function doctorContainerRunning(dockerImpl, containerName) {
  const r = doctorDockerRun(dockerImpl, [
    "ps",
    "--filter",
    `name=^/${containerName}$`,
    "--format",
    "{{.Names}}",
  ]);
  return r.ok && r.stdout.trim() === containerName;
}

// HEAD/GET an HTTP path without a secret, returning the status code (or null on a
// transport error/timeout). Read-only reachability/route-presence only.
async function doctorHttpStatus({ url, fetchImpl, method = "GET" }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOCTOR_HTTP_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { method, signal: controller.signal });
    return response.status;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Classify a no-secret route-presence probe like the runtime classifiers
// (src/lib/drupal-mcp-connection.ts, src/lib/wordpress-mcp-connection.ts):
//   - 200 / 401 / 403 / 405 → "present" (the route exists; auth-gated or
//     HEAD-unsupported still proves the plugin/module is installed)
//   - 404                   → "not-installed" (the route/plugin is absent → FAIL)
//   - null (transport/timeout) OR ANY OTHER status (5xx, 3xx, unexpected) →
//     "unreachable" (codex must-fix: a 500/502/503/3xx is NOT proof of presence
//     and must SKIP, never PASS).
function classifyRouteStatus(status) {
  if (status === null || status === undefined) return "unreachable";
  if (status === 200 || status === 401 || status === 403 || status === 405) return "present";
  if (status === 404) return "not-installed";
  return "unreachable";
}

// Assertions 6+7 — WP container + plugin readiness (read-only). Probes WITHOUT
// any secret (codex must-fix: this is a READINESS proxy, NOT a credential-validity
// claim — a .mjs cannot read the Nango-stored secret). SKIP (never PASS) when
// docker/container/CMS is down.
async function doctorAssertWordPressReadiness({ fetchImpl, dockerImpl }) {
  const id = "wordpress-readiness";
  const label = "WordPress container + plugin readiness (read-only)";
  if (!doctorContainerRunning(dockerImpl, DOCTOR_WORDPRESS.containerName)) {
    return makeAssertion(
      id,
      label,
      "skip",
      `${DOCTOR_WORDPRESS.containerName} not running`,
      "Start the WordPress dev container (`docker compose --profile wordpress up -d`), then re-run `cinatra doctor`.",
    );
  }
  // Route-presence probe (no secret), classified like the runtime classifier:
  // 200/401/403/405 = present, 404 = not-installed (FAIL), null/5xx/3xx/other =
  // unreachable → SKIP (codex must-fix: a 500/502/503/3xx is NOT proof of presence).
  const adapterStatus = await doctorHttpStatus({
    url: `${DOCTOR_WORDPRESS.siteUrl}${DOCTOR_WORDPRESS.mcpAdapterPath}`,
    fetchImpl,
  });
  const adapterClass = classifyRouteStatus(adapterStatus);
  if (adapterClass === "unreachable") {
    return makeAssertion(
      id,
      label,
      "skip",
      `${DOCTOR_WORDPRESS.siteUrl} not answering the mcp-adapter route (HTTP ${adapterStatus ?? "no-response"}) — container booting?`,
      "Wait for WordPress to finish booting, then re-run `cinatra doctor`.",
    );
  }
  if (adapterClass === "not-installed") {
    return makeAssertion(
      id,
      label,
      "fail",
      `mcp-adapter route absent (HTTP ${adapterStatus}) — the WP MCP plugins are not active`,
      "Re-run the WP container entrypoint / `cinatra setup dev`; ensure cinatra, abilities-api, and mcp-adapter are active.",
    );
  }
  // Read-only plugin-active list via wp-cli.
  const pluginList = doctorDockerRun(dockerImpl, [
    "exec",
    DOCTOR_WORDPRESS.containerName,
    "wp",
    "plugin",
    "list",
    "--status=active",
    "--field=name",
    "--allow-root",
  ]);
  const activePlugins = pluginList.ok
    ? pluginList.stdout.split("\n").map((l) => l.trim()).filter(Boolean)
    : null;
  const missingPlugins =
    activePlugins === null
      ? null
      : DOCTOR_WORDPRESS.requiredPlugins.filter((p) => !activePlugins.includes(p));
  if (missingPlugins === null) {
    // Route present but couldn't list plugins (wp-cli unavailable) — readiness
    // is partially proven; do not claim PASS, warn.
    return makeAssertion(
      id,
      label,
      "skip",
      `mcp-adapter route present (HTTP ${adapterStatus}) but wp-cli plugin list was unavailable`,
      "Re-run `cinatra doctor` once wp-cli is reachable in the container.",
    );
  }
  if (missingPlugins.length > 0) {
    return makeAssertion(
      id,
      label,
      "fail",
      `inactive required plugin(s): ${missingPlugins.join(", ")}`,
      "Activate the missing plugin(s) or re-run the WP entrypoint / `cinatra setup dev`.",
    );
  }
  return makeAssertion(
    id,
    label,
    "pass",
    `container up; mcp-adapter route present (HTTP ${adapterStatus}); active: ${DOCTOR_WORDPRESS.requiredPlugins.join(", ")}`,
  );
}

// Drupal container + module readiness (read-only, no secret).
async function doctorAssertDrupalReadiness({ fetchImpl, dockerImpl }) {
  const id = "drupal-readiness";
  const label = "Drupal container + module readiness (read-only)";
  if (!doctorContainerRunning(dockerImpl, DOCTOR_DRUPAL.containerName)) {
    return makeAssertion(
      id,
      label,
      "skip",
      `${DOCTOR_DRUPAL.containerName} not running`,
      "Start the Drupal dev container (`docker compose --profile drupal up -d`), then re-run `cinatra doctor`.",
    );
  }
  // `/_mcp_tools` is served only when the cinatra mcp_tools route is installed.
  // Classify like src/lib/drupal-mcp-connection.ts: 200/401/403/405 = present,
  // 404 = not_installed (FAIL), null/5xx/3xx/other = unreachable → SKIP (codex
  // must-fix: a 500/502/503/3xx is NOT proof of presence).
  const status = await doctorHttpStatus({
    url: `${DOCTOR_DRUPAL.siteUrl}${DOCTOR_DRUPAL.mcpToolsPath}`,
    fetchImpl,
  });
  const routeClass = classifyRouteStatus(status);
  if (routeClass === "unreachable") {
    return makeAssertion(
      id,
      label,
      "skip",
      `${DOCTOR_DRUPAL.siteUrl} not answering /_mcp_tools (HTTP ${status ?? "no-response"}) — container booting?`,
      "Wait for Drupal to finish booting, then re-run `cinatra doctor`.",
    );
  }
  if (routeClass === "not-installed") {
    return makeAssertion(
      id,
      label,
      "fail",
      `/_mcp_tools route absent (HTTP ${status}) — the cinatra module is not enabled`,
      "Enable the cinatra Drupal module or re-run the Drupal entrypoint / `cinatra setup dev`.",
    );
  }
  const moduleList = doctorDockerRun(dockerImpl, [
    "exec",
    DOCTOR_DRUPAL.containerName,
    "drush",
    "--root=/drupal/web",
    "pm:list",
    "--status=enabled",
    "--field=name",
  ]);
  const enabledModules = moduleList.ok
    ? moduleList.stdout.split("\n").map((l) => l.trim()).filter(Boolean)
    : null;
  if (enabledModules === null) {
    return makeAssertion(
      id,
      label,
      "skip",
      `/_mcp_tools route present (HTTP ${status}) but drush module list was unavailable`,
      "Re-run `cinatra doctor` once drush is reachable in the container.",
    );
  }
  if (!enabledModules.includes(DOCTOR_DRUPAL.requiredModule)) {
    return makeAssertion(
      id,
      label,
      "fail",
      `the "${DOCTOR_DRUPAL.requiredModule}" module is not enabled`,
      "Enable the cinatra Drupal module (`drush en cinatra`) or re-run `cinatra setup dev`.",
    );
  }
  return makeAssertion(
    id,
    label,
    "pass",
    `container up; /_mcp_tools route present (HTTP ${status}); "${DOCTOR_DRUPAL.requiredModule}" module enabled`,
  );
}

// Assertion 8 — dev-app clone presence. The WP plugin + Drupal module clones must
// exist on disk (they are gitignored; `cinatra setup dev` syncs them). Pure fs.
function doctorAssertDevAppsPresence(repoRoot) {
  const config = readDevAppsConfig(repoRoot);
  const id = "dev-apps-presence";
  const label = "Dev-app clones present (wordpress-plugin + drupal-module)";
  if (!config) {
    return makeAssertion(
      id,
      label,
      "skip",
      "no cinatra.devApps config found in package.json",
      null,
    );
  }
  // The two CMS dev-apps Step 5 is scoped to MUST both be declared AND present.
  // Codex must-fix: do NOT filter out an absent config ENTRY — a config that
  // exists but omits the WordPress or Drupal entry is itself a provisioning gap
  // (FAIL), not a silent pass on a partial set.
  const required = [
    { name: "@cinatra-ai/wordpress-plugin", relPath: config["@cinatra-ai/wordpress-plugin"]?.path },
    { name: "@cinatra-ai/drupal-module", relPath: config["@cinatra-ai/drupal-module"]?.path },
  ];
  const undeclared = required.filter((r) => typeof r.relPath !== "string" || !r.relPath);
  const missingClones = required.filter(
    (r) => typeof r.relPath === "string" && r.relPath && !existsSync(path.resolve(repoRoot, r.relPath)),
  );
  if (undeclared.length > 0 || missingClones.length > 0) {
    const undeclaredNote =
      undeclared.length > 0 ? `undeclared in cinatra.devApps: ${undeclared.map((r) => r.name).join(", ")}` : "";
    const missingNote =
      missingClones.length > 0 ? `missing clone(s): ${missingClones.map((m) => m.relPath).join(", ")}` : "";
    return makeAssertion(
      id,
      label,
      "fail",
      [undeclaredNote, missingNote].filter(Boolean).join("; "),
      "Run `cinatra setup dev` (without --skip-dev-apps) to clone the WordPress plugin + Drupal module " +
        "(and ensure both are declared in package.json `cinatra.devApps`).",
    );
  }
  return makeAssertion(
    id,
    label,
    "pass",
    `present: ${required.map((r) => r.relPath).join(", ")}`,
  );
}

// Run the full content-editor self-check. READ-ONLY. Returns
// { assertions: [...], counts: { pass, fail, skip } }. Dependencies (fetch,
// docker) are injectable for hermetic tests. Never throws past its boundary.
async function gatherDoctorReport({
  client,
  schemaName,
  env,
  repoRoot,
  fetchImpl = globalThis.fetch.bind(globalThis),
  dockerImpl = defaultDoctorDockerImpl,
} = {}) {
  const origin = resolveLocalOrigin(env);
  const assertions = [];

  // 1+2 — single AND.
  const access = await doctorAssertLlmMcpAccess(client, schemaName);
  assertions.push(access.assertion);

  // 3 — token mint (returns the token privately for 4+5).
  const mint = await doctorAssertTokenMint({ origin, providers: access.providers, fetchImpl });
  assertions.push(mint.assertion);

  // 4 — local tools/list.
  assertions.push(await doctorAssertLocalToolsList({ origin, token: mint.token, fetchImpl }));

  // 5 — public reachability (real e2e proof).
  assertions.push(
    await doctorAssertPublicReachability({ publicMcpUrl: access.publicMcpUrl, token: mint.token, fetchImpl }),
  );

  // 6+7 — WP/Drupal container + plugin/module readiness.
  assertions.push(await doctorAssertWordPressReadiness({ fetchImpl, dockerImpl }));
  assertions.push(await doctorAssertDrupalReadiness({ fetchImpl, dockerImpl }));

  // 8 — dev-app clone presence.
  assertions.push(doctorAssertDevAppsPresence(repoRoot));

  const counts = { pass: 0, fail: 0, skip: 0 };
  for (const a of assertions) counts[a.verdict] += 1;
  return { assertions, counts };
}

// Default read-only docker runner (spawnSync). Overridable in tests.
function defaultDoctorDockerImpl(args) {
  return spawnSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: DOCKER_CLI_PROBE_TIMEOUT_MS,
  });
}

// Pretty-print one assertion line. Statuses/booleans only — never a secret.
function printDoctorAssertion(a) {
  const glyph = a.verdict === "pass" ? "✓" : a.verdict === "fail" ? "✗" : "⚠";
  const tag = a.verdict.toUpperCase();
  console.log(`  ${glyph} [${tag}] ${a.label}: ${a.detail}`);
  if (a.verdict !== "pass" && a.remediation) {
    console.log(`        ↳ ${a.remediation}`);
  }
}

// Print the report. `tail` mode (setup tail) frames it as a non-fatal self-check;
// standalone mode frames it as the authoritative gate.
function printDoctorReport(report, { mode } = {}) {
  console.log(
    mode === "tail"
      ? "\n- Content-editor self-check (`cinatra doctor`):"
      : "Cinatra content-editor write-path self-check:",
  );
  for (const a of report.assertions) printDoctorAssertion(a);
  console.log(
    `  Summary: ${report.counts.pass} pass, ${report.counts.fail} fail, ${report.counts.skip} skip.`,
  );
  if (report.counts.skip > 0) {
    console.log(
      "  Some checks were SKIPPED (a dependency was down — they are NOT passes). " +
        "Re-run `cinatra doctor` after `pnpm dev` (and the CMS containers) are up; " +
        "it is the authoritative post-boot gate.",
    );
  }
}

// Standalone `cinatra doctor` (alias: `cinatra mcp llm-access verify`). Opens its
// own pg client, prints the report, and exits non-zero on any FAIL (the
// authoritative post-boot gate). A SKIP alone warns + exits 0 unless --strict.
async function runDoctor(rest = []) {
  const strict = rest.includes("--strict");
  const repoRoot = getRepoRoot();
  const env = collectEnvironment(repoRoot);
  const connectionString = requiredEnv(env, "SUPABASE_DB_URL");
  const schemaName = env.SUPABASE_SCHEMA?.trim() || "cinatra";
  const client = createClient(connectionString);
  await client.connect();
  let report;
  try {
    report = await gatherDoctorReport({ client, schemaName, env, repoRoot });
  } finally {
    await client.end();
  }
  printDoctorReport(report, { mode: "standalone" });
  if (report.counts.fail > 0) {
    process.exitCode = 1;
  } else if (strict && report.counts.skip > 0) {
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Post-extension-sync workspace re-link
// ---------------------------------------------------------------------------
//
// After an extension clone-back (`syncCinatraDevExtensions`), re-run
// `corepack pnpm install` so the freshly-cloned extension packages are linked
// into the pnpm workspace. pnpm only creates an extension's per-extension
// `node_modules` (and links its transitive deps) when the package is present on
// disk at install time, so a package cloned in AFTER the initial install stays
// unlinked — its host value-imports then fail at `pnpm dev` / `next build` with
// MODULE_NOT_FOUND. Guarded so a warm no-op sync (everything already present and
// up to date) does not pay a redundant install: re-install only when the sync
// actually cloned/reset a checkout, OR a synced extension is missing its
// `node_modules` (an interrupted earlier setup). Mirrors the install-after-
// provision that `setup clone` already performs for its own deps.
function extensionDeclaresInstallableDeps(pkgDir) {
  // Only dependencies / devDependencies / optionalDependencies cause pnpm to
  // create a per-package node_modules. A package with only peerDependencies (or
  // none at all) gets NO node_modules, so a "missing node_modules" check must
  // skip it — otherwise the guard would reinstall on every warm run forever.
  try {
    const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    const count = (o) => (o && typeof o === "object" ? Object.keys(o).length : 0);
    return count(pkg.dependencies) + count(pkg.devDependencies) + count(pkg.optionalDependencies) > 0;
  } catch {
    return false;
  }
}

function installAfterExtensionSync(repoRoot, syncResult, { failHard = false } = {}) {
  const results = syncResult && Array.isArray(syncResult.results) ? syncResult.results : [];
  if (results.length === 0) return; // no-config / nothing matched / nothing synced
  // A real clone, a force-reset, a verified prod download ("downloaded"), or a
  // fast-forward that moved HEAD (changed===true) needs a re-link; a no-op
  // "updated"/"skipped-dirty"/"verified-existing" on a warm checkout does not.
  const materiallyChanged = results.some(
    (r) => r.action === "cloned" || r.action === "force-reset" || r.action === "downloaded" || r.changed === true,
  );
  // Recover an extension cloned by an earlier interrupted setup whose install
  // never ran (present but no node_modules) — gated on actually-declared deps so
  // zero-dep packages (which never get a node_modules) don't reinstall every run.
  const hydrationMissing = results.some(
    (r) =>
      r.dest &&
      existsSync(r.dest) &&
      extensionDeclaresInstallableDeps(r.dest) &&
      !existsSync(path.join(r.dest, "node_modules")),
  );
  if (!materiallyChanged && !hydrationMissing) return;
  console.log("- Linking cloned extensions into the workspace (corepack pnpm install)…");
  const install = spawnSync("corepack", ["pnpm", "install"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (install.status !== 0) {
    if (failHard) {
      // Prod path: a failed re-link means the bootable set is NOT linked —
      // abort (the caller runs this BEFORE any DB mutation).
      throw new Error(
        `Post-acquisition \`pnpm install\` failed (exit ${install.status}) — the required extensions are not ` +
          `linked into the workspace. Fix the install error and re-run.`,
      );
    }
    console.error(
      `\n⚠ Post-extension-sync \`pnpm install\` FAILED — cloned extensions may not be linked into the workspace. ` +
        `Re-run \`corepack pnpm install\` in ${repoRoot}, then start the app.\n`,
    );
    process.exitCode = 1;
  }
}

// Regenerate src/lib/generated/* against the extension tree actually on disk
// (presence-aware emission: the generator only emits a literal import for a
// module whose source file exists). Runs after the dev extension sync so the
// maps can never reference a module the synced set does not ship — the
// committed maps track the maintainer-synced set and go stale the moment a
// companion repo's main moves (the cinatra#109/#110 fresh-clone failure
// class). Loud-but-non-fatal, like the sync itself: a regeneration failure
// must not abort an otherwise-complete dev setup. Dev-only by call site — the
// prod path acquires the lock-pinned set, which CI keeps consistent with the
// committed maps.
// Gate shared by every syncCinatraDevExtensions call site: regenerate ONLY
// after a successful, non-skipped sync that actually reconciled at least one
// extension. Regenerating from a tree the sync did not reconcile (throw,
// skip, or empty filter match) would presence-drop map entries for extensions
// that are merely missing, not absent.
function regenerateExtensionManifestAfterSync(repoRoot, syncResult, { failed = false } = {}) {
  const reconciled =
    !failed &&
    syncResult &&
    syncResult.skipped !== true &&
    Array.isArray(syncResult.results) &&
    syncResult.results.length > 0;
  if (!reconciled) {
    console.log(
      "- Skipping extension-manifest regeneration (extension sync failed, was skipped, or matched nothing) — the committed generated maps stay as-is.",
    );
    return;
  }
  regenerateExtensionManifest(repoRoot);
}

// NOTE: the generator roots itself via import.meta.url (relative .mjs imports
// only, no workspace install needed), so spawning the WORKTREE's copy of the
// script — relative path + cwd — regenerates that worktree's maps.
function regenerateExtensionManifest(repoRoot) {
  console.log("- Regenerating the extension manifest against the on-disk extension set…");
  const generator = path.join("scripts", "extensions", "generate-extension-manifest.mjs");
  const regen = spawnSync(process.execPath, [generator], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (regen.status !== 0) {
    console.error(
      `\n⚠ Extension-manifest regeneration FAILED (exit ${regen.status}) — the generated maps may reference ` +
        `modules your synced extensions do not ship. Re-run \`node ${generator}\` ` +
        `in ${repoRoot}, then start the app.\n`,
    );
    process.exitCode = 1;
    return;
  }
  // The generator's write mode logs catalog-parity issues but exits 0; the
  // fail-closed verdict lives in the check (drift trivially passes right after
  // a write, so this is purely the parity + self-consistency gate). A parity
  // break means a catalog descriptor lost its loader coverage — surface it
  // loudly instead of calling the regeneration a success. `--self` is the
  // NON-CANONICAL check mode (cinatra#7): this tree's presence universe
  // is whatever the sync materialized, so the check verifies the REGENERATED
  // output against a fresh emission for this tree and never binds the
  // committed maps (which track the canonical clone-back universe).
  const check = spawnSync(process.execPath, [generator, "--check", "--self"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (check.status !== 0) {
    console.error(
      `\n⚠ Extension-manifest parity check FAILED after regeneration (exit ${check.status}) — a connector-catalog ` +
        `descriptor is not covered by the regenerated maps (see lines above). The app may render that connector ` +
        `degraded until the extension set is fixed.\n`,
    );
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Agent skill auto-registration at setup time
// ---------------------------------------------------------------------------
//
// The walker (compileAndRegisterAgentSkillsViaPg + helpers) lives in
// @cinatra-ai/skills/cli (packages/skills/src/cli.mjs) and is dynamically
// imported at the call site below to avoid pulling in the server-only
// barrel from this plain-Node CLI.

async function runSetup(mode, { skipDevApps = false } = {}) {
  const repoRoot = getRepoRoot();
  const env = collectEnvironment(repoRoot);
  const runtimeMode = readConfiguredRuntimeMode(env);
  const connectionString = requiredEnv(env, "SUPABASE_DB_URL");
  const authSecret = requiredEnv(env, "BETTER_AUTH_SECRET");
  const schemaName = env.SUPABASE_SCHEMA?.trim() || "cinatra";
  const publicBaseUrl = normalizeOptionalUrl(
    env.MCP_PUBLIC_BASE_URL ??
      env.APP_PUBLIC_URL ??
      env.BETTER_AUTH_URL ??
      env.NEXT_PUBLIC_BETTER_AUTH_URL,
  );
  // cinatra#260 Step 3 — an EXPLICIT public MCP URL the operator set via env.
  // Distinct from `publicBaseUrl`, which falls back to the localhost
  // BETTER_AUTH_URL; only `MCP_PUBLIC_BASE_URL` / `APP_PUBLIC_URL` are operator
  // intent to PUBLISH. When present (and non-localhost) the dev-main
  // self-establish step stands down (codex must-fix: respect operator URLs).
  const explicitOperatorPublicUrl =
    normalizeOptionalUrl(env.MCP_PUBLIC_BASE_URL) ??
    normalizeOptionalUrl(env.APP_PUBLIC_URL);
  const hasExplicitOperatorPublicUrl =
    Boolean(explicitOperatorPublicUrl) && !isLocalhostUrl(explicitOperatorPublicUrl);
  const expectedRuntimeMode = mode === "prod" ? "production" : "development";

  if (runtimeMode !== expectedRuntimeMode) {
    throw new Error(
      `Configured app runtime mode is "${runtimeMode}", but "${mode}" setup was requested. ` +
        `Update CINATRA_RUNTIME_MODE or use the matching setup command.`,
    );
  }

  if (mode === "prod") {
    // Acquire the required-extension bootable set BEFORE any DB mutation:
    // pinned codeload tarballs verified against the committed lock (see
    // prod-extension-acquisition.mjs). Inside the standalone runtime image
    // (positively detected by its root server.js + .next/) this is a
    // documented no-op — the extension source was baked at image build. Any
    // acquisition or re-link failure throws here, so a half-acquired tree
    // can never be followed by DB setup.
    const { acquireProdRequiredExtensions } = await import("./prod-extension-acquisition.mjs");
    const acquisition = await acquireProdRequiredExtensions({ repoRoot });
    installAfterExtensionSync(repoRoot, acquisition, { failHard: true });
  }

  const client = createClient(connectionString);
  await client.connect();

  try {
    const bootstrapNangoSettings = await discoverBootstrapNangoSettings(env, runtimeMode);
    const migration = await maybeRunBetterAuthMigrate(client, repoRoot, {
      connectionString,
      secret: authSecret,
      baseURL: env.BETTER_AUTH_URL,
    });
    // Probe BEFORE the bootstrap creates base tables: a schema with no
    // `metadata` table has never been set up or booted, so the core migration
    // chain below must be ledger-FAKED, not executed — the idempotent
    // bootstrap DDL produces the current (post-migration) shape on fresh
    // databases, and executing historical ALTERs against the base tables
    // `ensureStoreSchema` creates would fail (cinatra#116).
    const freshCoreSchema = await isFreshCoreSchema(client, schemaName);
    await ensureStoreSchema(client, schemaName);
    // Versioned core schema migrations (node-pg-migrate; shared ledger
    // `pgmigrations` in the app schema). Runs on its own short-lived client
    // under the `cinatra-schema-init` advisory lock — the setup client above
    // must not inherit the runner's session-level search_path. A failure
    // aborts setup loudly: continuing would hand later setup steps a
    // half-migrated schema.
    const coreMigrations = await runCoreMigrations({
      connectionString,
      schemaName,
      rootDir: repoRoot,
      direction: "up",
      fake: freshCoreSchema,
    });
    const defaultOrg = await ensureDefaultOrganization(client);
    const nangoSettings = await ensureNangoSettings(client, schemaName, bootstrapNangoSettings);
    // cinatra#260 Step 3 — ownership-gate the "preserve existing" branch so a
    // dead auto-provisioned (tailscale-auto/-funnel) URL is NOT carried forward
    // in dev mode: it is ALWAYS superseded — either by an incoming explicit
    // operator URL (which then wins via the `incomingIsUsable` branch) or by
    // the later `ensureDevPublicMcpUrl` re-validation. Releasing it here (vs
    // preserving) is what lets an operator's `MCP_PUBLIC_BASE_URL` actually
    // replace a stale auto URL in the DB (codex must-fix). Operator-managed
    // ("manual") + legacy URLs still preserve as before.
    const ownershipGated = mode === "dev";
    const mcpSettings = await ensureMcpSettings(client, schemaName, publicBaseUrl, {
      ownershipGated,
    });
    const selfClient = await ensureSelfMcpClient(client, schemaName, mcpSettings);
    const llmAccess = await ensureLlmMcpAccess(client, schemaName, mcpSettings, mode);
    // Self-healing decryptable JWKS (dev only). Sequenced AFTER the OAuth-client
    // sync because it probes authoritatively via a real client_credentials token
    // mint (needs `selfClient`). Loud-but-non-fatal: an undecryptable-key heal,
    // an unreachable app, or any probe hiccup warns but never aborts setup.
    let jwksHeal = null;
    if (mode === "dev") {
      try {
        jwksHeal = await ensureDecryptableJwks(client, env, selfClient);
      } catch (err) {
        console.warn(
          `⚠ JWKS self-heal failed unexpectedly (continuing): ${err && err.message ? err.message : err}`,
        );
      }
    }
    // cinatra#260 Step 3 — self-establishing + self-healing public MCP URL
    // (dev only). Sequenced AFTER the OAuth/JWKS steps. Verifies the stored
    // `publicBaseUrl` is OWNED by source/ownership validation (live registered
    // Self.DNSName matches the predicted hostname — NOT a reachability probe,
    // so a fresh un-propagated URL is never torn down), (re)writes it from the
    // live DNSName when owned, and AUTO-BRINGS-UP the dev-main Funnel when it
    // is missing/down (owner decision). Strictly conditional + soft-fail: a
    // bring-up failure becomes a LOUD warning below, NEVER an aborted setup.
    let publicMcpUrl = null;
    if (mode === "dev") {
      try {
        publicMcpUrl = await ensureDevPublicMcpUrl({
          dbUrl: connectionString,
          schemaName,
          env,
          operatorUrl: { url: hasExplicitOperatorPublicUrl ? explicitOperatorPublicUrl : null },
        });
      } catch (err) {
        // Defensive — the helper never throws past its boundary, but any
        // escape must not abort setup.
        console.warn(
          `⚠ Public MCP URL self-establish failed unexpectedly (continuing): ${
            err && err.message ? err.message : err
          }`,
        );
        publicMcpUrl = {
          status: "errored",
          owned: false,
          broughtUp: false,
          publicBaseUrl: null,
          fixHint: "cinatra dev tunnel start",
        };
      }
    }
    const userCount = await readUserCount(client);

    // Auto-register agent skills from <repoRoot>/agents/.
    // Wrapped in try/catch — a missing agents/ tree, malformed SKILL.md, or
    // DB hiccup must NOT abort cinatra setup.
    let agentSkillsSummary = null;
    try {
      const { compileAndRegisterAgentSkillsViaPg } = await import("@cinatra-ai/skills/cli");
      agentSkillsSummary = await compileAndRegisterAgentSkillsViaPg({
        repoRoot,
        dbUrl: connectionString,
        schemaName,
      });
    } catch (err) {
      console.warn(
        `[setup] Agent skills auto-registration failed: ${err && err.message ? err.message : err}`,
      );
    }

    console.log(`Cinatra ${mode} setup complete.`);
    console.log(`- App runtime mode: ${runtimeMode}`);
    console.log(`- Better Auth: ${migration.action} (${migration.reason})`);
    console.log(`- Workspace store schema: ready (${schemaName})`);
    console.log(
      `- Core migrations: ${
        coreMigrations.ranNames.length === 0
          ? "up to date"
          : `${coreMigrations.faked ? "ledger-recorded (fresh schema)" : "applied"} ${coreMigrations.ranNames.length} (${coreMigrations.ranNames.join(", ")})`
      }`,
    );
    console.log(`- Default organization: ${defaultOrg.created ? 'created' : 'already exists'} (id: ${defaultOrg.id})`);
    console.log(
      `- Nango connection administration: ${
        nangoSettings.configured
          ? `configured${nangoSettings.source ? ` (${nangoSettings.source})` : ""}`
          : "not configured"
      }`,
    );
    // Step 3 establishes/re-validates the URL AFTER `mcpSettings.next` was
    // computed, so prefer its result for the summary. `null` means the step
    // did not establish an owned URL → fall back to the row value.
    const effectivePublicBaseUrl =
      (publicMcpUrl && publicMcpUrl.publicBaseUrl) ?? mcpSettings.next.publicBaseUrl ?? null;
    console.log(`- MCP public base URL: ${effectivePublicBaseUrl ?? "not configured"}`);
    if (publicMcpUrl) {
      console.log(
        `- Public MCP URL health: ${publicMcpUrl.status}${
          publicMcpUrl.broughtUp ? " (auto-brought-up the dev-main Funnel)" : ""
        }`,
      );
    }
    console.log(`- MCP self client: ${selfClient.clientId}`);
    if (llmAccess) {
      console.log(`- LLM MCP access: ${LLM_MCP_PROVIDERS.map((p) => p.id).join(", ")} (dev only)`);
    } else {
      console.log(`- LLM MCP access: skipped (production mode)`);
    }
    if (jwksHeal) {
      console.log(`- JWKS health: ${jwksHeal.status}${typeof jwksHeal.deleted === "number" && jwksHeal.deleted > 0 ? ` (regenerated ${jwksHeal.deleted})` : ""}`);
    }
    // cinatra#260 Step 3 — LOUD actionable warning when no public MCP URL could
    // be established. Naming the ONE command to fix it keeps setup usable for
    // developers who don't need the public URL (they get this warning, not a
    // failure or hang). Suppressed when an operator URL is in force or an owned
    // URL was (re)established.
    if (publicMcpUrl && !publicMcpUrl.owned && publicMcpUrl.fixHint) {
      console.warn(
        `\n⚠ Public MCP URL not established (status: ${publicMcpUrl.status}).\n` +
          `  Hosted LLM MCP clients (e.g. the OpenAI connector) cannot reach this\n` +
          `  dev instance until a public URL is set. To establish it, run:\n` +
          `      ${publicMcpUrl.fixHint}\n` +
          `  (Or paste an operator-managed public URL at\n` +
          `   /configuration/development?tab=tunnel.) Setup is otherwise complete.\n`,
      );
    }
    console.log(
      userCount === 0
        ? "- First-user bootstrap: ready. The first registered account will become the initial full-access admin."
        : `- First-user bootstrap: skipped because ${userCount} Better Auth user(s) already exist.`,
    );
    if (agentSkillsSummary) {
      console.log(
        `- Agent skills: registered ${agentSkillsSummary.registered.length} (skipped ${agentSkillsSummary.skipped.length})`,
      );
    } else {
      console.log("- Agent skills: skipped");
    }

    // Dev-mode: announce the auto-wiring that runs on next dev-server boot.
    // The actual work is performed by the boot self-heal hook in
    // src/instrumentation.node.ts (dev-mode-gated), which can do the work
    // in-process — necessary because the auto-setup module transitively
    // imports `server-only`, so it cannot be invoked from a standalone tsx
    // subprocess outside the Next.js runtime. Boot-time is the right place
    // anyway: it's idempotent + soft-fails + invisible to the operator.
    if (mode === "dev") {
      // Sync the WordPress plugin + Drupal module clones into the working tree
      // so the dev docker stack + boot auto-setup find them. Source of truth is
      // the companion repos (cinatra-ai/{wordpress-plugin,drupal-module}).
      // Loud-but-non-fatal: a clone/origin problem must not undo the DB setup
      // already done above; the printed remediation tells the operator what to
      // fix (or pass --skip-dev-apps).
      try {
        await syncDevApps({
          repoRoot,
          targetRoot: repoRoot,
          // `dev refresh` passes an explicit skip so it never re-clones the
          // WordPress/Drupal app repos; every other caller keeps the legacy
          // ambient-argv behavior.
          argv: skipDevApps ? ["--skip-dev-apps"] : process.argv.slice(2),
        });
      } catch (err) {
        // Loud + non-zero exit (DB setup above is NOT rolled back), so a
        // wrong-origin / non-git / clone-or-fetch failure can't masquerade as a
        // clean setup. Dirty-tree is a non-throwing skip and stays exit 0.
        console.error(`\n⚠ Dev app sync FAILED:\n  ${err && err.message ? err.message : err}\n`);
        process.exitCode = 1;
      }
      // Clone the companion extension repos (cinatra-ai/<slug>) into
      // extensions/<scope>/<name>. Source of truth is the companion repos
      // (post-cutover); a no-op when `cinatraDevExtensions` is empty.
      // Loud-but-non-fatal, like the dev-app sync above.
      let extensionSync;
      let extensionSyncFailed = false;
      try {
        extensionSync = await syncCinatraDevExtensions({
          repoRoot,
          targetRoot: repoRoot,
          argv: skipDevApps ? ["--skip-dev-apps"] : process.argv.slice(2),
        });
      } catch (err) {
        extensionSyncFailed = true;
        console.error(`\n⚠ Dev extension sync FAILED:\n  ${err && err.message ? err.message : err}\n`);
        process.exitCode = 1;
      }
      // Re-link the freshly-cloned extensions into the workspace so their host
      // value-imports resolve at `pnpm dev` (guarded no-op on warm checkouts).
      installAfterExtensionSync(repoRoot, extensionSync);
      // Presence-aware regeneration of the generated extension maps
      // (cinatra#109/#110): the committed src/lib/generated/* maps are
      // byte-checked in CI against the synced extension set, but the companion
      // repos move independently of this tree — a fresh clone can sync
      // extension mains that drifted past the committed maps, leaving literal
      // `import("...")` specifiers that no longer resolve (Turbopack
      // module-not-found on /connectors). Regenerating right after the sync
      // keeps the maps matching the extension set actually on disk.
      // Gated on a successful, non-skipped, non-empty sync — see
      // regenerateExtensionManifestAfterSync.
      regenerateExtensionManifestAfterSync(repoRoot, extensionSync, {
        failed: extensionSyncFailed,
      });
      console.log(
        "- Dev auto-setup: local docker Drupal + WordPress will be auto-wired on next `pnpm dev` boot (idempotent; see src/lib/dev-auto-setup.ts).",
      );

      // cinatra#260 Step 5 — content-editor write-path self-check (the "done"
      // gate). READ-ONLY + idempotent. NON-FATAL at the setup tail: a FAIL or a
      // (meaningful) SKIP warns and sets process.exitCode = 1 but NEVER aborts —
      // matching the existing loud-non-fatal dev-app pattern above, so a
      // developer who only ran setup for a local dev DB is never blocked. The
      // standalone `cinatra doctor` is the authoritative post-boot gate. Wrapped
      // defensively: any escape from the helper must not undo the completed setup.
      try {
        const report = await gatherDoctorReport({
          client,
          schemaName,
          env,
          repoRoot,
        });
        printDoctorReport(report, { mode: "tail" });
        // codex must-fix — exit-code discipline at the SETUP TAIL: most chain
        // FAILs here are pre-boot-NORMAL (the app/CMS are not started by setup, a
        // public URL may not be established yet) and must NOT turn a successful
        // `cinatra setup dev` into a non-zero exit — that would block a developer
        // who only ran setup for a local dev DB. Those are surfaced as warnings
        // in the report; the STANDALONE `cinatra doctor` is the authoritative gate
        // that exits non-zero on every FAIL once the app is up. The ONE FAIL that
        // is an app-independent, always-real provisioning gap at setup time is the
        // dev-app clone presence — that flips the exit code, mirroring the
        // existing loud-non-fatal `process.exitCode = 1` of the dev-app sync above.
        // codex round-2 must-fix: when dev-apps are INTENTIONALLY skipped
        // (`--skip-dev-apps`, or `dev refresh` which passes skipDevApps:true),
        // the clones are absent BY DESIGN — that FAIL must NOT flip the exit
        // code (the warning still prints). Only flip when the clones were
        // expected to be synced this run.
        const devAppsIntentionallySkipped =
          skipDevApps || process.argv.slice(2).includes("--skip-dev-apps");
        const devAppsFail = report.assertions.find(
          (a) => a.id === "dev-apps-presence" && a.verdict === "fail",
        );
        if (devAppsFail && !devAppsIntentionallySkipped) {
          process.exitCode = 1;
        }
      } catch (err) {
        console.warn(
          `⚠ Content-editor self-check failed unexpectedly (continuing; setup is complete): ${
            err && err.message ? err.message : err
          }`,
        );
      }
    }
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// Core schema migrations (`cinatra db migrate [--down] [--count=N]`)
// ---------------------------------------------------------------------------
//
// Ops entry point for the node-pg-migrate runner (cinatra#116/#118): applies
// pending migrations/core/ modules, or reverts the newest core ledger rows
// with `--down`. Works in dev checkouts AND inside the standalone production
// image (packages/cli + migrations/ are both copied into the image):
//
//   docker exec <cid> node packages/cli/bin/cinatra.mjs db migrate --down
//
// Setup and the app boot pass apply pending migrations automatically; this
// command exists for manual remediation and rollback.
//
// `--dir <abs> --namespace <ns>` (always together) is the OPERATOR ESCAPE
// HATCH for a NON-core source (#118): point it at an extension's materialized
// migrations directory to revert (or re-apply) that extension's newest ledger
// rows — e.g. when a core `--down` is fenced off because an `ext_…` row is
// newest. The host applies extension migrations automatically at
// boot/install/hot-activate; this flag pair exists for remediation only.

async function runDbMigrate(rest) {
  // Strict argv parse for a DDL-applying command: every token must be a known
  // flag or the VALUE of a value-taking flag — a stray positional must fail
  // fast, never silently proceed to apply/revert migrations.
  const valueTakingFlags = new Set(["--count", "--dir", "--namespace"]);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--down") continue;
    if (valueTakingFlags.has(arg)) {
      i++; // the next token is this flag's value (readOptionValue consumes it)
      continue;
    }
    if ([...valueTakingFlags].some((f) => arg.startsWith(`${f}=`))) continue;
    throw new Error(
      `Unexpected argument "${arg}" for cinatra db migrate. Supported: --down, --count=N, --dir <abs> --namespace <ns>.`,
    );
  }
  const repoRoot = getRepoRoot();
  const env = collectEnvironment(repoRoot);
  const connectionString = requiredEnv(env, "SUPABASE_DB_URL");
  const schemaName = env.SUPABASE_SCHEMA?.trim() || "cinatra";
  const down = rest.includes("--down");
  const countRaw = readOptionValue(rest, "--count");
  let count;
  if (countRaw !== null) {
    count = Number(countRaw);
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`Invalid --count=${countRaw}. Expected a positive integer.`);
    }
  }
  const dirRaw = readOptionValue(rest, "--dir");
  const namespaceRaw = readOptionValue(rest, "--namespace");
  if ((dirRaw === null) !== (namespaceRaw === null)) {
    throw new Error("cinatra db migrate: --dir and --namespace must be provided together.");
  }
  let result;
  let label = "Core";
  if (dirRaw !== null) {
    if (!path.isAbsolute(dirRaw)) {
      throw new Error("cinatra db migrate: --dir must be an absolute path (the remediation target must not depend on cwd).");
    }
    label = namespaceRaw.replace(/__$/, "");
    // Namespace shape is validated by the runner itself (assertValidNamespace)
    // — a malformed/truncated namespace must never reach prefix fencing.
    result = await runNamespacedMigrations({
      connectionString,
      schemaName,
      dirAbs: dirRaw,
      namespace: namespaceRaw,
      direction: down ? "down" : "up",
      ...(count !== undefined ? { count } : {}),
    });
  } else {
    result = await runCoreMigrations({
      connectionString,
      schemaName,
      rootDir: repoRoot,
      direction: down ? "down" : "up",
      ...(count !== undefined ? { count } : {}),
    });
  }
  if (result.ranNames.length === 0) {
    console.log(`${label} migrations (${schemaName}): ${down ? "nothing to revert" : "up to date"}.`);
  } else {
    console.log(
      `${label} migrations (${schemaName}): ${down ? "reverted" : "applied"} ${result.ranNames.length} — ${result.ranNames.join(", ")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Dev environment refresh (`cinatra dev refresh`)
// ---------------------------------------------------------------------------
//
// Reconciles a contributor's local dev environment (dependencies + dev database
// schema) to the code they have checked out. The human owns git (pull /
// checkout); this command never touches it. It is the idempotent,
// non-destructive subset of `scripts/setup.sh` minus .env.local creation —
// dev-mode only, never updates extensions, never rebuilds images, never deploys.

async function runDevRefresh(rest) {
  const repoRoot = getRepoRoot();
  const envPath = path.join(repoRoot, ".env.local");

  // Guard 1: there must be an existing dev checkout to reconcile (clearest message
  // for the common "haven't set up yet" case; the mode guard below also fails closed).
  if (!existsSync(envPath)) {
    throw new Error(
      "No .env.local found. `cinatra dev refresh` reconciles an existing dev checkout — run `make setup` first.",
    );
  }

  // Read the RAW .env.local values — NOT collectEnvironment(), which overlays
  // process.env over the file. Reading the file directly makes it authoritative
  // so (a) a `CINATRA_RUNTIME_MODE=development` shell override cannot bypass a
  // production .env.local, and (b) the docker isolation markers below reflect the
  // worktree file rather than an inherited/global env that could mask them.
  const fileEnv = parseEnvFile(envPath);

  // Guard 2: dev mode only, fail-closed. The mode MUST be explicitly set in the
  // file (normalizeRuntimeMode treats blank/garbage as "development", so a bare
  // presence check is required) and must not resolve to production. Production
  // updates ship as release-tagged Docker images, never through this command.
  const fileMode = APP_RUNTIME_MODE_ENV_KEYS.map((key) =>
    typeof fileEnv[key] === "string" ? fileEnv[key].trim() : "",
  ).find((value) => value.length > 0);
  if (!fileMode) {
    throw new Error(
      "No CINATRA_RUNTIME_MODE set in .env.local. `cinatra dev refresh` reconciles an existing dev " +
        "checkout — run `make setup` first.",
    );
  }
  // Strict allowlist (fail-closed): normalizeRuntimeMode() maps ANY non-prod value
  // ("staging", typos, "production # comment") to "development", so it is far too
  // loose for a privileged guard. Require the file value to be exactly development.
  const fileModeLower = fileMode.toLowerCase();
  if (fileModeLower !== "development" && fileModeLower !== "dev") {
    throw new Error(
      `cinatra dev refresh is development-only, but .env.local has CINATRA_RUNTIME_MODE=${fileMode}. ` +
        "It reconciles local dev dependencies and schema only; it never modifies git or production data.",
    );
  }

  // Keep .env.local authoritative end-to-end. runSetup() below reads
  // collectEnvironment(), where process.env OVERRIDES the file — so an inherited
  // shell `SUPABASE_DB_URL` / `SUPABASE_SCHEMA` could silently redirect the
  // migration to a different (possibly non-local) database after this guard passed.
  // Refuse when a shell override differs from the file rather than reconcile the
  // wrong target. (Unset in a normal shell, so this only trips on an explicit export.)
  for (const key of ["SUPABASE_DB_URL", "SUPABASE_SCHEMA"]) {
    const shellValue = process.env[key];
    if (shellValue !== undefined && shellValue.trim() !== (fileEnv[key]?.trim() ?? "")) {
      throw new Error(
        `Refusing: ${key} is set in your shell environment and differs from .env.local. ` +
          "cinatra dev refresh targets the .env.local dev database — unset the override " +
          "(or run from a clean shell) and retry.",
      );
    }
  }

  const { dockerMode } = parseDevRefreshFlags(rest);
  const dockerDecision = describeDockerDecision({ dockerMode, env: fileEnv });

  console.log("Refreshing the dev environment to match the checked-out code…");

  // 1. Infrastructure: bring up the bundled docker stack (idempotent). Skipped for
  //    isolated worktrees/clones (they borrow the shared main stack) and external
  //    infra in `auto` mode. `--docker=always` forces it and treats failure as fatal;
  //    `auto` warns and continues (setup below fails loudly if the DB is unreachable).
  if (dockerDecision.run) {
    try {
      console.log(`- Infrastructure: docker compose up -d (${dockerDecision.reason})…`);
      runCommandOrThrow("docker", ["compose", "-f", "docker-compose.yml", "-f", "docker-compose.dev.yml", "up", "-d"], "Failed to start Docker containers.", {
        cwd: repoRoot,
      });
      waitForPostgres(repoRoot);
      waitForRedis(repoRoot);
      waitForNango(repoRoot);
      console.log("  Postgres, Redis, and Nango are ready.");
    } catch (err) {
      if (dockerMode === "always") {
        throw err;
      }
      console.warn(
        "⚠ Could not start/verify the docker stack (continuing — setup below will fail loudly if the " +
          `database is unreachable): ${err && err.message ? err.message : err}`,
      );
    }
  } else {
    console.log(`- Infrastructure: skipped (${dockerDecision.reason}).`);
  }

  // 2. Dependencies: plain install so an intentionally-changed lockfile is honored
  //    (frozen installs are for CI, not a contributor reconcile).
  console.log("- Dependencies: corepack pnpm install…");
  runCommandOrThrow(
    "corepack",
    ["pnpm", "install"],
    "Failed to install dependencies (corepack pnpm install).",
    { cwd: repoRoot },
  );

  // 3. Database + settings: the existing idempotent dev setup (additive bootstrap +
  //    ensure* settings) followed by the versioned core migration chain
  //    (migrations/core/, recorded in the pgmigrations ledger) — both run inside
  //    runSetup. Dev app sync is skipped to keep refresh fast.
  console.log("- Database + settings: running idempotent dev setup…");
  await runSetup("dev", { skipDevApps: true });

  // 4. Advisory: additive schema is reconciled automatically and the versioned
  //    migration chain has been applied (or ledger-faked on a fresh schema) by
  //    runSetup above — transformational changes no longer require manual,
  //    release-note-driven steps.
  console.log(
    "\n✔ Dev environment refreshed — dependencies, additive schema, and the versioned core migration chain (pgmigrations ledger) are in sync.",
  );
  console.log("  Restart your dev server: make dev");
}

// ---------------------------------------------------------------------------
// Branch isolation setup (for git worktrees)
// ---------------------------------------------------------------------------

function findFreePort(start, end) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      if (port > end) {
        reject(new Error(`No free port found between ${start} and ${end}.`));
        return;
      }
      const server = net.createServer();
      server.once("error", () => {
        tryPort(port + 1);
      });
      server.once("listening", () => {
        server.close(() => resolve(port));
      });
      server.listen(port, "127.0.0.1");
    };
    tryPort(start);
  });
}

/**
 * Resolve the worktree's current branch name in a way that NEVER returns
 * the literal string "HEAD" for a
 * detached worktree (which would defeat the collision guard). Tries:
 *   1. `git symbolic-ref --short HEAD` — fails fast in detached state
 *   2. Original branch from an in-progress rebase
 *      (rebase-merge/head-name or rebase-apply/head-name in $GIT_DIR)
 *   3. Returns null — callers decide whether to fall back to slug or SKIP
 */
function resolveRealBranchName(worktreePath) {
  // (1) symbolic-ref — non-zero exit on detached HEAD.
  try {
    const out = execFileSync(
      "git",
      ["-C", worktreePath, "symbolic-ref", "--quiet", "--short", "HEAD"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    )
      .toString()
      .trim();
    if (out) return out;
  } catch {
    // Detached — fall through.
  }
  // (2) Try to recover the original branch from in-progress rebase state.
  try {
    const gitDir = execFileSync(
      "git",
      ["-C", worktreePath, "rev-parse", "--git-dir"],
      { encoding: "utf8" },
    )
      .toString()
      .trim();
    if (gitDir) {
      const absGitDir = path.isAbsolute(gitDir)
        ? gitDir
        : path.resolve(worktreePath, gitDir);
      for (const rel of ["rebase-merge/head-name", "rebase-apply/head-name"]) {
        const candidate = path.join(absGitDir, rel);
        if (existsSync(candidate)) {
          const raw = readFileSync(candidate, "utf8").trim();
          // head-name looks like `refs/heads/feature-foo` — strip the prefix.
          return raw.replace(/^refs\/heads\//, "");
        }
      }
    }
  } catch {
    // Fall through.
  }
  return null;
}

function sanitizeBranchSlug(branch) {
  let candidate = String(branch ?? "").trim();
  if (!candidate) {
    return "";
  }
  return candidate
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
}

function serializeEnv(envObj, sourceOrder) {
  const written = new Set();
  const lines = [];
  for (const key of sourceOrder) {
    if (key in envObj) {
      lines.push(`${key}=${envObj[key]}`);
      written.add(key);
    }
  }
  for (const key of Object.keys(envObj)) {
    if (!written.has(key)) {
      lines.push(`${key}=${envObj[key]}`);
    }
  }
  return lines.join("\n") + "\n";
}

function readEnvFileOrdered(filePath) {
  const order = [];
  const values = {};
  if (!existsSync(filePath)) {
    return { order, values };
  }
  const raw = readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in values)) {
      order.push(key);
    }
    values[key] = value;
  }
  return { order, values };
}

async function runSetupNango() {
  const repoRoot = getRepoRoot();
  const env = collectEnvironment(repoRoot);
  const connectionString = requiredEnv(env, "SUPABASE_DB_URL");
  const schemaName = env.SUPABASE_SCHEMA?.trim() || "cinatra";
  const runtimeMode = readConfiguredRuntimeMode(env);

  const bootstrapNangoSettings = await discoverBootstrapNangoSettings(env, runtimeMode);
  const client = createClient(connectionString);
  await client.connect();
  try {
    const result = await ensureNangoSettings(client, schemaName, bootstrapNangoSettings);
    if (result.configured) {
      console.log(`Nango administration saved (source: ${result.source}, serverUrl: ${result.administration?.serverUrl ?? "default"}).`);
    } else {
      console.warn(
        "Nango secret key not found. Start the Nango container first (pnpm services), then re-run: cinatra setup nango",
      );
      process.exit(1);
    }
  } finally {
    await client.end().catch(() => null);
  }
}

async function runSetupBranch(argv) {
  // 1. Resolve paths
  const worktreePath = path.resolve(readOptionValue(argv, "--worktree-path") ?? process.cwd());

  let sourcePath = readOptionValue(argv, "--source-env");
  if (sourcePath) {
    sourcePath = path.resolve(sourcePath);
  } else {
    let mainRepoRoot;
    try {
      const commonDir = execFileSync(
        "git",
        ["-C", worktreePath, "rev-parse", "--path-format=absolute", "--git-common-dir"],
        { encoding: "utf8" },
      )
        .toString()
        .trim();
      if (!commonDir) {
        throw new Error("git rev-parse returned empty common-dir");
      }
      // Main repo root is the parent of the common .git directory
      mainRepoRoot = path.dirname(path.resolve(commonDir));
    } catch (error) {
      throw new Error(
        `Could not locate the main repo root via git: ${error.message}. ` +
          `Use --source-env <path> to point at the source .env.local.`,
      );
    }
    if (mainRepoRoot === worktreePath) {
      throw new Error(
        "Refusing to run setup branch on the main repo root — this would overwrite the source .env.local.",
      );
    }
    sourcePath = path.join(mainRepoRoot, ".env.local");
  }

  if (!existsSync(sourcePath)) {
    throw new Error(
      `Source .env.local not found at ${sourcePath}. Use --source-env <path> to override.`,
    );
  }

  // 2. Derive slug
  let slug = readOptionValue(argv, "--slug");
  let branch = null;
  if (!slug) {
    branch = resolveRealBranchName(worktreePath);
    if (!branch) {
      throw new Error(
        `Could not read git branch from ${worktreePath} ` +
          `(detached HEAD with no in-progress rebase, or git missing). ` +
          `Use --slug <slug> to override.`,
      );
    }
    slug = sanitizeBranchSlug(branch);
  }
  if (!/^[a-z0-9][a-z0-9-]{0,29}$/.test(slug)) {
    throw new Error(
      `Derived slug "${slug}" is invalid. Must match /^[a-z0-9][a-z0-9-]{0,29}$/. ` +
        `Use --slug <slug> to override.`,
    );
  }

  // Worktree-name collision guard. Blocks if the proposed slug names an
  // existing worktree directory or local branch in the same repo. `--force`
  // bypasses; intended for explicit resume of a still-named worktree.
  const force = argv.includes("--force");
  let guardRepoRoot = worktreePath;
  try {
    const commonDir = execFileSync(
      "git",
      ["-C", worktreePath, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8" },
    )
      .toString()
      .trim();
    if (commonDir) guardRepoRoot = path.dirname(path.resolve(commonDir));
  } catch {
    // Best-effort — fall back to worktreePath for the git invocations below.
  }
  const { runCollisionCheck, makeDefaultGitImpl, formatResult } = await import(
    "./worktree-collision-guard.mjs"
  );
  // Self-context — if `cinatra setup branch` is re-running inside the
  // already-provisioned worktree, that's not a collision.
  let selfBranch = null;
  try {
    selfBranch = execFileSync(
      "git",
      ["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"],
      { encoding: "utf8" },
    )
      .toString()
      .trim();
  } catch {
    // best-effort
  }
  const guardResult = runCollisionCheck({
    slug,
    repoRoot: guardRepoRoot,
    selfWorktreePath: worktreePath,
    selfBranch,
    ...makeDefaultGitImpl(guardRepoRoot),
  });
  const guardLine = formatResult(guardResult);
  if (guardResult.verdict === "COLLISION") {
    console.error(guardLine);
    if (!force) {
      throw new Error(
        `Worktree slug "${guardResult.slug}" already exists ` +
          `(${guardResult.kind}=${guardResult.path ?? guardResult.branch}). ` +
          `If you intend to reuse it, pass --force.`,
      );
    }
    console.error(`[collision-guard] --force set; proceeding despite the collision.`);
  } else {
    console.log(guardLine);
  }

  // 3. Derive port
  let port;
  const portFlag = readOptionValue(argv, "--port");
  if (portFlag) {
    const parsed = Number.parseInt(portFlag, 10);
    if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
      throw new Error(`Invalid --port ${portFlag}. Must be an integer between 1024 and 65535.`);
    }
    port = parsed;
  } else {
    port = await findFreePort(3001, 3099);
  }

  // 4. Read source env and build output env
  const { order: sourceOrder, values: sourceEnv } = readEnvFileOrdered(sourcePath);
  const outputEnv = { ...sourceEnv };

  let schemaName = `cinatra_${slug.replace(/-/g, "_")}`;
  let queueName = `cinatra-bg-${slug}`;
  const baseUrl = `http://localhost:${port}`;

  outputEnv.PORT = String(port);
  outputEnv.SUPABASE_SCHEMA = schemaName;
  outputEnv.BULLMQ_QUEUE_NAME = queueName;
  outputEnv.BETTER_AUTH_URL = baseUrl;
  outputEnv.NEXT_PUBLIC_BETTER_AUTH_URL = baseUrl;
  // LANGGRAPH_CINATRA_BASE_URL is no longer written. No runtime code reads it;
  // only old dev .env.local files may still carry it. The per-clone WayFlow
  // container consumes CINATRA_BASE_URL directly via compose env, not via the
  // host's .env.local.
  // TUNNEL_METRICS_PORT is also no longer set automatically; old worktrees may
  // still have a stale line, which can be removed by hand if needed.

  if ("NEXT_PUBLIC_APP_URL" in sourceEnv) {
    outputEnv.NEXT_PUBLIC_APP_URL = baseUrl;
  }
  if ("NEXT_PUBLIC_SITE_URL" in sourceEnv) {
    outputEnv.NEXT_PUBLIC_SITE_URL = baseUrl;
  }

  // 5. Write .env.local (or skip if already configured — migrations + seeding still run)
  const outPath = path.join(worktreePath, ".env.local");
  if (existsSync(outPath) && !argv.includes("--force")) {
    // .env.local exists — read it to get the schema this worktree is already wired to,
    // then skip to migrations + seeding so re-running setup branch is always safe.
    const { values: existingEnv } = readEnvFileOrdered(outPath);
    const existingSchema = existingEnv.SUPABASE_SCHEMA?.trim();
    if (!existingSchema) {
      throw new Error(
        `SUPABASE_SCHEMA missing from existing ${outPath}. Re-run with --force to recreate .env.local.`,
      );
    }
    console.log(`.env.local already exists — skipping .env.local write, running migrations + seeding for schema ${existingSchema}.`);
    schemaName = existingSchema;
    // Also reuse the existing queue name so the summary at the end reflects
    // what this worktree actually uses (not the slug-derived form). Cosmetic
    // only — fixes a small asymmetry that mirrored the teardown bug.
    const existingQueue = existingEnv.BULLMQ_QUEUE_NAME?.trim();
    if (existingQueue) {
      queueName = existingQueue;
    }
  } else {
    const content = serializeEnv(outputEnv, sourceOrder);
    writeFileSync(outPath, content, { mode: 0o600 });
  }

  // 6. Create & migrate the branch schema, then seed metadata from source schema
  const connectionString = sourceEnv.SUPABASE_DB_URL?.trim();
  if (!connectionString) {
    throw new Error(
      `SUPABASE_DB_URL missing from ${sourcePath}. Cannot provision the branch schema.`,
    );
  }
  const sourceSchemaName = sourceEnv.SUPABASE_SCHEMA?.trim() || "cinatra";
  const client = createClient(connectionString);
  await client.connect();
  try {
    // Fresh branch schemas ledger-FAKE the core migration chain (the
    // bootstrap produces the current shape); a re-run against an existing
    // branch schema applies real migrations. Probe before base tables exist.
    // Runs BEFORE the seed copy so the branch ledger reflects the chain the
    // copied (already-migrated) source rows were produced under.
    const freshCoreSchema = await isFreshCoreSchema(client, schemaName);
    await ensureStoreSchema(client, schemaName);
    const coreMigrations = await runCoreMigrations({
      connectionString,
      schemaName,
      rootDir: worktreePath,
      direction: "up",
      fake: freshCoreSchema,
    });
    console.log(
      `  Core migrations: ${coreMigrations.ranNames.length === 0 ? "up to date" : `${coreMigrations.faked ? "ledger-recorded" : "applied"} ${coreMigrations.ranNames.length}`}`,
    );
    // Seed all reference/business-data tables from source schema.
    // Skips operational tables (per-run state, audit trail, metrics) that should
    // start fresh on every branch. Seeds everything else so the branch has full
    // data parity with source on day one — objects (contacts, typed data),
    // agent_templates, skills, campaigns, model_pricing, MCP config, etc.
    // SEED_SKIP_TABLES is defined at module scope (shared with runRefreshSeed).
    const sourceTables = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
      [sourceSchemaName],
    ).catch(() => ({ rows: [] }));
    // Resolve primary key column per table — not always "id" (e.g. metadata uses "key").
    const pkResult = await client.query(
      `SELECT kcu.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1`,
      [sourceSchemaName],
    ).catch(() => ({ rows: [] }));
    const pkByTable = {};
    for (const { table_name, column_name } of pkResult.rows) {
      pkByTable[table_name] = column_name;
    }

    for (const { table_name } of sourceTables.rows) {
      if (SEED_SKIP_TABLES.has(table_name)) continue;
      // The migrations ledger is recorded by the runner above, never copied:
      // copying the source's rows would duplicate names under fresh serial
      // ids and could import history the branch's migrations/core does not
      // have. (Deliberately NOT in SEED_SKIP_TABLES — runRefreshSeed uses
      // that list to TRUNCATE, and truncating a clone's ledger would re-run
      // the whole chain against already-migrated data.)
      if (table_name === "pgmigrations") continue;
      const rows = await client.query(
        `SELECT * FROM ${quoteIdentifier(sourceSchemaName)}.${quoteIdentifier(table_name)}`,
      ).catch(() => ({ rows: [] }));
      if (rows.rows.length === 0) continue;
      const pk = pkByTable[table_name] ?? "id";
      let seeded = 0;
      for (const row of rows.rows) {
        const cols = Object.keys(row);
        const colNames = cols.map((c) => quoteIdentifier(c)).join(", ");
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
        const updateSet = cols
          .filter((c) => c !== pk)
          .map((c) => `${quoteIdentifier(c)} = EXCLUDED.${quoteIdentifier(c)}`)
          .join(", ");
        const conflict = updateSet
          ? `ON CONFLICT (${quoteIdentifier(pk)}) DO UPDATE SET ${updateSet}`
          : `ON CONFLICT (${quoteIdentifier(pk)}) DO NOTHING`;
        await client.query(
          `INSERT INTO ${quoteIdentifier(schemaName)}.${quoteIdentifier(table_name)} (${colNames}) VALUES (${placeholders}) ${conflict}`,
          cols.map((c) => row[c]),
        ).catch(() => {});
        seeded++;
      }
      console.log(`  Seeded ${seeded} ${table_name} rows from ${sourceSchemaName}`);
    }
  } finally {
    await client.end();
  }

  // Worktree symlink hygiene.
  // Detect and remove cross-worktree symlinks under packages/*/node_modules.
  // When a pnpm install runs from a sibling worktree root, sub-package
  // node_modules can end up as symlinks pointing outside this worktree's
  // filesystem root. Turbopack rejects these with
  //   "Symlink [project]/packages/X/node_modules is invalid, it points
  //    out of the filesystem root"
  // and the dev server fails on first compile. Auto-repair surfaces it at
  // setup time so the operator can run `pnpm install` once before `pnpm dev`.
  const repairedSymlinks = [];
  try {
    const packagesDir = path.join(worktreePath, "packages");
    if (existsSync(packagesDir)) {
      const { readdirSync, lstatSync, readlinkSync, unlinkSync } = await import("node:fs");
      const pkgEntries = readdirSync(packagesDir, { withFileTypes: true });
      for (const entry of pkgEntries) {
        if (!entry.isDirectory()) continue;
        const linkPath = path.join(packagesDir, entry.name, "node_modules");
        let stat;
        try {
          stat = lstatSync(linkPath);
        } catch {
          continue; // node_modules absent — fine, pnpm install will create
        }
        if (!stat.isSymbolicLink()) continue;
        const target = readlinkSync(linkPath);
        const absoluteTarget = path.isAbsolute(target)
          ? target
          : path.resolve(path.dirname(linkPath), target);
        // Cross-worktree if the target resolves outside the worktree's filesystem root.
        const isCrossWorktree = !absoluteTarget.startsWith(worktreePath + path.sep);
        // Broken if the target doesn't exist at all.
        const isBroken = !existsSync(absoluteTarget);
        if (isCrossWorktree || isBroken) {
          unlinkSync(linkPath);
          repairedSymlinks.push({
            link: path.relative(worktreePath, linkPath),
            target,
            reason: isBroken ? "broken" : "cross-worktree",
          });
        }
      }
    }
  } catch (err) {
    console.warn(
      `[setup] Worktree symlink hygiene scan skipped: ${err && err.message ? err.message : err}`,
    );
  }

  // 6b. Sync dev-app clones into THIS worktree (loud-but-
  // non-fatal — branch isolation above is already complete).
  try {
    await syncDevApps({
      repoRoot: resolveMainRepoRoot(worktreePath),
      targetRoot: worktreePath,
      argv,
    });
  } catch (err) {
    // Loud + non-zero exit (worktree/clone provisioning above stays intact), so
    // a wrong-origin / non-git / clone failure can't masquerade as clean setup.
    console.error(`⚠ Dev app sync FAILED: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  }

  // 6c. Sync the companion extension repos into THIS worktree (no-op until
  // `cinatraDevExtensions` is populated). Same loud-but-non-fatal posture.
  let branchExtensionSync;
  let branchExtensionSyncFailed = false;
  try {
    branchExtensionSync = await syncCinatraDevExtensions({
      repoRoot: resolveMainRepoRoot(worktreePath),
      targetRoot: worktreePath,
      argv,
    });
  } catch (err) {
    branchExtensionSyncFailed = true;
    console.error(`⚠ Dev extension sync FAILED: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  }
  // Keep THIS worktree's generated maps matching the extension set the sync
  // just put on its disk (cinatra#109/#110) — same gating as `setup dev`.
  regenerateExtensionManifestAfterSync(worktreePath, branchExtensionSync, {
    failed: branchExtensionSyncFailed,
  });

  // 7. Print summary
  console.log(`Branch isolation configured for worktree ${worktreePath}`);
  if (branch) {
    console.log(`  Branch:      ${branch}`);
  }
  console.log(`  Slug:        ${slug}`);
  console.log(`  Port:        ${port}`);
  console.log(`  Schema:      ${schemaName}`);
  console.log(`  Queue:       ${queueName}`);
  console.log(`  .env.local:  ${outPath}`);
  if (repairedSymlinks.length > 0) {
    console.log("");
    console.log(`Removed ${repairedSymlinks.length} cross-worktree / broken node_modules symlink(s):`);
    for (const { link, target, reason } of repairedSymlinks) {
      console.log(`  - ${link} -> ${target}  (${reason})`);
    }
    console.log(`  Run \`pnpm install\` in ${worktreePath} before \`pnpm dev\` to re-populate them locally.`);
  }
  console.log("");
  console.log(`Next: cd ${worktreePath} && pnpm install && pnpm dev`);
}

async function runTeardownBranch(argv) {
  // 1. Resolve worktree path
  const worktreePath = path.resolve(readOptionValue(argv, "--worktree-path") ?? process.cwd());

  // 2. Require --yes (destructive-action gate; checked BEFORE any git / DB work)
  if (!argv.includes("--yes")) {
    throw new Error("cinatra teardown branch is destructive. Re-run with --yes to confirm.");
  }

  // 3. Derive slug — prefer --slug, else read git branch
  let slug = readOptionValue(argv, "--slug");
  let branch = null;
  if (!slug) {
    try {
      branch = execFileSync(
        "git",
        ["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"],
        { encoding: "utf8" },
      )
        .toString()
        .trim();
    } catch (error) {
      throw new Error(
        `Could not read git branch from ${worktreePath}: ${error.message}. ` +
          `Use --slug <slug> to override.`,
      );
    }
    slug = sanitizeBranchSlug(branch);
  }
  if (!/^[a-z0-9][a-z0-9-]{0,29}$/.test(slug)) {
    throw new Error(
      `Derived slug "${slug}" is invalid. Must match /^[a-z0-9][a-z0-9-]{0,29}$/. ` +
        `Use --slug <slug> to override.`,
    );
  }

  // 4. Read the worktree's .env.local ONCE. It's the authoritative record of
  //    what schema and queue this worktree actually used at provisioning
  //    time. If it declares SUPABASE_SCHEMA / BULLMQ_QUEUE_NAME, those win
  //    over the slug-derived names — otherwise the teardown drops a phantom
  //    schema and leaves the real one orphaned (this exact bug shipped a real
  //    worktree schema into orphan-land before the
  //    fix). MAIN-REPO .env.local is deliberately NOT consulted here: it
  //    would point teardown at `SUPABASE_SCHEMA=cinatra`, which is the live
  //    app schema. See packages/cli/src/teardown-config.mjs for the guards.
  let connectionString;
  let worktreeEnvValues = null;
  const worktreeEnvPath = path.join(worktreePath, ".env.local");
  if (existsSync(worktreeEnvPath)) {
    worktreeEnvValues = readEnvFileOrdered(worktreeEnvPath).values;
    connectionString = worktreeEnvValues.SUPABASE_DB_URL?.trim();
  }
  const { schemaName, queueName, schemaSource, queueSource } = resolveTeardownNames({
    slug,
    envSchema: worktreeEnvValues?.SUPABASE_SCHEMA?.trim(),
    envQueue: worktreeEnvValues?.BULLMQ_QUEUE_NAME?.trim(),
    envSource: worktreeEnvValues ? worktreeEnvPath : undefined,
  });

  // 5. Connection-string fallback — main repo .env.local is fine for DB / Redis
  //    URLs (worktrees share the same Postgres + Redis host), but only as a
  //    LAST RESORT after the worktree's own value was already preferred above.
  if (!connectionString) {
    // Fall back to main repo .env.local — mirrors runSetupBranch's git-common-dir walk.
    try {
      const commonDir = execFileSync(
        "git",
        ["-C", worktreePath, "rev-parse", "--path-format=absolute", "--git-common-dir"],
        { encoding: "utf8" },
      )
        .toString()
        .trim();
      if (commonDir) {
        const mainRepoRoot = path.dirname(path.resolve(commonDir));
        const mainEnvPath = path.join(mainRepoRoot, ".env.local");
        if (existsSync(mainEnvPath)) {
          const { values } = readEnvFileOrdered(mainEnvPath);
          connectionString = values.SUPABASE_DB_URL?.trim();
        }
      }
    } catch {
      /* fall through to error below */
    }
  }
  if (!connectionString) {
    throw new Error(
      `SUPABASE_DB_URL not found in ${worktreeEnvPath} or the main repo .env.local. ` +
        `Cannot drop the branch schema.`,
    );
  }

  // 6. Drop the schema (quoteIdentifier prevents SQL injection via slug)
  const client = createClient(connectionString);
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
  } finally {
    await client.end();
  }

  // 7. Auto-remove Redis queue keys (BullMQ does not clean them up itself).
  //    Falls back to printing the manual command if redis-cli is unreachable.
  const redisUrl = readRedisUrl(worktreePath);
  const redisResult = cleanupRedisQueueKeys(queueName, redisUrl);
  let queueSummary;
  console.log("");
  if (redisResult.ok) {
    if (redisResult.deletedCount === 0) {
      console.log(`Redis: no bull:${queueName}:* keys found (already clean).`);
      queueSummary = "no keys present";
    } else {
      console.log(`Redis: removed ${redisResult.deletedCount} bull:${queueName}:* key(s).`);
      queueSummary = `${redisResult.deletedCount} keys removed`;
    }
  } else {
    console.log(`Redis cleanup skipped: ${redisResult.error}`);
    console.log("To clean up manually, run:");
    console.log(`  redis-cli --scan --pattern 'bull:${queueName}:*' | xargs redis-cli del`);
    queueSummary = "manual cleanup needed — see above";
  }
  console.log("");

  // 8. Print summary (mirrors runSetupBranch's style)
  console.log(`Branch teardown complete for worktree ${worktreePath}`);
  if (branch) {
    console.log(`  Branch:  ${branch}`);
  }
  console.log(`  Slug:    ${slug}`);
  console.log(`  Schema:  ${schemaName}  (DROPPED, source: ${schemaSource})`);
  console.log(`  Queue:   ${queueName}  (${queueSummary}, source: ${queueSource})`);
}

function readRedisUrl(worktreePath) {
  const worktreeEnvPath = path.join(worktreePath, ".env.local");
  if (existsSync(worktreeEnvPath)) {
    const { values } = readEnvFileOrdered(worktreeEnvPath);
    const url = values.REDIS_URL?.trim();
    if (url) return url;
  }
  try {
    const commonDir = execFileSync(
      "git",
      ["-C", worktreePath, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8" },
    )
      .toString()
      .trim();
    if (commonDir) {
      const mainRepoRoot = path.dirname(path.resolve(commonDir));
      const mainEnvPath = path.join(mainRepoRoot, ".env.local");
      if (existsSync(mainEnvPath)) {
        const { values } = readEnvFileOrdered(mainEnvPath);
        const url = values.REDIS_URL?.trim();
        if (url) return url;
      }
    }
  } catch {
    /* fall through to default */
  }
  return undefined;  // redis-cli defaults to 127.0.0.1:6379
}

// Parse a redis connection string into { host, port, isLoopback, parsed }.
// `parsed:false` means an explicit REDIS_URL was set but the host could not
// be determined — callers MUST then fail closed (no in-container runner),
// never silently assume loopback:6379, which could clean the wrong Redis /
// falsely release the slot. `ioredis` accepts protocol-less
// forms (`host:port`, bare `host`) as well as `redis://` / `rediss://`, so
// try a scheme-prefixed parse before giving up.
export function parseRedisTarget(redisUrl) {
  if (!redisUrl) {
    // No URL configured → redis-cli's documented default.
    return { host: "127.0.0.1", port: 6379, isLoopback: true, parsed: true };
  }
  let host = null;
  let port = 6379;
  for (const candidate of [redisUrl, `redis://${redisUrl}`]) {
    try {
      const u = new URL(candidate);
      if (u.hostname) {
        host = u.hostname.replace(/^\[|\]$/g, ""); // unbracket IPv6 [::1]
        if (u.port) port = Number.parseInt(u.port, 10);
        break;
      }
    } catch {
      /* try the scheme-prefixed form next */
    }
  }
  if (!host) {
    // Explicit but unparseable REDIS_URL → fail closed.
    return { host: null, port: null, isLoopback: false, parsed: false };
  }
  const isLoopback =
    host === "127.0.0.1" || host === "localhost" || host === "::1";
  return { host, port: Number.isFinite(port) ? port : 6379, isLoopback, parsed: true };
}

function cleanupRedisQueueKeys(queueName, redisUrl) {
  const pattern = `bull:${queueName}:*`;
  const target = parseRedisTarget(redisUrl);

  const runner = resolveRedisCliRunner(redisUrl, target);
  if (!runner) {
    return {
      ok: false,
      error:
        "no usable redis-cli (host redis-cli absent; and for a local Redis no " +
        "single container publishes the configured port — failing closed)",
    };
  }

  const scan = runner.run(["--scan", "--pattern", pattern]);
  if (scan.error || scan.status !== 0) {
    const detail = scan.error?.message || scan.stderr?.trim() || `exit code ${scan.status}`;
    return { ok: false, error: `redis-cli scan failed via ${runner.label} (${detail})` };
  }
  const keys = scan.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  if (keys.length === 0) {
    return { ok: true, deletedCount: 0 };
  }
  // Chunk the key list so a large queue cannot blow the argv limit (E2BIG)
  // — that would otherwise make prune fail for exactly the stale-key-heavy
  // case it exists to clean. UNLINK (non-blocking) when
  // available; redis-cli treats an unknown command as an error so fall back
  // to DEL on the first chunk if UNLINK is unsupported.
  let deletedCount = 0;
  let verb = "UNLINK";
  for (let i = 0; i < keys.length; i += 200) {
    const chunk = keys.slice(i, i + 200);
    let res = runner.run([verb, ...chunk]);
    if ((res.error || res.status !== 0) && verb === "UNLINK") {
      verb = "DEL";
      res = runner.run([verb, ...chunk]);
    }
    if (res.error || res.status !== 0) {
      const detail = res.error?.message || res.stderr?.trim() || `exit code ${res.status}`;
      return { ok: false, error: `redis-cli ${verb} failed via ${runner.label} (${detail})` };
    }
    const n = parseInt(String(res.stdout).trim(), 10);
    deletedCount += Number.isFinite(n) ? n : chunk.length;
  }
  return { ok: true, deletedCount };
}

// Resolve a redis-cli runner. The runner OWNS the connection target:
//  - host runner passes `-u <redisUrl>` (works for ANY url, incl. remote);
//  - in-container runners run plain `redis-cli` (default localhost:6379
//    INSIDE the matched Redis container) and are ONLY used when the clone's
//    Redis is loopback — a host-loopback URL means something different
//    inside an arbitrary container.
// Container identity is resolved UNAMBIGUOUSLY by the host port the clone's
// REDIS_URL actually targets: the single running container that publishes
// `<port>->6379/tcp` IS, by definition, the Redis it connects to. 0 or >1
// matches → no in-container runner (fail closed; never guess by name and
// risk DEL-ing the wrong project's keys / a false slot release).
function resolveRedisCliRunner(redisUrl, target) {
  // 1. Host redis-cli — authoritative for any URL (local or remote).
  const hostProbe = spawnSync("redis-cli", ["--version"], { encoding: "utf8" });
  if (!hostProbe.error && hostProbe.status === 0) {
    const urlArgs = redisUrl ? ["-u", redisUrl] : [];
    return {
      label: "host redis-cli",
      run: (args) => spawnSync("redis-cli", [...urlArgs, ...args], { encoding: "utf8" }),
    };
  }

  // In-container runners only make sense for a positively-parsed LOCAL
  // (loopback) Redis. A remote / non-loopback / unparseable REDIS_URL must
  // go through host redis-cli; if that's absent we fail closed rather than
  // exec into an unrelated local container.
  if (!target.parsed || !target.isLoopback) {
    return undefined;
  }

  // 2. The single container publishing the clone's Redis port. `docker ps`
  //    Ports look like `0.0.0.0:6379->6379/tcp, [::]:6379->6379/tcp`.
  const psProbe = spawnSync(
    "docker",
    ["ps", "--format", "{{.Names}}\t{{.Ports}}"],
    { encoding: "utf8" },
  );
  if (!psProbe.error && psProbe.status === 0) {
    // Require the published host port to map to Redis' standard INTERNAL
    // port 6379 (`<hostport>->6379/tcp`). Matching `->\d+/tcp` could pick a
    // container that merely publishes the port but whose in-container
    // `redis-cli` localhost:6379 is an unrelated Redis. A non-standard
    // internal port simply won't match
    // → fail closed (slot retained), which is safe.
    const portRe = new RegExp(`(?:^|[^0-9])${target.port}->6379/tcp`);
    const matches = psProbe.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf("\t");
        return tab === -1
          ? { name: line, ports: "" }
          : { name: line.slice(0, tab), ports: line.slice(tab + 1) };
      })
      .filter((c) => portRe.test(c.ports));
    if (matches.length === 1) {
      const container = matches[0].name;
      const execProbe = spawnSync(
        "docker",
        ["exec", "-i", container, "redis-cli", "--version"],
        { encoding: "utf8" },
      );
      if (!execProbe.error && execProbe.status === 0) {
        return {
          label: `docker exec ${container}`,
          run: (args) =>
            spawnSync("docker", ["exec", "-i", container, "redis-cli", ...args], {
              encoding: "utf8",
            }),
        };
      }
    }
    // 0 matches (Redis not in docker / not published) or >1 (ambiguous):
    // fall through → fail closed. Slot is retained; prune is idempotent.
  }

  return undefined;
}

// ===========================================================================
// Clone-on-demand: seed DB + dormant deep-fork clone provisioning.
//
//   cinatra clone refresh-seed   — (re)build the `cinatra_seed` template DB
//   cinatra setup clone          — provision a dormant clone for a worktree
//   cinatra clone prune --yes    — destroy a clone's DB + registry slot
//   cinatra clone list           — list registered clones
//
// A "clone" is a deep fork: a SEPARATE Postgres database `cinatra_clone_<slug>`
// (vs the light `cinatra setup branch`, which is a `cinatra_<slug>` *schema* in
// the shared `postgres` DB). Pure registry/slug/port logic lives in
// `./clone-registry.mjs`; this file owns the DB + filesystem side effects.
// ===========================================================================

// Resolve the source `.env.local` (the main repo's). Mirrors runSetupBranch's
// git-common-dir walk; honours an explicit --source-env override.
function resolveMainEnvPath(fromDir, explicitSourceEnv) {
  if (explicitSourceEnv) {
    const resolved = path.resolve(explicitSourceEnv);
    if (!existsSync(resolved)) {
      throw new Error(`Source .env.local not found at ${resolved}.`);
    }
    return resolved;
  }
  let mainRepoRoot;
  try {
    const commonDir = execFileSync(
      "git",
      ["-C", fromDir, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8" },
    )
      .toString()
      .trim();
    if (!commonDir) {
      throw new Error("git rev-parse returned empty common-dir");
    }
    mainRepoRoot = path.dirname(path.resolve(commonDir));
  } catch (error) {
    throw new Error(
      `Could not locate the main repo root via git: ${error.message}. ` +
        `Use --source-env <path> to point at the source .env.local.`,
    );
  }
  const envPath = path.join(mainRepoRoot, ".env.local");
  if (!existsSync(envPath)) {
    throw new Error(
      `Source .env.local not found at ${envPath}. Use --source-env <path> to override.`,
    );
  }
  return envPath;
}

function redactConnString(connectionString) {
  return String(connectionString).replace(/:\/\/([^:@/]+):[^@/]*@/, "://$1:***@");
}

async function runRefreshSeed(argv) {
  const repoRoot = getRepoRoot();
  const sourceEnvPath = resolveMainEnvPath(
    process.cwd(),
    readOptionValue(argv, "--source-env"),
  );
  const { values: sourceEnv } = readEnvFileOrdered(sourceEnvPath);
  const connectionString = sourceEnv.SUPABASE_DB_URL?.trim();
  if (!connectionString) {
    throw new Error(`SUPABASE_DB_URL missing from ${sourceEnvPath}.`);
  }
  const appSchema = sourceEnv.SUPABASE_SCHEMA?.trim() || "cinatra";
  if (appSchema !== "cinatra") {
    throw new Error(
      `cinatra clone refresh-seed only supports the default 'cinatra' app schema ` +
        `(found SUPABASE_SCHEMA=${appSchema}).`,
    );
  }

  const adminUrl = adminConnString(connectionString);
  const seedUrl = connStringForDatabase(connectionString, SEED_DB_NAME);
  const env = collectEnvironment(repoRoot);

  // 1. Drop any existing seed DB, then create a fresh empty one.
  let adminClient = createClient(adminUrl);
  await adminClient.connect();
  try {
    const exists = await adminClient.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [SEED_DB_NAME],
    );
    if (exists.rows.length > 0) {
      // It may be marked IS_TEMPLATE / ALLOW_CONNECTIONS false from a prior run.
      await adminClient.query(
        `ALTER DATABASE ${quoteIdentifier(SEED_DB_NAME)} WITH IS_TEMPLATE false ALLOW_CONNECTIONS true`,
      );
      await adminClient.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [SEED_DB_NAME],
      );
      await adminClient.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(SEED_DB_NAME)}`);
    }
    await adminClient.query(`CREATE DATABASE ${quoteIdentifier(SEED_DB_NAME)}`);
  } finally {
    await adminClient.end().catch(() => null);
  }

  // 2. Snapshot the live app DB into the seed DB (public + cinatra schemas only,
  //    so branch-worktree `cinatra_<slug>` schemas are excluded). Reuses the
  //    existing runPostgresCommand helper — host pg_dump/psql, or a pinned
  //    postgres:17-alpine docker client with host.docker.internal rewriting.
  const dumpFile = path.join(os.tmpdir(), `cinatra-seed-${Date.now()}-${process.pid}.sql`);
  try {
    runPostgresCommand(
      repoRoot,
      env,
      "pg_dump",
      [
        "--format=plain",
        // --clean --if-exists: a bare plain-format dump emits unconditional
        // `CREATE SCHEMA` statements; the freshly-CREATEd cinatra_seed already
        // carries `public`, and ANY schema collision aborts the ON_ERROR_STOP
        // restore (observed live: `schema "cinatra" already exists`). Emitting
        // `DROP SCHEMA IF EXISTS ...` first makes the restore idempotent — the
        // same flag set the proven `createBackupFile` helper uses.
        "--clean",
        "--if-exists",
        "--no-owner",
        "--no-privileges",
        "--schema=public",
        `--schema=${appSchema}`,
        `--file=${dumpFile}`,
        // Dump the ACTUAL configured app database (connectionString), not the
        // forced-/postgres adminUrl — if SUPABASE_DB_URL ever points at a
        // non-`postgres` database the snapshot must follow it.
        connectionString,
      ],
      "Seed snapshot (pg_dump) failed. Ensure pg_dump is installed or Docker is available.",
      { cwd: repoRoot },
    );
    runPostgresCommand(
      repoRoot,
      env,
      "psql",
      ["-v", "ON_ERROR_STOP=1", "-d", seedUrl, "-f", dumpFile],
      "Seed restore (psql) failed.",
      { cwd: repoRoot },
    );
  } finally {
    try {
      rmSync(dumpFile, { force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  }

  // 3. Scrub operational + volatile-auth tables inside the seed DB.
  const seedClient = createClient(seedUrl);
  await seedClient.connect();
  const scrubbedOps = [];
  const scrubbedAuth = [];
  try {
    for (const table of SEED_SKIP_TABLES) {
      const present = await seedClient.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
        [appSchema, table],
      );
      if (present.rows.length === 0) continue;
      await seedClient.query(
        `TRUNCATE ${quoteIdentifier(appSchema)}.${quoteIdentifier(table)} RESTART IDENTITY CASCADE`,
      );
      scrubbedOps.push(table);
    }
    // Mixed-case Better Auth identifiers — match exactly via pg_tables.tablename
    // and quote BOTH schema and table so Postgres does not lowercase them.
    for (const table of SEED_AUTH_SCRUB_TABLES) {
      const present = await seedClient.query(
        `SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = $1`,
        [table],
      );
      if (present.rows.length === 0) continue;
      await seedClient.query(
        `TRUNCATE ${quoteIdentifier("public")}.${quoteIdentifier(table)} CASCADE`,
      );
      scrubbedAuth.push(table);
    }

    // 4. Record seed provenance.
    let gitSha = "unknown";
    try {
      gitSha =
        execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" })
          .toString()
          .trim() || "unknown";
    } catch {
      /* best effort */
    }
    let sourceDb = "postgres";
    try {
      sourceDb = new URL(connectionString).pathname.slice(1) || "postgres";
    } catch {
      /* keep default */
    }
    const seedInfo = JSON.stringify({
      sourceDb,
      refreshedAt: new Date().toISOString(),
      gitSha,
    });
    await seedClient.query(
      `INSERT INTO ${quoteIdentifier(appSchema)}.metadata (key, value) VALUES ('clone_seed_info', $1) ` +
        `ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [seedInfo],
    );
  } finally {
    await seedClient.end().catch(() => null);
  }

  // 5. Mark the seed as a template and lock out regular connections.
  adminClient = createClient(adminUrl);
  await adminClient.connect();
  try {
    await adminClient.query(
      `ALTER DATABASE ${quoteIdentifier(SEED_DB_NAME)} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`,
    );
  } finally {
    await adminClient.end().catch(() => null);
  }

  // 6. Summary.
  console.log(`Seed database refreshed: ${SEED_DB_NAME}`);
  console.log(`  Source:          ${redactConnString(connectionString)}`);
  console.log(`  Scrubbed (ops):  ${scrubbedOps.join(", ") || "(none present)"}`);
  console.log(`  Scrubbed (auth): ${scrubbedAuth.join(", ") || "(none present)"}`);
  console.log(`  Marked:          IS_TEMPLATE true, ALLOW_CONNECTIONS false`);
  const reg = readRegistry(defaultRegistryPath());
  const existingCount = reg.registry ? Object.keys(reg.registry.clones).length : 0;
  if (existingCount > 0) {
    console.log("");
    console.log(
      `Note: ${existingCount} existing clone(s) were templated from the PREVIOUS seed ` +
        `and will NOT auto-update. Re-provision them if they need the refreshed data.`,
    );
  }
}

function firstPositionalArg(argv) {
  // Skip subcommand tokens; return the first non-flag token that is also not
  // the value consumed by a recognized --opt. We only need a coarse parse here:
  // the explicit options used by `setup clone` are all "--flag value" pairs.
  const valueFlags = new Set(["--slug", "--worktree-path", "--source-env"]);
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === "setup" || tok === "clone") continue;
    if (tok.startsWith("--")) {
      if (valueFlags.has(tok)) i += 1; // skip its value
      continue;
    }
    return tok;
  }
  return null;
}

// Resolve the main-repo root from any path inside the repo, using the exact
// pattern `runSetupBranch` uses (parent of the git common-dir).
function resolveMainRepoRoot(fromPath) {
  const commonDir = execFileSync(
    "git",
    ["-C", fromPath, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8" },
  )
    .toString()
    .trim();
  if (!commonDir) {
    throw new Error("git rev-parse returned empty common-dir");
  }
  return path.dirname(path.resolve(commonDir));
}

async function runSetupClone(argv) {
  // Heavy-clone ownership: when a slug/name is supplied, this
  // command CREATES the git worktree itself at ../cinatra-ai-<slug> on branch
  // cinatra-ai-<slug> from origin/main, then provisions + auto-installs deps.
  // With NO slug it preserves the legacy behavior: provision an
  // already-existing worktree derived from cwd's branch (no worktree creation).
  const explicitSlugRaw = readOptionValue(argv, "--slug") ?? firstPositionalArg(argv);
  let worktreeJustCreated = false;
  let cliOwnedWorktree = false;
  let targetWorktreePath = null;
  let cliBranchName = null;

  if (explicitSlugRaw != null) {
    const explicitSlug = String(explicitSlugRaw).trim();
    if (!/^[a-z0-9][a-z0-9-]{0,29}$/.test(explicitSlug)) {
      throw new Error(
        `Invalid clone name/slug "${explicitSlug}". ` +
          `Must match /^[a-z0-9][a-z0-9-]{0,29}$/ (lowercase, digits, dashes; max 30 chars).`,
      );
    }
    let mainRepoRoot;
    try {
      mainRepoRoot = resolveMainRepoRoot(process.cwd());
    } catch (error) {
      throw new Error(
        `Could not locate the main repo root via git: ${error.message}. ` +
          `Run 'cinatra setup clone <name>' from inside the cinatra repo.`,
      );
    }
    const parentDir = path.dirname(mainRepoRoot);
    targetWorktreePath = path.join(parentDir, `cinatra-ai-${explicitSlug}`);
    cliBranchName = `cinatra-ai-${explicitSlug}`;
    cliOwnedWorktree = true;

    // Create the worktree if absent (idempotent).
    let worktreeListed = "";
    try {
      worktreeListed = execFileSync(
        "git",
        ["-C", mainRepoRoot, "worktree", "list", "--porcelain"],
        { encoding: "utf8" },
      ).toString();
    } catch {
      worktreeListed = "";
    }
    const alreadyHasWorktree = worktreeListed
      .split("\n")
      .some((line) => line.startsWith("worktree ") && path.resolve(line.slice("worktree ".length)) === targetWorktreePath);

    if (!alreadyHasWorktree) {
      console.log(`Creating heavy-clone worktree at ${targetWorktreePath} (branch ${cliBranchName}, from origin/main)…`);
      runCommandOrThrow(
        "git",
        ["-C", mainRepoRoot, "fetch", "origin"],
        `git fetch origin failed (needed to base ${cliBranchName} on origin/main).`,
      );
      const addNewBranch = spawnSync(
        "git",
        ["-C", mainRepoRoot, "worktree", "add", targetWorktreePath, "-b", cliBranchName, "origin/main"],
        { stdio: "inherit", env: process.env },
      );
      if (addNewBranch.status !== 0) {
        // Branch likely already exists — retry attaching it without -b.
        runCommandOrThrow(
          "git",
          ["-C", mainRepoRoot, "worktree", "add", targetWorktreePath, cliBranchName],
          `git worktree add failed for ${targetWorktreePath} (branch ${cliBranchName}).`,
        );
      }
      worktreeJustCreated = true;
    } else {
      console.log(`Worktree ${targetWorktreePath} already exists — provisioning idempotently.`);
    }
  }

  const worktreePath = path.resolve(
    targetWorktreePath ??
      readOptionValue(argv, "--worktree-path") ??
      process.cwd(),
  );
  const sourceEnvPath = resolveMainEnvPath(
    worktreePath,
    readOptionValue(argv, "--source-env"),
  );
  if (path.dirname(sourceEnvPath) === worktreePath) {
    throw new Error(
      "Refusing to run setup clone on the main repo root — clones are for branch worktrees.",
    );
  }
  const { order: sourceOrder, values: sourceEnv } = readEnvFileOrdered(sourceEnvPath);
  const connectionString = sourceEnv.SUPABASE_DB_URL?.trim();
  if (!connectionString) {
    throw new Error(`SUPABASE_DB_URL missing from ${sourceEnvPath}.`);
  }
  const appSchema = sourceEnv.SUPABASE_SCHEMA?.trim() || "cinatra";
  if (appSchema !== "cinatra") {
    throw new Error(
      `cinatra setup clone only supports the default 'cinatra' app schema ` +
        `(found SUPABASE_SCHEMA=${appSchema}).`,
    );
  }

  // Slug — explicit --slug/positional name, else derived from the worktree branch.
  let slug = explicitSlugRaw != null ? String(explicitSlugRaw).trim() : null;
  let branch = null;
  if (!slug) {
    branch = resolveRealBranchName(worktreePath);
    if (!branch) {
      throw new Error(
        `Could not read git branch from ${worktreePath} (detached HEAD?). Use --slug <slug>.`,
      );
    }
    slug = cloneSlugFromBranch(branch);
  }
  if (!/^[a-z0-9][a-z0-9-]{0,29}$/.test(slug)) {
    throw new Error(
      `Derived slug "${slug}" is invalid. Must match /^[a-z0-9][a-z0-9-]{0,29}$/. Use --slug <slug>.`,
    );
  }
  const force = argv.includes("--force");

  // Early .env.local sanity check — runs BEFORE slot allocation so an obviously
  // incompatible worktree env (wired to a light branch env, or a different
  // clone) aborts without leaving a provisioning ghost slot in the registry.
  // The full strict per-key compare still runs after
  // allocation, since the same-slug "stale ports" case needs the allocated slot.
  const earlyEnvPath = path.join(worktreePath, ".env.local");
  if (existsSync(earlyEnvPath) && !force) {
    const existingSlug = readEnvFileOrdered(earlyEnvPath).values.CINATRA_CLONE_SLUG?.trim();
    if (existingSlug !== slug) {
      throw new Error(
        `${earlyEnvPath} exists and is ${
          existingSlug ? `wired to a different clone ("${existingSlug}")` : "not a clone env"
        } — refusing to provision clone "${slug}" over it. Re-run with --force to overwrite, ` +
          `or 'cinatra clone prune' the existing clone first.`,
      );
    }
  }

  // Verify the seed DB exists AND is a template.
  const adminUrl = adminConnString(connectionString);
  {
    const adminClient = createClient(adminUrl);
    await adminClient.connect();
    try {
      const seedRow = await adminClient.query(
        `SELECT datistemplate FROM pg_database WHERE datname = $1`,
        [SEED_DB_NAME],
      );
      if (seedRow.rows.length === 0) {
        throw new Error(
          `Seed database "${SEED_DB_NAME}" does not exist. Run: cinatra clone refresh-seed`,
        );
      }
      if (seedRow.rows[0].datistemplate !== true) {
        throw new Error(
          `Database "${SEED_DB_NAME}" exists but is not a template. Run: cinatra clone refresh-seed`,
        );
      }
    } finally {
      await adminClient.end().catch(() => null);
    }
  }

  // Allocate the registry slot first (under lock) — the existing-.env.local
  // compat check needs the allocated ports/queue/URLs to compare against.
  const registryPath = defaultRegistryPath();
  const slot = await withRegistryLock(registryPath, async () => {
    const registry = requireUsableRegistry(registryPath);
    const existing = getClone(registry, slug);
    const { registry: next, slot: allocated } = allocateSlot(registry, slug, {
      worktreePath,
    });
    if (!existing) {
      writeRegistry(registryPath, next);
    }
    return allocated;
  });
  const dbName = slot.dbName;

  // Compute the full expected clone-env value set.
  const cloneUrl = connStringForDatabase(connectionString, dbName);
  const baseUrl = `http://localhost:${slot.nextjsPort}`;
  const expected = {
    CINATRA_CLONE_SLUG: slug,
    SUPABASE_DB_URL: cloneUrl,
    SUPABASE_SCHEMA: "cinatra",
    PORT: String(slot.nextjsPort),
    BULLMQ_QUEUE_NAME: `cinatra-clone-${slug}`,
    BETTER_AUTH_URL: baseUrl,
    NEXT_PUBLIC_BETTER_AUTH_URL: baseUrl,
    // LANGGRAPH_CINATRA_BASE_URL is intentionally not written.
  };
  if ("NEXT_PUBLIC_APP_URL" in sourceEnv) expected.NEXT_PUBLIC_APP_URL = baseUrl;
  if ("NEXT_PUBLIC_SITE_URL" in sourceEnv) expected.NEXT_PUBLIC_SITE_URL = baseUrl;

  // Strict compat check against an existing .env.local.
  const outPath = path.join(worktreePath, ".env.local");
  let writeEnv = true;
  if (existsSync(outPath)) {
    const { values: existingEnv } = readEnvFileOrdered(outPath);
    const mismatches = [];
    for (const [key, want] of Object.entries(expected)) {
      const have = existingEnv[key] ?? "";
      if (have !== want) {
        mismatches.push(`  ${key}: have "${have}", want "${want}"`);
      }
    }
    if (mismatches.length === 0) {
      writeEnv = false;
      console.log(`.env.local already matches clone "${slug}" — skipping env write.`);
    } else if (!force) {
      throw new Error(
        `${outPath} exists and does NOT match clone "${slug}":\n` +
          mismatches.join("\n") +
          `\nRe-run with --force to overwrite, or 'cinatra clone prune' the existing clone first.`,
      );
    }
  }

  // Create the clone database from the seed template (idempotent).
  {
    const adminClient = createClient(adminUrl);
    await adminClient.connect();
    try {
      const dbRow = await adminClient.query(
        `SELECT 1 FROM pg_database WHERE datname = $1`,
        [dbName],
      );
      if (dbRow.rows.length === 0) {
        await adminClient.query(
          `CREATE DATABASE ${quoteIdentifier(dbName)} TEMPLATE ${quoteIdentifier(SEED_DB_NAME)}`,
        );
      }
    } finally {
      await adminClient.end().catch(() => null);
    }
  }

  // Write the worktree .env.local (unless an identical one already exists).
  if (writeEnv) {
    const outputEnv = { ...sourceEnv, ...expected };
    writeFileSync(outPath, serializeEnv(outputEnv, sourceOrder), { mode: 0o600 });
  }

  // Clear inherited mcp_server.publicBaseUrl in the clone DB.
  // `cinatra_seed` is built from a scrubbed snapshot of the live app DB, but
  // `cinatra.metadata` is NOT in SEED_SKIP_TABLES (operator settings need to
  // carry forward), so the clone inherits whatever publicBaseUrl main was
  // configured with. A dormant clone with main's tunnel URL would route
  // external MCP traffic at main, not the clone — clear it before the slot
  // becomes "ready". `clone start` will write the clone's own Funnel URL
  // after Tailscale comes up.
  {
    const cloneClient = createClient(cloneUrl);
    await cloneClient.connect();
    try {
      const current = await readMetadataValue(cloneClient, "cinatra", MCP_SETTINGS_KEY, {});
      const cleared = buildMcpPublicBaseUrlRow(current, null);
      await writeMetadataValue(cloneClient, "cinatra", MCP_SETTINGS_KEY, cleared);
    } finally {
      await cloneClient.end().catch(() => null);
    }
  }

  // Commit: flip the slot to "ready".
  await withRegistryLock(registryPath, async () => {
    const registry = requireUsableRegistry(registryPath);
    if (getClone(registry, slug)) {
      writeRegistry(registryPath, markSlotReady(registry, slug));
    }
  });

  // Auto-install deps for command-managed heavy clones. Only run when the worktree
  // was just created OR node_modules is absent — a re-run on an
  // already-installed clone must NOT pay another slow pnpm pass. MUST use
  // `corepack pnpm` (NOT bare pnpm) so the pnpm@11.1.2 pin is honored and the
  // lockfile / patches are preserved.
  let depsAutoInstalled = false;
  if (cliOwnedWorktree) {
    const nodeModulesPath = path.join(worktreePath, "node_modules");
    if (worktreeJustCreated || !existsSync(nodeModulesPath)) {
      console.log("");
      console.log(`Installing dependencies (corepack pnpm install) in ${worktreePath}…`);
      const install = spawnSync("corepack", ["pnpm", "install"], {
        cwd: worktreePath,
        stdio: "inherit",
        env: process.env,
      });
      if (install.status !== 0) {
        console.error("");
        console.error(
          "ERROR: dependency install FAILED, but the deep-fork database, registry " +
            "slot, and git worktree were all provisioned SUCCESSFULLY and are intact.",
        );
        console.error(
          `Re-run the install manually: cd ${worktreePath} && corepack pnpm install`,
        );
        console.error("(Do NOT re-run 'cinatra setup clone' — that work is already done.)");
        process.exitCode = 1;
        return;
      }
      depsAutoInstalled = true;
    } else {
      console.log(`Dependencies already present at ${nodeModulesPath} — skipping install.`);
    }
  }

  // Sync dev-app clones into THIS clone worktree (loud-
  // but-non-fatal — the clone provisioning above is already complete).
  try {
    await syncDevApps({
      repoRoot: resolveMainRepoRoot(worktreePath),
      targetRoot: worktreePath,
      argv,
    });
  } catch (err) {
    // Loud + non-zero exit (worktree/clone provisioning above stays intact), so
    // a wrong-origin / non-git / clone failure can't masquerade as clean setup.
    console.error(`⚠ Dev app sync FAILED: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  }

  // Sync the companion extension repos into THIS clone worktree (no-op until
  // `cinatraDevExtensions` is populated). Same loud-but-non-fatal posture.
  let extensionSync;
  let extensionSyncFailed = false;
  try {
    extensionSync = await syncCinatraDevExtensions({
      repoRoot: resolveMainRepoRoot(worktreePath),
      targetRoot: worktreePath,
      argv,
    });
  } catch (err) {
    extensionSyncFailed = true;
    console.error(`⚠ Dev extension sync FAILED: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  }
  // The deps install above runs BEFORE this sync, so the freshly-cloned
  // extensions would be unlinked — re-link them now (guarded no-op on warm runs).
  installAfterExtensionSync(worktreePath, extensionSync);
  // Keep THIS worktree's generated maps matching the extension set the sync
  // just put on its disk (cinatra#109/#110) — same gating as `setup dev`.
  regenerateExtensionManifestAfterSync(worktreePath, extensionSync, {
    failed: extensionSyncFailed,
  });

  // Summary.
  console.log(`Clone provisioned (dormant) for worktree ${worktreePath}`);
  if (cliBranchName) console.log(`  Branch:        ${cliBranchName}`);
  else if (branch) console.log(`  Branch:        ${branch}`);
  console.log(`  Slug:          ${slug}`);
  console.log(`  Index:         ${slot.index}`);
  console.log(`  Next.js port:  ${slot.nextjsPort}`);
  console.log(`  WayFlow port:  ${slot.wayflowPort}  (container starts on 'cinatra clone start')`);
  console.log(`  Database:      ${dbName}  (from template ${SEED_DB_NAME})`);
  console.log(`  .env.local:    ${outPath}`);
  console.log("");
  if (cliOwnedWorktree && depsAutoInstalled) {
    console.log(`Next: cd ${worktreePath} && pnpm dev`);
  } else if (cliOwnedWorktree) {
    console.log(`Next: cd ${worktreePath} && corepack pnpm install && pnpm dev`);
  } else {
    console.log(`Next: cd ${worktreePath} && pnpm install && pnpm dev`);
  }
}

// Guarded removal of a command-managed heavy-clone git worktree.
// SAFETY: only removes a path that EXACTLY equals the expected sibling
// `<parentDir>/cinatra-ai-<slug>` AND is listed in `git worktree list`.
// NEVER removes mainRepoRoot or any path outside parentDir; light-branch
// worktree entries are skipped entirely so
// DB/slot/Redis-only behavior is preserved for them.
function pruneCliOwnedWorktree(slug, recordedWorktreePath) {
  if (!recordedWorktreePath) return;
  let mainRepoRoot;
  try {
    mainRepoRoot = resolveMainRepoRoot(process.cwd());
  } catch {
    console.warn(
      `  [skip worktree] Could not locate main repo root — leaving worktree at ` +
        `${recordedWorktreePath} untouched.`,
    );
    return;
  }
  const parentDir = path.dirname(mainRepoRoot);
  const expectedSibling = path.join(parentDir, `cinatra-ai-${slug}`);
  const recorded = path.resolve(recordedWorktreePath);

  if (recorded === path.resolve(mainRepoRoot)) {
    console.warn(`  [skip worktree] Recorded path is the main repo root — refusing to remove.`);
    return;
  }
  if (recorded !== expectedSibling) {
    // Unmanaged worktree — DB/slot/
    // Redis-only behavior; do not touch any worktree (back-compat).
    return;
  }

  let listed = "";
  try {
    listed = execFileSync(
      "git",
      ["-C", mainRepoRoot, "worktree", "list", "--porcelain"],
      { encoding: "utf8" },
    ).toString();
  } catch {
    listed = "";
  }
  const isRegistered = listed
    .split("\n")
    .some((line) => line.startsWith("worktree ") && path.resolve(line.slice("worktree ".length)) === expectedSibling);
  if (!isRegistered) {
    return; // already gone / not a git worktree — nothing to remove
  }

  const remove = spawnSync(
    "git",
    ["-C", mainRepoRoot, "worktree", "remove", expectedSibling],
    { stdio: ["ignore", "inherit", "inherit"], env: process.env },
  );
  if (remove.status !== 0) {
    const forced = spawnSync(
      "git",
      ["-C", mainRepoRoot, "worktree", "remove", "--force", expectedSibling],
      { stdio: ["ignore", "inherit", "inherit"], env: process.env },
    );
    if (forced.status !== 0) {
      console.warn(
        `  [partial] git worktree remove failed for ${expectedSibling}. ` +
          `Remove it manually: git worktree remove --force ${expectedSibling}`,
      );
      return;
    }
  }
  console.log(`  Worktree: ${expectedSibling}  (REMOVED)`);

  // Delete the command-managed branch too — `git worktree remove` leaves it behind.
  // The branch name is deterministic (`cinatra-ai-<slug>`, slug already
  // validated), so the exact-name `-D` is safe; best-effort, never fatal.
  const branchName = `cinatra-ai-${slug}`;
  const delBranch = spawnSync(
    "git",
    ["-C", mainRepoRoot, "branch", "-D", branchName],
    { stdio: ["ignore", "ignore", "ignore"], env: process.env },
  );
  if (delBranch.status === 0) {
    console.log(`  Branch:   ${branchName}  (DELETED)`);
  } else {
    console.warn(
      `  [partial] Could not delete branch ${branchName} ` +
        `(may be checked out elsewhere). Remove it manually: git branch -D ${branchName}`,
    );
  }
}

async function runClonePrune(argv) {
  // --stale bulk-prunes every slot whose worktreePath no longer resolves to
  // a directory. Combine with --dry-run to preview.
  if (argv.includes("--stale")) {
    return runClonePruneStale(argv);
  }

  if (!argv.includes("--yes")) {
    throw new Error("cinatra clone prune is destructive. Re-run with --yes to confirm.");
  }
  const worktreePath = path.resolve(
    readOptionValue(argv, "--worktree-path") ?? process.cwd(),
  );

  let slug = readOptionValue(argv, "--slug");
  let branch = null;
  if (!slug) {
    // Accept a positional <slug> as a convenience form. Use the shared helper
    // so `cinatra clone prune --worktree-path /tmp/wt --yes` doesn't read
    // `/tmp/wt` as the slug.
    slug = findPositionalSlug(argv);
  }
  if (!slug) {
    branch = resolveRealBranchName(worktreePath);
    if (!branch) {
      throw new Error(
        `Could not read git branch from ${worktreePath} (detached HEAD?). Use --slug <slug>.`,
      );
    }
    slug = cloneSlugFromBranch(branch);
  }
  if (!/^[a-z0-9][a-z0-9-]{0,29}$/.test(slug)) {
    throw new Error(
      `Derived slug "${slug}" is invalid. Must match /^[a-z0-9][a-z0-9-]{0,29}$/. Use --slug <slug>.`,
    );
  }

  // Validate the registry BEFORE any destructive work — a malformed registry
  // must never let a DROP through.
  const registryPath = defaultRegistryPath();
  const registry = requireUsableRegistry(registryPath);

  // Derive the database name deterministically — NEVER trust a stored dbName for
  // the destructive path. Cross-check the registry entry as a corruption signal.
  const dbName = cloneDbName(slug);
  const slot = getClone(registry, slug);
  if (slot && slot.dbName !== dbName) {
    throw new Error(
      `Registry entry for "${slug}" records dbName "${slot.dbName}" but the slug derives ` +
        `"${dbName}" — registry is inconsistent. Repair ${registryPath} before pruning.`,
    );
  }
  if (!slot) {
    console.warn(
      `[clone prune] No registry entry for "${slug}" — proceeding on the derived name ${dbName}.`,
    );
  }

  // Hard guard — fail closed on anything that is not a clone database.
  if (isProtectedDbName(dbName)) {
    throw new Error(
      `Refusing to drop "${dbName}" — not a clone database. This is a safety guard.`,
    );
  }

  // clone-runtime teardown BEFORE the destructive DB drop.
  //
  // Lifecycle invariants enforced here:
  //   - runtime LOCK held = another `clone start` / `clone stop` is in flight;
  //     always refuse, no --force-stop bypass. Bypassing would race a partial
  //     bring-up.
  //   - clone RUNNING (pid alive + cwd-matched) = a started clone; refuse
  //     unless --force-stop, which then invokes the full `runCloneStop` to
  //     gracefully SIGTERM → SIGKILL → wait. Only after stop succeeds do we
  //     proceed with rm + DROP DB.
  //
  // Order: refuse-if-lock → refuse-if-running (or --force-stop → stop first) →
  // docker compose down → rm -rf ~/.cinatra/clones/<slug>/ → DROP DATABASE →
  // Redis → release slot. Slot retained on any failure after compose-down
  // (the retain-on-failure contract is preserved).
  const slotIndex = slot?.index ?? null;
  const forceStop = argv.includes("--force-stop");

  // Hold the per-clone runtime lock across the ENTIRE destructive sequence
  // (stop → compose down → rm runtime dir → DROP DATABASE). The lock must stay
  // held between stop and the drop so a concurrent `clone start` cannot acquire
  // it and boot a clone while DB/runtime-dir prune is deleting it.
  // `acquireRuntimeLock` fail-fast-throws if another start/stop holds it.
  acquireRuntimeLock(slug);
  // Declared OUT here so the post-finally runtime-dir cleanup can see it:
  // the dir must only be removed once the registry slot was ACTUALLY
  // released. On a retained slot (Redis cleanup failed) a concurrent
  // `clone start` can still resolve the slot — deleting the dir would nuke
  // its fresh lock.
  let slotReleased = false;
  try {
  if (slotIndex !== null) {
    // Detect a running clone: pid file exists, process alive, cwd matches
    // the worktree path stored in the registry slot.
    const pidPath = clonePidPath(slug);
    let isCloneRunning = false;
    if (existsSync(pidPath)) {
      const pid = readPidFromFile(pidPath);
      if (pid != null && isPidAlive(pid)) {
        const match = processCommandLineMatches(pid, {
          cwdMustEqual: slot?.worktreePath ?? null,
        });
        // Fail CLOSED on a live recorded pid we could not VERIFY (ps/lsof/
        // proc lookup failed) — only a POSITIVE mismatch (different command
        // / different cwd) is safe to treat as a stale/reused pid and let
        // the DROP proceed. This is symmetric to the slot-less fail-open.
        if (match.ours || match.indeterminate) isCloneRunning = true;
      }
    }
    if (isCloneRunning && !forceStop) {
      throw new Error(
        `Clone "${slug}" is running. Run 'cinatra clone stop --slug ${slug}' first, or re-run prune with --force-stop.`,
      );
    }
    if (isCloneRunning && forceStop) {
      console.log(`  --force-stop: stopping the clone before prune...`);
      // Call the lock-free stop core directly — prune already holds the
      // runtime lock, so runCloneStop (which re-acquires) would EEXIST.
      // stopCloneRuntime uses slot.worktreePath internally, so a prune run
      // from the main worktree never clears main's mcp_server.publicBaseUrl.
      const stopResult = await stopCloneRuntime(slug, slot);
      if (!stopResult.stopped) {
        // Could NOT prove the clone stopped (unverifiable pid, or it
        // survived SIGKILL). Refuse the destructive DROP rather than yank
        // the DB out from under a possibly-live clone.
        throw new Error(
          `Clone "${slug}": --force-stop could not prove the clone is stopped ` +
            `(${stopResult.reason}). Refusing to DROP the database. Stop the ` +
            `process manually, then re-run 'cinatra clone prune --slug ${slug} --yes'.`,
        );
      }
    }

    const projectName = cloneComposeProjectName(slug, slotIndex);
    const cloneComposeYml = cloneComposePath(slug);

    // Stop + remove docker compose stack (best-effort — even after
    // runCloneStop the stack may have an orphaned container if compose
    // diverged from pid state).
    if (existsSync(cloneComposeYml) && isComposeAvailable()) {
      const downResult = spawnSync(
        "docker",
        ["compose", "-p", projectName, "-f", cloneComposeYml, "down"],
        { stdio: ["ignore", "inherit", "inherit"] },
      );
      if (downResult.status !== 0) {
        console.warn(`  [partial] docker compose down exited ${downResult.status} — continuing.`);
      }
    }

    // NOTE: the per-clone runtime dir is deliberately NOT removed here.
    // `acquireRuntimeLock` placed `clone.lock` INSIDE that dir; deleting it
    // now (before DROP DATABASE / Redis / slot-release) would physically
    // drop our own lock mid-sequence, letting a concurrent `clone start`
    // re-acquire and race the DB drop. The dir is cleaned up at the very
    // end, AFTER the lock is released and the registry slot is gone.
  } else {
    // Slot-less prune (registry entry absent/corrupt/already removed). The
    // running-clone check above is skipped because there is no
    // slot.worktreePath to cwd-match — but `~/.cinatra/clones/<slug>/
    // nextjs.pid` may still point at a LIVE clone. The runtime lock does
    // NOT prove the clone is stopped (a started clone does not hold it
    // after `clone start` returns), so dropping the DB here would yank it
    // out from under a running process.
    //
    // Hard refuse — NO --force-stop bypass. Without slot.worktreePath we
    // cannot cwd-disambiguate, so a `nextjs.pid` reused by an unrelated
    // `pnpm dev`/`next dev` would satisfy the command-shape check; force-
    // killing it would signal the wrong process group.
    // The operator must repair the registry or stop the process so a
    // normal slot-backed (cwd-verified) prune can run.
    const pidPath = clonePidPath(slug);
    if (existsSync(pidPath)) {
      const pid = readPidFromFile(pidPath);
      // Refuse if the recorded pid is alive AT ALL. We deliberately do NOT
      // gate on processCommandLineMatches here: it can return
      // ours:false for a transient `ps` failure / permission error on a
      // genuinely-live clone; clearing the pid file and dropping the DB then
      // yanks it from under a running clone. A live
      // recorded pid + slot-less destructive prune = always fail closed;
      // only a DEAD pid file is safe to clear and proceed.
      if (pid != null && isPidAlive(pid)) {
        throw new Error(
          `Clone "${slug}" has no registry slot but the recorded process ` +
            `(pid ${pid} at ${pidPath}) is still alive. Refusing to DROP the ` +
            `database — without a registry slot the process cannot be ` +
            `cwd-verified, so it is unsafe to signal or to assume it is ` +
            `unrelated. Stop pid ${pid} yourself (or repair ` +
            `${defaultRegistryPath()}), then re-run prune.`,
        );
      }
      // Dead pid file → safe to clear before the destructive drop.
      try { rmSync(pidPath, { force: true }); } catch { /* best-effort */ }
    }
  }

  // Resolve a connection string: worktree .env.local first, then main repo's.
  let connectionString;
  const worktreeEnvPath = path.join(worktreePath, ".env.local");
  if (existsSync(worktreeEnvPath)) {
    connectionString = readEnvFileOrdered(worktreeEnvPath).values.SUPABASE_DB_URL?.trim();
  }
  if (!connectionString) {
    try {
      const mainEnvPath = resolveMainEnvPath(worktreePath, null);
      connectionString = readEnvFileOrdered(mainEnvPath).values.SUPABASE_DB_URL?.trim();
    } catch {
      /* fall through to the error below */
    }
  }
  if (!connectionString) {
    throw new Error(
      `SUPABASE_DB_URL not found in ${worktreeEnvPath} or the main repo .env.local. ` +
        `Cannot drop the clone database.`,
    );
  }
  const adminUrl = adminConnString(connectionString);

  // Drop the clone database from the maintenance DB.
  const adminClient = createClient(adminUrl);
  await adminClient.connect();
  try {
    await adminClient.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await adminClient.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(dbName)} WITH (FORCE)`);
  } finally {
    await adminClient.end().catch(() => null);
  }

  // Redis queue cleanup (BullMQ does not clean its own keys).
  const queueName = `cinatra-clone-${slug}`;
  const redisUrl = readRedisUrl(worktreePath);
  const redisResult = cleanupRedisQueueKeys(queueName, redisUrl);
  let queueSummary;
  if (redisResult.ok) {
    queueSummary =
      redisResult.deletedCount === 0
        ? "no keys present"
        : `${redisResult.deletedCount} key(s) removed`;
  } else {
    queueSummary = `manual cleanup needed — ${redisResult.error}`;
  }

  // Release the registry slot ONLY when every cleanup step succeeded. If Redis
  // cleanup failed, keep the slot so the slug + queue name stay reserved — the
  // clone DB is already dropped, so re-running 'cinatra clone prune' is a safe,
  // idempotent way to retry the Redis cleanup and then release the slot
  // idempotent way to retry the Redis cleanup and then release the slot.
  if (redisResult.ok) {
    await withRegistryLock(registryPath, async () => {
      const current = requireUsableRegistry(registryPath);
      const { registry: next, removed } = releaseSlot(current, slug);
      if (removed) {
        writeRegistry(registryPath, next);
      }
    });
    slotReleased = true;
  }

  console.log(`Clone pruned: ${slug}`);
  if (branch) console.log(`  Branch:   ${branch}`);
  console.log(`  Database: ${dbName}  (DROPPED)`);
  console.log(`  Queue:    ${queueName}  (${queueSummary})`);
  console.log(
    `  Registry: ${slotReleased ? "slot released" : "slot RETAINED (Redis cleanup failed — see below)"}`,
  );
  if (!redisResult.ok) {
    console.log("");
    console.log(
      "Redis cleanup failed — the registry slot was retained. Clear the keys, then re-run " +
        `'cinatra clone prune --slug ${slug} --yes' to release the slot. Manual key cleanup:`,
    );
    console.log(`  redis-cli --scan --pattern 'bull:${queueName}:*' | xargs redis-cli del`);
  }

  // Remove the command-managed heavy-clone worktree (guarded). Only runs when the
  // slot was actually released (full cleanup succeeded) so a
  // retained-slot retry path is unaffected. Uses the slot's recorded
  // worktreePath; the helper itself enforces the sibling/path-equality and
  // legacy-skip guards.
  if (slotReleased) {
    pruneCliOwnedWorktree(slug, slot?.worktreePath ?? null);
  }
  } finally {
    releaseRuntimeLock(slug);
  }

  // Runtime-dir cleanup runs LAST: the lock has been released and (on
  // success) the registry slot is gone, so a concurrent `clone start` can
  // no longer resolve this clone and there is no DB left to race. Removing
  // the dir is disposable cleanup — warn (don't throw) if it fails; a
  // leftover dir is harmless and `clone prune --stale` / manual rm reclaim
  // it.
  // Remove the runtime dir when it is provably safe:
  //   - slot released (the registry no longer resolves this clone), OR
  //   - there was no registry slot at all (slotIndex === null) — a derived
  //     prune; `clone start` would fail "no clone registered", so nothing
  //     can re-resolve it. This also cleans the dir that the unconditional
  //     `acquireRuntimeLock(slug)` created for a slot-less prune.
  // It is NOT removed when the slot was RETAINED (Redis cleanup failed):
  // a concurrent `clone start --slug X` can still resolve that slot and
  // recreate the runtime dir + lock, which removing here would nuke. A
  // retained slot's dir is reclaimed on the idempotent prune re-run that
  // finally releases it.
  if (slotReleased || slotIndex === null) {
    const runtimeDir = cloneRuntimeDir(slug);
    if (existsSync(runtimeDir)) {
      try {
        rmSync(runtimeDir, { recursive: true, force: true });
      } catch (err) {
        console.warn(
          `  [partial] Could not remove runtime dir ${runtimeDir}: ${err?.message ?? err}. ` +
            `The clone DB is already dropped; remove the dir manually.`,
        );
      }
    }
  }
}

function runCloneList() {
  const registryPath = defaultRegistryPath();
  const result = readRegistry(registryPath);
  if (result.status === "malformed") {
    console.error(`Clone registry at ${registryPath} is malformed — cannot list.`);
    console.error("Inspect/repair it by hand, then retry.");
    process.exitCode = 1;
    return;
  }
  const clones = listClones(result.registry);
  if (clones.length === 0) {
    console.log(
      `No clones registered (${
        result.status === "missing" ? "registry not created yet" : "registry empty"
      }).`,
    );
    return;
  }
  console.log(`Registered clones — ${registryPath}`);
  console.log("");
  for (const clone of clones) {
    // Show STALE when the worktreePath no longer resolves to a directory.
    const stale = isWorktreePathStale(clone) ? "  [STALE]" : "";
    console.log(`  ${clone.slug}  [${clone.state}]${stale}`);
    console.log(
      `    index=${clone.index}  next.js=${clone.nextjsPort}  wayflow=${clone.wayflowPort}`,
    );
    console.log(`    database=${clone.dbName}`);
    console.log(`    worktree=${clone.worktreePath}`);
    console.log(`    created=${clone.createdAt}`);
  }
}

// ---------------------------------------------------------------------------
// Clone start/stop/status lifecycle.
//
//   cinatra clone start [--slug <s>] [--worktree-path <p>] [--rebuild-wayflow]
//                       [--tailscale-host-network]
//   cinatra clone stop  [--slug <s>] [--worktree-path <p>]
//   cinatra clone status [--slug <s>] [--worktree-path <p>]
//
// `start` brings up host-native Next.js on port 31NN + a per-clone WayFlow
// container on 32NN. A Tailscale Funnel sidecar is layered on top when
// `TS_AUTHKEY` is set in the operator's env; the start path runs
// **local-only** when it is unset.
//
// Lifecycle invariants enforced here:
//   - registry slot must be state=ready (`cinatra setup clone` succeeded)
//   - clone DB must exist (`pg_ping` succeeds against `cinatra_clone_<slug>`)
//   - per-band port guard (3100-3119, 3200-3219) catches corrupt rows
//   - per-clone runtime-state at `~/.cinatra/clones/<slug>/`:
//       nextjs.pid     — pgid of the spawned `pnpm dev` for SIGTERM/SIGKILL
//       nextjs.log     — truncated on each start
//       compose.yml    — rendered from docker/wayflow/compose.clone.template.yml
//       clone.lock     — file lock held only during start orchestration
//       tailscale-state/    — bind-mount for Tailscale state
//       tailscale-serve.json — Funnel TS_SERVE_CONFIG
// ---------------------------------------------------------------------------

function resolveCloneSlug(argv, worktreePath) {
  const flagSlug = readOptionValue(argv,"--slug");
  if (flagSlug) return flagSlug;
  const positional = findPositionalSlug(argv);
  if (positional) return positional;
  const branch = resolveRealBranchName(worktreePath);
  return cloneSlugFromBranch(branch);
}

function loadReadyCloneSlot(slug) {
  const registryPath = defaultRegistryPath();
  const registry = requireUsableRegistry(registryPath);
  const slot = getClone(registry, slug);
  if (!slot) {
    throw new Error(
      `No clone registered for slug "${slug}". Run 'cinatra setup clone' from the worktree first.`,
    );
  }
  if (slot.state !== "ready") {
    throw new Error(
      `Clone "${slug}" is in state "${slot.state}", not ready. Re-run 'cinatra setup clone' to repair.`,
    );
  }
  return { slot, registryPath };
}

async function pingCloneDb(connString) {
  const client = createClient(connString);
  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("connect timeout")), 3000)),
    ]);
    await client.query("SELECT 1");
    return true;
  } finally {
    await client.end().catch(() => null);
  }
}

function isComposeAvailable() {
  try {
    const out = spawnSync("docker", ["compose", "version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // Bounded (cinatra#260 Step 3): this metadata probe is now on the
      // `cinatra setup dev` auto-bring-up path — a hung docker CLI must not
      // block setup. On timeout spawnSync returns non-zero/`error` → treated as
      // "not available" by the `status === 0` check.
      timeout: DOCKER_CLI_PROBE_TIMEOUT_MS,
    });
    return out.status === 0;
  } catch {
    return false;
  }
}

// Fail-closed port-in-use precheck. ECONNREFUSED → port free. Anything else
// (timeout, transient
// network errors) → treat as "possibly bound" so we don't proceed past an
// ambiguous signal and trash a port we cannot prove is free.
async function isHostPortBound(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let resolved = false;
    const done = (bound) => {
      if (!resolved) {
        resolved = true;
        try { socket.destroy(); } catch { /* best-effort */ }
        resolve(bound);
      }
    };
    socket.once("connect", () => done(true));
    socket.once("error", (err) => {
      // ECONNREFUSED is the only signal that proves "free".
      done(err?.code !== "ECONNREFUSED");
    });
    setTimeout(() => done(true), 1_500); // fail-closed on timeout
  });
}

// Check whether a compose project has any running service before declaring
// "already running" on idempotent re-entry.
function isComposeProjectUp(projectName) {
  const result = spawnSync(
    "docker",
    ["compose", "-p", projectName, "ps", "--status=running", "--format", "{{.Name}}"],
    // Bounded (cinatra#260 Step 3): now on the setup auto-bring-up path. On
    // timeout, non-zero/`error` status → treated as "not up".
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: DOCKER_CLI_PROBE_TIMEOUT_MS },
  );
  if (result.error || result.status !== 0) return false;
  const lines = (result.stdout ?? "").trim().split("\n").filter((l) => l.length > 0);
  return lines.length > 0;
}

// Per-clone CINATRA_BRIDGE_TOKEN. Generate once per clone, persist to clone
// DB metadata (`cinatra.metadata['bridge_token']`),
// and propagate to both the host-native Next.js (via .env.local) and the
// per-clone WayFlow container (via compose env).
async function ensureCloneBridgeToken(cloneConnString) {
  const client = createClient(cloneConnString);
  await client.connect();
  try {
    const current = await readMetadataValue(client, "cinatra", "bridge_token", {});
    if (typeof current?.token === "string" && current.token.length >= 32) {
      return current.token;
    }
    const token = randomBytes(32).toString("base64url");
    await writeMetadataValue(client, "cinatra", "bridge_token", {
      token,
      createdAt: new Date().toISOString(),
    });
    return token;
  } finally {
    await client.end().catch(() => null);
  }
}

function ensureWayflowImage({ forceRebuild = false, repoRoot } = {}) {
  // Stable local tag, build-on-first-start, and --rebuild-wayflow escape
  // hatch. The shared docker-compose.yml currently builds the WayFlow image
  // into an auto-named tag on every `up`; we tag it as `cinatra-wayflow:local`
  // here so the per-clone compose can reference it without rebuilding.
  const inspect = spawnSync(
    "docker",
    ["image", "inspect", "cinatra-wayflow:local"],
    // Bounded (cinatra#260 Step 3): now on the setup auto-bring-up path. On
    // timeout, non-zero/`error` → falls through to the (bounded) build.
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: DOCKER_CLI_PROBE_TIMEOUT_MS },
  );
  if (inspect.status === 0 && !forceRebuild) return;
  console.log("Building cinatra-wayflow:local image (one-time per host)...");
  const build = spawnSync(
    "docker",
    ["build", "-t", "cinatra-wayflow:local", path.join(repoRoot, "docker", "wayflow")],
    // Finite safety bound (cinatra#260 Step 3): a HUNG docker build must not
    // block forever — the dev-tunnel auto-bring-up from `cinatra setup dev`
    // calls this path, and setup must never hang. Generous (10m) so a normal
    // cold build is unaffected; on timeout spawnSync kills the child and
    // returns a non-zero/`error` result → the throw below surfaces it.
    { stdio: ["ignore", "inherit", "inherit"], timeout: WAYFLOW_BUILD_TIMEOUT_MS },
  );
  if (build.error || build.status !== 0) {
    throw new Error(
      "docker build of cinatra-wayflow:local failed" +
        (build.error?.code === "ETIMEDOUT" ? " (timed out)" : "") +
        ". Re-run with --rebuild-wayflow once the underlying error is fixed.",
    );
  }
}

function renderCloneComposeTemplate({ templatePath, outPath, vars }) {
  // TS_AUTHKEY is rendered as the LITERAL string `${TS_AUTHKEY}` so docker
  // compose substitutes from the spawned-process env at exec time. The raw
  // secret never lands on disk.
  let rendered = readFileSync(templatePath, "utf8");
  for (const [name, value] of Object.entries(vars)) {
    const str = String(value);
    // Values are raw-substituted into double-quoted YAML scalars. Reject the
    // few characters that could break out of the scalar / inject YAML rather
    // than pulling in a serializer. The only free-form value is the worktree
    // path; `"`, newline or CR in it is pathological and never legitimate.
    if (/["\n\r]/.test(str)) {
      throw new Error(
        `Refusing to render clone compose template: value for "${name}" contains an unsafe character (quote/newline). Value: ${JSON.stringify(str)}`,
      );
    }
    rendered = rendered.split(`@@${name}@@`).join(str);
  }
  ensureDirOf(outPath);
  writeFileSync(outPath, rendered, { mode: 0o600 });
}

function ensureDirOf(filePath) {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

async function probeHttp(url, { timeoutMs = 30_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 2_000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(t);
      if (res.ok) return { ok: true, status: res.status };
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err?.message ?? String(err);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { ok: false, error: lastError ?? "timeout" };
}

function findRepoRootFromWorktree(worktreePath) {
  try {
    const out = execFileSync(
      "git",
      ["-C", worktreePath, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8" },
    ).trim();
    return path.dirname(out);
  } catch {
    return process.cwd();
  }
}

// ---------------------------------------------------------------------------
// Lazy loaders for the tailscale connector's CLI modules (cinatra#151
// Stage 5c — manifest-discovered): the connector DECLARES its modules under
// `cinatra.devCliModules` and the CLI resolves them by KEY through
// dev-cli-modules.mjs, naming no extension package or path. The
// extension-empty lazy bootstrap is preserved: each loader resolves on
// demand, and a missing declarer throws with `.code = ERR_MODULE_NOT_FOUND`
// — the same failure class as the retired literal import — so every caller's
// graceful-degradation guard keeps working.
// ---------------------------------------------------------------------------
function loadTailscaleApiModule() {
  return loadDevCliModule("tailscale-api");
}
function loadTailscaleHostnameModule() {
  return loadDevCliModule("tailscale-hostname");
}

// ---------------------------------------------------------------------------
// cinatra#260 Step 3 — self-establishing + self-healing public MCP URL.
//
// `runSetup("dev")` calls `ensureDevPublicMcpUrl` AFTER the OAuth/JWKS steps.
// The write path (token mint → public URL → provider reaches /api/mcp → CMS
// write) silently rots when the stored `publicBaseUrl` points at a node that
// is no longer registered (a torn-down or never-established dev-main Funnel).
// This step makes the URL VERIFY-BEFORE-REUSE and SELF-HEAL.
//
// HARD GATES (all must hold, else the helper SKIPS without side effect):
//   - dev mode only (caller passes mode === "dev"),
//   - NO operator/env override (`MCP_PUBLIC_BASE_URL` / `APP_PUBLIC_URL`, or a
//     stored `publicBaseUrlSource === "manual"`) — we never clobber a URL the
//     operator manages by hand,
//   - the runtime config + DB connection are dev-shaped.
//
// OWNERSHIP / LIVENESS — codex must-fix: a fresh node's Funnel URL is written
// OPTIMISTICALLY before DNS/cert propagation, so a just-provisioned URL that
// NXDOMAINs is NOT dead. We therefore validate by SOURCE/OWNERSHIP (does the
// node's live registered `Self.DNSName` match `deriveDevTailscaleHostname`?),
// reusing `waitForTailscaleFunnelUrl` + `verifyRegisteredHostnameMatchesPrediction`
// — NEVER a reachability/HTTP probe. No poller: ONE bounded read at setup.
//
// OWNER DECISION — AUTO-BRING-UP: when the URL is missing/unowned and the
// dev-main sidecar is DOWN, setup brings the Funnel up via `runDevTunnel("start")`
// (bounded by its existing 60s `waitForTailscaleFunnelUrl` cap). Strictly
// conditional + soft-fail: any failure → a LOUD actionable warning, NEVER an
// aborted setup. Setup stays usable for developers who don't need the public
// URL (they get a warning, not a hang/failure).
//
// Returns a status object (never throws past this boundary) for the runSetup
// summary. SECRET BOUNDARY: statuses/booleans/hostnames only — never a token.
//
// @param {object} args
// @param {string} args.dbUrl  resolved SUPABASE_DB_URL
// @param {string} args.schemaName  resolved SUPABASE_SCHEMA (codex must-fix:
//   the write uses THIS, never a hardcoded "cinatra")
// @param {Record<string,string>} args.env  collectEnvironment(repoRoot)
// @param {{ url: string | null }} args.operatorUrl  the operator/env override
//   resolved by runSetup (null when none / localhost-only)
// @param {object} [args.deps]  test seams for the non-pure boundaries (Docker /
//   Tailscale / tunnel bring-up / DB). DEFAULTS wire to the real module
//   functions so production behavior is identical; the vitest suite overrides
//   them to drive every branch hermetically (no Docker, no live DB).
// @returns {Promise<{ status: string, owned: boolean, broughtUp: boolean,
//   publicBaseUrl: string | null, fixHint: string | null }>}
async function ensureDevPublicMcpUrl({ dbUrl, schemaName, env, operatorUrl, deps = {} }) {
  const resolvedSchema = schemaName?.trim() || "cinatra";

  // Non-pure boundaries, injectable for hermetic tests. Each defaults to the
  // real implementation — production callers pass no `deps`.
  const composePathExists = deps.composePathExists ?? ((p) => existsSync(p));
  const composeAvailable = deps.composeAvailable ?? (() => isComposeAvailable());
  const composeProjectUp = deps.composeProjectUp ?? ((p) => isComposeProjectUp(p));
  const readFunnel = deps.waitForTailscaleFunnelUrl ?? waitForTailscaleFunnelUrl;
  const verifyHostname =
    deps.verifyRegisteredHostnameMatchesPrediction ??
    verifyRegisteredHostnameMatchesPrediction;
  const bringUpTunnel = deps.runDevTunnel ?? runDevTunnel;
  const writeUrl = deps.writeClonePublicBaseUrl ?? writeClonePublicBaseUrl;
  const readStoredSettings =
    deps.readStoredMcpSettings ??
    (async (connString, schema) => {
      const client = createClient(connString);
      try {
        await client.connect();
        return await readMetadataValue(client, schema, MCP_SETTINGS_KEY, {});
      } catch {
        return {};
      } finally {
        await client.end().catch(() => null);
      }
    });

  // GATE 1 — operator-supplied env URL wins.
  // Only an EXPLICIT public URL counts as operator-supplied. BETTER_AUTH_URL /
  // NEXT_PUBLIC_BETTER_AUTH_URL default to http://localhost:3000, which is NOT
  // a public MCP URL — runSetup already folds those into `operatorUrl`, but we
  // re-derive the explicit signal here so a localhost fallback never blocks
  // self-heal.
  const explicitOperatorUrl =
    normalizeOptionalUrl(env.MCP_PUBLIC_BASE_URL) ??
    normalizeOptionalUrl(env.APP_PUBLIC_URL) ??
    // Belt-and-suspenders: honor any operator URL runSetup already resolved.
    (operatorUrl?.url ?? null);
  if (explicitOperatorUrl && !isLocalhostUrl(explicitOperatorUrl)) {
    // RECONCILE the DB to the operator URL (codex must-fix): a stale
    // auto-provisioned (tailscale-auto/-funnel) row must not survive while the
    // summary reports the operator URL. ensureMcpSettings already releases the
    // auto row + writes the incoming operator URL earlier in runSetup, but we
    // re-assert it here into the RESOLVED schema, tagged "manual" (operator-
    // owned), so the DB is authoritatively the operator URL. Soft-fail.
    if (dbUrl) {
      try {
        await writeUrl(dbUrl, explicitOperatorUrl, {
          source: "manual",
          schemaName: resolvedSchema,
        });
      } catch (err) {
        console.warn(
          `⚠ Public MCP URL: failed to reconcile the operator URL into the DB (continuing): ${
            err && err.message ? err.message : err
          }`,
        );
      }
    }
    return {
      status: "operator-url",
      owned: true,
      broughtUp: false,
      publicBaseUrl: explicitOperatorUrl,
      fixHint: null,
    };
  }

  if (!dbUrl) {
    return {
      status: "skipped-no-db",
      owned: false,
      broughtUp: false,
      publicBaseUrl: null,
      fixHint: null,
    };
  }

  // Read the currently-stored URL + its source from THIS schema's metadata.
  const current = (await readStoredSettings(dbUrl, resolvedSchema)) ?? {};
  const storedUrl = normalizeOptionalUrl(current?.publicBaseUrl);
  const storedSource =
    current && typeof current === "object" ? current.publicBaseUrlSource ?? null : null;

  // GATE 2 — a stored operator-managed ("manual") URL is the operator's to
  // own. Never override it (codex must-fix: respect operator URLs). A null /
  // localhost manual URL is not a real public URL, so it does NOT block heal.
  if (storedSource === "manual" && storedUrl && !isLocalhostUrl(storedUrl)) {
    return {
      status: "operator-url",
      owned: true,
      broughtUp: false,
      publicBaseUrl: storedUrl,
      fixHint: null,
    };
  }

  // --- Ownership read: is the dev-main Funnel up AND registered under the
  // predicted hostname? Reuse the dev-tunnel slug + path builders so this
  // reads the EXACT compose project the tunnel manages.
  const DEV_MAIN_SLUG = "dev-main";
  const DEV_MAIN_INDEX = 0;
  const composePath = cloneComposePath(DEV_MAIN_SLUG);
  const projectName = cloneComposeProjectName(DEV_MAIN_SLUG, DEV_MAIN_INDEX);

  // Probe the live registered DNSName ONLY when the project is up — a cheap
  // `isComposeProjectUp` short-circuit avoids the ~3s wait loop when down.
  let registeredDnsName = null;
  let funnelUrl = null;
  const sidecarUp =
    composePathExists(composePath) && composeAvailable() && composeProjectUp(projectName);
  if (sidecarUp) {
    try {
      const tailscaleFunnel = await readFunnel({
        projectName,
        composePath,
        composeEnv: process.env,
        // Short bounded READ — the node is already registered if up; we are not
        // waiting for a fresh join (that is auto-bring-up's job, with its own
        // 60s cap). One-shot, NOT a poller.
        timeoutMs: 3_000,
      });
      registeredDnsName = tailscaleFunnel?.registeredDnsName ?? null;
      funnelUrl = tailscaleFunnel?.url ?? null;
    } catch {
      registeredDnsName = null;
      funnelUrl = null;
    }
  }

  // SOURCE/OWNERSHIP validation — NOT reachability. Matches → owned; a fresh
  // un-propagated URL still validates here because we compare node identity,
  // never DNS resolution.
  const hostnameCheck = await verifyHostname({
    registered: registeredDnsName,
    dbUrl,
    schema: resolvedSchema,
  });

  if (sidecarUp && shouldWritePublicBaseUrl({ funnelUrl, hostnameCheck })) {
    // OWNED. (Re)write `publicBaseUrl` from the live DNSName into THIS schema —
    // idempotent: a matching stored URL is rewritten to the identical value; a
    // missing/dead one is replaced. Tagged `tailscale-auto` (the dev-main
    // self-establish source; same tag the dev tab uses for auto-provisioned).
    try {
      await writeUrl(dbUrl, funnelUrl, {
        source: "tailscale-auto",
        schemaName: resolvedSchema,
      });
      return {
        status: storedUrl === funnelUrl ? "owned" : "rewritten",
        owned: true,
        broughtUp: false,
        publicBaseUrl: funnelUrl,
        fixHint: null,
      };
    } catch (err) {
      // Ownership was confirmed but the AUTHORITATIVE write failed → nothing
      // was reliably (re)established in THIS schema's DB row (the prior auto URL
      // may have just been released by ensureMcpSettings, leaving it empty).
      // Report NOT owned so the loud summary warning fires (codex must-fix: a
      // write failure must never be reported as established/owned).
      console.warn(
        `⚠ Public MCP URL: ownership confirmed but the write failed (continuing): ${
          err && err.message ? err.message : err
        }`,
      );
      return {
        status: "write-failed",
        owned: false,
        broughtUp: false,
        publicBaseUrl: null,
        fixHint: "cinatra dev tunnel start",
      };
    }
  }

  // --- NOT owned. Either nothing is up, or the up node's hostname does not
  // match (a collision-suffixed dead URL). AUTO-BRING-UP the Funnel (owner
  // decision). Strictly conditional (dev + no operator URL + definite
  // ownership failure, all already established above) + SOFT-FAIL.
  if (sidecarUp && !hostnameCheck.ok) {
    // Sidecar up but hostname mismatched (MagicDNS collision): a (re)start is
    // unlikely to fix a collision and could surprise the operator. Do NOT
    // auto-restart; warn loud + name an ACTIONABLE fix command. The collision
    // wants a tunnel stop+start (drops the colliding node, re-registers under
    // the predicted hostname), so `dev tunnel stop && dev tunnel start` is the
    // establishing command — NOT `status`, which only diagnoses.
    return {
      status: "hostname-mismatch",
      owned: false,
      broughtUp: false,
      publicBaseUrl: null,
      fixHint: "cinatra dev tunnel stop && cinatra dev tunnel start",
    };
  }

  // Sidecar down → bring it up. `runDevTunnel("start")` owns the bounded 60s
  // wait + its own optimistic write; it throws on no-authkey / docker errors.
  let broughtUp = false;
  try {
    await bringUpTunnel(["start"]);
    broughtUp = true;
  } catch (err) {
    return {
      status: "bring-up-failed",
      owned: false,
      broughtUp: false,
      publicBaseUrl: null,
      fixHint: "cinatra dev tunnel start",
      reason: err && err.message ? err.message : String(err),
    };
  }

  // After bring-up, re-derive ownership ONE-SHOT and write the URL into the
  // RESOLVED schema (runDevTunnel writes into the hardcoded "cinatra" schema;
  // when this dev instance uses a different schema, THIS write is the
  // authoritative one — codex must-fix: honor schemaName).
  let postRegistered = null;
  let postFunnelUrl = null;
  if (composePathExists(composePath) && composeAvailable() && composeProjectUp(projectName)) {
    try {
      const tailscaleFunnel = await readFunnel({
        projectName,
        composePath,
        composeEnv: process.env,
        timeoutMs: 3_000,
      });
      postRegistered = tailscaleFunnel?.registeredDnsName ?? null;
      postFunnelUrl = tailscaleFunnel?.url ?? null;
    } catch {
      postRegistered = null;
      postFunnelUrl = null;
    }
  }
  const postCheck = await verifyHostname({
    registered: postRegistered,
    dbUrl,
    schema: resolvedSchema,
  });
  if (shouldWritePublicBaseUrl({ funnelUrl: postFunnelUrl, hostnameCheck: postCheck })) {
    try {
      await writeUrl(dbUrl, postFunnelUrl, {
        source: "tailscale-auto",
        schemaName: resolvedSchema,
      });
    } catch (err) {
      // The Funnel is up + owned, but the AUTHORITATIVE resolved-schema write
      // failed — so NOTHING was established in THIS schema. Report it as
      // not-owned so the loud summary warning fires (codex must-fix: a write
      // failure must not be reported as "established").
      console.warn(
        `⚠ Public MCP URL: brought the Funnel up but the schema-resolved write failed (continuing): ${
          err && err.message ? err.message : err
        }`,
      );
      return {
        status: "established-write-failed",
        owned: false,
        broughtUp,
        publicBaseUrl: null,
        fixHint: "cinatra dev tunnel start",
      };
    }
    return {
      status: "established",
      owned: true,
      broughtUp,
      publicBaseUrl: postFunnelUrl,
      fixHint: null,
    };
  }

  // Brought up but no owned URL surfaced within the bound (propagation timing
  // or collision). Soft-fail → warn + name the establishing fix command.
  return {
    status: "established-unverified",
    owned: false,
    broughtUp,
    publicBaseUrl: null,
    fixHint: "cinatra dev tunnel start",
  };
}

async function runCloneStart(argv) {
  // Reject every form of --tailscale-authkey. Implementation lives in
  // clone-runtime.mjs so it's hermetically testable (covers space form +
  // equals form).
  rejectTailscaleAuthkeyFlag(argv);
  const worktreeFlag = readOptionValue(argv,"--worktree-path");
  const callerWorktreePath = path.resolve(worktreeFlag ?? process.cwd());
  const slug = resolveCloneSlug(argv, callerWorktreePath);
  if (!slug) {
    throw new Error("Could not resolve clone slug. Pass `--slug <s>` or run from a clone-on-demand worktree.");
  }
  const rebuildWayflow = argv.includes("--rebuild-wayflow");
  const tailscaleHostNetwork = argv.includes("--tailscale-host-network");
  if (tailscaleHostNetwork && process.platform === "darwin") {
    throw new Error(
      "--tailscale-host-network is Linux-only (Docker Desktop on macOS does not support host networking).",
    );
  }

  const { slot } = loadReadyCloneSlot(slug);
  assertPortBandOk(slot.nextjsPort, "nextjs");
  assertPortBandOk(slot.wayflowPort, "wayflow");

  // The registry slot is the source of truth for the clone's worktree — a
  // dormant clone has no listening socket, so `clone start --slug <s>` must
  // be invocable from anywhere (e.g. the EnterWorktree hook runs from the
  // main repo, not the clone dir). If the operator passed an explicit
  // `--worktree-path` that disagrees with the registry, hard-error rather
  // than silently driving the wrong tree.
  if (
    worktreeFlag &&
    canonicalizeWorktreePath(callerWorktreePath) !== canonicalizeWorktreePath(slot.worktreePath)
  ) {
    throw new Error(
      `Clone "${slug}" is registered at ${slot.worktreePath}, but --worktree-path resolved to ${callerWorktreePath}. ` +
        `Re-run without --worktree-path, or fix the registry with 'cinatra setup clone --force'.`,
    );
  }
  const worktreePath = slot.worktreePath;

  const repoRoot = findRepoRootFromWorktree(worktreePath);
  const projectName = cloneComposeProjectName(slug, slot.index);
  // Legacy hostname kept as the backfill candidate for already-
  // provisioned clones; the canonical value is resolved from the clone
  // DB once `cloneUrl` is available (see `resolveCloneTailscaleHostname`).
  const legacyTailscaleHostname = cloneTailscaleHostname(slug, slot.index);
  let tailscaleHostname = legacyTailscaleHostname;
  const composePath = cloneComposePath(slug);
  const tailscaleServePath = cloneTailscaleServePath(slug);
  const pidPath = clonePidPath(slug);
  const logPath = cloneLogPath(slug);
  ensureCloneRuntimeDir(slug);

  // Acquire the per-clone runtime lock; release in `finally` on every failure
  // path past this point.
  acquireRuntimeLock(slug);
  let success = false;
  let spawnedChildPid = null;
  let composeAttempted = false;
  try {
    // Idempotency check: pid file present + process alive + cwd matches the
    // clone's worktree → no-op. cwd is the strong disambiguator; a stale pid
    // reused by another process must NEVER be misclassified as ours.
    if (existsSync(pidPath)) {
      const recordedPid = readPidFromFile(pidPath);
      if (recordedPid != null) {
        const match = processCommandLineMatches(recordedPid, {
          cwdMustEqual: worktreePath,
        });
        if (match.alive && match.ours) {
          // Avoid false-idempotent on partial start. Validate the FULL stack
          // before declaring "already running".
          const nextProbe = await probeHttp(
            `http://localhost:${slot.nextjsPort}/api/health`,
            { timeoutMs: 1_500, intervalMs: 500 },
          );
          if (nextProbe.ok) {
            const composeUp = isComposeProjectUp(projectName);
            if (composeUp) {
              console.log(`Clone "${slug}" already running (pid ${recordedPid}).`);
              success = true;
              return;
            }
            console.log(
              `Clone "${slug}": Next.js is up but WayFlow compose is not — repairing stack.`,
            );
            // Fall through to (re-)bring up docker compose; skip Next spawn.
          } else {
            console.log(
              `Clone "${slug}": pid ${recordedPid} alive but Next.js health not reachable — repairing stack.`,
            );
          }
        }
        if (match.alive && !match.ours) {
          throw new Error(
            `Clone "${slug}": pid ${recordedPid} is alive but does not match our worktree (${match.why}). Refusing to spawn a second instance.`,
          );
        }
        if (!match.alive) {
          // Process is dead — pid file is stale. Auto-clean.
          try { rmSync(pidPath, { force: true }); } catch { /* best-effort */ }
        }
      }
    }

    // Port-not-already-bound precheck. Catches a 3100 / 3200 conflict before
    // partial startup. Skipped if our own pid file already owns the port
    // (idempotency / partial-stack repair path above).
    const ourPidOwnsPort = existsSync(pidPath) && (() => {
      const p = readPidFromFile(pidPath);
      if (p == null) return false;
      return isPidAlive(p);
    })();
    if (!ourPidOwnsPort) {
      if (await isHostPortBound(slot.nextjsPort)) {
        throw new Error(
          `Clone "${slug}": port ${slot.nextjsPort} (Next.js) is already bound by another process. Free it before starting.`,
        );
      }
    }
    // WayFlow port — docker compose will fail loudly if it's bound, but
    // surface it up-front for symmetry.
    if (await isHostPortBound(slot.wayflowPort)) {
      console.warn(
        `Clone "${slug}": port ${slot.wayflowPort} (WayFlow) already bound. docker compose may fail or attach to an existing container.`,
      );
    }

    // Clone-DB existence precheck. Tailscale auto-mint needs the clone DB URL
    // to read this instance's `instance_identity.instanceNamespace` for the
    // dynamic tag.
    const cloneUrl = readEnvVarFromWorktree(worktreePath, "SUPABASE_DB_URL");

    // Derive the dedicated Tailscale hostname from this clone's immutable
    // isolation inputs (DB name + schema) so the
    // dev-tab flyout's predicted URL equals what the sidecar registers.
    // Already-provisioned clones keep their legacy name (backfill) to
    // avoid live-URL churn. Pure + deterministic — no DB persistence.
    if (cloneUrl) {
      tailscaleHostname = await resolveCloneTailscaleHostname({
        cloneConnString: cloneUrl,
        schemaName:
          readEnvVarFromWorktree(worktreePath, "SUPABASE_SCHEMA") || "cinatra",
        legacyHostname: legacyTailscaleHostname,
        stateDir: cloneTailscaleStateDir(slug),
      });
    }

    // TS_AUTHKEY is optional. Local-only mode runs without a
    // Tailscale sidecar; publicBaseUrl in the clone DB stays cleared.
    // TS_AUTHKEY is env-only; no `--tailscale-authkey` CLI flag exists
    // because it would leak via shell history + ps.
    //
    // When TS_AUTHKEY env is UNSET, fall back to the Nango
    // `cinatra-tailscale` API access token
    // (configured at /connectors/tailscale). The CLI mints a fresh per-
    // clone tag-scoped auth-key on every start using the API token as
    // the Bearer; the resulting publicBaseUrl is tagged `"tailscale-auto"`
    // (vs `"tailscale-funnel"` for the env-keyed legacy path) so the dev
    // tab can distinguish operator-pasted from auto-provisioned URLs.
    let tsAuthkey = process.env.TS_AUTHKEY ?? "";
    let tailscaleEnabled = false;
    /** @type {"env" | "nango"} */
    let tailscaleAuthkeySource = "env";
    if (tsAuthkey.length > 0) {
      validateTailscaleAuthkey(tsAuthkey);
      tailscaleEnabled = true;
      tailscaleAuthkeySource = "env";
    } else if (cloneUrl) {
      // Declared in the outer scope so the catch can `instanceof`-test it; it
      // stays `undefined` when the lazy import below was the throwing call (an
      // extension-empty checkout), in which case we fall through to local-only
      // mode rather than hard-failing.
      let TailscaleApiError;
      try {
        // Lazy-load the connector's typed error INSIDE the try so an
        // extension-empty checkout (ERR_MODULE_NOT_FOUND on the gitignored
        // source) is caught and falls through to local-only mode.
        ({ TailscaleApiError } = await loadTailscaleApiModule());
        const mintedFromNango = await autoMintTailscaleAuthKeyFromNango(cloneUrl);
        if (mintedFromNango) {
          validateTailscaleAuthkey(mintedFromNango);
          tsAuthkey = mintedFromNango;
          tailscaleEnabled = true;
          tailscaleAuthkeySource = "nango";
          console.log(
            "Tailscale auth-key minted from Nango `cinatra-tailscale` (auto-tunnel).",
          );
        }
      } catch (err) {
        // Surface typed errors to the operator without leaking secrets.
        if (TailscaleApiError && err instanceof TailscaleApiError) {
          console.warn(
            `Tailscale auto-tunnel skipped: ${err.code} — ${err.message}`,
          );
        } else {
          console.warn(
            `Tailscale auto-tunnel skipped: ${err?.name ?? "unknown error"}`,
          );
        }
        // Fall through to local-only mode.
      }
    }

    // Clone-DB existence precheck (post-move: validate cloneUrl after
    // potential Tailscale auto-mint has had a chance to use it).
    if (!cloneUrl) {
      throw new Error(
        `Clone "${slug}": ${path.join(worktreePath, ".env.local")} missing SUPABASE_DB_URL. Re-run 'cinatra setup clone --force'.`,
      );
    }
    try {
      await pingCloneDb(cloneUrl);
    } catch (err) {
      throw new Error(
        `Clone "${slug}": cannot reach clone database (${err?.message ?? err}). Run 'cinatra setup clone --force' or check that Postgres is up.`,
      );
    }

    // Make sure the cinatra-wayflow:local image exists.
    if (!isComposeAvailable()) {
      throw new Error("`docker compose` is not available on PATH.");
    }
    ensureWayflowImage({ forceRebuild: rebuildWayflow, repoRoot });

    // Render per-clone compose.yml. The template lives in the repo at
    // docker/wayflow/compose.clone.template.yml.
    const templatePath = path.join(repoRoot, "docker", "wayflow", "compose.clone.template.yml");
    if (!existsSync(templatePath)) {
      throw new Error(
        `Per-clone compose template missing at ${templatePath}. Is the clone runtime template present?`,
      );
    }
    renderCloneComposeTemplate({
      templatePath,
      outPath: composePath,
      vars: {
        NEXTJS_PORT: slot.nextjsPort,
        WAYFLOW_PORT: slot.wayflowPort,
        WORKTREE_PATH: worktreePath,
        TS_HOSTNAME: tailscaleHostname,
        CLONE_STATE_DIR: cloneRuntimeDir(slug),
        TAILSCALE_NETWORK_MODE: tailscaleHostNetwork ? "host" : "bridge",
      },
    });

    // Write Tailscale serve config only when the sidecar is enabled.
    if (tailscaleEnabled) {
      writeTailscaleServeConfig({
        servePath: tailscaleServePath,
        tailscaleHostname,
        nextjsPort: slot.nextjsPort,
        hostNetwork: tailscaleHostNetwork,
      });
    }

    // Per-clone bridge token. Generate once, persist in clone DB, propagate to
    // BOTH the host Next.js process (via the env we spawn pnpm dev with) AND
    // the per-clone WayFlow container (via the compose env at docker up time).
    const bridgeToken = await ensureCloneBridgeToken(cloneUrl);

    // Skip the pnpm-dev spawn only when our pid file points at a live, cwd-
    // matched process AND `/api/health` actually returns 200. pid+cwd match
    // alone isn't enough; Next.js might be stuck or in a startup loop. Without
    // the health probe we'd skip the respawn and never recover.
    const existingPid = existsSync(pidPath) ? readPidFromFile(pidPath) : null;
    const existingMatchesUs = existingPid != null && processCommandLineMatches(existingPid, {
      cwdMustEqual: worktreePath,
    }).ours;
    let skipNextSpawn = false;
    if (existingMatchesUs) {
      const probe = await probeHttp(`http://localhost:${slot.nextjsPort}/api/health`, {
        timeoutMs: 1_500,
        intervalMs: 500,
      });
      skipNextSpawn = probe.ok;
      if (!probe.ok) {
        // Pid alive + cwd-matched but unhealthy — kill it before respawn.
        console.log(`  Next.js pid ${existingPid} alive but unhealthy — restarting.`);
        try { process.kill(-existingPid, "SIGTERM"); } catch { /* best-effort */ }
        // Brief grace, then SIGKILL if still alive.
        await new Promise((r) => setTimeout(r, 3_000));
        if (isPidAlive(existingPid)) {
          try { process.kill(-existingPid, "SIGKILL"); } catch { /* gone */ }
        }
        try { rmSync(pidPath, { force: true }); } catch { /* best-effort */ }
      }
    }

    if (!skipNextSpawn) {
      // Spawn host-native Next.js. Truncate log + write pid file. Process group
      // leader (detached=true) so `clone stop` SIGTERMs the whole tree (turbopack,
      // tsc-watch, etc.).
      truncateCloneLog(slug);
      const logFd = openSync(logPath, "a", 0o600);
      // The host Next.js process must NOT inherit TS_AUTHKEY — it is a
      // Tailscale secret only the compose/sidecar process needs. Strip it
      // from the spawned env (it would otherwise leak via `...process.env`).
      const childEnv = {
        ...process.env,
        ...readEnvFileSnapshot(path.join(worktreePath, ".env.local")),
        CINATRA_BRIDGE_TOKEN: bridgeToken,
        CINATRA_CLONE_SLUG: slug,
      };
      delete childEnv.TS_AUTHKEY;
      const child = spawn("pnpm", ["dev"], {
        cwd: worktreePath,
        env: childEnv,
        detached: true,
        stdio: ["ignore", logFd, logFd],
      });
      closeSync(logFd);
      if (!child.pid) {
        throw new Error("Failed to spawn `pnpm dev` for the clone.");
      }
      writeFileSync(pidPath, `${child.pid}\n${new Date().toISOString()}\n`, { mode: 0o600 });
      spawnedChildPid = child.pid;
      child.unref();
    }

    // Bring up WayFlow (+ Tailscale if enabled). Pass the clone-specific
    // bridge token so the per-clone WayFlow doesn't inherit main's
    // CINATRA_BRIDGE_TOKEN from the operator's shell.
    const composeEnv = {
      ...process.env,
      CINATRA_BRIDGE_TOKEN: bridgeToken,
    };
    if (tailscaleEnabled) composeEnv.TS_AUTHKEY = tsAuthkey;
    const services = ["wayflow"];
    if (tailscaleEnabled) services.push("tailscale");
    const upArgs = ["compose", "-p", projectName, "-f", composePath, "up", "-d", ...services];
    // Scrub TS_AUTHKEY out of any forwarded stderr. Pipe + scrub instead of
    // inheriting stdio when Tailscale is enabled.
    composeAttempted = true;
    const upResult = spawnSync("docker", upArgs, {
      env: composeEnv,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const upStdout = tailscaleEnabled
      ? scrubTailscaleAuthkey(upResult.stdout ?? "", tsAuthkey)
      : (upResult.stdout ?? "");
    const upStderr = tailscaleEnabled
      ? scrubTailscaleAuthkey(upResult.stderr ?? "", tsAuthkey)
      : (upResult.stderr ?? "");
    if (upStdout) process.stdout.write(upStdout);
    if (upStderr) process.stderr.write(upStderr);
    if (upResult.status !== 0) {
      throw new Error(`docker compose up failed (exit ${upResult.status}).`);
    }

    // Health probes.
    console.log(`Waiting for Next.js at http://localhost:${slot.nextjsPort}/api/health ...`);
    const nextHealth = await probeHttp(`http://localhost:${slot.nextjsPort}/api/health`, { timeoutMs: 60_000 });
    if (!nextHealth.ok) {
      console.warn(`  Next.js health failed: ${nextHealth.error}. Inspect ${logPath}.`);
    } else {
      console.log("  Next.js: OK");
    }
    console.log(`Waiting for WayFlow at http://localhost:${slot.wayflowPort}/.health ...`);
    const wfHealth = await probeHttp(`http://localhost:${slot.wayflowPort}/.health`, { timeoutMs: 60_000 });
    if (!wfHealth.ok) {
      console.warn(`  WayFlow health failed: ${wfHealth.error}.`);
    } else {
      console.log("  WayFlow: OK");
    }

    // Tailscale Funnel: derive the deterministic
    // URL from `Self.DNSName`, fail loud on a MagicDNS collision,
    // then write clone DB `publicBaseUrl` IMMEDIATELY. The write is
    // intentionally DECOUPLED from `/api/mcp/health` reachability:
    // Fresh ephemeral nodes can hold NXDOMAIN for longer than any practical
    // probe window while `Self.DNSName` is byte-identical to the deterministic
    // prediction, so gating the write on a racing probe leaves a race-losing
    // clone with NO publicBaseUrl. Reachability is NOT probed by a background
    // poll because this is a one-shot CLI that exits on event-loop drain; it is
    // surfaced as one honest log line, and propagation timing lies outside this
    // CLI's lifecycle.
    if (tailscaleEnabled) {
      const tailscaleFunnel = await waitForTailscaleFunnelUrl({
        projectName,
        composePath,
        composeEnv,
        timeoutMs: 60_000,
      });
      const funnelUrl = tailscaleFunnel?.url ?? null;
      // Guard the RAW registered Self.DNSName, never a prediction-reconstructed
      // value, because that would be circular.
      const registeredDnsName = tailscaleFunnel?.registeredDnsName ?? null;
      if (funnelUrl) {
        console.log(`Tailscale Funnel URL: ${funnelUrl}`);
        // Compare the actually-registered MagicDNS hostname against the
        // deterministic prediction. Mismatch / unresolved ⇒ fail loud, NO
        // write (a `-1` collision suffix yields a dead predicted URL).
        const schema =
          readEnvVarFromWorktree(worktreePath, "SUPABASE_SCHEMA") || "cinatra";
        const hostnameCheck = await verifyRegisteredHostnameMatchesPrediction({
          registered: registeredDnsName,
          dbUrl: cloneUrl,
          schema,
        });
        // Tag the source so the dev tab can distinguish auto-provisioned
        // (Nango OAuth client) from operator-pasted URLs.
        const urlSource =
          tailscaleAuthkeySource === "nango" ? "tailscale-auto" : "tailscale-funnel";
        if (shouldWritePublicBaseUrl({ funnelUrl, hostnameCheck })) {
          await writeClonePublicBaseUrl(cloneUrl, funnelUrl, { source: urlSource });
          // A detached reachability poll is architecturally incoherent in a
          // one-shot non-daemon CLI: `runCli` returns and the process exits on
          // event-loop drain, so an unref'd inter-iteration timer makes the
          // loop unreachable after the first failed probe. The optimistic write
          // above is the fix; the URL is deterministic and proven byte-
          // identical to `Self.DNSName`. Reachability is DNS/cert propagation
          // timing outside this CLI's lifecycle, so we state it honestly in
          // one line and exit promptly. No probe, no timers.
          console.log(
            `  publicBaseUrl written (source: ${urlSource}). Tailscale Funnel ` +
              `cert/DNS for a fresh node typically takes a few minutes to ` +
              `propagate — the URL is deterministic and correct; it becomes ` +
              `reachable once propagation completes. (One-shot CLI does not ` +
              `probe.)`,
          );
        } else {
          const err = hostnameCheck.error;
          console.warn(
            `  Tailscale hostname check failed: ${
              err instanceof TailscaleProvisionError
                ? `${err.code} — ${err.message}`
                : err?.message ?? "unknown"
            }. publicBaseUrl NOT written.`,
          );
        }
      } else {
        console.warn("Tailscale sidecar started but did not surface a Funnel URL within 60s.");
      }
    } else {
      console.log("(Tailscale Funnel skipped — TS_AUTHKEY unset; publicBaseUrl remains cleared.)");
    }

    success = true;
    console.log("");
    console.log(`Clone "${slug}" started.`);
    console.log(`  Next.js:  http://localhost:${slot.nextjsPort}`);
    console.log(`  WayFlow:  http://localhost:${slot.wayflowPort}`);
    console.log(`  pid:      ${pidPath}`);
    console.log(`  log:      ${logPath}`);
  } finally {
    if (!success && spawnedChildPid != null) {
      // We spawned `pnpm dev` THIS run but start ultimately failed. Don't
      // leak the Next.js process group + a dangling pid file. (We only kill
      // a pid WE spawned — a pre-existing healthy Next.js from an
      // idempotent-repair start is never signalled.)
      try {
        process.kill(-spawnedChildPid, "SIGTERM");
      } catch {
        try { process.kill(spawnedChildPid, "SIGTERM"); } catch { /* gone */ }
      }
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && isPidAlive(spawnedChildPid)) {
        await new Promise((r) => setTimeout(r, 200));
      }
      if (isPidAlive(spawnedChildPid)) {
        try { process.kill(-spawnedChildPid, "SIGKILL"); } catch { /* gone */ }
        try { process.kill(spawnedChildPid, "SIGKILL"); } catch { /* gone */ }
      }
      try { rmSync(pidPath, { force: true }); } catch { /* best-effort */ }
    }
    if (!success && composeAttempted && existsSync(composePath) && isComposeAvailable()) {
      // Tear down compose on ANY failed start once `docker compose up` was
      // attempted — independent of whether we spawned Next.js this run. A
      // `skipNextSpawn` repair where compose up then fails would otherwise
      // leave orphaned containers if cleanup were gated on spawnedChildPid.
      spawnSync("docker", ["compose", "-p", projectName, "-f", composePath, "down"], {
        stdio: ["ignore", "ignore", "ignore"],
      });
    }
    releaseRuntimeLock(slug);
  }
}

// ---------------------------------------------------------------------------
// `cinatra dev tunnel <start|stop|status>`.
//
// This is a CLI verb, not a dev-boot hook: explicit, no surprise sidecars,
// independently testable, and composed with the flat `runCli` if-ladder exactly
// like `clone start/stop/status`. It brings the bare `pnpm dev` MAIN instance
// its OWN dedicated Tailscale Funnel (`cinatra-main` → predicted by
// `deriveDevTailscaleHostname`) live.
//
// HARD CONSTRAINT: every piece of provisioning machinery is REUSED from
// clone-start by direct call — `renderCloneComposeTemplate`,
// `writeTailscaleServeConfig`, `autoMintTailscaleAuthKeyFromNango`,
// `waitForTailscaleFunnelUrl`, `writeClonePublicBaseUrl`, the hostname guard
// (`verifyRegisteredHostnameMatchesPrediction`) + the write-decision
// (`shouldWritePublicBaseUrl`). Nothing is forked /
// duplicated (regression-asserted in tests/dev-tunnel.test.mjs).
//
// The outcome here matches `runCloneStart`: derive funnelUrl → guard on the
// RAW registered Self.DNSName → optimistic immediate `writeClonePublicBaseUrl`
// into the MAIN app DB's `connector_config:mcp_server` row (the same row the
// dev tab reads) → one honest informational log line (NO background
// `/api/mcp/health` poll because this is a one-shot CLI that exits on
// event-loop drain) → on a guard mismatch a typed `TailscaleProvisionError`,
// NO write.
//
// Dev-only HARD GATE:
// refuses to run unless the configured runtime mode is "development", so
// a production main is NEVER Funnel-exposed (it keeps the operator-
// supplied URL model at /configuration/development?tab=tunnel).
//
// The reserved per-main slug is the fixed string "dev-main". It is a
// valid slug shape but is NEVER registered in the clone registry —
// `runDevTunnel` deliberately bypasses `loadReadyCloneSlot`, using only
// the slug-parameterised PURE path builders (lowest-risk reuse, no
// parallel path scheme). A real registered clone literally named
// "dev-main" would collide; we assert none exists before any side effect.
async function runDevTunnel(argv) {
  const action = String(argv[0] ?? "").trim();
  if (action !== "start" && action !== "stop" && action !== "status") {
    throw new Error(
      `Unknown 'cinatra dev tunnel' sub-command "${argv[0] ?? ""}". ` +
        `Expected: cinatra dev tunnel <start|stop|status>.`,
    );
  }

  // --- shared preamble (all three sub-actions) ----------------------------
  // Intentional divergence from clone-start. clone-start uses
  // `findRepoRootFromWorktree()` (git --git-common-dir) because its template
  // changes only take effect once merged to main. dev-tunnel provisions THIS
  // dev instance (not a clone), so the local checkout's
  // `docker/wayflow/compose.clone.template.yml` IS the correct one — hence
  // `getRepoRoot()` (module-relative). Not an oversight.
  const repoRoot = getRepoRoot();
  const env = collectEnvironment(repoRoot);

  // Dev-only HARD REFUSAL. Fires BEFORE any Docker / Nango / DB work.
  if (readConfiguredRuntimeMode(env) !== "development") {
    throw new Error(
      "cinatra dev tunnel is development-only. Set CINATRA_RUNTIME_MODE=development " +
        "(this provisions a Tailscale sidecar for the local dev main; production " +
        "main must use the operator-supplied public URL at " +
        "/configuration/development?tab=tunnel).",
    );
  }

  // Reserved per-main slug. NEVER a registered clone — assert no real
  // clone has claimed this name before doing anything (collision guard;
  // collision-safety sibling). `readRegistry` is a safe non-throwing
  // reader; a missing/empty registry just means "no clones", which is
  // fine.
  const DEV_MAIN_SLUG = "dev-main";
  const DEV_MAIN_INDEX = 0;
  let registeredClone = null;
  try {
    registeredClone = getClone(readRegistry(defaultRegistryPath()), DEV_MAIN_SLUG);
  } catch {
    registeredClone = null;
  }
  if (registeredClone) {
    throw new Error(
      `A registered clone named "${DEV_MAIN_SLUG}" exists — that name is ` +
        `reserved by 'cinatra dev tunnel' for the local dev main. Prune or ` +
        `rename the clone (it would collide on the compose project + runtime ` +
        `dir).`,
    );
  }

  // Main's identity inputs from the main repo `.env.local`.
  const mainDbUrl =
    env.SUPABASE_DB_URL ?? process.env.SUPABASE_DB_URL ?? null;
  const mainSchema =
    env.SUPABASE_SCHEMA || process.env.SUPABASE_SCHEMA || "cinatra";

  // NOTE: the predicted hostname (and its lazy connector-helper import) is
  // derived in the `start` branch below — NOT here. `stop` needs no hostname,
  // and `status` derives its own via `verifyRegisteredHostnameMatchesPrediction`
  // (which lazy-imports internally), so neither must pay the connector-source
  // import. Computing it in the shared preamble would hard-fail `stop`/`status`
  // on an extension-empty checkout, defeating the cold-boot fix.

  // Stable per-main runtime paths under the reserved "dev-main" slug.
  // These clone-runtime helpers are slug-parameterised PURE path builders
  // — passing the reserved slug is the lowest-risk reuse (no parallel
  // path scheme invented).
  const composePath = cloneComposePath(DEV_MAIN_SLUG);
  const servePath = cloneTailscaleServePath(DEV_MAIN_SLUG);
  const projectName = cloneComposeProjectName(DEV_MAIN_SLUG, DEV_MAIN_INDEX);
  // The local dev main's Next.js port is the bare `pnpm dev` default
  // (3000) — NOT the 3100+ clone band.
  const nextjsPort = Number(env.PORT) || 3000;

  if (action === "status") {
    // Never throws on "not running". Predicted hostname is already
    // computed; attempt a SHORT (3s) non-fatal probe for the registered
    // value and read whether publicBaseUrl is currently set in the main
    // DB (same metadata read helper `writeClonePublicBaseUrl` uses).
    // Short-circuit on `isComposeProjectUp` (one cheap call) so a down
    // project skips the ~3s / 3-spawn
    // `waitForTailscaleFunnelUrl` loop entirely — behaviour is identical
    // (registeredDnsName stays null when not running), just faster.
    let registeredDnsName = null;
    if (
      existsSync(composePath) &&
      isComposeAvailable() &&
      isComposeProjectUp(projectName)
    ) {
      try {
        const tailscaleFunnel = await waitForTailscaleFunnelUrl({
          projectName,
          composePath,
          composeEnv: process.env,
          timeoutMs: 3_000,
        });
        registeredDnsName = tailscaleFunnel?.registeredDnsName ?? null;
      } catch {
        registeredDnsName = null;
      }
    }
    const hostnameCheck = await verifyRegisteredHostnameMatchesPrediction({
      registered: registeredDnsName,
      dbUrl: mainDbUrl,
      schema: mainSchema,
    });
    let publicBaseUrl = null;
    if (mainDbUrl) {
      const client = createClient(mainDbUrl);
      try {
        await client.connect();
        const current = await readMetadataValue(
          client,
          mainSchema,
          MCP_SETTINGS_KEY,
          {},
        );
        publicBaseUrl =
          current && typeof current === "object"
            ? current.publicBaseUrl ?? null
            : null;
      } catch {
        publicBaseUrl = null;
      } finally {
        await client.end().catch(() => null);
      }
    }
    console.log("cinatra dev tunnel — main Tailscale Funnel status");
    console.log(`  predicted hostname:  ${hostnameCheck.predicted}`);
    console.log(
      `  registered hostname: ${registeredDnsName ? hostnameCheck.registered : "(not running)"}`,
    );
    console.log(
      `  predicted == registered: ${
        registeredDnsName ? (hostnameCheck.ok ? "yes" : "NO (collision/unresolved)") : "n/a (not running)"
      }`,
    );
    console.log(
      `  publicBaseUrl in main DB: ${publicBaseUrl ? publicBaseUrl : "(not set)"}`,
    );
    return;
  }

  if (action === "stop") {
    // Best-effort teardown. NOTE the asymmetry vs `stopCloneRuntime`: that
    // clears a CLONE's isolated DB where the only publicBaseUrl source is
    // the clone Funnel, so an unconditional clear is safe there. This
    // writes the MAIN app DB's connector_config:mcp_server row — the SAME
    // row the operator-supplied URL surface at
    // /configuration/development?tab=tunnel reads/writes (source
    // "manual"). Only clear when dev-tunnel/clone owns the value (source
    // tailscale-auto / tailscale-funnel); an
    // operator-pasted manual URL (e.g. a named Cloudflare/ngrok tunnel)
    // must NOT be silently destroyed by `dev tunnel stop`.
    if (existsSync(composePath) && isComposeAvailable()) {
      const downResult = spawnSync(
        "docker",
        ["compose", "-p", projectName, "-f", composePath, "down"],
        { stdio: ["ignore", "inherit", "inherit"] },
      );
      if (downResult.status !== 0) {
        console.warn(`docker compose down exited ${downResult.status}.`);
      }
    }
    if (mainDbUrl) {
      const client = createClient(mainDbUrl);
      let src = null;
      try {
        await client.connect();
        const current = await readMetadataValue(
          client,
          mainSchema,
          MCP_SETTINGS_KEY,
          {},
        );
        src =
          current && typeof current === "object"
            ? current.publicBaseUrlSource ?? null
            : null;
      } catch {
        src = null;
      } finally {
        await client.end().catch(() => null);
      }
      if (src === "tailscale-auto" || src === "tailscale-funnel") {
        try {
          await writeClonePublicBaseUrl(mainDbUrl, null, { schemaName: mainSchema });
          console.log(
            "cinatra dev tunnel stopped for main; publicBaseUrl cleared.",
          );
        } catch (err) {
          console.warn(
            `  Failed to clear publicBaseUrl in main DB: ${err?.message ?? err}`,
          );
        }
      } else {
        console.log(
          "cinatra dev tunnel stopped for main; left operator-set " +
            `publicBaseUrl (source: ${src ?? "unknown"}) untouched.`,
        );
      }
      return;
    }
    console.log("cinatra dev tunnel stopped for main; publicBaseUrl cleared.");
    return;
  }

  // --- action === "start" -------------------------------------------------

  // SINGLE source of truth for the predicted hostname — never re-derive by
  // hand. Expected `cinatra-main` for a default main. The connector helper is
  // loaded lazily here (the `start` path is post-config, so the extension is
  // present); `stop`/`status` already returned above without needing it.
  const { deriveDevTailscaleHostname } = await loadTailscaleHostnameModule();
  const tailscaleHostname = deriveDevTailscaleHostname({
    dbUrl: mainDbUrl,
    schema: mainSchema,
  });

  // 1. Idempotency: skip if the dev-main compose project is already up.
  if (isComposeProjectUp(projectName)) {
    console.log("cinatra dev tunnel already running for main.");
    return;
  }

  // 2. Compose availability + image.
  if (!isComposeAvailable()) {
    throw new Error("`docker compose` is not available on PATH.");
  }
  ensureWayflowImage({ repoRoot });

  // 3. Mint the auth-key. TS_AUTHKEY env wins; else mint from Nango.
  //    Wrap the Nango mint in try/catch surfacing TailscaleApiError.code
  //    without leaking secrets — exactly as runCloneStart does.
  let tsAuthkey = process.env.TS_AUTHKEY ?? "";
  /** @type {"env" | "nango"} */
  let tailscaleAuthkeySource = "env";
  if (tsAuthkey.length > 0) {
    validateTailscaleAuthkey(tsAuthkey);
    tailscaleAuthkeySource = "env";
  } else {
    // Lazy-load the connector's typed error so the `instanceof` check in the
    // catch resolves at runtime (the extension is present on this post-config
    // provisioning path).
    const { TailscaleApiError } = await loadTailscaleApiModule();
    let mintedFromNango = null;
    try {
      mintedFromNango = await autoMintTailscaleAuthKeyFromNango(mainDbUrl);
    } catch (err) {
      if (err instanceof TailscaleApiError) {
        throw new Error(
          `No Tailscale auth-key: Nango mint failed (${err.code} — ${err.message}). ` +
            `Set TS_AUTHKEY or connect Tailscale at /connectors/tailscale.`,
        );
      }
      throw new Error(
        `No Tailscale auth-key: Nango mint failed (${err?.name ?? "unknown error"}). ` +
          `Set TS_AUTHKEY or connect Tailscale at /connectors/tailscale.`,
      );
    }
    if (!mintedFromNango) {
      throw new Error(
        "No Tailscale auth-key: set TS_AUTHKEY or connect Tailscale at /connectors/tailscale.",
      );
    }
    validateTailscaleAuthkey(mintedFromNango);
    tsAuthkey = mintedFromNango;
    tailscaleAuthkeySource = "nango";
    console.log(
      "Tailscale auth-key minted from Nango `cinatra-tailscale` (dev-tunnel).",
    );
  }

  // 4. Tailscale serve config — bridge networking (host-network is the
  //    Linux-only clone affordance; dev-tunnel uses bridge, so the
  //    sidecar proxies to host.docker.internal:<nextjsPort>, which
  //    writeTailscaleServeConfig already produces for hostNetwork:false).
  writeTailscaleServeConfig({
    servePath,
    tailscaleHostname,
    nextjsPort,
    hostNetwork: false,
  });

  // 5. Render the per-main compose.yml from the SAME clone template, then
  //    bring up ONLY the `tailscale` service: the dev main already runs
  //    its own Next.js + WayFlow via `pnpm dev`, so starting wayflow/next
  //    here would clash on ports. WAYFLOW_PORT is set
  //    to an intentionally-unused high port (the wayflow service is never
  //    started, so the value is inert — it only satisfies the template
  //    substitution).
  const DEV_MAIN_UNUSED_WAYFLOW_PORT = 39999;
  const templatePath = path.join(
    repoRoot,
    "docker",
    "wayflow",
    "compose.clone.template.yml",
  );
  if (!existsSync(templatePath)) {
    throw new Error(
      `Per-clone compose template missing at ${templatePath}. Is the clone runtime template present?`,
    );
  }
  renderCloneComposeTemplate({
    templatePath,
    outPath: composePath,
    vars: {
      NEXTJS_PORT: nextjsPort,
      // Deliberately-unused: only the `tailscale` service is brought up.
      WAYFLOW_PORT: DEV_MAIN_UNUSED_WAYFLOW_PORT,
      WORKTREE_PATH: repoRoot,
      TS_HOSTNAME: tailscaleHostname,
      CLONE_STATE_DIR: cloneRuntimeDir(DEV_MAIN_SLUG),
      TAILSCALE_NETWORK_MODE: "bridge",
    },
  });

  const composeEnv = { ...process.env, TS_AUTHKEY: tsAuthkey };
  // Start ONLY the tailscale service (mirror how clone-start scopes
  // services.push("tailscale") — but here that is the ONLY service).
  composeEnv.TS_AUTHKEY = tsAuthkey;
  const upArgs = [
    "compose",
    "-p",
    projectName,
    "-f",
    composePath,
    "up",
    "-d",
    "tailscale",
  ];
  const upResult = spawnSync("docker", upArgs, {
    env: composeEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // Finite safety bound (cinatra#260 Step 3): the auto-bring-up from `cinatra
    // setup dev` calls this — a hung `compose up` must not block setup forever.
    // On timeout spawnSync kills the child; the throw below surfaces it (soft-
    // failed by the setup caller).
    timeout: COMPOSE_UP_TIMEOUT_MS,
  });
  const upStdout = scrubTailscaleAuthkey(upResult.stdout ?? "", tsAuthkey);
  const upStderr = scrubTailscaleAuthkey(upResult.stderr ?? "", tsAuthkey);
  if (upStdout) process.stdout.write(upStdout);
  if (upStderr) process.stderr.write(upStderr);
  if (upResult.error || upResult.status !== 0) {
    throw new Error(
      `docker compose up failed${
        upResult.error?.code === "ETIMEDOUT" ? " (timed out)" : ` (exit ${upResult.status})`
      }.`,
    );
  }

  // Same shared path as runCloneStart: derive funnelUrl → guard on the RAW
  // registered Self.DNSName → optimistic immediate write into the MAIN app
  // DB's connector_config:mcp_server row → one honest informational log line
  // (NO background poll in a one-shot CLI) → on a guard mismatch a typed
  // TailscaleProvisionError, NO write.
  const tailscaleFunnel = await waitForTailscaleFunnelUrl({
    projectName,
    composePath,
    composeEnv,
    timeoutMs: 60_000,
  });
  const funnelUrl = tailscaleFunnel?.url ?? null;
  // Guard the RAW registered Self.DNSName, never a prediction-reconstructed
  // value, because that would be circular.
  const registeredDnsName = tailscaleFunnel?.registeredDnsName ?? null;
  if (funnelUrl) {
    console.log(`Tailscale Funnel URL: ${funnelUrl}`);
    const hostnameCheck = await verifyRegisteredHostnameMatchesPrediction({
      registered: registeredDnsName,
      dbUrl: mainDbUrl,
      schema: mainSchema,
    });
    // Tag the source so the dev tab can distinguish auto-provisioned
    // (Nango OAuth client) from operator-pasted URLs.
    const urlSource =
      tailscaleAuthkeySource === "nango" ? "tailscale-auto" : "tailscale-funnel";
    if (shouldWritePublicBaseUrl({ funnelUrl, hostnameCheck })) {
      // Honor the resolved SUPABASE_SCHEMA (cinatra#260 Step 3 codex must-fix):
      // a non-default-schema dev main must NOT have its publicBaseUrl written
      // into a hardcoded "cinatra" schema as a side effect.
      await writeClonePublicBaseUrl(mainDbUrl, funnelUrl, { source: urlSource, schemaName: mainSchema });
      // A detached reachability poll is architecturally incoherent in a
      // one-shot non-daemon CLI: the process exits on event-loop drain and the
      // unref'd inter-iteration timer makes the loop unreachable after the
      // first failed probe. The optimistic write above is the fix; the URL is
      // deterministic and proven byte-identical to `Self.DNSName`.
      // Reachability is propagation timing outside this CLI's lifecycle, so it
      // is stated honestly in one line and the command exits promptly. No
      // probe, no timers.
      console.log(
        `  publicBaseUrl written (source: ${urlSource}). Tailscale Funnel ` +
          `cert/DNS for a fresh node typically takes a few minutes to ` +
          `propagate — the URL is deterministic and correct; it becomes ` +
          `reachable once propagation completes. (One-shot CLI does not ` +
          `probe.)`,
      );
    } else {
      const err = hostnameCheck.error;
      console.warn(
        `  Tailscale hostname check failed: ${
          err instanceof TailscaleProvisionError
            ? `${err.code} — ${err.message}`
            : err?.message ?? "unknown"
        }. publicBaseUrl NOT written.`,
      );
    }
  } else {
    console.warn(
      "Tailscale sidecar started but did not surface a Funnel URL within 60s.",
    );
  }

  console.log("");
  console.log("cinatra dev tunnel started for main.");
  console.log(`  Funnel:  https://${tailscaleHostname}.<tailnet>.ts.net`);
  console.log(
    "  The dev tab at /configuration/development?tab=tunnel now reflects this URL.",
  );
}

function readPidFromFile(pidPath) {
  try {
    const raw = readFileSync(pidPath, "utf8");
    const first = raw.split("\n", 1)[0]?.trim();
    if (!first) return null;
    const pid = Number.parseInt(first, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function readEnvVarFromWorktree(worktreePath, key) {
  const envPath = path.join(worktreePath, ".env.local");
  if (!existsSync(envPath)) return null;
  const { values } = readEnvFileOrdered(envPath);
  return values[key] ?? null;
}

function readEnvFileSnapshot(envPath) {
  if (!existsSync(envPath)) return {};
  const { values } = readEnvFileOrdered(envPath);
  return values;
}

function writeTailscaleServeConfig({ servePath, tailscaleHostname, nextjsPort, hostNetwork }) {
  const backend = hostNetwork
    ? `http://127.0.0.1:${nextjsPort}`
    : `http://host.docker.internal:${nextjsPort}`;
  const config = {
    TCP: { 443: { HTTPS: true } },
    Web: {
      [`${tailscaleHostname}:443`]: {
        Handlers: { "/": { Proxy: backend } },
      },
    },
    AllowFunnel: { [`${tailscaleHostname}:443`]: true },
  };
  ensureDirOf(servePath);
  writeFileSync(servePath, JSON.stringify(config, null, 2), { mode: 0o600 });
}

/**
 * Poll `tailscale status --json` until `Self.DNSName` is registered.
 *
 * Returns BOTH the massaged Funnel URL AND the RAW `Self.DNSName` exactly
 * as Tailscale reported it (trailing dot and
 * any MagicDNS `-1` collision suffix preserved). The hostname guard
 * (`verifyRegisteredHostnameMatchesPrediction`) MUST see the raw
 * registered value — never a URL reconstructed from the prediction —
 * otherwise it would validate the prediction against itself (circular,
 * defeating collision detection).
 *
 * @returns {Promise<{ url: string, registeredDnsName: string } | null>}
 *   `null` if no `.ts.net` `Self.DNSName` surfaced within `timeoutMs`.
 */
async function waitForTailscaleFunnelUrl({ projectName, composePath, composeEnv, timeoutMs = 60_000 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = spawnSync(
      "docker",
      ["compose", "-p", projectName, "-f", composePath, "exec", "-T", "tailscale", "tailscale", "status", "--json"],
      // Per-spawn timeout (cinatra#260 Step 3 codex must-fix): a HUNG
      // `docker compose exec` would otherwise never let the `timeoutMs` loop
      // deadline be reached, so `cinatra setup dev` auto-bring-up could hang.
      // A single status read is fast; cap it well under the loop interval so a
      // stuck exec is killed and the loop's deadline check stays authoritative.
      {
        env: composeEnv,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: TAILSCALE_STATUS_SPAWN_TIMEOUT_MS,
      },
    );
    if (result.status === 0 && result.stdout) {
      try {
        const json = JSON.parse(result.stdout);
        const dnsName = json?.Self?.DNSName;
        if (typeof dnsName === "string" && dnsName.endsWith(".ts.net.")) {
          // Tailscale DNS names include a trailing dot; strip it for the
          // URL only — `registeredDnsName` keeps the raw value for validation.
          return { url: `https://${dnsName.replace(/\.$/, "")}`, registeredDnsName: dnsName };
        }
        if (typeof dnsName === "string" && dnsName.endsWith(".ts.net")) {
          return { url: `https://${dnsName}`, registeredDnsName: dnsName };
        }
      } catch {
        // continue polling
      }
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return null;
}

/**
 * Read the Tailscale API access token stored on the Nango `cinatra-tailscale`
 * connection via HTTP. No
 * `@nangohq/node` dep — matches the CLI's minimal-dep doctrine.
 *
 * Uses Nango's built-in `tailscale-api-key` provider (`auth_mode: API_KEY`).
 * The token lives at the **connection** level (API_KEY can't go at
 * integration level per Nango's public schema). We GET the connection
 * and read `credentials.apiKey` + `connection_config.organizationName`.
 *
 * Uses `discoverBootstrapNangoSettings(...)` so the same multi-source URL
 * + secret discovery the rest of the CLI uses also feeds this helper —
 * `/tmp/nango/.env`, default server URL, local Nango DB read for the
 * secret. Bare `process.env.NANGO_*` is not sufficient on a typical local
 * setup where Nango is brought up via `pnpm services` and the operator
 * never exports the secret.
 *
 * Returns `null` when:
 *   - Nango is not configured (neither env nor local discovery resolves)
 *   - HTTP GET fails (404, network error, etc.)
 *   - response body lacks a non-empty `credentials.apiKey`
 *
 * Never throws — the caller falls through to local-only mode.
 *
 * @returns {Promise<{ apiKey: string, tailnet: string } | null>}
 */
async function readTailscaleCredentialFromNango() {
  const runtimeMode = String(process.env.CINATRA_RUNTIME_MODE ?? "").trim() || "development";
  let nangoSettings;
  try {
    nangoSettings = await discoverBootstrapNangoSettings(process.env, runtimeMode);
  } catch {
    return null;
  }
  const serverUrl = nangoSettings?.serverUrl;
  const secretKey = nangoSettings?.secretKey;
  if (!serverUrl || !secretKey) {
    return null;
  }
  // Nango's public GET /connection endpoint requires `provider_config_key`
  // in the query. API_KEY credentials don't expire — no force_refresh
  // needed.
  const base = String(serverUrl).replace(/\/+$/, "");
  const url = `${base}/connection/cinatra-tailscale?provider_config_key=cinatra-tailscale`;
  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  /**
   * @type {{
   *   credentials?: { apiKey?: unknown };
   *   connection_config?: { organizationName?: unknown };
   * } | null}
   */
  let payload;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  const apiKey =
    typeof payload?.credentials?.apiKey === "string"
      ? payload.credentials.apiKey.trim()
      : "";
  if (!apiKey) return null;
  const orgName =
    typeof payload?.connection_config?.organizationName === "string"
      ? payload.connection_config.organizationName.trim()
      : "";
  // Fall back to `-` (token's home tailnet) for blank organizationName.
  return { apiKey, tailnet: orgName || "-" };
}

/**
 * Read the operator-configured Tailscale clone tag from the local
 * `connector_config:tailscale` row. Falls back
 * to `tag:cinatra-clone` when no value is stored (e.g. clone DB is fresh
 * or the operator never visited /connectors/tailscale).
 *
 * @param {string} cloneConnString
 * @returns {Promise<string>}
 */
async function readTailscaleCloneTagFromClone(cloneConnString) {
  const client = createClient(cloneConnString);
  try {
    await client.connect();
    const raw = await readMetadataValue(client, "cinatra", "connector_config:tailscale", null);
    if (raw && typeof raw === "object" && "cloneTag" in raw) {
      const tag = (raw).cloneTag;
      if (typeof tag === "string" && tag.startsWith("tag:")) return tag;
    }
    return "tag:cinatra-clone";
  } catch {
    return "tag:cinatra-clone";
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }
  }
}

/**
 * Resolve the dedicated Tailscale device hostname for THIS clone so the
 * dev-tab flyout's predicted URL equals the URL the sidecar actually
 * registers.
 *
 * The hostname is a pure deterministic derivation from the clone's
 * immutable isolation inputs (its `SUPABASE_DB_URL` database name +
 * `SUPABASE_SCHEMA`) — the SAME `deriveDevTailscaleHostname` the app's
 * flyout preview uses. No DB persistence (the persisted-value approach
 * is a stale-cache bug vector). The ONE exception is the backfill cohort: a
 * clone already provisioned with persistent Tailscale state already has a live
 * MagicDNS node under the legacy `cinatra-<slug>-<index>` name (its
 * persistent `tailscale-state` dir is non-empty). For those, keep the
 * legacy name so the live URL doesn't churn.
 *
 * Never throws past this boundary — any failure falls back to the
 * deterministic derivation (and finally the legacy name).
 *
 * @param {object} args
 * @param {string} args.cloneConnString  clone's SUPABASE_DB_URL
 * @param {string} args.schemaName  the clone's SUPABASE_SCHEMA
 * @param {string} args.legacyHostname  `cinatra-<slug>-<index>`
 * @param {string} args.stateDir  cloneTailscaleStateDir(slug)
 * @returns {Promise<string>}
 */
async function resolveCloneTailscaleHostname({
  cloneConnString,
  schemaName,
  legacyHostname,
  stateDir,
}) {
  // Backfill cohort: already-provisioned clone keeps its legacy
  // MagicDNS name so the live Funnel URL doesn't churn on the first
  // post-upgrade restart.
  try {
    if (existsSync(stateDir) && readdirSync(stateDir).length > 0) {
      return legacyHostname;
    }
  } catch {
    // fall through to fresh derivation
  }
  // Fresh: pure deterministic derivation, identical to the app preview. The
  // connector hostname helper is loaded lazily (present on this post-config
  // path); an absent extension falls through to the legacy name, honoring this
  // function's "never throws past this boundary" contract.
  try {
    const { deriveDevTailscaleHostname } = await loadTailscaleHostnameModule();
    return deriveDevTailscaleHostname({
      dbUrl: cloneConnString,
      schema: schemaName,
    });
  } catch {
    return legacyHostname;
  }
}

/**
 * Auto-mint a Tailscale auth-key for THIS clone via the Nango-stored API
 * access token. Called from `runCloneStart` when `TS_AUTHKEY` env is unset.
 *
 * The API token is used directly as the Bearer for the Tailscale auth-key
 * endpoint — no OAuth token exchange. Tag is whatever the operator
 * configured at /connectors/tailscale (default `tag:cinatra-clone`).
 *
 * Returns `null` when Nango doesn't have a Tailscale credential (caller
 * falls through to local-only mode). Throws on Tailscale API errors
 * (caller surfaces the typed error code to the operator).
 *
 * @param {string} cloneConnString — used to read the clone-tag this
 *   operator configured. Pass the clone DB connection string from
 *   runCloneStart.
 * @returns {Promise<string | null>} the minted `tskey-auth-…` value, or null
 */
async function autoMintTailscaleAuthKeyFromNango(cloneConnString) {
  const cred = await readTailscaleCredentialFromNango();
  if (!cred) return null;
  const cloneTag = await readTailscaleCloneTagFromClone(cloneConnString);
  // Lazy-load the connector mint helper (present on this post-config path; the
  // early `return null` above avoids loading it when Nango has no credential).
  const { mintTailscaleAuthKey } = await loadTailscaleApiModule();
  const { authKey } = await mintTailscaleAuthKey({
    // API key IS the Bearer for /api/v2/tailnet/-/keys — no exchange.
    accessToken: cred.apiKey,
    tailnet: cred.tailnet,
    // Operator-chosen tag for least-privilege scoping. The API token must
    // have been authorised for this tag in the operator's Tailscale ACL.
    tags: [cloneTag],
    ephemeral: true,
    preauthorized: true,
    reusable: false,
  });
  return authKey;
}

/**
 * Write `publicBaseUrl` into a clone's `connector_config:mcp_server` row.
 *
 * `options.source` lets callers tag the write with a non-default
 * `publicBaseUrlSource`. The default (`"manual"`) is preserved for existing
 * setup/teardown callers; the auto-tunnel path in `runCloneStart` passes
 * `{ source: "tailscale-auto" }` so the dev tab can distinguish
 * operator-pasted from auto-provisioned URLs.
 *
 * `options.schemaName` selects the workspace schema the metadata row lives in.
 * It DEFAULTS to `"cinatra"` so every pre-existing caller (clone start/stop,
 * dev-tunnel) is byte-unchanged. The `cinatra#260` Step-3 setup helper
 * (`ensureDevPublicMcpUrl`) passes the runtime-resolved `SUPABASE_SCHEMA` so a
 * non-default-schema dev instance writes the URL into its OWN schema, never a
 * hardcoded `"cinatra"` (codex must-fix).
 *
 * @param {string} cloneConnString
 * @param {string | null} url
 * @param {{ source?: "manual" | "tailscale-auto" | "tailscale-funnel", schemaName?: string }} [options]
 */
async function writeClonePublicBaseUrl(cloneConnString, url, options) {
  const schemaName = options?.schemaName?.trim() || "cinatra";
  const client = createClient(cloneConnString);
  await client.connect();
  try {
    const current = await readMetadataValue(client, schemaName, MCP_SETTINGS_KEY, {});
    const next = buildMcpPublicBaseUrlRow(current, url, options);
    await writeMetadataValue(client, schemaName, MCP_SETTINGS_KEY, next);
  } finally {
    await client.end().catch(() => null);
  }
}

// Lock-free stop teardown. The CALLER must already hold the per-clone
// runtime lock (runCloneStop acquires it; runClonePrune holds it across the
// whole destructive sequence). Extracted so prune can stop a running clone
// WITHOUT re-acquiring the lock (which would EEXIST-throw against its own
// held lock. This also prevents a concurrent `clone start` from grabbing the
// lock between stop releasing it and prune's DROP DATABASE.
async function stopCloneRuntime(slug, slot) {
  const projectName = cloneComposeProjectName(slug, slot.index);
  const composePath = cloneComposePath(slug);
  const pidPath = clonePidPath(slug);
  // Always use the registry's worktree path, never the caller cwd. The
  // ExitWorktree teardown hook `cd`s to the main repo before calling stop;
  // reading the caller-cwd `.env.local` there would clear publicBaseUrl in
  // the MAIN app DB instead of the clone DB.
  const worktreePath = slot.worktreePath;

  // Clear publicBaseUrl in the clone DB BEFORE bringing anything down, so a
  // stale Funnel URL doesn't linger across a stop.
  const cloneUrl = readEnvVarFromWorktree(worktreePath, "SUPABASE_DB_URL");
  if (cloneUrl) {
    try {
      await writeClonePublicBaseUrl(cloneUrl, null);
    } catch (err) {
      console.warn(`  Failed to clear publicBaseUrl in clone DB: ${err?.message ?? err}`);
    }
  }

  // Stop docker compose stack (best-effort).
  if (existsSync(composePath) && isComposeAvailable()) {
    const downResult = spawnSync(
      "docker",
      ["compose", "-p", projectName, "-f", composePath, "down"],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    if (downResult.status !== 0) {
      console.warn(`docker compose down exited ${downResult.status}.`);
    }
  }

  // SIGTERM the Next.js process group; SIGKILL after 10s. Verify cwd-match
  // before signalling so a stale pid that was reused by an unrelated process
  // is NEVER killed.
  //
  // Returns { stopped, reason? }. `stopped:true` means the recorded clone
  // process is PROVABLY gone (or the pid was a positively-unrelated
  // stale/reused pid, i.e. not our clone). `stopped:false` means we could
  // NOT prove it is gone — a destructive caller (prune --force-stop) must
  // refuse the DROP. The pid file is preserved on `stopped:false` so the
  // operator / a re-run can still find it.
  if (!existsSync(pidPath)) {
    return { stopped: true };
  }
  const recordedPid = readPidFromFile(pidPath);
  if (recordedPid == null || !isPidAlive(recordedPid)) {
    try { rmSync(pidPath, { force: true }); } catch { /* best-effort */ }
    return { stopped: true };
  }
  const match = processCommandLineMatches(recordedPid, {
    cwdMustEqual: slot.worktreePath,
  });
  if (!match.alive) {
    // Raced: died between isPidAlive and the match check.
    try { rmSync(pidPath, { force: true }); } catch { /* best-effort */ }
    return { stopped: true };
  }
  if (match.indeterminate) {
    // Alive but UNVERIFIABLE — refuse to signal a possibly-unrelated pid,
    // and report not-stopped so prune fails closed. Keep the pid file.
    console.warn(
      `Clone "${slug}" stop: pid ${recordedPid} alive but unverifiable (${match.why}). NOT signalling.`,
    );
    return { stopped: false, reason: `pid ${recordedPid} alive but unverifiable (${match.why})` };
  }
  if (!match.ours) {
    // Positively a DIFFERENT process (command/cwd mismatch) — the recorded
    // pid was reused; our clone is not running. Safe: clear the stale pid.
    console.warn(
      `Clone "${slug}" stop: pid ${recordedPid} is a different process (${match.why}); treating clone as not running.`,
    );
    try { rmSync(pidPath, { force: true }); } catch { /* best-effort */ }
    return { stopped: true };
  }
  // It's our clone — SIGTERM the group, grace, then SIGKILL.
  try {
    process.kill(-recordedPid, "SIGTERM");
  } catch {
    try { process.kill(recordedPid, "SIGTERM"); } catch { /* gone */ }
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && isPidAlive(recordedPid)) {
    await new Promise((r) => setTimeout(r, 250));
  }
  if (isPidAlive(recordedPid)) {
    try { process.kill(-recordedPid, "SIGKILL"); } catch { /* gone */ }
    try { process.kill(recordedPid, "SIGKILL"); } catch { /* gone */ }
    // Brief settle, then VERIFY death before claiming stopped; a swallowed
    // kill error must not let prune DROP under a live clone.
    await new Promise((r) => setTimeout(r, 500));
    if (isPidAlive(recordedPid)) {
      return {
        stopped: false,
        reason: `pid ${recordedPid} still alive after SIGTERM+SIGKILL`,
      };
    }
  }
  try { rmSync(pidPath, { force: true }); } catch { /* best-effort */ }
  return { stopped: true };
}

async function runCloneStop(argv) {
  const worktreeFlag = readOptionValue(argv,"--worktree-path");
  const callerWorktreePath = path.resolve(worktreeFlag ?? process.cwd());
  const slug = resolveCloneSlug(argv, callerWorktreePath);
  if (!slug) {
    throw new Error("Could not resolve clone slug. Pass `--slug <s>` or run from a clone-on-demand worktree.");
  }
  const { slot } = loadReadyCloneSlot(slug);

  // Take the per-clone runtime lock so stop cannot race a concurrent
  // start/prune (prune treats a held lock as "operation in flight").
  acquireRuntimeLock(slug);
  let stopResult;
  try {
    stopResult = await stopCloneRuntime(slug, slot);
  } finally {
    releaseRuntimeLock(slug);
  }

  if (stopResult.stopped) {
    console.log(`Clone "${slug}" stopped.`);
  } else {
    // `clone stop` is best-effort and non-destructive (no DB drop), so this
    // is a loud warning, not a throw — the operator can investigate.
    console.warn(
      `Clone "${slug}": could not confirm the clone stopped (${stopResult.reason}). ` +
        `Investigate with 'cinatra clone status --slug ${slug}'.`,
    );
    process.exitCode = 1;
  }
}

async function runCloneStatus(argv) {
  const worktreeFlag = readOptionValue(argv,"--worktree-path");
  const worktreePath = path.resolve(worktreeFlag ?? process.cwd());
  const slug = resolveCloneSlug(argv, worktreePath);
  if (!slug) {
    throw new Error("Could not resolve clone slug. Pass `--slug <s>` or run from a clone-on-demand worktree.");
  }
  const registry = requireUsableRegistry(defaultRegistryPath());
  const slot = getClone(registry, slug);
  if (!slot) {
    throw new Error(`No clone registered for slug "${slug}".`);
  }
  const projectName = cloneComposeProjectName(slug, slot.index);
  const pidPath = clonePidPath(slug);
  const logPath = cloneLogPath(slug);
  const composePath = cloneComposePath(slug);

  console.log(`Clone "${slug}"  [${slot.state}]`);
  console.log(`  index=${slot.index}  next.js=${slot.nextjsPort}  wayflow=${slot.wayflowPort}`);
  console.log(`  database=${slot.dbName}`);
  console.log(`  worktree=${slot.worktreePath}`);
  console.log(`  runtimeDir=${cloneRuntimeDir(slug)}`);
  console.log(`  composePath=${composePath}`);
  console.log(`  composeProject=${projectName}`);
  console.log(`  runtimeLockHeld=${isRuntimeLockHeld(slug) ? "yes" : "no"}`);

  if (existsSync(pidPath)) {
    const pid = readPidFromFile(pidPath);
    const match = pid != null ? processCommandLineMatches(pid, {}) : null;
    console.log(`  nextjs.pid=${pid ?? "?"}  alive=${match?.alive ? "yes" : "no"}  ours=${match?.ours ? "yes" : "no"}`);
  } else {
    console.log("  nextjs.pid=(none)");
  }

  const nextProbe = await probeHttp(`http://localhost:${slot.nextjsPort}/api/health`, {
    timeoutMs: 2_000,
    intervalMs: 500,
  });
  console.log(`  nextjs.health(${slot.nextjsPort})=${nextProbe.ok ? "OK" : `down (${nextProbe.error})`}`);

  const wfProbe = await probeHttp(`http://localhost:${slot.wayflowPort}/.health`, {
    timeoutMs: 2_000,
    intervalMs: 500,
  });
  console.log(`  wayflow.health(${slot.wayflowPort})=${wfProbe.ok ? "OK" : `down (${wfProbe.error})`}`);

  if (existsSync(logPath)) {
    console.log(`  log=${logPath}`);
  }
}

// ---------------------------------------------------------------------------
// Registry lookup for shell hooks.
//
//   cinatra clone slug-for-worktree --worktree-path <p>
//
// Prints the slug to stdout (exit 0). Prints nothing + exit 1 if no clone
// is registered for the given path. Used by the ExitWorktree hook so it
// can decide between `clone stop` (clone mode) vs `teardown branch`
// (light branch mode). The lookup falls back to abs-normalised string-eq when
// realpath fails, which is required for the typical ExitWorktree-after-removal
// scenario.
// ---------------------------------------------------------------------------

// Bulk-prune all clones whose worktreePath no longer resolves to a directory.
// The dry-run flag lists targets without executing.
async function runClonePruneStale(argv) {
  const dryRun = argv.includes("--dry-run");
  if (!dryRun && !argv.includes("--yes")) {
    throw new Error(
      "cinatra clone prune --stale is destructive. Re-run with --yes to confirm, or pass --dry-run to preview.",
    );
  }
  const registryPath = defaultRegistryPath();
  const result = readRegistry(registryPath);
  if (result.status === "malformed") {
    throw new Error(
      `Clone registry at ${registryPath} is malformed — refusing to prune anything.`,
    );
  }
  if (result.status === "missing") {
    console.log("No clones registered.");
    return;
  }
  const allSlots = listClones(result.registry);
  const staleSlugs = allSlots.filter((slot) => isWorktreePathStale(slot)).map((s) => s.slug);
  if (staleSlugs.length === 0) {
    console.log("No stale clones — all registered worktrees still exist.");
    return;
  }
  console.log(`Stale clones (worktreePath missing):  ${staleSlugs.join(", ")}`);
  if (dryRun) {
    console.log("(dry-run — pass --yes to actually prune.)");
    return;
  }
  let anyFailed = false;
  for (const slug of staleSlugs) {
    try {
      console.log("");
      console.log(`Pruning ${slug}...`);
      // Delegates to runClonePrune, which applies the SAME guarded
      // command-managed worktree removal (pruneCliOwnedWorktree): same
      // parentDir/sibling/path-equality guards, same legacy-path skip,
      // and no behavior change for unmanaged light-branch worktree slots.
      await runClonePrune(["--slug", slug, "--yes"]);
    } catch (err) {
      anyFailed = true;
      console.error(`  Failed: ${err?.message ?? err}`);
    }
  }
  if (anyFailed) {
    process.exitCode = 1;
  }
}

function runCloneSlugForWorktree(argv) {
  const worktreeFlag = readOptionValue(argv, "--worktree-path");
  if (!worktreeFlag) {
    process.stderr.write("--worktree-path <p> is required.\n");
    process.exitCode = 1;
    return;
  }
  const registry = readRegistry(defaultRegistryPath());
  if (registry.status !== "ok") {
    process.exitCode = 1;
    return;
  }
  const match = findCloneByWorktreePath(registry.registry, worktreeFlag);
  if (!match) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${match.slug}\n`);
}

async function runResetDev(argv) {
  if (!argv.includes("--yes")) {
    throw new Error('Development reset is destructive. Re-run with "cinatra reset dev --yes".');
  }

  const repoRoot = getRepoRoot();
  const env = collectEnvironment(repoRoot);
  const runtimeMode = readConfiguredRuntimeMode(env);
  const connectionString = requiredEnv(env, "SUPABASE_DB_URL");
  const schemaName = env.SUPABASE_SCHEMA?.trim() || "cinatra";
  const backupFileArgument = readOptionValue(argv, "--file");
  const isFull = argv.includes("--full");

  if (runtimeMode !== "development") {
    throw new Error('Development reset requires CINATRA_RUNTIME_MODE=development.');
  }

  if (isFull && (argv.includes("--purge-app-data") || argv.includes("--keep-app-data"))) {
    throw new Error("--purge-app-data and --keep-app-data are not applicable with --full (all data is wiped).");
  }

  // Backup must happen before Docker teardown (pg_dump needs running Postgres).
  const shouldBackup = await resolveBackupPreference(argv);

  if (shouldBackup) {
    const backupFilePath = resolveBackupFilePath(repoRoot, backupFileArgument);
    createBackupBundle(repoRoot, env, connectionString, backupFilePath);
    console.log(`Backup created at ${backupFilePath}`);
  }

  const rebuildEnv = argv.includes("--rebuild-env");

  if (rebuildEnv && !isFull) {
    throw new Error("--rebuild-env can only be used with --full.");
  }

  if (isFull) {
    // ── Full reset: tear down everything and rebuild from scratch ──

    console.log("Stopping Docker containers and removing volumes...");
    runCommandOrThrow("docker", ["compose", "down", "-v"], "Failed to stop Docker containers.", { cwd: repoRoot });

    console.log("Cleaning build artifacts...");
    cleanBuildArtifacts(repoRoot);

    if (rebuildEnv) {
      console.log("Rebuilding .env.local from running infrastructure...");
      rebuildEnvLocal(repoRoot);
    }

    console.log("Starting Docker containers...");
    runCommandOrThrow("docker", ["compose", "-f", "docker-compose.yml", "-f", "docker-compose.dev.yml", "up", "-d"], "Failed to start Docker containers.", { cwd: repoRoot });

    console.log("Waiting for Postgres...");
    waitForPostgres(repoRoot);
    console.log("Postgres is ready.");

    console.log("Waiting for Redis...");
    waitForRedis(repoRoot);
    console.log("Redis is ready.");

    console.log("Waiting for Nango...");
    waitForNango(repoRoot);
    console.log("Nango is ready.");

    console.log("Reinstalling dependencies...");
    reinstallDependencies(repoRoot);

    console.log("Running setup...");
    await runSetup("dev");

    console.log("Building OpenAI shell Docker image...");
    buildOpenAiShellImage(repoRoot);

    console.log("\nFull development reset complete. Everything has been rebuilt from scratch.");
    console.log("Start the app with: pnpm dev");
  } else {
    // ── Soft reset: reset database data, flush Redis, rebuild setup ──

    const purgeAppData = await resolveAppDataPurgePreference(argv);

    const client = createClient(connectionString);
    await client.connect();

    try {
      await resetDevelopmentData(client, schemaName, purgeAppData);
    } finally {
      await client.end();
    }

    console.log("Flushing Redis...");
    flushRedis(repoRoot);

    console.log(
      `Development reset complete.${purgeAppData ? " App-generated workspace data was purged." : " App-generated workspace data was kept."} Rebuilding setup now...`,
    );
    await runSetup("dev");
  }
}

async function runBackupCreate(argv) {
  const repoRoot = getRepoRoot();
  const env = collectEnvironment(repoRoot);
  const connectionString = requiredEnv(env, "SUPABASE_DB_URL");
  const filePath = resolveBackupFilePath(repoRoot, readOptionValue(argv, "--file"));

  createBackupBundle(repoRoot, env, connectionString, filePath);
  console.log(`Cinatra full backup created at ${filePath}`);
}

async function runBackupImport(argv) {
  const repoRoot = getRepoRoot();
  const env = collectEnvironment(repoRoot);
  const connectionString = requiredEnv(env, "SUPABASE_DB_URL");
  const explicitFile = readOptionValue(argv, "--file");
  const positionalFile = argv.find((entry) => !entry.startsWith("--"));

  let filePath;
  if (explicitFile || positionalFile) {
    filePath = resolveBackupFilePath(repoRoot, explicitFile ?? positionalFile);
  } else {
    filePath = findLatestBackupFile(repoRoot);
    if (!filePath) {
      throw new Error(
        `No backup files found in ${path.join(repoRoot, DEFAULT_BACKUP_DIRECTORY)}. ` +
          `Create a backup first with "cinatra backup create", or specify a file with --file.`,
      );
    }
    console.log(`No --file specified. Using most recent backup: ${path.basename(filePath)}`);
  }

  if (!argv.includes("--yes")) {
    throw new Error('Backup import is destructive. Re-run with "cinatra backup import --yes".');
  }

  if (isLegacySqlBackupPath(filePath)) {
    importBackupFile(repoRoot, env, connectionString, filePath);
  } else if (isArchiveBackupPath(filePath)) {
    importBackupBundle(repoRoot, env, connectionString, filePath);
  } else {
    throw new Error('Unsupported backup format. Use a ".tar.gz", ".tgz", or legacy ".sql" backup file.');
  }

  console.log(`Cinatra full backup imported from ${filePath}`);
}

const API_CONFIG_METADATA_PREFIXES = ["connector_config:"];
const API_CONFIG_METADATA_EXACT_KEYS = ["openai_connection"];

function defaultApiConfigsFilePath(repoRoot) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return path.join(repoRoot, DEFAULT_DATA_DIRECTORY, `cinatra-api-configs-${timestamp}.json`);
}

function resolveApiConfigsFilePath(repoRoot, value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return defaultApiConfigsFilePath(repoRoot);
  }
  if (path.isAbsolute(trimmed)) {
    return trimmed;
  }
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return path.resolve(repoRoot, trimmed);
  }
  return path.join(repoRoot, DEFAULT_DATA_DIRECTORY, trimmed);
}

function findLatestApiConfigsFile(repoRoot) {
  const dir = path.join(repoRoot, DEFAULT_DATA_DIRECTORY);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.startsWith("cinatra-api-configs-") && f.endsWith(".json"))
    .sort()
    .reverse();
  return files.length > 0 ? path.join(dir, files[0]) : null;
}

async function runBackupExportApiConfigs(argv) {
  const repoRoot = getRepoRoot();
  const env = collectEnvironment(repoRoot);
  const connectionString = requiredEnv(env, "SUPABASE_DB_URL");
  const schemaName = env.SUPABASE_SCHEMA?.trim() || "cinatra";
  const filePath = resolveApiConfigsFilePath(repoRoot, readOptionValue(argv, "--file"));

  const client = createClient(connectionString);
  await client.connect();

  try {
    const prefixConditions = API_CONFIG_METADATA_PREFIXES.map(
      (_, i) => `key LIKE $${i + 1}`,
    ).join(" OR ");
    const exactConditions = API_CONFIG_METADATA_EXACT_KEYS.map(
      (_, i) => `key = $${API_CONFIG_METADATA_PREFIXES.length + i + 1}`,
    ).join(" OR ");
    const whereClause = [prefixConditions, exactConditions].filter(Boolean).join(" OR ");

    const params = [
      ...API_CONFIG_METADATA_PREFIXES.map((p) => `${p}%`),
      ...API_CONFIG_METADATA_EXACT_KEYS,
    ];

    const result = await client.query(
      `SELECT key, value FROM ${quoteIdentifier(schemaName)}.metadata WHERE ${whereClause} ORDER BY key`,
      params,
    );

    const entries = result.rows.map((row) => ({
      key: row.key,
      value: (() => {
        try { return JSON.parse(row.value); } catch { return row.value; }
      })(),
    }));

    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({ format: "cinatra-api-configs", version: 1, exportedAt: new Date().toISOString(), entries }, null, 2));

    console.log(`Exported ${entries.length} API config entries to ${filePath}`);
  } finally {
    await client.end();
  }
}

async function runBackupImportApiConfigs(argv) {
  const repoRoot = getRepoRoot();
  const env = collectEnvironment(repoRoot);
  const connectionString = requiredEnv(env, "SUPABASE_DB_URL");
  const schemaName = env.SUPABASE_SCHEMA?.trim() || "cinatra";

  const explicitFile = readOptionValue(argv, "--file");
  const positionalFile = argv.find((entry) => !entry.startsWith("--"));

  let filePath;
  if (explicitFile || positionalFile) {
    filePath = resolveApiConfigsFilePath(repoRoot, explicitFile ?? positionalFile);
  } else {
    filePath = findLatestApiConfigsFile(repoRoot);
    if (!filePath) {
      throw new Error(
        `No API config files found in ${path.join(repoRoot, DEFAULT_BACKUP_DIRECTORY)}. ` +
          `Export them first with "cinatra backup export-api-configs", or specify a file with --file.`,
      );
    }
    console.log(`No --file specified. Using most recent: ${path.basename(filePath)}`);
  }

  if (!argv.includes("--yes")) {
    throw new Error('API config import will overwrite existing configs. Re-run with "cinatra backup import-api-configs --yes".');
  }

  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const raw = JSON.parse(readFileSync(filePath, "utf8"));
  if (raw.format !== "cinatra-api-configs" || !Array.isArray(raw.entries)) {
    throw new Error(`Invalid API config file format. Expected a file created by "cinatra backup export-api-configs".`);
  }

  const client = createClient(connectionString);
  await client.connect();

  try {
    for (const entry of raw.entries) {
      await client.query(
        `INSERT INTO ${quoteIdentifier(schemaName)}.metadata (key, value)
         VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [entry.key, typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value)],
      );
    }
    console.log(`Imported ${raw.entries.length} API config entries from ${filePath}`);
  } finally {
    await client.end();
  }
}

async function runSkillsResetRepo(argv) {
  const yes = argv.includes("--yes");
  if (!yes) {
    throw new Error('Pass --yes to confirm: cinatra skills reset-repo --yes\nThis will replace all content in the connected GitHub skills repo with the local store.');
  }

  const appUrl = normalizeOptionalUrl(readOptionValue(argv, "--app-url") ?? "http://localhost:3000");
  const endpoint = `${appUrl}/api/skills/reset-repo`;

  console.log(`Pushing local skills store to GitHub repo via ${endpoint} …`);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Accept: "application/json" },
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(payload?.error || `Request failed with status ${response.status}.`);
  }

  console.log(`Skills repo purged and replaced. Commit: ${payload?.commitSha ?? "(unknown)"}`);
}

// Human-origin destructive extension-purge path. The MCP `extensions_purge`
// tool is DRY-RUN ONLY (returns the digest); this CLI is the only way to
// actually execute (loopback POST → /api/extensions/purge).
async function runExtensionsPurge(argv) {
  const packageName = argv.find((a) => a && !a.startsWith("--"));
  if (!packageName) {
    throw new Error(
      "Usage: cinatra extensions purge <packageName> --confirm <packageName> --digest <d> [--reason <r>] --yes",
    );
  }
  const confirm = readOptionValue(argv, "--confirm");
  if (confirm !== packageName) {
    throw new Error(
      `Refusing: --confirm must exactly equal the package name.\n` +
        `  package: ${packageName}\n  --confirm: ${confirm ?? "(missing)"}`,
    );
  }
  if (!argv.includes("--yes")) {
    throw new Error(
      `Pass --yes to confirm: cinatra extensions purge ${packageName} --confirm ${packageName} --yes\n` +
        `This IRREVERSIBLY unpublishes EVERY Verdaccio version and deletes DB + on-disk state.`,
    );
  }
  const digest = readOptionValue(argv, "--digest");
  if (!digest) {
    throw new Error(
      `Refusing: --digest is required. Run the extensions_purge MCP dry-run for ` +
        `${packageName} first, then pass its digest:\n` +
        `  cinatra extensions purge ${packageName} --confirm ${packageName} --digest <digest> --yes`,
    );
  }
  const reason = readOptionValue(argv, "--reason");
  const appUrl = normalizeOptionalUrl(
    readOptionValue(argv, "--app-url") ?? "http://localhost:3000",
  );
  const endpoint = `${appUrl}/api/extensions/purge`;

  console.log(`Purging ${packageName} via ${endpoint} …`);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      packageName,
      ...(digest ? { expectedDigest: digest } : {}),
      ...(reason ? { reason } : {}),
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      payload?.error || `Request failed with status ${response.status}.`,
    );
  }
  const r = payload?.result ?? {};
  if (r.stopped) {
    console.log(
      `Purge STOPPED (safe, re-runnable): ${r.reason}\n` +
        `Quarantine: ${r.quarantineDir ?? "(none)"}`,
    );
    return;
  }
  console.log(
    `Purged ${packageName}.\n` +
      `  DB/disk deleted: ${r.dbDiskDeleted ? "yes" : "no (connector — PR+redeploy)"}\n` +
      `  Quarantine: ${r.quarantineDir ?? "(none)"}\n` +
      `  Registry: untouched (purge never unpublishes from Verdaccio; version cleanup is a separate ops op).`,
  );
}

async function runStatus() {
  const repoRoot = getRepoRoot();
  const env = collectEnvironment(repoRoot);
  const runtimeMode = readConfiguredRuntimeMode(env);
  const connectionString = requiredEnv(env, "SUPABASE_DB_URL");
  const schemaName = env.SUPABASE_SCHEMA?.trim() || "cinatra";
  const client = createClient(connectionString);
  await client.connect();

  try {
    const status = await gatherStatus(client, schemaName);
    console.log(JSON.stringify({
      runtimeMode,
      ...status,
    }, null, 2));
  } finally {
    await client.end();
  }
}


// ---------------------------------------------------------------------------
// ZIP helpers — no external dependencies; stores files uncompressed (method 0)
// ---------------------------------------------------------------------------

function buildCrc32TableCli() {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
}

const CRC32_TABLE_CLI = buildCrc32TableCli();

function crc32Cli(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) crc = (crc >>> 8) ^ CRC32_TABLE_CLI[(crc ^ byte) & 0xff];
  return ((crc ^ 0xffffffff) >>> 0);
}

function createZipBufferCli(files) {
  const encoded = files.map((f) => ({ name: Buffer.from(f.name, "utf8"), data: Buffer.from(f.content, "utf8") }));
  const chunks = [];
  const localOffsets = [];
  let offset = 0;
  for (const { name, data } of encoded) {
    localOffsets.push(offset);
    const crc = crc32Cli(data);
    const h = Buffer.alloc(30 + name.length);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0, 6); h.writeUInt16LE(0, 8);
    h.writeUInt16LE(0, 10); h.writeUInt16LE(0, 12); h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    name.copy(h, 30);
    chunks.push(h, data);
    offset += h.length + data.length;
  }
  const centralStart = offset;
  for (let i = 0; i < encoded.length; i++) {
    const { name, data } = encoded[i];
    const crc = crc32Cli(data);
    const e = Buffer.alloc(46 + name.length);
    e.writeUInt32LE(0x02014b50, 0); e.writeUInt16LE(20, 4); e.writeUInt16LE(20, 6); e.writeUInt16LE(0, 8);
    e.writeUInt16LE(0, 10); e.writeUInt16LE(0, 12); e.writeUInt16LE(0, 14); e.writeUInt32LE(crc, 16);
    e.writeUInt32LE(data.length, 20); e.writeUInt32LE(data.length, 24); e.writeUInt16LE(name.length, 28);
    e.writeUInt16LE(0, 30); e.writeUInt16LE(0, 32); e.writeUInt16LE(0, 34); e.writeUInt16LE(0, 36);
    e.writeUInt32LE(0, 38); e.writeUInt32LE(localOffsets[i], 42);
    name.copy(e, 46);
    chunks.push(e);
    offset += e.length;
  }
  const centralSize = offset - centralStart;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(encoded.length, 8); eocd.writeUInt16LE(encoded.length, 10);
  eocd.writeUInt32LE(centralSize, 12); eocd.writeUInt32LE(centralStart, 16); eocd.writeUInt16LE(0, 20);
  chunks.push(eocd);
  return Buffer.concat(chunks);
}

function readZipFilesCli(buf) {
  const result = new Map();
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset < 0) return result;
  const numEntries = buf.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buf.readUInt32LE(eocdOffset + 16);
  let pos = centralDirOffset;
  for (let i = 0; i < numEntries; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const filenameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const filename = buf.subarray(pos + 46, pos + 46 + filenameLen).toString("utf8");
    const lfhFilenameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const lfhExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + lfhFilenameLen + lfhExtraLen;
    result.set(filename, buf.subarray(dataOffset, dataOffset + compressedSize).toString("utf8"));
    pos += 46 + filenameLen + extraLen + commentLen;
  }
  return result;
}

// ---------------------------------------------------------------------------
// agent export
// ---------------------------------------------------------------------------

async function runAgentExport(argv) {
  const repoRoot = getRepoRoot();
  const env = collectEnvironment(repoRoot);
  const connectionString = requiredEnv(env, "SUPABASE_DB_URL");
  const schemaName = env.SUPABASE_SCHEMA?.trim() || "cinatra";

  const query = argv.find((a) => !a.startsWith("--"));
  if (!query) throw new Error('Usage: cinatra agent export <id-or-name> [--file <output.zip>]');

  const client = createClient(connectionString);
  await client.connect();
  try {
    // Try by exact ID, then by name (case-insensitive)
    let row = (await client.query(
      `SELECT * FROM ${quoteIdentifier(schemaName)}.agent_templates WHERE id = $1 LIMIT 1`,
      [query],
    )).rows[0];
    if (!row) {
      row = (await client.query(
        `SELECT * FROM ${quoteIdentifier(schemaName)}.agent_templates WHERE lower(name) = lower($1) LIMIT 1`,
        [query],
      )).rows[0];
    }
    if (!row) throw new Error(`Agent template not found: ${query}`);

    const exportedAt = new Date().toISOString();

    // Normalize compiledPlan: parse the stored JSON string to an actual array so the
    // ZIP always contains a JSON array, never a double-encoded JSON string.
    function parseToArray(raw) {
      if (Array.isArray(raw)) return raw;
      if (typeof raw !== "string") return [];
      try { const p = JSON.parse(raw); return Array.isArray(p) ? p : (typeof p === "string" ? parseToArray(p) : []); } catch { return []; }
    }
    // Similarly normalize object fields
    function parseToObject(raw, fallback) {
      if (raw !== null && typeof raw === "object") return raw;
      if (typeof raw !== "string") return fallback;
      try { const p = JSON.parse(raw); return (p !== null && typeof p === "object") ? p : fallback; } catch { return fallback; }
    }

    const agentJson = JSON.stringify({
      formatVersion: 1,
      id: row.id,
      name: row.name,
      description: row.description ?? null,
      sourceNl: row.source_nl,
      executionMode: row.execution_mode,
      compiledPlan: parseToArray(row.compiled_plan),
      inputSchema: parseToObject(row.input_schema, {}),
      outputSchema: row.output_schema ? parseToObject(row.output_schema, null) : null,
      approvalPolicy: parseToObject(row.approval_policy, { steps: [] }),
      taskSpec: row.task_spec ?? null,
      status: row.status,
      exportedAt,
    }, null, 2);
    const manifestJson = JSON.stringify({ version: 1, exportedAt, cinatra: "agent-builder-v1" }, null, 2);

    const zipBuf = createZipBufferCli([
      { name: "agent.json", content: agentJson },
      { name: "manifest.json", content: manifestJson },
    ]);

    const outFile = readOptionValue(argv, "--file") ?? (() => {
      const slug = row.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const dateStr = exportedAt.slice(0, 10).replace(/-/g, "");
      return path.join(DEFAULT_DOWNLOADS_DIRECTORY, `cinatra-agent-${slug}-${dateStr}.zip`);
    })();
    const outPath = path.isAbsolute(outFile) ? outFile : path.resolve(repoRoot, outFile);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, zipBuf);
    console.log(`Exported agent "${row.name}" (${row.id}) → ${outPath}`);
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// agent import
// ---------------------------------------------------------------------------

async function runAgentImport(argv) {
  const repoRoot = getRepoRoot();
  const env = collectEnvironment(repoRoot);
  const connectionString = requiredEnv(env, "SUPABASE_DB_URL");
  const schemaName = env.SUPABASE_SCHEMA?.trim() || "cinatra";

  const filePath = argv.find((a) => !a.startsWith("--"));
  if (!filePath) throw new Error('Usage: cinatra agent import <file.zip> [--name <override-name>]');

  const absPath = path.resolve(process.cwd(), filePath);
  if (!existsSync(absPath)) throw new Error(`File not found: ${absPath}`);

  const zipBuf = readFileSync(absPath);
  const files = readZipFilesCli(zipBuf);

  const agentRaw = files.get("agent.json");
  if (!agentRaw) throw new Error("Invalid archive: agent.json not found.");

  const manifestRaw = files.get("manifest.json");
  if (manifestRaw) {
    const m = JSON.parse(manifestRaw);
    if (m.version !== 1) throw new Error(`Unsupported manifest version: ${m.version}`);
  }

  const agent = JSON.parse(agentRaw);
  if (agent.formatVersion !== 1) throw new Error(`Unsupported agent.json formatVersion: ${agent.formatVersion}`);

  const importedName = readOptionValue(argv, "--name") ?? agent.name ?? "Imported Agent";

  const client = createClient(connectionString);
  await client.connect();
  try {
    const newId = randomUUID();
    await client.query(
      `INSERT INTO ${quoteIdentifier(schemaName)}.agent_templates
       (id, name, description, source_nl, compiled_plan, input_schema, output_schema, approval_policy, execution_mode, task_spec, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft')`,
      [
        newId,
        importedName,
        agent.description ?? null,
        agent.sourceNl ?? "",
        agent.compiledPlan ?? "[]",
        agent.inputSchema ?? "{}",
        agent.outputSchema ?? null,
        agent.approvalPolicy ?? "{}",
        agent.executionMode ?? "deterministic",
        agent.taskSpec ?? null,
      ],
    );

    const snapshotStr = JSON.stringify({ compiledPlan: agent.compiledPlan, inputSchema: agent.inputSchema, taskSpec: agent.taskSpec });
    const contentHash = createHash("sha256").update(snapshotStr).digest("hex");
    await client.query(
      `INSERT INTO ${quoteIdentifier(schemaName)}.agent_versions (id, template_id, content_hash, snapshot)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), newId, contentHash, snapshotStr],
    );

    console.log(`Imported agent "${importedName}" → ID: ${newId}`);
    console.log(`View in app: /agents/builder/${newId}`);
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// Test-only surface (cinatra#260 Steps 1+2). Exported so the package vitest
// suite can exercise the verify-before-reuse predicate, the two-table OAuth
// sync, and the JWKS decrypt-error→delete-once self-heal against a mocked pg
// client + mocked token mint — without booting the app or a live DB.
// ---------------------------------------------------------------------------
export {
  hashClientSecret,
  canReuseClientCredentials,
  ensureSelfMcpClient,
  ensureLlmMcpAccess,
  ensureDecryptableJwks,
  ensureMcpSettings,
  ensureDevPublicMcpUrl,
  probeTokenMint,
  deleteLatestJwksRow,
  resolveLocalOrigin,
  gatherStatus,
  gatherDoctorReport,
  deriveConfiguredPublicMcpUrl,
  doctorAssertLlmMcpAccess,
  doctorAssertDevAppsPresence,
  DOCTOR_CMS_WRITE_TOOLS,
  SELF_MCP_CLIENT_ID,
  SELF_MCP_CLIENT_SCOPE,
  SELF_MCP_CLIENT_SCOPES,
  LLM_MCP_PROVIDERS,
  LLM_MCP_CLIENT_SCOPES,
  LLM_MCP_SETTINGS_KEY,
  MCP_SETTINGS_KEY,
};

export async function runCli(argv) {
  const [command, mode, ...rest] = argv;

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "status") {
    await runStatus();
    return;
  }


  if (command === "skills" && mode === "reset-repo") {
    await runSkillsResetRepo(rest);
    return;
  }

  if (command === "extensions" && mode === "purge") {
    await runExtensionsPurge(rest);
    return;
  }

  if (command === "extensions" && mode === "acquire-prod") {
    const { acquireProdRequiredExtensions } = await import("./prod-extension-acquisition.mjs");
    const repoRoot = getRepoRoot();
    const outcome = await acquireProdRequiredExtensions({ repoRoot });
    if (outcome.skipped) {
      console.log(`extensions acquire-prod: skipped (${outcome.reason}).`);
      return;
    }
    console.log(
      "Run `corepack pnpm install` next so the acquired extension packages are linked into the workspace.",
    );
    return;
  }

  if (command === "extensions" && mode === "submit") {
    const { runExtensionsSubmit } = await import("./extensions-submit.mjs");
    await runExtensionsSubmit(rest);
    return;
  }

  if (command === "mcp" && mode === "tunnel") {
    throw new Error(
      "`cinatra mcp tunnel` was removed when the Cloudflare quick-tunnel feature was retired. " +
      "Run your own tunnel (Tailscale Funnel, named Cloudflare Tunnel, ngrok, etc.) pointing at " +
      "http://localhost:3000 and paste the public URL into /configuration/development?tab=tunnel.",
    );
  }

  if (command === "backup" && mode === "create") {
    await runBackupCreate(rest);
    return;
  }

  if (command === "backup" && mode === "import") {
    await runBackupImport(rest);
    return;
  }

  if (command === "backup" && mode === "export-api-configs") {
    await runBackupExportApiConfigs(rest);
    return;
  }

  if (command === "backup" && mode === "import-api-configs") {
    await runBackupImportApiConfigs(rest);
    return;
  }

  if (command === "setup" && !mode) {
    const env = collectEnvironment(getRepoRoot());
    await runSetup(readConfiguredRuntimeMode(env) === "production" ? "prod" : "dev");
    return;
  }

  if (command === "setup" && (mode === "dev" || mode === "prod")) {
    await runSetup(mode);
    return;
  }

  if (command === "setup" && mode === "nango") {
    await runSetupNango();
    return;
  }

  if (command === "setup" && mode === "branch") {
    await runSetupBranch(rest);
    return;
  }

  if (command === "teardown" && mode === "branch") {
    await runTeardownBranch(rest);
    return;
  }

  if (command === "setup" && mode === "clone") {
    await runSetupClone(rest);
    return;
  }

  if (command === "clone" && mode === "refresh-seed") {
    await runRefreshSeed(rest);
    return;
  }

  if (command === "clone" && mode === "prune") {
    await runClonePrune(rest);
    return;
  }

  if (command === "clone" && mode === "list") {
    runCloneList();
    return;
  }

  // Clone start/stop/status lifecycle.
  if (command === "clone" && mode === "start") {
    await runCloneStart(rest);
    return;
  }
  if (command === "clone" && mode === "stop") {
    await runCloneStop(rest);
    return;
  }
  if (command === "clone" && mode === "status") {
    await runCloneStatus(rest);
    return;
  }
  // Registry lookup for shell hooks.
  if (command === "clone" && mode === "slug-for-worktree") {
    runCloneSlugForWorktree(rest);
    return;
  }

  if (command === "db" && mode === "migrate") {
    await runDbMigrate(rest);
    return;
  }

  // dev-main Tailscale Funnel verb.
  if (command === "dev" && mode === "refresh") {
    await runDevRefresh(rest);
    return;
  }

  if (command === "dev" && mode === "tunnel") {
    await runDevTunnel(rest);
    return;
  }

  if (command === "reset" && mode === "dev") {
    await runResetDev(rest);
    return;
  }

  if (command === "mcp" && mode === "llm-access" && rest[0] === "setup") {
    await runLlmMcpAccessSetup();
    return;
  }

  if (command === "mcp" && mode === "llm-access" && rest[0] === "refresh") {
    await runLlmMcpAccessRefresh();
    return;
  }

  // cinatra#260 Step 5 — content-editor write-path self-check.
  if (command === "doctor") {
    await runDoctor(rest);
    return;
  }
  // Alias: `cinatra mcp llm-access verify`.
  if (command === "mcp" && mode === "llm-access" && rest[0] === "verify") {
    await runDoctor(rest.slice(1));
    return;
  }

  if (command === "agents") {
    if (mode === "install") {
      const { runAgentsInstall } = await import("./agents-install.mjs");
      return runAgentsInstall(rest);
    }
    printHelp();
    process.exit(1);
  }

  if (command === "agent" && mode === "export") {
    await runAgentExport(rest);
    return;
  }

  if (command === "agent" && mode === "import") {
    await runAgentImport(rest);
    return;
  }

  throw new Error(`Unknown command: ${[command, mode].filter(Boolean).join(" ")}. Run "cinatra --help" for usage.`);
}
