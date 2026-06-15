// Step 4 (#260) — validity-checking CMS connector-cred reconcile.
//
// Verifies the reuse-first / probe-then-rotate discipline added to
// src/lib/dev-auto-setup.ts for the Drupal `mcp_tools_remote` Bearer and the
// WordPress application password, mirroring `ensureTwentyBearerAttached`:
//   - reuse on a valid probe (no mint, no rotate)
//   - rotate ONLY on a definite 401/403
//   - NEVER rotate on transient/unreachable (no key/app-password churn)
//   - Drupal readback-verify before write (a failed mint never overwrites)
//   - WordPress updates BOTH halves (connector metadata + Nango) and surfaces
//     a swallowed Nango-sync failure
//   - URL-keyed probe caches are invalidated on rotate
//
// SECRET BOUNDARY: assertions only ever check statuses/booleans/equality —
// never log a credential.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock every host dep + the docker exec surface. `server-only` is auto-stubbed
// by the root vitest alias.
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("@/lib/drupal-api", () => ({
  saveDrupalInstance: vi.fn(async () => ({ id: "drupal-1" })),
  listDrupalInstances: vi.fn(async () => []),
}));

vi.mock("@/lib/wordpress-api", () => ({
  saveWordPressInstance: vi.fn(async () => ({ id: "wp-1" })),
  listWordPressInstances: vi.fn(async () => []),
  readWordPressInstanceById: vi.fn(() => null),
}));

vi.mock("@/lib/drupal-mcp-connection", () => ({
  probeDrupalMcpWithBearer: vi.fn(),
  invalidateDrupalMcpProbeCache: vi.fn(),
}));

vi.mock("@/lib/wordpress-mcp-connection", () => ({
  invalidateWordPressMcpProbeCache: vi.fn(),
}));

vi.mock("@/lib/drupal-widget-auth", () => ({
  generateDrupalWidgetAuthConfig: vi.fn(() => ({ apiKey: "widget-uuid-aaaa" })),
  readDrupalWidgetAuthConfig: vi.fn(() => ({ apiKey: "widget-uuid-aaaa" })),
}));

vi.mock("@/lib/wordpress-widget-auth", () => ({
  generateWidgetAuthConfig: vi.fn(() => ({ apiKey: "wp-widget-uuid" })),
  readWidgetAuthConfig: vi.fn(() => ({ apiKey: "wp-widget-uuid" })),
}));

vi.mock("@/lib/nango-system", () => ({
  isNangoConfigured: vi.fn(() => true),
  ensureNangoIntegration: vi.fn(async () => null),
  importNangoConnection: vi.fn(async () => null),
  getNangoCredentials: vi.fn(),
  CINATRA_NANGO_PROVIDER_CONFIG_KEYS: { drupal: "cinatra-drupal", wordpress: "cinatra-wordpress" },
}));

// Heavy transitive deps pulled in by dev-auto-setup's connector-policy seed —
// stub to inert shapes so the module loads in the unit sandbox.
vi.mock("@cinatra-ai/connectors-catalog/descriptors.mjs", () => ({
  listConnectorDescriptors: vi.fn(() => []),
}));
vi.mock("@cinatra-ai/extensions/install-access-contract", () => ({
  setExtensionInstallAccess: vi.fn(async () => undefined),
}));
vi.mock("@cinatra-ai/extensions/lifecycle-primitive", () => ({
  installExtensionManifest: vi.fn(async () => ({ id: "x" })),
}));
vi.mock("@/lib/postgres-sync", () => ({ runPostgresQueriesSync: vi.fn(() => [{ rows: [] }]) }));
vi.mock("@/lib/database", () => ({
  getPostgresConnectionString: vi.fn(() => "postgres://stub"),
  postgresSchema: "cinatra",
}));
vi.mock("@/lib/external-mcp-registry", () => ({
  getExternalMcpServerById: vi.fn(() => null),
  upsertExternalMcpServer: vi.fn(),
  resolveExternalMcpServerBearer: vi.fn(async () => null),
  EXTERNAL_MCP_NANGO_PROVIDER_CONFIG_KEY: "external-mcp",
}));
vi.mock("@/lib/twenty-keygen.mjs", () => ({
  buildSeedDevArgs: vi.fn(() => []),
  buildGenerateApiKeyArgs: vi.fn(() => []),
  parseTwentyApiKey: vi.fn(() => null),
  probeTwentyBearer: vi.fn(async () => "unreachable"),
}));

