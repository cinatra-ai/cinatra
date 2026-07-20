/**
 * Regression: run-completion artifact materialization must thread an explicit
 * VerdaccioConfig into getAgentPackage (cinatra#1454).
 *
 * The #1454 live walk proved that loadRunPackageBindings (run-artifact-
 * materializer.ts) and resolveProducerAssertionPlan (producer-assertions.ts)
 * called getAgentPackage WITHOUT the required VerdaccioConfig, so the
 * fail-fast ensureConfig() guard in packages/registries threw before any
 * registry I/O — materialization + producer assertions failed CLOSED.
 *
 * This test drives BOTH functions through their REAL exported entry points and
 * mocks ONLY the network/registry fetch boundary (pacote). The config plumbing
 * (loadVerdaccioConfigForReads → ensureConfig) runs FOR REAL: getAgentPackage
 * enforces the genuine ensureConfig guard, and VerdaccioConfig is loaded
 * through the real host read wrapper (no consumer attachment in the sandbox →
 * it falls through to the vendor loader's env-override branch). If a call site
 * drops the
 * config, the REAL ensureConfig throws "config parameter required" and the
 * assertions below fail — exactly the defect the walk observed.
 *
 *   npx vitest run src/lib/artifacts/__tests__/materializer-config-threading.regression.test.ts
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const PKG_MANIFEST = {
  name: "@acme/demo-agent",
  version: "1.0.0",
  cinatra: { kind: "agent" },
};

// pacote is the registries client's process-level network client. Neither
// module under test loads it directly, but the REAL modules we importActual
// below (verdaccio client + config) `import * as pacote`, so stub it to keep
// the heavy native chain — and any accidental network — out of the sandbox.
vi.mock("pacote", () => ({
  packument: vi.fn(),
  extract: vi.fn(),
  tarball: vi.fn(),
}));

// Route the module-under-test's dynamic import("@cinatra-ai/registries") past
// the root vitest stub (which omits getAgentPackage) to a faithful surface:
//   - getAgentPackage runs the REAL ensureConfig fail-fast DI guard (the exact
//     contract cinatra#1454 violated), then returns a synthetic package. That
//     synthetic return IS the network/registry fetch boundary being mocked — a
//     dropped config still throws through the genuine guard, exactly as in prod.
//   - loadVerdaccioConfigAsync is the REAL config plumbing the host wrapper
//     (@/lib/verdaccio-config) calls — NOT the fetch boundary, so it stays
//     genuine (its env-override branch builds a VerdaccioConfig, no DB/crypto).
vi.mock("@cinatra-ai/registries", async () => {
  const client = await vi.importActual<
    typeof import("../../../../packages/registries/src/verdaccio/client")
  >("../../../../packages/registries/src/verdaccio/client");
  const config = await vi.importActual<
    typeof import("../../../../packages/registries/src/verdaccio/config")
  >("../../../../packages/registries/src/verdaccio/config");
  return {
    loadVerdaccioConfigAsync: config.loadVerdaccioConfigAsync,
    getAgentPackage: vi.fn(
      async (
        _input: { packageName: string; packageVersion?: string },
        cfg?: unknown,
      ) => {
        // REAL guard — throws "config parameter required" when the caller
        // dropped the config, precisely as the packages/registries client does.
        client.ensureConfig(cfg as never, "getAgentPackage");
        return {
          manifest: PKG_MANIFEST,
          payload: null,
          readme: null,
          distTags: { latest: "1.0.0" },
          availableVersions: [],
        };
      },
    ),
  };
});

// The declared-produces reader is a pure manifest parser — a package with no
// declared produces yields [], which drives the "no bindings" early return in
// both call sites. Kept as a trivial stub so the test does not depend on the
// extensions barrel.
vi.mock("@cinatra-ai/extensions/agent-produces-reader", () => ({
  // Declare ONE produced extension. In producer-assertions this is the
  // discriminator: a config-required throw is swallowed to `produces: []`, so
  // only a COMPLETED registry read surfaces this declared id.
  readAgentProducesFromPackageManifest: () => [{ extension: "demo-artifact" }],
}));

// ---------------------------------------------------------------------------
// DB seams — pre-getAgentPackage plumbing the two entries traverse. Mocked so
// the test reaches the registry read deterministically. NOT the config
// plumbing under test.
// ---------------------------------------------------------------------------
const { poolQueryMock, runPostgresQueriesSyncMock } = vi.hoisted(() => ({
  poolQueryMock: vi.fn(),
  runPostgresQueriesSyncMock: vi.fn(),
}));

// run-artifact-materializer DB seams
vi.mock("@/lib/db/pooled", () => ({
  getPooledDb: () => ({ query: poolQueryMock }),
}));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "public",
}));
vi.mock("@/lib/postgres-schema-init", () => ({
  ensurePostgresSchema: vi.fn(),
}));
vi.mock("@/lib/register-all-object-types", () => ({
  registerAllObjectTypes: vi.fn(),
}));

// producer-assertions DB seams
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: runPostgresQueriesSyncMock,
}));
vi.mock("@/lib/database", () => ({
  getPostgresConnectionString: () => "postgres://test",
  ensurePostgresSchema: () => {},
  postgresSchema: "public",
  // loadVerdaccioConfigForReads → readInstanceIdentity reads this metadata
  // (a DB infra boundary, NOT config logic). Return the fallback so no identity
  // row exists → the REAL read wrapper falls through to the vendor loader's
  // env-override branch below, exercising the genuine config plumbing.
  readMetadataValueFromDatabase: <T,>(_key: string, fallback: T): T => fallback,
}));
vi.mock("../artifact-extension-access", () => ({
  isArtifactExtensionWriteAllowed: vi.fn(async () => true),
}));

import { materializeRunArtifacts } from "../run-artifact-materializer";
import { resolveProducerAssertionPlan } from "../producer-assertions";

// Drive the REAL loadVerdaccioConfigForReads (→ vendor env-override branch) so
// the config plumbing produces a genuine VerdaccioConfig with no DB/crypto.
const PRIOR_ENV = {
  url: process.env.CINATRA_AGENT_REGISTRY_URL,
  token: process.env.CINATRA_AGENT_REGISTRY_TOKEN,
};

describe("cinatra#1454 — materializer threads VerdaccioConfig into getAgentPackage", () => {
  beforeEach(() => {
    process.env.CINATRA_AGENT_REGISTRY_URL = "http://127.0.0.1:4873";
    process.env.CINATRA_AGENT_REGISTRY_TOKEN = "test-token";
    poolQueryMock.mockReset();
    runPostgresQueriesSyncMock.mockReset();
  });

  afterAll(() => {
    if (PRIOR_ENV.url === undefined) delete process.env.CINATRA_AGENT_REGISTRY_URL;
    else process.env.CINATRA_AGENT_REGISTRY_URL = PRIOR_ENV.url;
    if (PRIOR_ENV.token === undefined) delete process.env.CINATRA_AGENT_REGISTRY_TOKEN;
    else process.env.CINATRA_AGENT_REGISTRY_TOKEN = PRIOR_ENV.token;
  });

  it("materializeRunArtifacts resolves the run package bindings without a config-required throw", async () => {
    // resolveTemplatePackageName → package_name row.
    poolQueryMock.mockResolvedValueOnce({
      rows: [{ package_name: "@acme/demo-agent" }],
    });

    const outcomes = await materializeRunArtifacts({
      runId: "run-1",
      orgId: "org-a",
      templateId: "tpl-1",
      packageVersion: "1.0.0",
      createdBy: "user-1",
      endNodeOutputs: {},
    });

    // On the UNFIXED code getAgentPackage was called without config, so the
    // real ensureConfig threw and the wholesale catch produced a synthetic
    // "(binding-resolution)" failure whose error carries "config parameter
    // required". With config threaded the package has no bindings → clean [].
    const configThrow = outcomes.find((o) =>
      !o.ok && /config parameter required/i.test(o.error),
    );
    expect(configThrow, JSON.stringify(outcomes)).toBeUndefined();
    expect(outcomes).toEqual([]);
  });

  it("resolveProducerAssertionPlan reads the pinned manifest without a config-required throw", async () => {
    // 1) agent_runs row (same-org). 2) agent_templates row (package_name).
    runPostgresQueriesSyncMock
      .mockReturnValueOnce([
        {
          rows: [
            { org_id: "org-a", package_version: "1.0.0", template_id: "tpl-1" },
          ],
        },
      ])
      .mockReturnValueOnce([
        { rows: [{ package_name: "@acme/demo-agent" }] },
      ]);

    // Must not throw (a config-required throw here would be uncaught inside the
    // try and degrade to empty produces while the run id still validated).
    const plan = await resolveProducerAssertionPlan({
      createdByRunId: "run-1",
      orgId: "org-a",
    });

    // The run validated AND the pinned manifest read COMPLETED: the declared
    // produced extension surfaces. On the UNFIXED code the config-required
    // throw is swallowed to `produces: []` (validatedRunId still set), so this
    // exact-equality assertion is what fails closed.
    expect(plan.validatedRunId).toBe("run-1");
    expect(plan.produces).toEqual(["demo-artifact"]);
  });
});
