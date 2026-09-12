/**
 * THE DISPATCH ADMITS A RUN OF A PACKAGE-BOUND TEMPLATE (cinatra#2960, #3035).
 *
 * The seam one layer above `resolveRunExtensionContext`: the passthrough hands
 * `dispatchExtensionScopedTool` the run row exactly as the creation primitives
 * wrote it — `package_version` empty on every road but the request-time one —
 * and the dispatch refused every packaged tool with "no one declaration to
 * admit this call under". These cases hold the dispatch to the run's TEMPLATE
 * binding instead, and hold the refusal in place for a template bound to no
 * package at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const getAgentPackage = vi.fn();

vi.mock("@/lib/db/pooled", () => ({
  getPooledDb: () => ({ query: (...a: unknown[]) => query(...a) }),
}));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://unused",
  postgresSchema: "cinatra",
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));
vi.mock("@cinatra-ai/registries", () => ({
  getAgentPackage: (...a: unknown[]) => getAgentPackage(...a),
}));
vi.mock("@/lib/verdaccio-config", () => ({ loadVerdaccioConfigForReads: async () => ({}) }));

/** The run row as the creation primitives write it: no package version of its own. */
const RUN = {
  id: "run-1",
  orgId: "org-1",
  runBy: "user-1",
  templateId: "tmpl-1",
  packageVersion: null,
};

const REFUSED_UNRESOLVED = /resolves to no extension package at a pinned version/;

describe("dispatchExtensionScopedTool — whose declaration admits the call", () => {
  beforeEach(() => {
    query.mockReset();
    getAgentPackage.mockReset();
    // A manifest that declares NO tables: the admission is proven by the call
    // reaching the extension-data tool's own refusal instead of the seam's.
    getAgentPackage.mockResolvedValue({ manifest: { cinatra: {} } });
  });

  it("admits a run whose OWN column is empty but whose template is package-bound", async () => {
    const { dispatchExtensionScopedTool } = await import("@/lib/extension-scoped-tools");
    query.mockResolvedValue({
      rows: [{ package_name: "@cinatra-ai/pipeline", package_version: "0.2.0" }],
    });
    const outcome = await dispatchExtensionScopedTool({
      tool: "extension_data",
      input: { table: "ext_pipeline_rows", operation: "select" },
      run: RUN,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).not.toMatch(REFUSED_UNRESOLVED);
    expect(outcome.error).toMatch(/declares no tables/);
    // The manifest was read AT the template's bound version, never floating.
    expect(getAgentPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        packageName: "@cinatra-ai/pipeline",
        packageVersion: "0.2.0",
      }),
      expect.anything(),
    );
  });

  it("still refuses a run whose template is bound to no package", async () => {
    const { dispatchExtensionScopedTool } = await import("@/lib/extension-scoped-tools");
    query.mockResolvedValue({ rows: [{ package_name: null, package_version: null }] });
    const outcome = await dispatchExtensionScopedTool({
      tool: "extension_data",
      input: { table: "ext_pipeline_rows", operation: "select" },
      run: RUN,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(403);
    expect(outcome.error).toMatch(REFUSED_UNRESOLVED);
    expect(getAgentPackage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// THE ALLOWLIST CARRIES NO PACK'S NAME (cinatra#3249, epic #3023).
//
// Acceptance item 2 in the issue's own words: "`EXTENSION_SCOPED_TOOLS` in
// `src/lib/extension-scoped-tools.ts` no longer carries an entry named after one
// pack's feature (the name the issue quotes, or equivalent); the passthrough
// instead
// admits a type- and table-agnostic `extension_data` operation".
// ---------------------------------------------------------------------------

describe("the names the passthrough admits", () => {
  /**
   * Assembled from fragments rather than written out, so this file is never
   * itself an occurrence of the name the border gate walks the tree for.
   */
  const PACK_NAMED_TOOL = ["blog", "pipeline", "ideas"].join("_");

  it("admits exactly the type- and table-agnostic names, and nothing besides", async () => {
    const { EXTENSION_SCOPED_TOOLS } = await import("@/lib/extension-scoped-tools");
    expect([...EXTENSION_SCOPED_TOOLS].sort()).toEqual([
      "artifact_content_read",
      "artifacts_get",
      "artifacts_list",
      "extension_data",
    ]);
  });

  it("no longer carries an entry named after one pack's own feature", async () => {
    const { EXTENSION_SCOPED_TOOLS } = await import("@/lib/extension-scoped-tools");
    expect(EXTENSION_SCOPED_TOOLS.has(PACK_NAMED_TOOL)).toBe(false);
  });
});