import { spawnSync, execSync } from "node:child_process";
import { saveDrupalInstance } from "@/lib/drupal-api";
import { saveWordPressInstance, readWordPressInstanceById } from "@/lib/wordpress-api";
import {
  probeDrupalMcpWithBearer,
  invalidateDrupalMcpProbeCache,
} from "@/lib/drupal-mcp-connection";
import { invalidateWordPressMcpProbeCache } from "@/lib/wordpress-mcp-connection";
import { getNangoCredentials } from "@/lib/nango-system";

import {
  parseDrupalRemoteKey,
  trimTrailingSlashes,
  ensureDrupalRemoteKeyReconciled,
  ensureWordPressAppPasswordReconciled,
} from "@/lib/dev-auto-setup";

const WIDGET_UUID = "widget-uuid-aaaa";
const STORED_BEARER = "stored-remote-key-0123456789abcdef";
const FRESH_BEARER = "fresh-remote-key-fedcba9876543210xyz";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ===========================================================================
// parseDrupalRemoteKey — ReDoS-safe porcelain extraction
// ===========================================================================

describe("parseDrupalRemoteKey", () => {
  it("returns the trailing token line", () => {
    expect(parseDrupalRemoteKey(`some log\n${FRESH_BEARER}`)).toBe(FRESH_BEARER);
  });

  it("returns the token when it is the only line", () => {
    expect(parseDrupalRemoteKey(FRESH_BEARER)).toBe(FRESH_BEARER);
  });

  it("rejects a trailing human log line (no clean token)", () => {
    expect(parseDrupalRemoteKey(`${FRESH_BEARER}\n[notice] key created.`)).toBeNull();
  });

  it("rejects a token shorter than 16 chars", () => {
    expect(parseDrupalRemoteKey("short")).toBeNull();
  });

  it("rejects empty / whitespace-only output", () => {
    expect(parseDrupalRemoteKey("\n   \n")).toBeNull();
  });

  it("does not catastrophically backtrack on a long non-token line (ReDoS guard)", () => {
    const evil = `${"a".repeat(50_000)} !`; // contains a space → not a single token
    const start = Date.now();
    expect(parseDrupalRemoteKey(evil)).toBeNull();
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

// ===========================================================================
// trimTrailingSlashes — linear (ReDoS-safe) replacement for /\/+$/
// ===========================================================================

describe("trimTrailingSlashes", () => {
  it("strips a single trailing slash", () => {
    expect(trimTrailingSlashes("http://localhost:8080/")).toBe("http://localhost:8080");
  });
  it("strips many trailing slashes", () => {
    expect(trimTrailingSlashes("http://h////")).toBe("http://h");
  });
  it("leaves a slash-free string unchanged", () => {
    expect(trimTrailingSlashes("http://h")).toBe("http://h");
  });
  it("does NOT catastrophically backtrack on many trailing slashes (linear; the /\\/+$/ ReDoS guard)", () => {
    const evil = `http://h${"/".repeat(200_000)}`;
    const start = Date.now();
    expect(trimTrailingSlashes(evil)).toBe("http://h");
    expect(Date.now() - start).toBeLessThan(200); // linear → fast even at 200k
  });
});

// ===========================================================================
// Drupal reconcile
// ===========================================================================

const drupalInput = {
  instanceId: "drupal-1",
  instanceName: "Local Drupal",
  siteUrl: "http://localhost:8082",
  widgetApiKey: WIDGET_UUID,
};

describe("ensureDrupalRemoteKeyReconciled", () => {
  it("REUSE on a valid probe — no mint, no rotate, no cache eviction", async () => {
    vi.mocked(getNangoCredentials).mockResolvedValueOnce({ apiKey: STORED_BEARER } as never);
    vi.mocked(probeDrupalMcpWithBearer).mockResolvedValueOnce("registered");

    const r = await ensureDrupalRemoteKeyReconciled(drupalInput);

    expect(r).toMatchObject({ working: true, rotated: false });
    expect(spawnSync).not.toHaveBeenCalled(); // no drush mint
    expect(saveDrupalInstance).not.toHaveBeenCalled();
    expect(invalidateDrupalMcpProbeCache).not.toHaveBeenCalled();
  });

  it("ROTATE only on a definite 401/403 (auth_error) — mints + re-imports + evicts cache", async () => {
    vi.mocked(getNangoCredentials).mockResolvedValueOnce({ apiKey: STORED_BEARER } as never);
    vi.mocked(probeDrupalMcpWithBearer).mockResolvedValueOnce("auth_error");
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 0, stdout: FRESH_BEARER, stderr: "" } as never);

    const r = await ensureDrupalRemoteKeyReconciled(drupalInput);

    expect(r).toMatchObject({ working: true, rotated: true });
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(saveDrupalInstance).toHaveBeenCalledWith(
      expect.objectContaining({ id: "drupal-1", mcpApiKey: FRESH_BEARER }),
    );
    expect(invalidateDrupalMcpProbeCache).toHaveBeenCalledWith(drupalInput.siteUrl);
  });

  it("ROTATE on legacy split-brain (stored value === widget UUID) without even probing", async () => {
    vi.mocked(getNangoCredentials).mockResolvedValueOnce({ apiKey: WIDGET_UUID } as never);
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 0, stdout: FRESH_BEARER, stderr: "" } as never);

    const r = await ensureDrupalRemoteKeyReconciled(drupalInput);

    expect(r).toMatchObject({ working: true, rotated: true });
    expect(probeDrupalMcpWithBearer).not.toHaveBeenCalled(); // short-circuits to rotate
    expect(saveDrupalInstance).toHaveBeenCalledWith(
      expect.objectContaining({ mcpApiKey: FRESH_BEARER }),
    );
  });

  it("NO rotate on unreachable (transient) — keeps existing, no mint", async () => {
    vi.mocked(getNangoCredentials).mockResolvedValueOnce({ apiKey: STORED_BEARER } as never);
    vi.mocked(probeDrupalMcpWithBearer).mockResolvedValueOnce("unreachable");

    const r = await ensureDrupalRemoteKeyReconciled(drupalInput);

    expect(r).toMatchObject({ working: false, rotated: false });
    expect(spawnSync).not.toHaveBeenCalled();
    expect(saveDrupalInstance).not.toHaveBeenCalled();
    expect(invalidateDrupalMcpProbeCache).not.toHaveBeenCalled();
  });

  it("NO rotate on 404 not_installed (transient/non-auth)", async () => {
    vi.mocked(getNangoCredentials).mockResolvedValueOnce({ apiKey: STORED_BEARER } as never);
    vi.mocked(probeDrupalMcpWithBearer).mockResolvedValueOnce("not_installed");

    const r = await ensureDrupalRemoteKeyReconciled(drupalInput);

    expect(r.rotated).toBe(false);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("NO mint on an unresolved Nango read (transient) — never mints a duplicate", async () => {
    vi.mocked(getNangoCredentials).mockResolvedValueOnce(null as never);

    const r = await ensureDrupalRemoteKeyReconciled(drupalInput);

    expect(r).toMatchObject({ working: false, rotated: false });
    expect(spawnSync).not.toHaveBeenCalled();
    expect(probeDrupalMcpWithBearer).not.toHaveBeenCalled();
  });

  it("a FAILED mint never overwrites the working key (no re-import, no rotate)", async () => {
    vi.mocked(getNangoCredentials).mockResolvedValueOnce({ apiKey: STORED_BEARER } as never);
    vi.mocked(probeDrupalMcpWithBearer).mockResolvedValueOnce("auth_error");
    // drush returns a human log line, not a clean token → parseDrupalRemoteKey → null
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 0, stdout: "[error] could not create", stderr: "" } as never);

    const r = await ensureDrupalRemoteKeyReconciled(drupalInput);

    expect(r).toMatchObject({ working: false, rotated: false });
    expect(saveDrupalInstance).not.toHaveBeenCalled(); // never re-imports a bad key
    expect(invalidateDrupalMcpProbeCache).not.toHaveBeenCalled();
  });

  it("readback-verify: a saveDrupalInstance throw (readback mismatch) surfaces as not-working WITHOUT leaking the error text (secret boundary)", async () => {
    vi.mocked(getNangoCredentials).mockResolvedValueOnce({ apiKey: STORED_BEARER } as never);
    vi.mocked(probeDrupalMcpWithBearer).mockResolvedValueOnce("auth_error");
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 0, stdout: FRESH_BEARER, stderr: "" } as never);
    vi.mocked(saveDrupalInstance).mockRejectedValueOnce(
      // A lower-layer error message that could in principle carry sensitive text.
      new Error(`SENSITIVE-LEAK-${STORED_BEARER}`),
    );

    const r = await ensureDrupalRemoteKeyReconciled(drupalInput);

    expect(r).toMatchObject({ working: false, rotated: false });
    // The surfaced note is a FIXED host-owned label — the raw error text never escapes.
    expect(r.note).toMatch(/^re-import-failed/);
    expect(r.note).not.toContain("SENSITIVE-LEAK");
    expect(r.note).not.toContain(STORED_BEARER);
    expect(invalidateDrupalMcpProbeCache).not.toHaveBeenCalled();
  });

  it("a non-zero drush exit yields no key → no rotate", async () => {
    vi.mocked(getNangoCredentials).mockResolvedValueOnce({ apiKey: STORED_BEARER } as never);
    vi.mocked(probeDrupalMcpWithBearer).mockResolvedValueOnce("auth_error");
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 1, stdout: FRESH_BEARER, stderr: "boom" } as never);

    const r = await ensureDrupalRemoteKeyReconciled(drupalInput);

    expect(r.rotated).toBe(false);
    expect(saveDrupalInstance).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// WordPress reconcile
