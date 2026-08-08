/**
 * Shared state helpers for the setup-flow acceptance suite (cinatra#2392,
 * epic #2385 S7).
 *
 * FRESH-INSTANCE SEMANTICS: `resetFreshInstance()` returns the running stack
 * to the zero-humans pre-setup state — every Better Auth `public.*` table is
 * truncated and the setup-owned application rows (instance identity, the S3
 * provider commitment, both providers' stored connections, the Anthropic
 * skill-sync bookkeeping) are deleted. Setup completion is derived FRESH on
 * every read since S3 removed the positive completion cache
 * (src/lib/setup-wizard.ts), so no server restart is needed for the wizard to
 * reappear: the next request re-derives "incomplete" from the emptied store.
 * Cold-boot freshness on a bare database is separately proven by
 * scripts/ci/prod-boot-e2e.sh.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { expect, type Page } from "@playwright/test";
import { waitForHydration } from "../../config/hydration";

export { waitForHydration };

/** The wizard's route segments, as settled by the #2477 owner-acceptance
 *  review (shipped in #2483). Referenced as constants so a future rename
 *  fails compilation here instead of silently timing out in every spec. */
export const SETUP_ACCOUNT_PATH = "/setup/account";
export const SETUP_MODEL_PATH = "/setup/model";

function readEnvLocal(): Record<string, string> {
  try {
    const raw = readFileSync(path.resolve(process.cwd(), ".env.local"), "utf-8");
    const out: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      out[trimmed.slice(0, eq).trim()] = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}

const ENV_LOCAL = readEnvLocal();

// NO built-in fallback. `resetFreshInstance()` truncates every `public` table;
// a default connection string would point that at whatever ordinary database
// happens to be listening, so the target must be stated explicitly.
export const DATABASE_URL = process.env.SUPABASE_DB_URL ?? ENV_LOCAL.SUPABASE_DB_URL ?? "";

export const APP_SCHEMA =
  process.env.SUPABASE_SCHEMA ?? ENV_LOCAL.SUPABASE_SCHEMA ?? "cinatra";

/** Must match the stub's default (tests/e2e/setup/support/provider-boundary-stub.mjs). */
export const STUB_DIR =
  process.env.LANE_STUB_DIR ??
  path.join(process.cwd(), "test-results", "setup-acceptance-stub");

/** The assistant-turn sentinel the stub answers with. */
export const TURN_SENTINEL = "CINATRA_SETUP_ACCEPTANCE_OK";

/** The setup-owned metadata keys (mirrors the S6 reset driver, extended with
 *  the S3 commitment record and the instance identity). */
export const SETUP_METADATA_KEYS = [
  "instance_identity",
  "setup_provider_commit",
  "connector_config:llm_default_provider",
  "connector_config:setup_provider_selection",
  "connector_config:setup_readiness_receipt",
  "connector_config:setup_readiness_last_failure",
  "connector_config:anthropic",
  "connector_config:anthropic_connection",
  "connector_config:anthropic_skill_sync_enabled",
  "openai_connection",
];

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  if (!DATABASE_URL) {
    throw new Error(
      "SUPABASE_DB_URL is required for the setup-acceptance suite — point it at a DEDICATED database.",
    );
  }
  const client = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Truncate every Better Auth table in `public` (the dedicated acceptance
 *  database — never a shared one) and delete the setup-owned app rows.
 *
 *  DESTRUCTIVE, and guarded twice: SUPABASE_DB_URL must be stated explicitly
 *  (no fallback, see DATABASE_URL above) AND the caller must opt in with
 *  E2E_SETUP_ALLOW_DB_RESET=1. The flag is deliberately NOT baked into the
 *  `test:e2e:setup` package script — an operator who runs the suite has to
 *  say, in the same breath, that this database is expendable. */
export async function resetFreshInstance(): Promise<void> {
  // The opt-in names the DATABASE, not just the intent. A bare "yes" flag
  // confirms the operation but not the target: DATABASE_URL can still resolve
  // out of a checkout's .env.local (which is exactly how the driven server
  // finds the same database), so the guard has to bind to the target's
  // identity. Naming it forces the operator to look at what they are wiping.
  // Empty FIRST: `new URL("")` throws a bare TypeError, which would replace
  // both actionable messages below with a URL parse error.
  if (!DATABASE_URL) {
    throw new Error(
      "SUPABASE_DB_URL is required for the setup-acceptance suite — point it at a DEDICATED database.",
    );
  }
  const target = new URL(DATABASE_URL).pathname.replace(/^\//, "");
  if (!target || process.env.E2E_SETUP_ALLOW_DB_RESET !== target) {
    throw new Error(
      "resetFreshInstance() truncates EVERY table in `public`. Point SUPABASE_DB_URL at a " +
        `dedicated acceptance database and set E2E_SETUP_ALLOW_DB_RESET to its NAME ` +
        `(here: "${target || "<none>"}") to confirm.`,
    );
  }
  await withClient(async (client) => {
    const tables = await client.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public'`,
    );
    if (tables.rows.length > 0) {
      const names = tables.rows.map((r) => `public."${r.tablename}"`).join(", ");
      await client.query(`truncate ${names} restart identity cascade`);
    }
    await client.query(
      `delete from ${APP_SCHEMA}.metadata where key = any($1::text[])`,
      [SETUP_METADATA_KEYS],
    );
    for (const table of [
      "anthropic_skill_sync",
      "anthropic_skill_reconcile_outbox",
      "anthropic_skill_lease",
      "skill_upload_consent",
    ]) {
      await client.query(`delete from ${APP_SCHEMA}.${table}`).catch(() => {
        /* table absent on this build — nothing to clear */
      });
    }
  });
}

export async function readMetadataValue(key: string): Promise<string | null> {
  return withClient(async (client) => {
    const res = await client.query<{ value: string }>(
      `select value from ${APP_SCHEMA}.metadata where key = $1`,
      [key],
    );
    return res.rows[0]?.value ?? null;
  });
}

export async function deleteMetadataKeys(keys: string[]): Promise<void> {
  await withClient(async (client) => {
    await client.query(`delete from ${APP_SCHEMA}.metadata where key = any($1::text[])`, [keys]);
  });
}

/** The S3 commitment record, parsed — null while absent or still a claim. */
export async function readCommitment(): Promise<Record<string, unknown> | null> {
  const raw = await readMetadataValue("setup_provider_commit");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed.state === "committed" ? parsed : null;
  } catch {
    return null;
  }
}

