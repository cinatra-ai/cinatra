/**
 * Row 15 of the archive adversarial acceptance manifest (cinatra#1943):
 * the 3-ROLE LIVE PROOF of the #1942 Danger-zone Archive/Unarchive surface,
 * on the production-equivalent build the `e2e-rbac` job boots.
 *
 * WHY IT LIVES HERE AND NOT IN ITS OWN SUITE. `tests/e2e/config/rbac.config.ts`
 * globs `tests/e2e/rbac/`, so this file joins the `e2e-rbac` job with NO
 * workflow change — the exact property PR #2703 recorded when it re-pointed
 * row 15's `ciDependency` at `build-image.yml` / `e2e-rbac`. That job builds
 * the app with `pnpm build`, serves the standalone output, and runs against a
 * real Postgres + Redis: a production build, a real browser, real sessions.
 * Nothing in this file can be verified on a developer box.
 *
 * ── THE GATE STAYS OFF IN PRODUCTION ──────────────────────────────────────
 * The Archive direction is hidden until the `org_archive_activation` gate is
 * on, and `archiveOrganization` refuses `activation-gate-off` before anything
 * else runs. That gate is a DATABASE row — `metadata` key
 * `connector_config:org_archive_activation` — read through
 * `readConnectorConfigFromDatabase` (10s per-process TTL, fail-closed).
 *
 * So the harness-scoped flip is a row in the EPHEMERAL CI database, written
 * and RESTORED by this file, the way `rbac-authorization.spec.ts` already
 * flips `connector_config:instance_identity` for its single-org-mode test.
 * Three containment rules hold it there, because "it is only a test" is not
 * a containment argument for a write that turns a dark-launched lifecycle
 * feature on:
 *   1. the suite REFUSES to run unless both the database and the app under
 *      test are on loopback (`assertLoopbackTarget` below) — a stale
 *      `SUPABASE_DB_URL` pointed at anything reachable cannot be armed by
 *      running a test;
 *   2. every metadata row it touches is SNAPSHOTTED first (absence included)
 *      and restored to those exact bytes in teardown — it never invents a
 *      "default" to reset to, and never clobbers sibling keys such as
 *      `closedRegistration` inside `instance_identity`;
 *   3. if teardown finds the gate still armed, it waits out the read cache
 *      before returning, so no later spec can observe a stale ON.
 * Production activation remains #1942's owner-run V6 closeout, untouched by
 * this spec, by the surface it drives, and by the PR that carries it.
 * `scripts/ops/flip-org-archive-activation-staging.mjs` is deliberately NOT
 * invoked: it requires a `--i-verified-staging-host` affirmation that a test
 * cannot honestly make, and its database write is the one made below.
 *
 * ── WHAT THIS FILE PROVES, AND WHAT ITS RED HALVES FALSIFY ────────────────
 * Row 15's criterion bundles a SUCCESS claim (the owner can archive AND
 * unarchive) with three REFUSAL claims (admin read-only, member read-only,
 * non-member 404). Per #2703's rule, a control is the counterpart run in
 * which the OUTCOME INVERTS once the ONE guard under test stops refusing —
 * never a second refusal of a different attack, and never a switch to a
 * different principal. Every control below keeps the SAME identity, the SAME
 * session, the SAME payload and the SAME seam, and flips exactly the one
 * stored predicate its guard reads:
 *
 *   guard                                  proof            control
 *   ─────────────────────────────────────  ───────────────  ────────────────
 *   isArchiveActivationEnabled()           owner archives   gate row off →
 *                                                           no control, and
 *                                                           the same bytes
 *                                                           land nothing
 *   organization.archivedAt (admin)        read-only note   org active → no
 *                                          + fieldset       note, no disabled
 *                                          disabled+inert   fieldset
 *   organization.archivedAt (member)       archived badge   org active → no
 *                                          + the org leaves badge, and the
 *                                          their active     org is back in
 *                                          list             their active list
 *   readUserIsOrgMember()                  non-member 404   membership row
 *                                                           exists → 200
 *   capabilities.canArchive                admin/member     the SAME admin
 *                                          replay refused   session with its
 *                                                           LIVE-org role row
 *                                                           set to owner lands
 *                                                           the same bytes
 *
 * The member's half is deliberately NOT "the member sees no management
 * surface": a member has no management surface in EITHER lifecycle state, so
 * that assertion inverts under nothing and would be unfalsifiable. What a
 * member actually observes changing is the archived badge and the
 * organization leaving their active list for the fixed Archived section —
 * both keyed on `archivedAt` alone, and both asserted in both directions.
 *
 * ── WHY THE ACTION IS ATTACKED BY REPLAY ──────────────────────────────────
 * A non-owner is never RENDERED the archive form — that is the surface half.
 * The action half therefore has to be reached the way a real attacker would:
 * capture the owner's Next server-action POST (its `Next-Action` id and body
 * are a build-time module identity, not a per-user secret) and re-issue the
 * identical bytes under the other roles' cookie jars. Two things keep that
 * from passing vacuously: the replay's HTTP status is asserted to be a
 * non-error (a 404 would mean the action was never resolved, and "the row
 * did not change" would then prove nothing), and the promoted-role control
 * lands the same bytes through the same code path.
 *
 * ── EVIDENCE ──────────────────────────────────────────────────────────────
 * `baseUse.screenshot` is "only-on-failure", so a green run captures nothing
 * by default. Every state of the surface is therefore attached EXPLICITLY and
 * rides the `rbac-playwright-report` artifact the job already uploads. Those
 * attachments are this PR's render evidence for the surface.
 *
 * ── DELIBERATE NON-ASSERTION, STATED RATHER THAN HIDDEN ───────────────────
 * The fixed "Archived organizations" section on `/organizations` renders its
 * rows through an embedded drizzle-cube grid, i.e. a client-side query. This
 * file asserts the SERVER-RENDERED per-viewer signal that drives that
 * section's empty state (`viewerHasArchivedOrganizations(userId)`) rather
 * than reading rows out of the grid, and it asserts that signal in BOTH
 * directions per viewer — present before the archive, absent while archived,
 * present again after the unarchive. Because each fixture identity is created
 * fresh in this run and belongs to exactly two organizations, that
 * three-point inversion is specific to the organization under test. Asserting
 * cube-rendered rows is a separate concern owned by the V4 section's own
 * tests, not smuggled in here.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";
import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
  type TestInfo,
} from "@playwright/test";

// ---------------------------------------------------------------------------
// Environment (mirrors auth.setup.ts / rbac-authorization.spec.ts verbatim)
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
const DATABASE_URL =
  process.env.SUPABASE_DB_URL ?? ENV_LOCAL.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/postgres";
const SCHEMA = process.env.SUPABASE_SCHEMA ?? ENV_LOCAL.SUPABASE_SCHEMA ?? "cinatra";
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${process.env.E2E_PORT ?? 3000}`;

/** `readConnectorConfigFromDatabase`'s per-process TTL is 10s; +1s of slack.
 *  The same constant `rbac-authorization.spec.ts` waits for its own flip. */