// ===========================================================================

const wpInput = {
  instanceId: "wp-1",
  siteUrl: "http://localhost:8080",
  username: "admin",
  providerConfigKey: "cinatra-wordpress",
  connectionId: "wp-1",
};

const FRESH_APP_PW = "abcd EFGH ijkl MNOP";

function stubFetchStatus(status: number) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ status } as Response)));
}

describe("ensureWordPressAppPasswordReconciled", () => {
  it("REUSE on a 200 probe — no mint, no rotate, no cache eviction", async () => {
    vi.mocked(getNangoCredentials).mockResolvedValueOnce({ username: "admin", password: "good-pw" } as never);
    stubFetchStatus(200);

    const r = await ensureWordPressAppPasswordReconciled(wpInput);

    expect(r).toMatchObject({ working: true, rotated: false });
    expect(execSync).not.toHaveBeenCalled(); // no wp-cli mint
    expect(saveWordPressInstance).not.toHaveBeenCalled();
    expect(invalidateWordPressMcpProbeCache).not.toHaveBeenCalled();
  });

  it("ROTATE only on a definite 401 — mints, re-saves, BOTH halves verified, evicts cache", async () => {
    vi.mocked(getNangoCredentials)
      .mockResolvedValueOnce({ username: "admin", password: "stale-pw" } as never) // pre-probe resolve
      .mockResolvedValueOnce({ username: "admin", password: FRESH_APP_PW } as never); // post-save both-halves readback
    stubFetchStatus(401);
    vi.mocked(execSync).mockReturnValueOnce(Buffer.from(`${FRESH_APP_PW}\n`) as never);

    const r = await ensureWordPressAppPasswordReconciled(wpInput);

    expect(r).toMatchObject({ working: true, rotated: true });
    expect(saveWordPressInstance).toHaveBeenCalledWith(
      expect.objectContaining({ id: "wp-1", username: "admin", applicationPassword: FRESH_APP_PW }),
    );
    expect(invalidateWordPressMcpProbeCache).toHaveBeenCalledWith(wpInput.siteUrl);
  });

  it("ROTATE on 403 (also a definite auth failure)", async () => {
    vi.mocked(getNangoCredentials)
      .mockResolvedValueOnce({ username: "admin", password: "stale-pw" } as never)
      .mockResolvedValueOnce({ username: "admin", password: FRESH_APP_PW } as never);
    stubFetchStatus(403);
    vi.mocked(execSync).mockReturnValueOnce(Buffer.from(FRESH_APP_PW) as never);

    const r = await ensureWordPressAppPasswordReconciled(wpInput);

    expect(r.rotated).toBe(true);
  });

  it("NO rotate on a 5xx (unreachable/transient) — kept-but-UNCONFIRMED (note set), no mint, no churn", async () => {
    vi.mocked(getNangoCredentials).mockResolvedValueOnce({ username: "admin", password: "good-pw" } as never);
    stubFetchStatus(503);

    const r = await ensureWordPressAppPasswordReconciled(wpInput);

    // working stays true (avoids a false 401 hint + churn) but a note marks it
    // unconfirmed — the caller must NOT label this "valid".
    expect(r).toMatchObject({ working: true, rotated: false });
    expect(r.note).toMatch(/probe-unreachable/);
    expect(execSync).not.toHaveBeenCalled();
    expect(saveWordPressInstance).not.toHaveBeenCalled();
    expect(invalidateWordPressMcpProbeCache).not.toHaveBeenCalled();
  });

  it("NO rotate on a network error (fetch throws) — treated as unreachable", async () => {
    vi.mocked(getNangoCredentials).mockResolvedValueOnce({ username: "admin", password: "good-pw" } as never);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));

    const r = await ensureWordPressAppPasswordReconciled(wpInput);

    expect(r.rotated).toBe(false);
    expect(execSync).not.toHaveBeenCalled();
  });

  it("NO mint on an unresolved Nango read with NO local credential to repair from (transient) — never litters the app-password list", async () => {
    vi.mocked(getNangoCredentials).mockResolvedValueOnce(null as never);
    // default readWordPressInstanceById → null (no local pw)

    const r = await ensureWordPressAppPasswordReconciled(wpInput);

    expect(r).toMatchObject({ working: false, rotated: false });
    expect(r.note).toMatch(/credential-unresolved \(kept/);
    expect(execSync).not.toHaveBeenCalled();
    expect(saveWordPressInstance).not.toHaveBeenCalled();
  });

  it("UNRESOLVED Nango but LOCAL has a usable pw — self-heal: re-sync from local, NO mint", async () => {
    // Nango connection went fully missing; local connector-metadata still has the pw.
    vi.mocked(readWordPressInstanceById).mockReturnValueOnce({
      id: "wp-1",
      username: "admin",
      applicationPassword: FRESH_APP_PW,
    } as never);
    vi.mocked(getNangoCredentials)
      .mockResolvedValueOnce(null as never) // pre-probe resolve → unresolved
      .mockResolvedValueOnce({ username: "admin", password: FRESH_APP_PW } as never); // post re-sync → now present

    const r = await ensureWordPressAppPasswordReconciled(wpInput);

    expect(r).toMatchObject({ working: true, rotated: false });
    expect(r.note).toMatch(/nango-resynced-from-local \(was unresolved/);
    expect(execSync).not.toHaveBeenCalled(); // no mint
    expect(saveWordPressInstance).toHaveBeenCalledWith(
      expect.objectContaining({ applicationPassword: FRESH_APP_PW }),
    );
    expect(invalidateWordPressMcpProbeCache).toHaveBeenCalledWith(wpInput.siteUrl);
  });

  it("BOTH-HALVES: a swallowed Nango-sync failure (readback mismatch) surfaces as not-working", async () => {
    // No local pw divergence (readWordPressInstanceById → null) → mint path.
    vi.mocked(getNangoCredentials)
      .mockResolvedValueOnce({ username: "admin", password: "stale-pw" } as never) // pre-probe
      .mockResolvedValueOnce({ username: "admin", password: "stale-pw" } as never); // post-save STILL stale → Nango didn't sync
    stubFetchStatus(401);
    vi.mocked(execSync).mockReturnValueOnce(Buffer.from(FRESH_APP_PW) as never);

    const r = await ensureWordPressAppPasswordReconciled(wpInput);

    expect(r).toMatchObject({ working: false, rotated: false });
    expect(r.note).toMatch(/nango-sync-failed/);
    expect(invalidateWordPressMcpProbeCache).not.toHaveBeenCalled(); // not a verified rotate
  });

  it("CHURN GUARD: when LOCAL holds a fresh pw but Nango is stale (prior rotate's sync failed), RE-SYNC from local — NO new mint", async () => {
    // local connector-metadata already carries the fresh password; Nango is behind.
    vi.mocked(readWordPressInstanceById).mockReturnValueOnce({
      id: "wp-1",
      username: "admin",
      applicationPassword: FRESH_APP_PW,
    } as never);
    vi.mocked(getNangoCredentials)
      .mockResolvedValueOnce({ username: "admin", password: "stale-pw" } as never) // pre-probe → stale → 401
      .mockResolvedValueOnce({ username: "admin", password: FRESH_APP_PW } as never); // post re-sync → Nango now matches local
    stubFetchStatus(401);

    const r = await ensureWordPressAppPasswordReconciled(wpInput);

    expect(r).toMatchObject({ working: true, rotated: false });
    expect(r.note).toMatch(/nango-resynced-from-local/);
    expect(execSync).not.toHaveBeenCalled(); // CRUCIAL: no new app-password minted (no churn)
    expect(saveWordPressInstance).toHaveBeenCalledWith(
      expect.objectContaining({ applicationPassword: FRESH_APP_PW }), // re-pushes the EXISTING local pw
    );
    expect(invalidateWordPressMcpProbeCache).toHaveBeenCalledWith(wpInput.siteUrl);
  });

  it("a FAILED mint (wp-cli Error) never overwrites — no re-save", async () => {
    vi.mocked(getNangoCredentials).mockResolvedValueOnce({ username: "admin", password: "stale-pw" } as never);
    stubFetchStatus(401);
    vi.mocked(execSync).mockReturnValueOnce(Buffer.from("Error: could not create application password") as never);

    const r = await ensureWordPressAppPasswordReconciled(wpInput);

    expect(r).toMatchObject({ working: false, rotated: false });
    expect(r.note).toMatch(/mint-failed/);
    expect(saveWordPressInstance).not.toHaveBeenCalled();
  });

  it("a saveWordPressInstance throw surfaces a FIXED label — no remote response-body text leaks (secret boundary)", async () => {
    vi.mocked(getNangoCredentials).mockResolvedValueOnce({ username: "admin", password: "stale-pw" } as never);
    stubFetchStatus(401);
    vi.mocked(execSync).mockReturnValueOnce(Buffer.from(FRESH_APP_PW) as never);
    vi.mocked(saveWordPressInstance).mockRejectedValueOnce(new Error(`WP-BODY-LEAK-${FRESH_APP_PW}`));

    const r = await ensureWordPressAppPasswordReconciled(wpInput);

    expect(r).toMatchObject({ working: false, rotated: false });
    expect(r.note).toBe("re-save-failed"); // fixed host-owned label only
    expect(r.note).not.toContain("WP-BODY-LEAK");
    expect(r.note).not.toContain(FRESH_APP_PW);
  });
});