/** Seed a pending (or expired) CLAIM record — the concurrent-session fence /
 *  resume states of the S3 matrix.
 *
 *  UPSERTS deliberately: consecutive matrix arms re-seed a fresh claim over
 *  the previous arm's leftover record (a pending fence, then an expired one),
 *  so an insert-if-absent seed would silently leave the earlier state in
 *  place and prove the wrong thing. The machine's OWN insert-if-absent
 *  primitive is a separate contract, proven at the unit tier
 *  (src/lib/__tests__/setup-provider-commit.test.ts) — this helper is a state
 *  fixture, not a re-implementation of it. */
export async function seedClaim(options: { provider: string; expired?: boolean }): Promise<void> {
  const now = Date.now();
  const claim = {
    recordVersion: 1,
    state: "claimed",
    nonce: `e2e-seeded-${now}`,
    provider: options.provider,
    startingCredentialFingerprint: null,
    priorDefault: "openai",
    actorId: null,
    claimedAt: new Date(options.expired ? now - 20 * 60_000 : now).toISOString(),
    expiresAt: new Date(options.expired ? now - 10 * 60_000 : now + 10 * 60_000).toISOString(),
  };
  await withClient(async (client) => {
    await client.query(
      `insert into ${APP_SCHEMA}.metadata (key, value) values ($1, $2)
       on conflict (key) do update set value = excluded.value`,
      ["setup_provider_commit", JSON.stringify(claim)],
    );
  });
}

export async function countBetterAuthUsers(): Promise<number> {
  // HUMANS only — the bootstrap also mints assistant users (`userType`
  // 'assistant'), and the wizard's own zero-users check is humans-only.
  return withClient(async (client) => {
    const res = await client.query<{ n: string }>(
      `select count(*) as n from public."user" where "userType" = 'human'`,
    );
    return Number(res.rows[0]?.n ?? "0");
  });
}

/** Clear the Anthropic skill-sync map — reproduces the "first turn before the
 *  background sync caught up" state deterministically. */
export async function clearAnthropicSkillSync(): Promise<void> {
  await withClient(async (client) => {
    await client.query(`delete from ${APP_SCHEMA}.anthropic_skill_sync`);
  });
}

