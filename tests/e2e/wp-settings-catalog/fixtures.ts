/**
 * Fixture matrix for the WordPress "Site tools & access" settings-catalog UAT
 * (cinatra-ai/cinatra#2022 S7, final acceptance criterion).
 *
 * The card under test ships in `@cinatra-ai/wordpress-mcp-connector`
 * (`src/wordpress-site-tools-card.tsx`) and renders on the connector's settings
 * surface, one card per configured site. It has three panels — discovered MCP
 * servers + health, per-pipeline readiness, and the tool-selection editor — and
 * the per-connection header badge is derived from the SAME probe health rather
 * than the old static "Connected" text.
 *
 * WHY SEED THE STORES DIRECTLY. The card's inputs are two host reads
 * (`listInstanceServers`, `readInstanceToolPolicy`) backed by two persisted
 * tables, plus the connector's own instance list. Driving the badge STATE space
 * through real WordPress sites would need five differently-broken live sites;
 * seeding the stores reaches every state deterministically and still exercises
 * the real host reads, the real server components, and the real client
 * hydration — nothing here stubs a module or intercepts a route.
 *
 *   cinatra.metadata                       key `connector_config:wordpress`
 *                                          → the connector's instance list
 *                                            (a PLAIN json blob: only the
 *                                            `nango` connector-config has
 *                                            sealed secret fields, see
 *                                            src/lib/connector-config-secret-fields.ts)
 *   cinatra.connector_instance_server      → the discovered-server health matrix
 *   cinatra.connector_instance_tool_policy → the per-instance allow/deny record
 *
 * DETERMINISM — THE HEALTH-REFRESH RACE, AND WHAT IT COSTS THIS SUITE.
 * `listInstanceServers` resolves through `listInstanceServersWithHealthRefresh`,
 * which returns the CURRENT store rows and THEN kicks a fire-and-forget re-probe
 * of every ENROLLED row. Our sites are unroutable `.invalid` hosts, so that
 * probe rewrites each enrolled row's `last_status` to `unreachable`.
 *
 * Nothing about that is suppressible from here:
 *   • the 60s per-instance debounce is an in-process Map that does NOT hold
 *     across renders here — rows are observably re-probed on every navigation;
 *   • the probe's own guard (`refreshEnrolledServerHealth` returns early unless
 *     the instance resolves siteUrl + username + applicationPassword) reads the
 *     SAME instance row the settings page renders from, so blanking a credential
 *     to disable the probe also removes the connection card entirely; and
 *   • per-test instance ids are invisible to the app for 10s, because the
 *     instance list is read through the connector-config cache
 *     (CONNECTOR_CONFIG_CACHE_TTL_MS, src/lib/database.ts).
 *
 * So the fixture is built to be INVARIANT under the probe instead of racing it:
 *
 *   • every ENROLLED row is seeded `unreachable` — the exact verdict the probe
 *     writes — so a render before the probe and a render after it are identical;
 *   • the richer per-row health labels ("Available", "Authentication error",
 *     "Not checked yet", "Retired") are covered on NON-ENROLLED rows, which
 *     `refreshEnrolledServerHealth` skips outright (`row.status !== "enrolled"`)
 *     and whose seeded `last_status` is therefore stable; and
 *   • policy-driven state (the summary badge, pipeline readiness, the allow/deny
 *     editor) never depends on the probe at all.
 *
 * KNOWN COVERAGE GAP, deliberately not faked: the header-badge states that
 * require a HEALTHY enrolled server — "Connected" and "Connected — health
 * unverified" — and the success variant of a per-row health badge cannot be
 * asserted against an unroutable host, because the probe demotes any enrolled
 * row to `unreachable` before the assertion runs. Covering them needs a
 * REACHABLE fixture site answering the MCP discovery probe (the repo already
 * runs a WordPress container for the wp-drupal UAT), not a seeded status.
 * `deriveSiteConnectionBadge`'s healthy branches are unit-covered in the
 * connector's own suite; what is missing here is the live-render proof.
 *
 * The site URLs use the reserved `.invalid` TLD (RFC 2606) so the background
 * probe fails at DNS instead of reaching a real host.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

function readEnvLocal(): Record<string, string> {
  try {
    const raw = readFileSync(resolve(process.cwd(), ".env.local"), "utf-8");
    const out: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}

const ENV_LOCAL = readEnvLocal();

export const DATABASE_URL =
  process.env.SUPABASE_DB_URL ??
  ENV_LOCAL.SUPABASE_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5434/postgres";

export const SCHEMA = process.env.SUPABASE_SCHEMA ?? ENV_LOCAL.SUPABASE_SCHEMA ?? "cinatra";

export function newClient(): Client {
  return new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5_000 });
}

// ---------------------------------------------------------------------------
// Constants mirrored from the code under test
// ---------------------------------------------------------------------------

/** The host connector key the WordPress connector's rows are stored under
 * (src/lib/register-host-connector-services.ts). */