const CONNECTOR_CONFIG_TTL_WAIT_MS = 11_000;

const ARCHIVE_GATE_KEY = "connector_config:org_archive_activation";
const INSTANCE_IDENTITY_KEY = "connector_config:instance_identity";

const HYDRATION_TIMEOUT_MS = process.env.CI ? 30_000 : 90_000;

/**
 * Containment fence for the activation flip. This suite arms a dark-launched
 * lifecycle feature by writing a row, so it must be structurally unable to
 * arm anything but a local, disposable instance. Both the database it writes
 * and the app it drives have to be loopback; anything else THROWS (loudly —
 * never a silent skip, which would report a green row nobody proved).
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

function assertLoopbackTarget(label: string, value: string): void {
  let hostname: string;
  try {
    hostname = new URL(value).hostname;
  } catch {
    throw new Error(`${label} is not a parseable URL, so this suite cannot verify it is local: refusing to run.`);
  }
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(
      `${label} points at "${hostname}", which is not loopback. This suite turns the ` +
        `org_archive_activation gate ON, so it only ever runs against a local, disposable ` +
        `instance. Point it at a local stack or do not run it.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Postgres helpers
// ---------------------------------------------------------------------------

async function withDb<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5_000 });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** The RAW stored string for a metadata key, or null when no row exists —
 *  the snapshot teardown restores byte-for-byte. */
async function readMetadataRaw(key: string): Promise<string | null> {
  return withDb(async (c) => {
    const r = await c.query<{ value: string | null }>(
      `SELECT value FROM "${SCHEMA}"."metadata" WHERE key = $1 LIMIT 1`,
      [key],
    );
    return r.rowCount && r.rowCount > 0 ? (r.rows[0]!.value ?? null) : null;
  });
}

/** Write a `metadata` KV row the way `writeMetadataValueInternal` does. */
async function setMetadataValue(key: string, value: unknown): Promise<void> {
  await withDb(async (c) => {
    await c.query(
      `INSERT INTO "${SCHEMA}"."metadata" (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(value)],
    );
  });
}

/** Put a snapshotted row back exactly: the same bytes, or no row at all. */
async function restoreMetadataRaw(key: string, raw: string | null): Promise<void> {
  await withDb(async (c) => {
    if (raw === null) {
      await c.query(`DELETE FROM "${SCHEMA}"."metadata" WHERE key = $1`, [key]);
      return;
    }
    await c.query(
      `INSERT INTO "${SCHEMA}"."metadata" (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, raw],
    );
  });
}