/** Environment prep, NOT flow bypass: the assistant runtime attaches the
 *  Cinatra self-MCP as a hosted tool and fail-closes without a configured
 *  public MCP base URL (normally written from the dev Tunnel tab or by the
 *  production ingress). The wizard under test does not own this row; the
 *  local suite seeds it to its own base URL, which the liveness probe accepts
 *  (any HTTP response counts) and the stubbed provider never actually relays. */
export async function seedMcpPublicBaseUrl(baseUrl: string): Promise<void> {
  await withClient(async (client) => {
    await client.query(
      `insert into ${APP_SCHEMA}.metadata (key, value) values ($1, $2)
       on conflict (key) do update set value = excluded.value`,
      [
        "connector_config:mcp_server",
        JSON.stringify({ publicBaseUrl: baseUrl, publicBaseUrlSource: "manual" }),
      ],
    );
  });
}

/** The DURABLE STATE a successful consented Anthropic key save leaves behind,
 *  seeded out of band — the S6-established precedent (see
 *  evidence/2093-s6-setup/drivers/seed-anthropic-connection.mjs): the
 *  connector's writer has Nango VERIFY the credential against the REAL
 *  Anthropic API from inside Nango's own container — outside the host-process
 *  boundary stub — so with no live Anthropic key available to a lane, the
 *  save arm is recorded NOT-DRIVEN and this seed writes the DB-fallback
 *  credential row plus the workspace upload opt-in the save would have
 *  recorded. Everything after it (the commit machine, the strict sync, the
 *  assistant turn) runs for real. */
export async function seedAnthropicStoredConnection(apiKey: string): Promise<void> {
  await withClient(async (client) => {
    const upsert = async (key: string, value: string) =>
      client.query(
        `insert into ${APP_SCHEMA}.metadata (key, value) values ($1, $2)
         on conflict (key) do update set value = excluded.value`,
        [key, value],
      );
    await upsert(
      "connector_config:anthropic_connection",
      JSON.stringify({ apiKey, lastValidatedAt: new Date().toISOString() }),
    );
    await upsert("connector_config:anthropic_skill_sync_enabled", "true");
  });
}

/** Compile + warm the self-MCP route BEFORE any assistant turn.
 *
 *  The assistant runtime probes the configured public MCP base URL and
 *  REFUSES to run a turn if it does not answer within 2.5 s (#1699 — running
 *  without Cinatra tools would be a silent capability regression). Under
 *  `next dev` the route is compiled lazily on first request, and that cold
 *  Turbopack compile is comfortably slower than the probe budget, so the very
 *  first turn of a run loses the race and the wizard's own behaviour is never
 *  exercised. This is a dev-server property, not a product one — a built
 *  server has the route ready — so the suite pays the compile up front
 *  instead of letting it masquerade as a product failure. Any HTTP response
 *  counts (the probe only checks liveness). */
export async function warmPublicMcpEndpoint(baseUrl: string): Promise<void> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/mcp`;
  for (let attempt = 0; attempt < 10; attempt++) {
    const started = Date.now();
    try {
      await fetch(url, { method: "GET", signal: AbortSignal.timeout(120_000) });
      // Warm once the route answers FAST — a slow answer means the compile
      // was still in flight and the runtime's 2.5 s probe would still fail.
      if (Date.now() - started < 2_000) return;
    } catch {
      /* not compiled yet — retry */
    }
  }
  throw new Error(`warmPublicMcpEndpoint: ${url} never answered within the probe budget`);
}

// --- boundary-stub control -------------------------------------------------

export function flipStubControl(patch: Record<string, unknown>): void {
  mkdirSync(STUB_DIR, { recursive: true });
  const controlPath = path.join(STUB_DIR, "control.json");
  const current = existsSync(controlPath)
    ? (JSON.parse(readFileSync(controlPath, "utf8")) as Record<string, unknown>)
    : {};
  // ATOMIC: the server process re-reads control.json on every intercepted
  // provider call. A plain writeFileSync truncates first, so a read landing
  // inside that window parses nothing, the stub falls back to `{}` and every
  // NEGATIVE arm (openaiKeyValid:false, probeAccept:false) silently answers
  // success. Write-then-rename within the same directory is atomic.
  const tmpPath = `${controlPath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify({ ...current, ...patch }, null, 2));
  renameSync(tmpPath, controlPath);
}