export const CONNECTOR_KEY = "wordpress";

/** The connector-config metadata key holding the connector's instance list. */
export const CONNECTOR_CONFIG_KEY = `connector_config:${CONNECTOR_KEY}`;

/** The deterministic UAT account. Declared here (not in auth.setup.ts) because
 * the fixture seeding needs it too: the instances must be bound to the org this
 * user administers, or the tool-policy read refuses them. */
export const UAT_EMAIL = process.env.E2E_WP_SETTINGS_USER_EMAIL ?? "wp-settings-admin@local.test";
export const UAT_PASSWORD = process.env.E2E_WP_SETTINGS_USER_PASSWORD ?? "WpSettingsAdmin!2026";

/**
 * The org that OWNS every fixture instance.
 *
 * NOT decoration. `readInstanceToolPolicy` authorizes INSIDE the member
 * (src/lib/connector-instance-tool-policy-surface.ts): it resolves the owning
 * org from the persisted instance row via `resolveInstanceOrgId` and requires
 * `connector.update` (org_admin+) membership there. An instance with no
 * `orgId` is org-unbound and collapses into the SAME opaque refusal as a
 * non-member, which the connector's `loadToolAccessState` catches into
 * `policy = null` — rendering the card's "Unavailable" summary badge and no
 * selection editor at all. Seeding instances WITHOUT this binding therefore
 * produces a card that looks plausible and asserts nothing.
 */
export async function resolveUatOrgId(c: Client): Promise<string> {
  const r = await c.query<{ organizationId: string }>(
    `SELECT m."organizationId"
       FROM public."member" m
       JOIN public."user" u ON u.id = m."userId"
      WHERE u.email = $1
      LIMIT 1`,
    [UAT_EMAIL],
  );
  const orgId = r.rowCount && r.rowCount > 0 ? r.rows[0]!.organizationId : null;
  if (!orgId) {
    throw new Error(
      `No org membership for ${UAT_EMAIL} — run the setup project first (it provisions the user and the org).`,
    );
  }
  return orgId;
}

/** Mirrors `DEFAULT_CATALOG_SERVER_ID` in the card and the host's
 * `CATALOG_DEFAULT_SERVER_ID`. Pipeline readiness keys off this exact id. */
export const DEFAULT_CATALOG_SERVER_ID = "mcp-adapter-default";

/** The union of every ability the card's three pipelines require. Mirrors
 * `PIPELINE_REQUIREMENTS` in wordpress-site-tools-card.tsx — kept as a literal
 * so a silent change to the shipped requirement set FAILS this suite rather
 * than quietly re-deriving from it. */
export const ALL_PIPELINE_TOOLS = [
  "ewpa/create-post",
  "ewpa/update-post-meta",
  "ewpa/get-posts",
  "ewpa/get-post",
  "ewpa/get-page",
  "ewpa/update-post",
] as const;

/** Per-pipeline required counts, used by the "Blocked — N tools not allowed"
 * assertions. Mirrors the shipped `PIPELINE_REQUIREMENTS` arity. */
export const PIPELINE_REQUIRED_COUNTS = {
  "blog-publishing": 3,
  "post-editing": 3,
  "freshness-checks": 1,
} as const;

// ---------------------------------------------------------------------------
// The fixture matrix
// ---------------------------------------------------------------------------

type SeedServer = {
  serverId: string;
  source: "default" | "discovered" | "manual";
  status: "enrolled" | "present_unenrolled" | "retired";
  restPath: string;
  label: string | null;
  serverVersion: string | null;
  /** `null` models "probed never" — the card's "Not checked yet". */
  lastStatus: "registered" | "not_installed" | "auth_error" | "unreachable" | "catalog_unavailable" | null;
};

export type SeedInstance = {
  id: string;
  name: string;
  siteUrl: string;
  username: string;
  /** Ordering key — `listInstancesSorted()` sorts `updatedAt` DESC, so the
   * cards render in the order this array declares. */
  updatedAt: string;
  servers: SeedServer[];
  policy: {
    mode: "restricted" | "open";
    allow: string[];
    deny: string[];
  };
};

/**
 * Five sites, chosen to cover what is deterministically assertable against an
 * unroutable host (see the determinism note above):
 *
 *   catalog     header "No MCP servers enrolled" · four NON-ENROLLED rows carry
 *               the per-row health labels: Available / Authentication error /
 *               Not checked yet / Retired
 *   blocked     header "Unreachable"             · policy allows nothing → all
 *               three pipelines blocked (policy outranks health)
 *   unreachable header "Unreachable"             · full allow, so readiness
 *               demotes on SERVER health instead
 *   denied      header "No MCP servers enrolled" · a denied ability is listed
 *               as always-blocked
 *   noservers   header "No MCP servers enrolled" · zero rows → the empty-state
 *               copy
 *
 * `denied` and `noservers` also pin the designed asymmetry: readiness is
 * policy-driven and only a KNOWN-BAD ENROLLED default server demotes it, so
 * both read "Ready" while their header badges do not say "Connected".
 */
