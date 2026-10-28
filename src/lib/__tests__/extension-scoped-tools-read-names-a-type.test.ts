/**
 * THE ARTIFACT READS CARRY THE TYPE A CALLER NAMES.
 *
 * A caller may name the object type it expects on the get and on the content
 * read (`objectType`). The read then refuses an artifact of any other type on
 * the same row read that picks the revision it reads
 * (extension-artifact-reads.integration.test.ts proves that half on a real
 * Postgres). This file holds the passthrough to its half: the dispatch hands
 * the named type to the read, and refuses a type field it cannot read rather
 * than dropping it, because a dropped field would read any admitted type.
 * The extension tool's `artifacts.contentRead` port goes through the same
 * mapping (`runArtifactRead`).
 *
 * The reads themselves are stubbed here; the run context and the admission are
 * fixtures, so nothing names a real extension or type.
 *
 *   pnpm exec vitest run src/lib/__tests__/extension-scoped-tools-read-names-a-type.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const contentRead = vi.fn();
const get = vi.fn();

vi.mock("@/lib/db/pooled", async () => ({
  ...(await vi.importActual<typeof import("@/lib/db/pooled")>("@/lib/db/pooled")),
  getPooledDb: () => ({ query: async () => ({ rows: [] }) }),
}));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://unused",
  postgresSchema: "cinatra",
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));
// The same import-time stubs as extension-scoped-tools-admit-a-bound-run.test.ts.
vi.mock("@cinatra-ai/registries", () => ({ getAgentPackage: async () => null }));
vi.mock("@cinatra-ai/agents/installed-oas-path", () => ({
  probeInstalledOasPathForRead: () => ({ path: null }),
}));
vi.mock("@/lib/verdaccio-config", () => ({ loadVerdaccioConfigForReads: async () => ({}) }));
vi.mock("@/lib/extension-run-package", () => ({
  resolveRunExtensionContext: async () => ({
    packageName: "@fixture-scope/fixture-reader",
    packageVersion: "1.0.0",
    cinatra: { dependencies: [] },
  }),
}));
vi.mock("@/lib/artifacts/extension-artifact-admission", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/artifacts/extension-artifact-admission")>()),
  resolveArtifactDependencyAdmission: () => ({ fixture: "admission" }),
}));
vi.mock("@/lib/artifacts/extension-artifact-reads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/artifacts/extension-artifact-reads")>()),
  extensionArtifactContentRead: (...a: unknown[]) => contentRead(...a),
  extensionArtifactGet: (...a: unknown[]) => get(...a),
}));

const RUN = {
  id: "run-1",
  orgId: "org-1",
  runBy: "user-1",
  templateId: "tmpl-1",
  packageVersion: "1.0.0",
};
const TYPE = "@fixture-scope/fixture-artifact:thing";

beforeEach(() => {
  contentRead.mockReset();
  get.mockReset();
  contentRead.mockResolvedValue({ text: "t", objectType: TYPE });
  get.mockResolvedValue({ artifactId: "a-1", objectType: TYPE });
});

afterEach(() => {
  vi.resetModules();
});

async function dispatch(tool: string, input: Record<string, unknown>) {
  const { dispatchExtensionScopedTool } = await import("@/lib/extension-scoped-tools");
  return dispatchExtensionScopedTool({ tool, input, run: RUN });
}

describe("the artifact reads carry the type a caller names", () => {
  it("hands the named type to the content read", async () => {
    const out = await dispatch("artifact_content_read", {
      artifactId: "a-1",
      representationRevisionId: "rev-1",
      objectType: TYPE,
    });
    expect(out.ok).toBe(true);
    expect(contentRead).toHaveBeenCalledTimes(1);
    expect(contentRead.mock.calls[0]?.[1]).toEqual({
      artifactId: "a-1",
      representationRevisionId: "rev-1",
      objectType: TYPE,
    });
  });

  it("hands the named type to the get", async () => {
    const out = await dispatch("artifacts_get", { artifactId: "a-1", objectType: TYPE });
    expect(out.ok).toBe(true);
    expect(get.mock.calls[0]?.[1]).toEqual({ artifactId: "a-1", objectType: TYPE });
  });

  it("names no type when the caller names none", async () => {
    await dispatch("artifact_content_read", { artifactId: "a-1" });
    expect(contentRead.mock.calls[0]?.[1]).toEqual({ artifactId: "a-1" });
  });

  for (const bad of [42, "", "   ", null, ["x"]]) {
    it(`refuses a type field it cannot read (${JSON.stringify(bad)}), and reads nothing`, async () => {
      const out = await dispatch("artifact_content_read", { artifactId: "a-1", objectType: bad });
      expect(out).toMatchObject({ ok: false, status: 403 });
      expect(contentRead).not.toHaveBeenCalled();
      const outGet = await dispatch("artifacts_get", { artifactId: "a-1", objectType: bad });
      expect(outGet).toMatchObject({ ok: false, status: 403 });
      expect(get).not.toHaveBeenCalled();
    });
  }
});