export type EgressEntry = {
  at: string;
  phase: string;
  provider: "openai" | "anthropic";
  method: string;
  path: string;
  outcome: string;
  containerSkillsRef?: { skill_id?: string; version?: string; type?: string } | null;
};

export function readEgressLedger(): EgressEntry[] {
  const ledgerPath = path.join(STUB_DIR, "egress.jsonl");
  if (!existsSync(ledgerPath)) return [];
  const raw = readFileSync(ledgerPath, "utf8");
  // Split, then drop ONLY the empty segment a terminal newline produces —
  // never `.filter(Boolean)`, which would also swallow interior blank lines
  // and let more than the one permitted torn line disappear from the ledger
  // the zero-egress measurement is read off.
  const lines = raw.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return [];
  // The stub APPENDS from the server process while the specs read, so a read
  // landing mid-append yields ONE torn line — always the last, and only when
  // the snapshot does not end in a newline. That single case is dropped; any
  // OTHER unparsable line is real corruption and MUST throw. Blanket
  // skip-on-error would let a malformed Anthropic record vanish and turn the
  // "zero Anthropic egress" measurement into a false pass.
  const torn = lines.length > 0 && !raw.endsWith("\n") ? lines.pop()! : null;
  if (torn !== null) {
    try {
      // A complete final line that merely lacked its newline is still data.
      return [...lines.map((l) => JSON.parse(l) as EgressEntry), JSON.parse(torn) as EgressEntry];
    } catch {
      /* genuinely torn — drop just this one */
    }
  }
  return lines.map((line, i) => {
    try {
      return JSON.parse(line) as EgressEntry;
    } catch (cause) {
      throw new Error(`readEgressLedger: corrupt ledger line ${i + 1} in ${ledgerPath}`, { cause });
    }
  });
}

// --- screenshots -----------------------------------------------------------

/** Design-spec content widths: Medium = 672px (the /setup onboarding column),
 *  Narrow = 576px (single-column forms). Captured as a desktop viewport that
 *  renders the column at its Medium max-width, and a narrow viewport that
 *  compresses it to the Narrow tier. */
export const SHOT_VIEWPORTS = {
  medium: { width: 1440, height: 1100 },
  narrow: { width: 600, height: 1100 },
} as const;

export const SHOTS_DIR =
  process.env.E2E_SETUP_SHOTS_DIR ??
  path.join(process.cwd(), "test-results", "setup-acceptance-shots");

/** Capture the current page state at BOTH acceptance widths. Restores the
 *  medium viewport afterwards so subsequent interactions see the desktop
 *  layout. */
export async function captureStateShots(page: Page, slug: string): Promise<void> {
  mkdirSync(SHOTS_DIR, { recursive: true });
  for (const [tier, viewport] of Object.entries(SHOT_VIEWPORTS)) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(400);
    await page.screenshot({
      path: path.join(SHOTS_DIR, `${slug}--${tier}.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize(SHOT_VIEWPORTS.medium);
}

/** The suite's base URL — mirrors the config's derivation so manually created
 *  contexts (shared serial-walk pages) navigate absolutely. */
export function suiteBaseUrl(): string {
  const port = Number(process.env.E2E_SETUP_PORT ?? 3104);
  return process.env.E2E_BASE_URL ?? `http://localhost:${port}`;
}

/** Fill that SURVIVES a dev-mode Fast Refresh rebuild: Turbopack lazily
 *  recompiles a route shortly after first paint and the RSC replacement wipes
 *  uncontrolled input state, silently discarding a fill that landed in the
 *  window. Re-fill until the value persists. */
export async function fillStable(
  locator: import("@playwright/test").Locator,
  value: string,
): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await locator.fill(value);
    await locator.page().waitForTimeout(800);
    if ((await locator.inputValue().catch(() => "")) === value) return;
  }
  throw new Error(`fillStable: value did not persist after 6 attempts`);
}

/** Check a (Radix) checkbox so the checked state survives the same rebuild
 *  window — see fillStable. */
export async function checkStable(
  locator: import("@playwright/test").Locator,
): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const state = await locator.getAttribute("aria-checked").catch(() => null);
    const checked =
      state === "true" || (await locator.isChecked().catch(() => false));
    if (checked) {
      await locator.page().waitForTimeout(800);
      const still =
        (await locator.getAttribute("aria-checked").catch(() => null)) === "true" ||
        (await locator.isChecked().catch(() => false));
      if (still) return;
    }
    await locator.click();
    await locator.page().waitForTimeout(400);
  }
  throw new Error(`checkStable: checked state did not persist after 6 attempts`);
}

