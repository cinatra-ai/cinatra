/**
 * THE VERSION THE ADMISSION IS BOUND TO (cinatra#2960, cinatra#3035).
 *
 * A run of a package-bound template reached the W7 admission seam with an empty
 * `package_version` column and was refused its own package's tools: the seam
 * read the package NAME off the template row and the VERSION off the run row,
 * and only one of the two is written at creation. The pipeline agent then died
 * at its first packaged tool call with its own caller unresolved.
 *
 * The version is resolved here, from the same template row the name already
 * comes from, and NOT stamped onto the run: `agent_runs` encodes a REQUIRED
 * version pin as `version_id` AND `package_version` both set, so writing the
 * package version onto the roads that already pin `version_id` forges a
 * required pin that the snapshot table cannot serve and refuses the run before
 * its first step.
 *
 * UNPINNED IS UNRESOLVED still holds, and these cases say what it now means: a
 * version no stored binding names is refused, because a floating "whatever is
 * published now" read would let a republish widen a RUNNING flow's reach. A
 * template row that records the version this installation materialized the
 * template from is not that: it names ONE declaration.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();

vi.mock("@/lib/db/pooled", () => ({
  getPooledDb: () => ({ query: (...a: unknown[]) => query(...a) }),
}));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://unused",
  postgresSchema: "cinatra",
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));

const MANIFEST = {
  cinatra: { dependencies: [{ kind: "artifact", package: "@cinatra-ai/blog" }] },
};

/** The template row as a package install writes it: both halves of the binding. */
function boundTemplate(packageVersion: string | null) {
  return { rows: [{ package_name: "@cinatra-ai/pipeline", package_version: packageVersion }] };
}

describe("the run's package version, resolved at the admission seam", () => {
  beforeEach(() => query.mockReset());

  it("resolves through the TEMPLATE's own binding when the run row carries no pin", async () => {
    const { resolveRunExtensionContext } = await import("@/lib/extension-run-package");
    query.mockResolvedValue(boundTemplate("0.2.0"));
    const loadManifest = vi.fn().mockResolvedValue(MANIFEST);
    for (const runPin of [null, "", "   "]) {
      const ctx = await resolveRunExtensionContext(
        { templateId: "t1", packageVersion: runPin },
        { loadManifest },
      );
      expect(ctx?.packageName).toBe("@cinatra-ai/pipeline");
      expect(ctx?.packageVersion).toBe("0.2.0");
    }
    expect(loadManifest).toHaveBeenCalledWith({
      packageName: "@cinatra-ai/pipeline",
      packageVersion: "0.2.0",
    });
  });

  it("the RUN's own pin outranks the version the template row carries now", async () => {
    // The request-time road pins the version a peer asked for. A reinstall that
    // has since moved the template on must not move a running flow with it.
    const { resolveRunExtensionContext } = await import("@/lib/extension-run-package");
    query.mockResolvedValue(boundTemplate("2.0.0"));
    const loadManifest = vi.fn().mockResolvedValue(MANIFEST);
    const ctx = await resolveRunExtensionContext(
      { templateId: "t1", packageVersion: "1.2.3" },
      { loadManifest },
    );
    expect(ctx?.packageVersion).toBe("1.2.3");
    expect(loadManifest).toHaveBeenCalledWith({
      packageName: "@cinatra-ai/pipeline",
      packageVersion: "1.2.3",
    });
  });

  it("REFUSES when neither the run nor its template names a version", async () => {
    const { resolveRunExtensionContext } = await import("@/lib/extension-run-package");
    const loadManifest = vi.fn().mockResolvedValue(MANIFEST);
    for (const templatePin of [null, "", "   "]) {
      query.mockResolvedValue(boundTemplate(templatePin));
      expect(
        await resolveRunExtensionContext({ templateId: "t1", packageVersion: null }, { loadManifest }),
      ).toBeNull();
    }
    // And it never even asked the registry.
    expect(loadManifest).not.toHaveBeenCalled();
  });

  it("REFUSES a template that is bound to no package, however it is versioned", async () => {
    const { resolveRunExtensionContext } = await import("@/lib/extension-run-package");
    const loadManifest = vi.fn().mockResolvedValue(MANIFEST);
    query.mockResolvedValue({ rows: [{ package_name: null, package_version: "0.2.0" }] });
    expect(
      await resolveRunExtensionContext({ templateId: "t1", packageVersion: null }, { loadManifest }),
    ).toBeNull();
    expect(
      await resolveRunExtensionContext({ templateId: "t1", packageVersion: "0.2.0" }, { loadManifest }),
    ).toBeNull();
    expect(loadManifest).not.toHaveBeenCalled();
  });

  it("reads BOTH halves of the binding from ONE template row", async () => {
    const { resolveRunExtensionContext } = await import("@/lib/extension-run-package");
    query.mockResolvedValue(boundTemplate("0.2.0"));
    await resolveRunExtensionContext(
      { templateId: "t1", packageVersion: null },
      { loadManifest: vi.fn().mockResolvedValue(MANIFEST) },
    );
    expect(query).toHaveBeenCalledTimes(1);
    const sql = String(query.mock.calls[0]?.[0] ?? "");
    expect(sql).toMatch(/package_name/);
    expect(sql).toMatch(/package_version/);
  });
});