export const FIXTURE_INSTANCES: SeedInstance[] = [
  {
    // The CATALOG VIEWER case. Every row is non-enrolled, so the health refresh
    // skips all of them and their seeded `last_status` values survive — this is
    // where the per-row health labels are actually asserted.
    id: "laneb-wp-catalog",
    name: "Catalog Editorial Site",
    siteUrl: "https://laneb-catalog.invalid",
    username: "laneb-editor",
    updatedAt: "2026-07-31T12:00:05.000Z",
    servers: [
      {
        serverId: DEFAULT_CATALOG_SERVER_ID,
        source: "default",
        status: "present_unenrolled",
        restPath: "/wp-json/mcp/v1/",
        label: null,
        serverVersion: "1.2.0",
        lastStatus: "registered",
      },
      {
        serverId: "laneb-srv-editorial",
        source: "manual",
        status: "present_unenrolled",
        restPath: "/wp-json/editorial-mcp/v1/",
        label: "Editorial tools",
        serverVersion: null,
        lastStatus: "auth_error",
      },
      {
        serverId: "laneb-srv-media",
        source: "discovered",
        status: "present_unenrolled",
        restPath: "/wp-json/media-mcp/v1/",
        label: "Media tools",
        serverVersion: "0.4.1",
        // A never-probed row is honestly "not checked", never a guessed green.
        lastStatus: null,
      },
      {
        serverId: "laneb-srv-legacy",
        source: "discovered",
        status: "retired",
        restPath: "/wp-json/legacy-mcp/v1/",
        label: null,
        serverVersion: null,
        // A retired row reports "Retired" REGARDLESS of its stored health.
        lastStatus: "not_installed",
      },
    ],
    policy: { mode: "restricted", allow: [...ALL_PIPELINE_TOOLS], deny: [] },
  },
  {
    id: "laneb-wp-blocked",
    name: "Blocked Campaign Site",
    siteUrl: "https://laneb-blocked.invalid",
    username: "laneb-campaigns",
    updatedAt: "2026-07-31T12:00:04.000Z",
    servers: [
      {
        serverId: DEFAULT_CATALOG_SERVER_ID,
        source: "default",
        status: "enrolled",
        restPath: "/wp-json/mcp/v1/",
        label: null,
        serverVersion: "1.2.0",
        lastStatus: "unreachable",
      },
    ],
    // The cinatra#2232 default flip: a site starts with NOTHING allowed. Policy
    // gaps outrank server health in `evaluatePipelineReadiness`, so this site
    // reads "Blocked", not "Unreachable", on every pipeline.
    policy: { mode: "restricted", allow: [], deny: [] },
  },
  {
    id: "laneb-wp-unreachable",
    name: "Unreachable Archive Site",
    siteUrl: "https://laneb-unreachable.invalid",
    username: "laneb-archive",
    updatedAt: "2026-07-31T12:00:03.000Z",
    servers: [
      {
        serverId: DEFAULT_CATALOG_SERVER_ID,
        source: "default",
        status: "enrolled",
        restPath: "/wp-json/mcp/v1/",
        label: null,
        serverVersion: "1.1.0",
        lastStatus: "unreachable",
      },
    ],
    // Policy allows everything, so readiness demotes on SERVER health instead.
    policy: { mode: "restricted", allow: [...ALL_PIPELINE_TOOLS], deny: [] },
  },
  {
    // The DENY case. No servers, so readiness is purely policy-driven.
    id: "laneb-wp-denied",
    name: "Denied Staging Site",
    siteUrl: "https://laneb-denied.invalid",
    username: "laneb-staging",
    updatedAt: "2026-07-31T12:00:02.000Z",
    servers: [],
    policy: { mode: "restricted", allow: [...ALL_PIPELINE_TOOLS], deny: ["ewpa/delete-post"] },
  },
  {
    id: "laneb-wp-noservers",
    name: "No Servers Site",
    siteUrl: "https://laneb-noservers.invalid",
    username: "laneb-empty",
    updatedAt: "2026-07-31T12:00:01.000Z",
    servers: [],
    policy: { mode: "restricted", allow: [...ALL_PIPELINE_TOOLS], deny: [] },
  },
];

export const FIXTURE_BY_ID = Object.fromEntries(
  FIXTURE_INSTANCES.map((i) => [i.id, i]),
) as Record<string, SeedInstance>;

/** Every fixture instance id starts with this, so a seed can scope its writes
 * without touching a developer's own local WordPress instances. */