/** Fill + submit a provider key form until the DURABLE saved-connection alert
 *  renders. A dev-mode rebuild can wipe the filled value in the window between
 *  the persistence check and the submit, so the whole fill→submit→verify
 *  cycle retries as a unit. */
export async function saveProviderKeyUntilStored(
  page: Page,
  formTestId: string,
  keySelector: string,
  value: string,
): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const form = page.getByTestId(formTestId);
    if (!(await form.isVisible().catch(() => false))) {
      // Either the save already landed on a previous attempt (the form hid
      // behind the Administration pointer) or the step simply has not
      // rendered yet. The DURABLE saved alert is what distinguishes them —
      // returning on the bare absence of the form would let this helper
      // succeed without ever storing a connection.
      await page
        .getByTestId("setup-connection-saved")
        .waitFor({ state: "visible", timeout: 15_000 });
      return;
    }
    await fillStable(form.locator(keySelector), value);
    await form.locator('button[type="submit"]').click();
    try {
      await page
        .getByTestId("setup-connection-saved")
        .waitFor({ state: "visible", timeout: 10_000 });
      return;
    } catch {
      /* wiped by a rebuild — retry the whole cycle */
    }
  }
  throw new Error(`saveProviderKeyUntilStored: no saved alert after 4 attempts`);
}

// --- the real sign-up form -------------------------------------------------

export type FirstAccount = { email: string; password: string; name: string; username: string };

export function uniqueFirstAccount(label: string): FirstAccount {
  const stamp = Date.now();
  return {
    email: `setup-acceptance-${label}-${stamp}@local.test`,
    password: "SetupAcceptance!2392",
    name: `Setup Acceptance ${label}`,
    // Better Auth's username validator rejects hyphens — keep it alphanumeric.
    username: `setupacc${label.replace(/[^a-z0-9]/gi, "")}${stamp}`.toLowerCase(),
  };
}

/** Drive the REAL /setup/account form (no API seeding, no session forgery).
 *  Caller must already be ON /setup/account. Resolves once the post-submit
 *  redirect leaves the account surface for the wizard proper. */
export async function signUpThroughSetupForm(page: Page, account: FirstAccount): Promise<void> {
  // Interacting before React hydration commits races the synthetic event
  // attachment and gets silently reset — gate on the form's own fiber keys.
  await waitForHydration(page, { selectors: ['input[type="email"]'] });
  // fillStable, not fill: this page is subject to the same Turbopack
  // rebuild-wipes-uncontrolled-input window every other step is (see
  // fillStable above). A wiped field here fails submit validation for a
  // reason that reads as an unrelated form bug.
  const nameInput = page.locator('input[name="name"]').first();
  if (await nameInput.count()) await fillStable(nameInput, account.name);
  const usernameInput = page.locator('input[name="username"]').first();
  if (await usernameInput.count()) await fillStable(usernameInput, account.username);
  await fillStable(page.locator('input[type="email"]').first(), account.email);
  const pwds = page.locator('input[type="password"]');
  const n = await pwds.count();
  for (let i = 0; i < n; i++) await fillStable(pwds.nth(i), account.password);
  await page.click('button[type="submit"]');
  // The post-success hop: /setup/account -> /setup -> the first incomplete
  // step. Wait for a WIZARD page that is not the account surface (a regex on
  // "/setup" alone would match the CURRENT url and wait for nothing).
  await page.waitForURL(
    (url) => url.pathname.startsWith("/setup") && url.pathname !== SETUP_ACCOUNT_PATH,
    { timeout: 90_000 },
  );
}

// --- the universal step rail (#2477, shipped in #2483) ---------------------

/** The four unconditional wizard steps, in rail order. The Connections step is
 *  conditional (Nango-dependent) and deliberately absent from the SESSIONLESS
 *  forecast rail — see src/app/setup/layout.tsx. */
export const UNIVERSAL_STEP_TITLES = ["Account", "Key", "Name", "Model"] as const;

/** The one CONDITIONAL step. It joins the live (authenticated) rail whenever
 *  Nango is not connected, and is deliberately absent from the sessionless
 *  forecast rail — whether it applies is itself a status read the sessionless
 *  branch must never perform (src/app/setup/layout.tsx). */
export const CONDITIONAL_STEP_TITLE = "Connections";