/** Tracks whether the gate is currently armed, so teardown knows whether it
 *  has to wait out the server's read cache before handing the database on. */
let gateIsArmed = false;

async function setArchiveActivationGate(on: boolean): Promise<void> {
  await setMetadataValue(ARCHIVE_GATE_KEY, { enabled: on });
  gateIsArmed = on;
}

async function readArchivedAt(organizationId: string): Promise<string | null> {
  return withDb(async (c) => {
    const r = await c.query<{ archivedAt: string | null }>(
      `SELECT "archivedAt" FROM public."organization" WHERE id = $1 LIMIT 1`,
      [organizationId],
    );
    if (!r.rowCount) throw new Error(`organization row vanished: ${organizationId}`);
    return r.rows[0]!.archivedAt;
  });
}

async function userIdByEmail(c: Client, email: string): Promise<string> {
  const r = await c.query<{ id: string }>(`SELECT id FROM public."user" WHERE email = $1 LIMIT 1`, [email]);
  if (!r.rowCount) throw new Error(`user not found after sign-up: ${email}`);
  return r.rows[0]!.id;
}

/** Set one identity's role in the organization under test. Used only by the
 *  capability control, which restores the original role in its own `finally`. */
async function setLiveOrgRole(email: string, role: "owner" | "admin" | "member"): Promise<void> {
  await withDb(async (c) => {
    const userId = await userIdByEmail(c, email);
    const r = await c.query(
      `UPDATE public."member" SET role = $1 WHERE "organizationId" = $2 AND "userId" = $3`,
      [role, LIVE_ORG_ID, userId],
    );
    if (!r.rowCount) throw new Error(`no membership row to set role on: ${email}`);
  });
}

// ---------------------------------------------------------------------------
// Fixture identities
// ---------------------------------------------------------------------------

const SUFFIX = `${Date.now().toString(36)}`;
const PASSWORD = "ArchiveLiveUAT!2026";

type RoleName = "owner" | "admin" | "member" | "outsider";

const ACCOUNTS: Record<RoleName, { email: string; name: string }> = {
  owner: { email: `archive-owner-${SUFFIX}@local.test`, name: "Archive Owner UAT" },
  admin: { email: `archive-admin-${SUFFIX}@local.test`, name: "Archive Admin UAT" },
  member: { email: `archive-member-${SUFFIX}@local.test`, name: "Archive Member UAT" },
  outsider: { email: `archive-outsider-${SUFFIX}@local.test`, name: "Archive Outsider UAT" },
};

/** The organization under test. Its name is typed verbatim into the
 *  confirm-to-act field, so keep it plain. Its slug is deliberately not
 *  "default" — the shared lifecycle fence refuses the Default org outright. */
const LIVE_ORG_ID = `archive-live-org-${SUFFIX}`;
const LIVE_ORG_NAME = `Archive Live Proof ${SUFFIX}`;

/**
 * A second org every fixture identity belongs to, used ONLY as their ACTIVE
 * organization. This is load-bearing, not tidiness: the archive transaction
 * atomically NULLs `session.activeOrganizationId` for every session pointing
 * at the archived org (Decision 2a), and every dashboards screen redirects to
 * sign-in when the session carries no active org
 * (`buildSecurityContextFromSession` returns null). Parking each identity's
 * active org on a DIFFERENT organization keeps the archived org's own
 * surfaces reachable, which is what row 15 has to observe.
 */
const HOME_ORG_ID = `archive-home-org-${SUFFIX}`;

// ---------------------------------------------------------------------------
// Session + request helpers
// ---------------------------------------------------------------------------

type StorageState = Awaited<ReturnType<APIRequestContext["storageState"]>>;

const STATE: Partial<Record<RoleName, StorageState>> = {};

async function signUp(email: string, name: string): Promise<void> {
  const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL });
  try {
    // 200 = created; 400/422 = already exists. Anything else is a real failure.
    const res = await ctx.post("/api/auth/sign-up/email", {
      data: { email, password: PASSWORD, name },
      headers: { Origin: BASE_URL },
      failOnStatusCode: false,
    });
    expect([200, 400, 422]).toContain(res.status());
  } finally {
    await ctx.dispose();
  }
}

