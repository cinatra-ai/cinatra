/**
 * WHO THE CALLER IS, AND AT WHICH DECLARATION (cinatra#3031, epic #3023 W7).
 *
 * Enabler 0.26: the artifact reads are admitted "only for types the calling
 * extension declares as artifact dependencies — an admission bound to the
 * declaration and the version"; 0.25 derives the extension-data caller "from
 * the run's extension identity". Both need ONE declaration at ONE version, so
 * a run that is not pinned has no declaration to be admitted by.
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

describe("resolving the run's extension identity", () => {
  beforeEach(() => query.mockReset());

  it("resolves the package on the run's template at the run's PINNED version", async () => {
    const { resolveRunExtensionContext } = await import("@/lib/extension-run-package");
    query.mockResolvedValue({ rows: [{ package_name: "@cinatra-ai/pipeline" }] });
    const loadManifest = vi.fn().mockResolvedValue(MANIFEST);
    const ctx = await resolveRunExtensionContext(
      { templateId: "t1", packageVersion: "1.2.3" },
      { loadManifest },
    );
    expect(ctx?.packageName).toBe("@cinatra-ai/pipeline");
    expect(ctx?.packageVersion).toBe("1.2.3");
    expect(loadManifest).toHaveBeenCalledWith({
      packageName: "@cinatra-ai/pipeline",
      packageVersion: "1.2.3",
    });
  });

  it("REFUSES an unpinned run rather than reading whatever is published now", async () => {
    // Without a version there is no one declaration to bind the admission to,
    // and a floating read would let a republish widen a RUNNING flow's reach
    // with no restart and no rebinding.
    const { resolveRunExtensionContext } = await import("@/lib/extension-run-package");
    query.mockResolvedValue({ rows: [{ package_name: "@cinatra-ai/pipeline" }] });
    const loadManifest = vi.fn().mockResolvedValue(MANIFEST);
    expect(
      await resolveRunExtensionContext({ templateId: "t1", packageVersion: null }, { loadManifest }),
    ).toBeNull();
    expect(
      await resolveRunExtensionContext({ templateId: "t1", packageVersion: "  " }, { loadManifest }),
    ).toBeNull();
    // And it never even asked the registry.
    expect(loadManifest).not.toHaveBeenCalled();
  });

  it("is fail-closed on a template with no package and on an unreadable manifest", async () => {
    const { resolveRunExtensionContext } = await import("@/lib/extension-run-package");
    query.mockResolvedValue({ rows: [] });
    expect(
      await resolveRunExtensionContext(
        { templateId: "t1", packageVersion: "1.0.0" },
        { loadManifest: vi.fn() },
      ),
    ).toBeNull();
    query.mockResolvedValue({ rows: [{ package_name: "@cinatra-ai/pipeline" }] });
    expect(
      await resolveRunExtensionContext(
        { templateId: "t1", packageVersion: "1.0.0" },
        {
          loadManifest: vi.fn().mockRejectedValue(new Error("registry down")),
        },
      ),
    ).toBeNull();
  });
});