/** Assert the universal step rail: present on EVERY setup page (including the
 *  sessionless account page), carrying all four unconditional steps in order,
 *  with no label wrapping AND with every pill fully inside the rail.
 *
 *  `exact: true` additionally forbids the conditional Connections pill — the
 *  contract for the SESSIONLESS chrome specifically.
 *
 *  cinatra#2505 — the fit assertion below applies to EVERY rail this helper
 *  sees, so it covers the five-step AUTHENTICATED case (Connections present)
 *  that previously ran past the wizard column and clipped the trailing Model
 *  pill. It is a strictly ADDED constraint: the four-step sessionless rail
 *  satisfied it before this issue and still does (measured 446.72px of content
 *  in a 672px scrollport), so nothing the #2477/#2483 acceptance pinned is
 *  loosened here. No new viewport is introduced — this reads the rail at the
 *  Playwright project's configured desktop viewport, whatever that is. */
export async function expectUniversalStepRail(
  page: Page,
  options: { exact?: boolean } = {},
): Promise<void> {
  const rail = page.getByRole("navigation", { name: "Setup progress" });
  await expect(rail).toBeVisible();
  const pills = rail.locator("li");
  // Compared case-insensitively: the pill's `uppercase` class is presentation,
  // and allInnerTexts() reports the RENDERED casing.
  const titles = (await pills.allInnerTexts()).map((t) => t.trim().toLowerCase());
  const universal = UNIVERSAL_STEP_TITLES.map((t) => t.toLowerCase());
  if (options.exact) {
    expect(titles).toEqual(universal);
  } else {
    // All four unconditional steps, in order — a step that "retires" from the
    // rail was the #2477 finding. The ONLY tolerated variation is a SINGLE
    // Connections pill in its own position: between Name and Model, where
    // src/lib/setup-wizard.ts pushes it. A duplicate, or Connections anywhere
    // else, fails.
    const withConnections = [...universal];
    withConnections.splice(universal.indexOf("model"), 0, CONDITIONAL_STEP_TITLE.toLowerCase());
    expect([universal, withConnections]).toContainEqual(titles);
  }
  // NO-WRAP, read off the COMPUTED style rather than the box: every pill
  // already carries a fixed `h-8`, so a height check cannot tell a wrapped
  // label from an unwrapped one — it would pass either way.
  const whiteSpace = await pills
    .locator("> :last-child")
    .evaluateAll((els) => els.map((el) => getComputedStyle(el).whiteSpace));
  expect(whiteSpace).toHaveLength(titles.length);
  for (const ws of whiteSpace) expect(ws).toBe("nowrap");

  // FITS — cinatra#2505. Two independent reads, because either one alone can
  // pass on a broken rail:
  //   • the row must not overflow the nav's scrollport at all
  //     (scrollWidth > clientWidth is content the operator can only reach by
  //     scrolling a progress indicator, which is what #2505 reported); and
  //   • every pill's box must sit inside that scrollport. A rail that HAS been
  //     scrolled has scrollWidth > clientWidth too, but would hide a LEADING
  //     pill instead of the trailing one — the geometry check catches both
  //     ends, and catches a clip that arrives by any other route.
  const fit = await rail.evaluate((nav) => {
    const navBox = nav.getBoundingClientRect();
    return {
      overflowPx: nav.scrollWidth - nav.clientWidth,
      outside: Array.from(nav.querySelectorAll("li")).flatMap((li) => {
        const pill = li.lastElementChild;
        if (!pill) return [];
        const box = pill.getBoundingClientRect();
        // Half a pixel of tolerance: sub-pixel layout rounds either way and a
        // 0.2px difference is not a clipped pill.
        return box.left < navBox.left - 0.5 || box.right > navBox.right + 0.5
          ? [(pill.textContent ?? "").trim()]
          : [];
      }),
    };
  });
  expect(
    fit.outside,
    "every step pill must be fully visible inside the rail (cinatra#2505)",
  ).toEqual([]);
  expect(
    fit.overflowPx,
    "the step rail must not overflow the wizard column (cinatra#2505)",
  ).toBeLessThanOrEqual(0);
}

/** Assert a right-aligned Continue carrying the forward arrow — the shared
 *  affordance every setup step (including sign-up) now uses. */