export const FIXTURE_ID_PREFIX = "laneb-wp-";

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

function toRefs(names: readonly string[]): { serverId: string; name: string }[] {
  return names.map((name) => ({ serverId: DEFAULT_CATALOG_SERVER_ID, name }));
}

const qSchema = () => `"${SCHEMA.replaceAll('"', '""')}"`;

/**
 * Write the whole fixture matrix. Idempotent and total: every call re-asserts
 * the instance blob, every server row, and every policy row, so a background
 * health refresh that clobbered `last_status` between navigations is repaired.
 *
 * Scoped to the fixture ids only — it never truncates the tables, so a
 * developer's own local WordPress instances survive a suite run.
 */
export async function seedFixtures(c: Client): Promise<void> {
  const orgId = await resolveUatOrgId(c);
  // 1. The connector's instance list (a plain JSON blob in the metadata store).
  //    `value` is TEXT holding the JSON.stringify'd payload — the same encoding
  //    writeMetadataValueToDatabase uses.
  const config = {
    loggingEnabled: false,
    instances: FIXTURE_INSTANCES.map((i) => ({
      id: i.id,
      name: i.name,
      siteUrl: i.siteUrl,
      username: i.username,
      // The owning-org binding the tool-policy member authorizes against.
      orgId,
      // Present because an instance whose credential fields are incomplete is
      // dropped from the connector's instance list entirely (no card renders at
      // all). The value is never used to authenticate: the site is an
      // unroutable `.invalid` host.
      applicationPassword: "laneb fixture placeholder",
      createdAt: i.updatedAt,
      updatedAt: i.updatedAt,
    })),
  };
  await c.query(
    `INSERT INTO ${qSchema()}."metadata" (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [CONNECTOR_CONFIG_KEY, JSON.stringify(config)],
  );

  // Clear the fixture rows wholesale (scoped by the fixture id prefix, so a
  // developer's own instances survive) before re-asserting them.
  await c.query(
    `DELETE FROM ${qSchema()}."connector_instance_server"
       WHERE connector_key = $1 AND instance_id LIKE $2`,
    [CONNECTOR_KEY, `${FIXTURE_ID_PREFIX}%`],
  );
  await c.query(
    `DELETE FROM ${qSchema()}."connector_instance_tool_policy"
       WHERE connector_key = $1 AND instance_id LIKE $2`,
    [CONNECTOR_KEY, `${FIXTURE_ID_PREFIX}%`],
  );

  for (const instance of FIXTURE_INSTANCES) {
    const instanceId = instance.id;
    // 2. Server rows (the prefix purge above already cleared the table).
    for (const [index, s] of instance.servers.entries()) {
      // `listInstanceServers` orders by `created_at ASC, server_id ASC`. Seed
      // EXPLICIT, strictly increasing timestamps so the rendered row order is
      // the order this fixture declares — `now()` for every row would make the
      // order depend on sub-millisecond clock resolution and the tie-break
      // would silently re-sort the rows alphabetically by server id.
      const createdAt = new Date(Date.parse(instance.updatedAt) + index * 1_000).toISOString();
      await c.query(
        `INSERT INTO ${qSchema()}."connector_instance_server"
           (connector_key, instance_id, server_id, source, status, rest_path,
            label, server_version, enrolled_at, last_status, last_status_at,
            created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $9, now())`,
        [
          CONNECTOR_KEY,
          instanceId,
          s.serverId,
          s.source,
          s.status,
          s.restPath,
          s.label,
          s.serverVersion,
          createdAt,
          s.lastStatus,
          // A never-probed row has no probe timestamp either.
          s.lastStatus === null ? null : createdAt,
          "laneb-e2e-fixture",
        ],
      );
    }

    // 3. The tool policy record.
    await c.query(
      `INSERT INTO ${qSchema()}."connector_instance_tool_policy"
         (connector_key, instance_id, mode, allow_refs, deny_refs, updated_by, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
       ON CONFLICT (connector_key, instance_id) DO UPDATE
         SET mode = EXCLUDED.mode,
             allow_refs = EXCLUDED.allow_refs,
             deny_refs = EXCLUDED.deny_refs,
             updated_by = EXCLUDED.updated_by,
             updated_at = EXCLUDED.updated_at`,
      [
        CONNECTOR_KEY,
        instanceId,
        instance.policy.mode,
        JSON.stringify(toRefs(instance.policy.allow)),
        JSON.stringify(toRefs(instance.policy.deny)),
        "laneb-e2e-fixture",
        instance.updatedAt,
      ],
    );
  }
}

/** Open a connection, seed, close. The per-test entry point. */
export async function reseed(): Promise<void> {
  const c = newClient();
  await c.connect();
  try {
    await seedFixtures(c);
  } finally {
    await c.end();
  }
}