async function signInAndCaptureState(email: string, activeOrganizationId: string): Promise<StorageState> {
  const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL });
  try {
    const signIn = await ctx.post("/api/auth/sign-in/email", {
      data: { email, password: PASSWORD },
      headers: { Origin: BASE_URL },
    });
    expect(signIn.ok(), `sign-in failed for ${email} (${signIn.status()})`).toBeTruthy();
    const setActive = await ctx.post("/api/auth/organization/set-active", {
      data: { organizationId: activeOrganizationId },
      headers: { Origin: BASE_URL },
      failOnStatusCode: false,
    });
    expect(setActive.ok(), `set-active failed for ${email} (${setActive.status()})`).toBeTruthy();
    return await ctx.storageState();
  } finally {
    await ctx.dispose();
  }
}

function stateFor(role: RoleName): StorageState {
  const state = STATE[role];
  if (!state) throw new Error(`no captured session for ${role} — beforeAll did not complete`);
  return state;
}

/** A fresh browser context under one role's session. Callers close it. */
async function contextFor(browser: Browser, role: RoleName): Promise<BrowserContext> {
  return browser.newContext({ storageState: stateFor(role) });
}

/** Run `fn` on a page under `role`'s session, always tearing the context down. */
async function asRole<T>(browser: Browser, role: RoleName, fn: (page: Page) => Promise<T>): Promise<T> {
  const ctx = await contextFor(browser, role);
  try {
    return await fn(await ctx.newPage());
  } finally {
    await ctx.close();
  }
}

/**
 * Wait for React to own `selector` before driving it. Same element-specific
 * `__reactFiber$` gate the sibling spec documents, targeted at the control
 * under test rather than the sidebar.
 */
async function waitForHydration(page: Page, selector: string): Promise<void> {
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      return !!el && Object.keys(el).some((k) => k.startsWith("__reactFiber$"));
    },
    selector,
    { timeout: HYDRATION_TIMEOUT_MS },
  );
}

const settingsPath = (orgId: string) => `/organizations/${encodeURIComponent(orgId)}/settings`;

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
}

/**
 * The per-viewer archived-list signal: `/organizations` renders the fixed
 * Archived section's empty state only while `viewerHasArchivedOrganizations`
 * is false for THIS viewer. Asserted in both directions per identity.
 */
async function expectArchivedListSignal(
  browser: Browser,
  role: RoleName,
  expected: "empty" | "populated",
): Promise<void> {
  await asRole(browser, role, async (page) => {
    await page.goto("/organizations", { waitUntil: "domcontentloaded" });
    const section = page.locator('[data-cinatra-archived-organizations-section="true"]');
    await expect(section).toBeVisible({ timeout: 30_000 });
    const emptyMarker = page.locator('[data-cinatra-archived-organizations-empty="true"]');
    if (expected === "empty") {
      await expect(emptyMarker).toBeVisible();
    } else {
      await expect(emptyMarker).toHaveCount(0);
    }
  });
}

// ---------------------------------------------------------------------------
// Captured server-action requests (the replay attack surface)
// ---------------------------------------------------------------------------

type CapturedAction = {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
};

const CAPTURED: { archive?: CapturedAction; unarchive?: CapturedAction } = {};

/** Snapshot a Next server-action POST so it can be re-issued verbatim. */
function captureAction(request: import("@playwright/test").Request): CapturedAction {
  const raw = request.postDataBuffer() ?? (request.postData() ? Buffer.from(request.postData()!) : null);
  if (!raw) {
    throw new Error(
      "could not capture the server-action request body — the action-level " +
        "denial below would be unfalsifiable without it, so this fails loudly " +
        "instead of passing vacuously",
    );
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers())) {
    // Drop hop-by-hop / connection-scoped headers: the cookie jar comes from
    // the replaying context, and the length is recomputed by the client.
    if (key.startsWith(":")) continue;
    if (key === "cookie" || key === "content-length" || key === "host") continue;
    headers[key] = value;
  }
  return { url: request.url(), headers, body: raw };
}

function capturedArchive(): CapturedAction {
  const captured = CAPTURED.archive;
  if (!captured) throw new Error("the archive server-action request was never captured");
  return captured;
}

function capturedUnarchive(): CapturedAction {
  const captured = CAPTURED.unarchive;
  if (!captured) throw new Error("the unarchive server-action request was never captured");
  return captured;
}

/**
 * Re-issue a captured server-action request under a role's session, and
 * assert it actually REACHED the action. A 404 (unknown action id) or a 5xx
 * would make the "nothing changed in the database" assertions that follow
 * prove nothing at all — that is the vacuity this check closes.
 */