export async function expectRightAlignedContinue(
  page: Page,
  submit: import("@playwright/test").Locator,
): Promise<void> {
  await expect(submit).toHaveText(/continue/i);
  // THE FORWARD ARROW specifically — `lucide-arrow-right` is the class
  // lucide-react stamps from the icon name, so a different glyph (or a
  // spinner) cannot satisfy this. And it must TRAIL the label.
  const arrow = submit.locator("svg.lucide-arrow-right");
  await expect(arrow).toHaveCount(1);
  const arrowTrails = await submit.evaluate((el) => {
    const svg = el.querySelector("svg.lucide-arrow-right");
    if (!svg) return false;
    // Any non-empty text of the button must come BEFORE the arrow in document
    // order (Node.DOCUMENT_POSITION_FOLLOWING === 4).
    const label = Array.from(el.childNodes).find(
      (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim().length > 0,
    );
    return label ? Boolean(label.compareDocumentPosition(svg) & 4) : false;
  });
  expect(arrowTrails, "the arrow must trail the Continue label").toBe(true);

  // RIGHT-ALIGNED, measured against the button's OWN containing block (the
  // step's `flex justify-end` / `grid` row), not the outer wizard column —
  // a button floating mid-column inside a wide parent would otherwise read as
  // "right enough".
  const geometry = await submit.evaluate((el) => {
    const parent = el.parentElement!;
    const b = el.getBoundingClientRect();
    const p = parent.getBoundingClientRect();
    return { rightGap: p.right - b.right, buttonWidth: b.width, parentWidth: p.width };
  });
  // Flush right within a few px of its row (padding/border tolerance only).
  // ABSOLUTE: a button overflowing past its row's right edge has a NEGATIVE
  // gap, which a one-sided upper bound would happily accept.
  expect(Math.abs(geometry.rightGap)).toBeLessThanOrEqual(4);
  // …and NOT full-width: a full-bleed button is also "flush right".
  expect(geometry.buttonWidth).toBeLessThan(geometry.parentWidth * 0.6);
}

/** Assert nothing ENCAPSULATES the step's content in a card. The #2477/#2483
 *  acceptance findings removed the white-background card around the Name
 *  step's fields and around the Key step's instruction blocks.
 *
 *  Checked as the owner stated it — "the card ENCAPSULATING the two text
 *  fields" — by walking each anchor's ANCESTOR chain up to <main>. A blanket
 *  document-wide token scan cannot express this: the rail's incomplete pill
 *  and the shared <Input> control legitimately carry `bg-surface-strong`
 *  themselves, and neither is a wrapper. The render-tier counterpart of
 *  src/app/setup/{name,key}/__tests__/page-card-removal.test.tsx, which can
 *  scan the whole markup only because it stubs those very components out. */
export async function expectNoCardChrome(page: Page, anchorSelectors: string[]): Promise<void> {
  // Every anchor must actually be on the page. Without this, a selector that
  // stops matching (a renamed id, a field that vanished) yields zero
  // iterations and the helper reports a vacuous pass.
  for (const selector of anchorSelectors) {
    await expect(page.locator(selector), `card-chrome anchor ${selector} must render`).not.toHaveCount(
      0,
    );
  }
  const offenders = await page.evaluate((selectors) => {
    // BOTH card signatures: the shared <Card> component
    // (src/components/ui/card.tsx — `data-slot="card"`, `rounded-xl bg-card`)
    // AND the hand-rolled section the setup steps used before #2477/#2483
    // (`rounded-card ... bg-surface-strong`). Matching only the hand-rolled
    // tokens would let a regression that wraps the fields in <Card> pass.
    const CARDY = /(^|\s)(rounded-card|bg-surface-strong|rounded-xl|bg-card)(\s|$)/;
    const CONTROL = new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON", "PRE", "CODE"]);
    const found: string[] = [];
    for (const selector of selectors) {
      for (const el of Array.from(document.querySelectorAll(selector))) {
        let node = el.parentElement;
        while (node && node.tagName !== "MAIN") {
          const cls = node.getAttribute("class") ?? "";
          const isCard = node.getAttribute("data-slot") === "card" || CARDY.test(cls);
          if (!CONTROL.has(node.tagName) && isCard) {
            found.push(`${selector} < ${node.tagName.toLowerCase()}.${cls.slice(0, 100)}`);
          }
          node = node.parentElement;
        }
      }
    }
    return found;
  }, anchorSelectors);
  expect(offenders, "no card may encapsulate the step content").toEqual([]);
}