async function replayAs(role: RoleName, action: CapturedAction, label: string): Promise<void> {
  const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL, storageState: stateFor(role) });
  try {
    const res = await ctx.post(action.url, {
      headers: action.headers,
      data: action.body,
      failOnStatusCode: false,
    });
    expect(
      res.status(),
      `${label}: the replayed server action returned ${res.status()} — it never reached the action, ` +
        `so any "the row did not change" assertion below would be vacuous`,
    ).toBeLessThan(400);
  } finally {
    await ctx.dispose();
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

// Serial: this is one state machine (active → archived → active), and each
// test observes the state the previous one left. `retries: 0` overrides the
// suite-wide CI retry ON PURPOSE — a serial-mode retry re-runs the whole
// group including its TTL waits, which would push the rbac suite past its own
// globalTimeout. Every assertion here is either server-rendered markup or a
// database read, so there is no flake budget to buy back.
test.describe.configure({ mode: "serial", retries: 0, timeout: 180_000 });

test.describe("archive live proof — 3 roles on a production-equivalent build (cinatra#1942 / #1943 row 15)", () => {
  /** Byte-exact snapshots of every metadata row this file writes. */
  const SNAPSHOT: { gate?: string | null; instanceIdentity?: string | null } = {};

  test.beforeAll(async () => {
    assertLoopbackTarget("SUPABASE_DB_URL", DATABASE_URL);
    assertLoopbackTarget("E2E_BASE_URL", BASE_URL);

    SNAPSHOT.gate = await readMetadataRaw(ARCHIVE_GATE_KEY);
    SNAPSHOT.instanceIdentity = await readMetadataRaw(INSTANCE_IDENTITY_KEY);

    // Multi-org mode is a precondition of the whole criterion (the shared
    // lifecycle fence refuses single-org outright, and a sibling spec in this
    // same suite toggles that row). Set it by READ-MODIFY-WRITE so sibling
    // keys inside `instance_identity` — closedRegistration and friends —
    // survive; a blind overwrite would silently reconfigure the instance.
    let identity: Record<string, unknown> = {};
    try {
      const parsed = SNAPSHOT.instanceIdentity ? JSON.parse(SNAPSHOT.instanceIdentity) : null;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        identity = parsed as Record<string, unknown>;
      }
    } catch {
      identity = {};
    }
    await setMetadataValue(INSTANCE_IDENTITY_KEY, { ...identity, singleOrg: false });
    await setArchiveActivationGate(true);

    for (const account of Object.values(ACCOUNTS)) {
      await signUp(account.email, account.name);
    }

    await withDb(async (c) => {
      const ids = {
        owner: await userIdByEmail(c, ACCOUNTS.owner.email),
        admin: await userIdByEmail(c, ACCOUNTS.admin.email),
        member: await userIdByEmail(c, ACCOUNTS.member.email),
        outsider: await userIdByEmail(c, ACCOUNTS.outsider.email),
      };

      for (const [id, name] of [
        [LIVE_ORG_ID, LIVE_ORG_NAME],
        [HOME_ORG_ID, `Archive Home ${SUFFIX}`],
      ] as const) {
        await c.query(
          `INSERT INTO public."organization" (id, name, slug, "createdAt")
             VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO NOTHING`,
          [id, name, id],
        );
      }

      // Roles in the org under test. The outsider deliberately gets no row.
      const liveRoles: ReadonlyArray<readonly [string, string]> = [
        [ids.owner, "owner"],
        [ids.admin, "admin"],
        [ids.member, "member"],
      ];
      for (const [userId, role] of liveRoles) {
        await c.query(
          `INSERT INTO public."member" (id, "userId", "organizationId", role, "createdAt")
             VALUES ($1, $2, $3, $4, now()) ON CONFLICT (id) DO NOTHING`,
          [`archive-live-${role}-${SUFFIX}`, userId, LIVE_ORG_ID, role],
        );
      }
      // Everyone (the outsider included) is a plain member of the home org —
      // it exists only to hold their ACTIVE organization.
      for (const [role, userId] of Object.entries(ids)) {
        await c.query(
          `INSERT INTO public."member" (id, "userId", "organizationId", role, "createdAt")
             VALUES ($1, $2, $3, 'member', now()) ON CONFLICT (id) DO NOTHING`,
          [`archive-home-${role}-${SUFFIX}`, userId, HOME_ORG_ID],
        );
      }
    });

    for (const role of Object.keys(ACCOUNTS) as RoleName[]) {
      STATE[role] = await signInAndCaptureState(ACCOUNTS[role].email, HOME_ORG_ID);
    }

    // One wait for both metadata writes above to clear the 10s TTL in the
    // running server's process.
    await new Promise((r) => setTimeout(r, CONNECTOR_CONFIG_TTL_WAIT_MS));
  });

  test.afterAll(async () => {
    // Byte-exact restore, absence included — never a guessed default.
    if (SNAPSHOT.gate !== undefined) await restoreMetadataRaw(ARCHIVE_GATE_KEY, SNAPSHOT.gate);
    if (SNAPSHOT.instanceIdentity !== undefined) {
      await restoreMetadataRaw(INSTANCE_IDENTITY_KEY, SNAPSHOT.instanceIdentity);
    }
    // A mid-suite failure can leave the gate armed in the server's read cache.
    // Hand the database on only once that cache can no longer serve an ON.
    if (gateIsArmed) {
      gateIsArmed = false;
      await new Promise((r) => setTimeout(r, CONNECTOR_CONFIG_TTL_WAIT_MS));
    }
  });

  test("the owner archives the organization from the Danger zone and it goes read-only", async ({
    browser,
  }, testInfo) => {
    expect(await readArchivedAt(LIVE_ORG_ID)).toBeNull();
    // Baseline for the archived-list signal: this viewer has NO archived
    // organization yet, so the flip asserted below is caused by THIS org.
    await expectArchivedListSignal(browser, "owner", "empty");

    const ctx = await contextFor(browser, "owner");
    try {
      const page = await ctx.newPage();
      await page.goto(settingsPath(LIVE_ORG_ID), { waitUntil: "domcontentloaded" });

      const archiveForm = page.locator('form[data-cinatra-org-archive="armed"]');
      await expect(archiveForm).toBeVisible({ timeout: 30_000 });
      await shot(page, testInfo, "01-owner-archive-card-gate-on");

      // Confirm-to-act, the established danger-zone arming pattern: the
      // destructive button stays disabled until the typed name matches the
      // organization's name exactly.
      await waitForHydration(page, 'form[data-cinatra-org-archive="armed"]');
      const submit = archiveForm.getByRole("button", { name: "Archive organization" });
      await expect(submit).toBeDisabled();
      await archiveForm.locator("#org-archive-confirm").fill(`${LIVE_ORG_NAME}x`);
      await expect(submit).toBeDisabled();
      await archiveForm.locator("#org-archive-confirm").fill(LIVE_ORG_NAME);
      await expect(submit).toBeEnabled();

      const [actionRequest] = await Promise.all([
        page.waitForRequest(
          (req) => req.method() === "POST" && req.headers()["next-action"] !== undefined,
          { timeout: 60_000 },
        ),
        submit.click(),
      ]);
      CAPTURED.archive = captureAction(actionRequest);

      // The transaction is authoritative — assert the row, not the toast.
      await expect
        .poll(async () => await readArchivedAt(LIVE_ORG_ID), { timeout: 60_000 })
        .not.toBeNull();

      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.locator('[data-lifecycle="archived"]').first()).toBeVisible({ timeout: 30_000 });
      // The read-only posture is the disabled+inert fieldset, not the note
      // that explains it — assert the enforcing markup, then the note.
      await expect(
        page.locator('[data-cinatra-org-manage="true"] fieldset[disabled][inert]'),
      ).toHaveCount(2);
      await expect(page.locator('[data-cinatra-org-manage-readonly="settings"]')).toBeVisible();
      await expect(page.locator('[data-cinatra-org-manage-readonly="members"]')).toBeVisible();
      // Recovery is ungated by design (Decision 2 asymmetry) — the Unarchive
      // control replaces the Archive one, outside any disabled fieldset.
      await expect(page.locator('[data-cinatra-org-archive="unarchive"]')).toBeVisible();
      await expect(
        page.locator('fieldset[disabled] [data-cinatra-org-archive="unarchive"]'),
      ).toHaveCount(0);
      await expect(page.locator('form[data-cinatra-org-archive="armed"]')).toHaveCount(0);
      await shot(page, testInfo, "02-owner-settings-archived-readonly");
      await page.goto("/organizations", { waitUntil: "domcontentloaded" });
      await shot(page, testInfo, "03-owner-organizations-archived-section");
    } finally {
      await ctx.close();
    }

    // Visibility drops: the org has left this viewer's active list for the
    // fixed Archived section.
    await expectArchivedListSignal(browser, "owner", "populated");
  });

  test("an org admin is read-only on the archived organization and gets no archive control", async ({
    browser,
  }, testInfo) => {
    expect(await readArchivedAt(LIVE_ORG_ID)).not.toBeNull();

    await asRole(browser, "admin", async (page) => {
      const res = await page.goto(settingsPath(LIVE_ORG_ID), { waitUntil: "domcontentloaded" });
      expect(res?.status()).toBe(200);
      // Non-vacuity: the admin DOES reach the management surface — their
      // Settings card renders — and it is NEUTRALIZED, not merely annotated.
      // `disabled` cascades to native controls; `inert` additionally blocks
      // clicks, focus and portalled Radix triggers. Both are the contract.
      await expect(page.locator('[data-cinatra-org-manage="true"]')).toBeVisible({ timeout: 30_000 });
      await expect(
        page.locator('[data-cinatra-org-manage="true"] fieldset[disabled][inert]'),
      ).toHaveCount(1);
      await expect(page.locator('[data-cinatra-org-manage-readonly="settings"]')).toBeVisible();
      await expect(page.locator("[data-cinatra-org-archive]")).toHaveCount(0);
      await shot(page, testInfo, "04-admin-settings-archived-readonly");
    });
  });

  test("an ordinary member sees the organization as archived, with no management or archive control", async ({
    browser,
  }, testInfo) => {
    expect(await readArchivedAt(LIVE_ORG_ID)).not.toBeNull();

    await asRole(browser, "member", async (page) => {
      const res = await page.goto(settingsPath(LIVE_ORG_ID), { waitUntil: "domcontentloaded" });
      expect(res?.status()).toBe(200);
      // Non-vacuity: the member reaches the page (the read-only access model
      // renders). The lifecycle-sensitive observable for a member is the
      // archived badge — the management surface is absent in BOTH states, so
      // asserting its absence alone would invert under nothing.
      await expect(page.locator('[data-cinatra-org-permissions="true"]')).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('[data-lifecycle="archived"]').first()).toBeVisible();
      await expect(page.locator('[data-cinatra-org-manage="true"]')).toHaveCount(0);
      await expect(page.locator("[data-cinatra-org-archive]")).toHaveCount(0);
      await shot(page, testInfo, "05-member-settings-archived");
    });

    // The org has left the member's active list too.
    await expectArchivedListSignal(browser, "member", "populated");
  });

  test("a non-member gets a 404 on the archived organization's settings surface", async ({ browser }) => {
    expect(await readArchivedAt(LIVE_ORG_ID)).not.toBeNull();
    await asRole(browser, "outsider", async (page) => {
      const res = await page.goto(settingsPath(LIVE_ORG_ID), { waitUntil: "domcontentloaded" });
      expect(res?.status()).toBe(404);
      await expect(page.locator('[data-cinatra-org-permissions="true"]')).toHaveCount(0);
      await expect(page.locator("[data-cinatra-org-archive]")).toHaveCount(0);
    });
  });

  test("negative control: the same non-member reaches the same organization once their membership row exists", async ({
    browser,
  }) => {
    const membershipId = `archive-live-control-outsider-${SUFFIX}`;
    await withDb(async (c) => {
      const outsiderId = await userIdByEmail(c, ACCOUNTS.outsider.email);
      await c.query(
        `INSERT INTO public."member" (id, "userId", "organizationId", role, "createdAt")
           VALUES ($1, $2, $3, 'member', now()) ON CONFLICT (id) DO NOTHING`,
        [membershipId, outsiderId, LIVE_ORG_ID],
      );
    });
    try {
      await asRole(browser, "outsider", async (page) => {
        const res = await page.goto(settingsPath(LIVE_ORG_ID), { waitUntil: "domcontentloaded" });
        // The 404 above inverts to a rendered page: the guard that refused
        // was membership, not the archived state and not a broken route.
        expect(res?.status()).toBe(200);
        await expect(page.locator('[data-cinatra-org-permissions="true"]')).toBeVisible({ timeout: 30_000 });
      });
    } finally {
      await withDb(async (c) => {
        await c.query(`DELETE FROM public."member" WHERE id = $1`, [membershipId]);
      });
    }
  });

  test("the owner unarchives the organization and it is restored", async ({ browser }, testInfo) => {
    expect(await readArchivedAt(LIVE_ORG_ID)).not.toBeNull();

    const ctx = await contextFor(browser, "owner");
    try {
      const page = await ctx.newPage();
      await page.goto(settingsPath(LIVE_ORG_ID), { waitUntil: "domcontentloaded" });

      const unarchive = page.locator('[data-cinatra-org-archive="unarchive"]');
      await expect(unarchive).toBeVisible({ timeout: 30_000 });
      await waitForHydration(page, '[data-cinatra-org-archive="unarchive"]');

      const [actionRequest] = await Promise.all([
        page.waitForRequest(
          (req) => req.method() === "POST" && req.headers()["next-action"] !== undefined,
          { timeout: 60_000 },
        ),
        unarchive.getByRole("button", { name: "Unarchive organization" }).click(),
      ]);
      CAPTURED.unarchive = captureAction(actionRequest);

      await expect.poll(async () => await readArchivedAt(LIVE_ORG_ID), { timeout: 60_000 }).toBeNull();

      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.locator('form[data-cinatra-org-archive="armed"]')).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('[data-cinatra-org-archive="unarchive"]')).toHaveCount(0);
      await expect(page.locator('[data-lifecycle="archived"]')).toHaveCount(0);
      await expect(page.locator("[data-cinatra-org-manage-readonly]")).toHaveCount(0);
      await expect(page.locator('[data-cinatra-org-manage="true"] fieldset[disabled]')).toHaveCount(0);
      await shot(page, testInfo, "06-owner-settings-restored");
    } finally {
      await ctx.close();
    }

    await expectArchivedListSignal(browser, "owner", "empty");
  });

  test("negative control: on the active organization the same admin and member see the state invert", async ({
    browser,
  }) => {
    expect(await readArchivedAt(LIVE_ORG_ID)).toBeNull();

    await asRole(browser, "admin", async (page) => {
      await page.goto(settingsPath(LIVE_ORG_ID), { waitUntil: "domcontentloaded" });
      await expect(page.locator('[data-cinatra-org-manage="true"]')).toBeVisible({ timeout: 30_000 });
      // Same identity, same surface: only `archivedAt` changed, and the
      // read-only posture is gone — no note, and a live (non-disabled,
      // non-inert) fieldset where a neutralized one stood.
      await expect(page.locator("[data-cinatra-org-manage-readonly]")).toHaveCount(0);
      await expect(page.locator('[data-cinatra-org-manage="true"] fieldset[disabled]')).toHaveCount(0);
      await expect(page.locator('[data-cinatra-org-manage="true"] fieldset[inert]')).toHaveCount(0);
      // Still no archive control — that one is the ROLE gate, not the
      // lifecycle gate, and it does not move.
      await expect(page.locator("[data-cinatra-org-archive]")).toHaveCount(0);
    });

    await asRole(browser, "member", async (page) => {
      await page.goto(settingsPath(LIVE_ORG_ID), { waitUntil: "domcontentloaded" });
      await expect(page.locator('[data-cinatra-org-permissions="true"]')).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('[data-lifecycle="archived"]')).toHaveCount(0);
      await expect(page.locator("[data-cinatra-org-archive]")).toHaveCount(0);
    });

    // And the organization is back in the member's active list.
    await expectArchivedListSignal(browser, "member", "empty");
  });

  test("the same archive submission is refused by the action when it carries an org admin's or a member's session", async () => {
    expect(await readArchivedAt(LIVE_ORG_ID)).toBeNull();
    const action = capturedArchive();

    for (const role of ["admin", "member"] as const) {
      await replayAs(role, action, `${role} archive replay`);
      expect(
        await readArchivedAt(LIVE_ORG_ID),
        `the ${role} replay archived the organization — the capability gate did not hold`,
      ).toBeNull();
    }
  });

  test("negative control: the same admin session lands the same submission once its membership row says owner", async () => {
    expect(await readArchivedAt(LIVE_ORG_ID)).toBeNull();

    // Same identity, same session cookie, same captured bytes, same endpoint.
    // The ONLY thing that changes is the one stored predicate the capability
    // gate reads: this user's role row in THIS organization. The refusal above
    // therefore came from the gate, not from a replay that never landed.
    await setLiveOrgRole(ACCOUNTS.admin.email, "owner");
    try {
      await replayAs("admin", capturedArchive(), "promoted-admin archive replay");
      await expect.poll(async () => await readArchivedAt(LIVE_ORG_ID), { timeout: 60_000 }).not.toBeNull();

      // Restore through the real recovery path, never by touching the row.
      await replayAs("admin", capturedUnarchive(), "promoted-admin unarchive replay");
      await expect.poll(async () => await readArchivedAt(LIVE_ORG_ID), { timeout: 60_000 }).toBeNull();
    } finally {
      await setLiveOrgRole(ACCOUNTS.admin.email, "admin");
    }
  });

  test("negative control: with the activation gate off, the same owner's same archive submission renders nothing and lands nothing", async ({
    browser,
  }, testInfo) => {
    expect(await readArchivedAt(LIVE_ORG_ID)).toBeNull();

    await setArchiveActivationGate(false);
    await new Promise((r) => setTimeout(r, CONNECTOR_CONFIG_TTL_WAIT_MS));

    await asRole(browser, "owner", async (page) => {
      await page.goto(settingsPath(LIVE_ORG_ID), { waitUntil: "domcontentloaded" });
      // Non-vacuity: the owner still reaches their full management surface —
      // only the Archive control is gone, because only the gate changed.
      await expect(page.locator('[data-cinatra-org-manage="true"]')).toBeVisible({ timeout: 30_000 });
      await expect(page.locator("[data-cinatra-org-archive]")).toHaveCount(0);
      await shot(page, testInfo, "07-owner-settings-gate-off");
    });

    // And the action itself refuses: the identical submission that archived
    // this organization minutes ago now lands nothing.
    await replayAs("owner", capturedArchive(), "gate-off owner archive replay");
    expect(
      await readArchivedAt(LIVE_ORG_ID),
      "the archive landed with the activation gate off — the gate is not the guard it claims to be",
    ).toBeNull();
  });
});
