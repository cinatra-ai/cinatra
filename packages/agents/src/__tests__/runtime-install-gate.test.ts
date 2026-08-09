// cinatra#659 — the runtime-lifecycle gate shared by the four non-connector
// AGENT consumer surfaces (agent_run, the workflow agent_task executor + probe,
// the /agents picker, and the agent_list MCP primitive).
//
// Mirrors `packages/extensions/src/__tests__/connector-installed-predicate.test.ts`
// (the #657 connector predicate's direct unit test): the rule is small but
// load-bearing, so the PURE decision + the host wrapper's fail-open/CG-1 handling
// are unit-tested here (this package's `vitest run` auto-includes the file — it is
// NOT the `@cinatra-ai/extensions` explicit `test:invariants` list).

import { describe, it, expect } from "vitest";
import {
  isAgentRuntimeRunnable,
  resolveRunnableAgentPackageNames,
} from "../runtime-install-gate";

describe("isAgentRuntimeRunnable (pure runtime-lifecycle decision)", () => {
  it("a null/undefined packageName is always runnable (untracked legacy template)", () => {
    expect(isAgentRuntimeRunnable({ packageName: null, effectiveStatus: undefined })).toBe(true);
    expect(isAgentRuntimeRunnable({ packageName: undefined, effectiveStatus: "archived" })).toBe(true);
  });

  it("an 'active' canonical row is runnable (runtime source of truth: live)", () => {
    expect(isAgentRuntimeRunnable({ packageName: "@x/a", effectiveStatus: "active" })).toBe(true);
  });

  it("an 'archived' canonical row is NOT runnable (fail-CLOSED on runtime archive)", () => {
    expect(isAgentRuntimeRunnable({ packageName: "@x/a", effectiveStatus: "archived" })).toBe(false);
  });

  it("CG-1: NO canonical row (undefined) is runnable — the bundled/ungoverned floor", () => {
    // A bundled/legacy/ungoverned agent the canonical store does not track must
    // NOT be blanked by the fail-closed flip (the load-bearing CG-1 invariant).
    expect(isAgentRuntimeRunnable({ packageName: "@x/bundled", effectiveStatus: undefined })).toBe(true);
  });

  it("an archived row is NOT resurrected by the bundled floor (archive beats no-row)", () => {
    // The ONLY case the bundled floor applies is NO row. A present archived row
    // is an explicit operator disable and must stay refused.
    expect(isAgentRuntimeRunnable({ packageName: "@x/a", effectiveStatus: "archived" })).toBe(false);
  });
});

describe("resolveRunnableAgentPackageNames (host wrapper: read + gate)", () => {
  it("keeps active + no-row (CG-1) and drops archived", async () => {
    const readStatus = async (names: string[]) => {
      expect(names).toContain("@x/active");
      const m = new Map<string, "active" | "archived">();
      m.set("@x/active", "active");
      m.set("@x/archived", "archived");
      // "@x/norow" intentionally absent → CG-1 floor.
      return m;
    };
    const runnable = await resolveRunnableAgentPackageNames(
      ["@x/active", "@x/archived", "@x/norow"],
      { readStatus },
    );
    expect(runnable.has("@x/active")).toBe(true);
    expect(runnable.has("@x/norow")).toBe(true); // CG-1: no row → runnable
    expect(runnable.has("@x/archived")).toBe(false); // fail-closed
  });

  it("de-dupes and ignores null/empty inputs", async () => {
    const readStatus = async (names: string[]) => {
      // null / "" / duplicates must be stripped before the read.
      expect(names).toEqual(["@x/a"]);
      return new Map<string, "active" | "archived">([["@x/a", "active"]]);
    };
    const runnable = await resolveRunnableAgentPackageNames(
      ["@x/a", "@x/a", null, undefined, ""],
      { readStatus },
    );
    expect([...runnable]).toEqual(["@x/a"]);
  });

  it("fail-OPEN on a canonical-store OUTAGE: every input is runnable (never invent an archive)", async () => {
    const readStatus = async () => {
      throw new Error("canonical store down");
    };
    const runnable = await resolveRunnableAgentPackageNames(
      ["@x/a", "@x/b"],
      { readStatus },
    );
    // A degraded status store must not block discovery/execution — the
    // ownership/tenancy/project gates at each call site are the real authz.
    expect(runnable.has("@x/a")).toBe(true);
    expect(runnable.has("@x/b")).toBe(true);
  });

  it("returns an empty set when there are no named packages (no read)", async () => {
    let called = false;
    const readStatus = async () => {
      called = true;
      return new Map<string, "active" | "archived">();
    };
    const runnable = await resolveRunnableAgentPackageNames([null, undefined, ""], { readStatus });
    expect(runnable.size).toBe(0);
    expect(called).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cinatra#2605 — the PROVISIONING layer.
//
// The lifecycle rule above answers "did an operator archive this?". These tests
// pin the second question the /agents picker got wrong: "is this agent (and its
// required closure) actually INSTALLED?" — the exact shape of the two agents in
// the issue (`blog-draft-writer-agent`, `blog-idea-generator-agent`:
// resolution "guardedOptional", serverEntry null, a REQUIRED runtime edge on
// `context-selection-agent`), which the boot seeder anchors no row for.
//
// The install-blocking predicate is the REAL shared one from the installer
// (`@cinatra-ai/extensions/dependency-closure`), injected — the gate must never
// carry a second copy of the required/peer semantics.
// ---------------------------------------------------------------------------
import { isInstallBlockingEdge } from "@cinatra-ai/extensions/dependency-closure";
import {
  resolveAgentRunAvailability,
  resolveAgentRunAvailabilityMap,
  partitionRunnableAgentPackages,
  assertAgentPackageRunnable,
  type AgentCatalogRecord,
  type AgentCatalogView,
  type AgentEffectiveInstallStatus,
} from "../runtime-install-gate";

function rec(
  packageName: string,
  over: Partial<AgentCatalogRecord> = {},
): AgentCatalogRecord {
  return {
    packageName,
    kind: "agent",
    version: "0.1.2",
    resolution: "guardedOptional",
    displayName: null,
    dependencies: [],
    ...over,
  } as AgentCatalogRecord;
}

/** A REQUIRED runtime edge — install-blocking per the shared predicate. */
function requiredEdge(packageName: string, kind: AgentCatalogRecord["kind"] = "agent") {
  return {
    packageName,
    kind,
    edgeType: "runtime",
    versionConstraint: { kind: "semver-range", range: "^0.1.0" },
    requirement: "required",
  } as NonNullable<AgentCatalogRecord["dependencies"]>[number];
}

/** The issue's exact catalog shape (src/lib/generated/extensions.server.ts). */
const BLOG_CATALOG: AgentCatalogView = {
  "@cinatra-ai/blog-draft-writer-agent": rec("@cinatra-ai/blog-draft-writer-agent", {
    displayName: "Blog Draft Writer Agent",
    dependencies: [requiredEdge("@cinatra-ai/context-selection-agent")],
  }),
  "@cinatra-ai/blog-idea-generator-agent": rec("@cinatra-ai/blog-idea-generator-agent", {
    displayName: "Blog Idea Generator Agent",
    dependencies: [requiredEdge("@cinatra-ai/context-selection-agent")],
  }),
  "@cinatra-ai/context-selection-agent": rec("@cinatra-ai/context-selection-agent", {
    version: "0.1.1",
    displayName: "Context Selection Agent",
  }),
  // A `required`-resolution agent: the boot seeder anchors its row, so a
  // missing row there is an anomaly, never proof of "not installed".
  "@cinatra-ai/author-agent": rec("@cinatra-ai/author-agent", {
    version: "0.1.1",
    resolution: "required",
    displayName: "Author Agent",
  }),
};

function availabilityFor(
  packageName: string,
  statuses: Record<string, AgentEffectiveInstallStatus>,
  opts: { catalog?: AgentCatalogView; templateVersion?: string | null } = {},
) {
  const catalog = opts.catalog === undefined ? BLOG_CATALOG : opts.catalog;
  return resolveAgentRunAvailability({
    packageName,
    effectiveStatus: statuses[packageName],
    templateVersion: opts.templateVersion,
    catalog,
    statusOf: (name) => statuses[name],
    isBlockingEdge: isInstallBlockingEdge,
  });
}

describe("resolveAgentRunAvailability (pure provisioning decision, cinatra#2605)", () => {
  it("the issue's state: guardedOptional bundled agent, NO install row → not-installed (no Run)", () => {
    for (const pkg of [
      "@cinatra-ai/blog-draft-writer-agent",
      "@cinatra-ai/blog-idea-generator-agent",
    ]) {
      const verdict = availabilityFor(pkg, {});
      expect(verdict.state).toBe("not-installed");
      if (verdict.state === "not-installed") {
        expect(verdict.displayName).toBe(BLOG_CATALOG![pkg].displayName);
      }
    }
  });

  it("installed agent whose REQUIRED dependency has no row → missing-required-dependency", () => {
    const verdict = availabilityFor("@cinatra-ai/blog-draft-writer-agent", {
      "@cinatra-ai/blog-draft-writer-agent": "active",
    });
    expect(verdict.state).toBe("missing-required-dependency");
    if (verdict.state === "missing-required-dependency") {
      expect(verdict.missing).toEqual([
        {
          packageName: "@cinatra-ai/context-selection-agent",
          displayName: "Context Selection Agent",
          kind: "agent",
          reason: "not-installed",
        },
      ]);
    }
  });

  it("an ARCHIVED required dependency is missing too (archive beats presence)", () => {
    const verdict = availabilityFor("@cinatra-ai/blog-draft-writer-agent", {
      "@cinatra-ai/blog-draft-writer-agent": "active",
      "@cinatra-ai/context-selection-agent": "archived",
    });
    expect(verdict.state).toBe("missing-required-dependency");
    if (verdict.state === "missing-required-dependency") {
      expect(verdict.missing[0].reason).toBe("archived");
    }
  });

  it("agent + its whole required closure installed → runnable (offered iff runnable)", () => {
    expect(
      availabilityFor("@cinatra-ai/blog-draft-writer-agent", {
        "@cinatra-ai/blog-draft-writer-agent": "active",
        "@cinatra-ai/context-selection-agent": "active",
      }).state,
    ).toBe("runnable");
  });

  it("an ARCHIVED agent stays archived (the #659 verdict is never re-labelled)", () => {
    expect(
      availabilityFor("@cinatra-ai/blog-draft-writer-agent", {
        "@cinatra-ai/blog-draft-writer-agent": "archived",
      }).state,
    ).toBe("archived");
  });

  it("CG-1 floors are preserved: null package, uncatalogued package, and resolution 'required'", () => {
    expect(
      resolveAgentRunAvailability({
        packageName: null,
        effectiveStatus: undefined,
        catalog: BLOG_CATALOG,
        statusOf: () => undefined,
        isBlockingEdge: isInstallBlockingEdge,
      }).state,
    ).toBe("runnable");
    // Not in the catalog at all → ungoverned/user-imported → floor.
    expect(availabilityFor("@acme/hand-imported-agent", {}).state).toBe("runnable");
    // `required` resolution with no row → the SDK's fail-closed reading of an
    // absent/unknown classification is "required", which this layer never gates.
    expect(availabilityFor("@cinatra-ai/author-agent", {}).state).toBe("runnable");
  });

  it("a missing/unknown `resolution` reads as 'required' (never gated)", () => {
    const catalog: AgentCatalogView = {
      "@x/no-resolution": rec("@x/no-resolution", {
        resolution: undefined as unknown as AgentCatalogRecord["resolution"],
      }),
    };
    expect(availabilityFor("@x/no-resolution", {}, { catalog }).state).toBe("runnable");
  });

  it("OPTIONAL and PEER edges never gate (the shared install-blocking predicate decides)", () => {
    const catalog: AgentCatalogView = {
      "@x/root": rec("@x/root", {
        dependencies: [
          {
            packageName: "@x/optional-dep",
            kind: "agent",
            edgeType: "runtime",
            versionConstraint: { kind: "semver-range", range: "*" },
            requirement: "optional",
          },
          {
            packageName: "@x/peer-dep",
            kind: "agent",
            edgeType: "peer",
            versionConstraint: { kind: "semver-range", range: "*" },
            requirement: "required",
          },
        ] as NonNullable<AgentCatalogRecord["dependencies"]>,
      }),
      "@x/optional-dep": rec("@x/optional-dep"),
      "@x/peer-dep": rec("@x/peer-dep"),
    };
    expect(availabilityFor("@x/root", { "@x/root": "active" }, { catalog }).state).toBe("runnable");
  });

  it("reports the agent's OWN required edges — deduped, deterministically ordered, self-edge-safe", () => {
    const catalog: AgentCatalogView = {
      "@x/root": rec("@x/root", {
        // Declared out of order, with a duplicate and a self-edge.
        dependencies: [
          requiredEdge("@x/dep-b"),
          requiredEdge("@x/dep-a"),
          requiredEdge("@x/dep-b"),
          requiredEdge("@x/root"),
        ],
      }),
      "@x/dep-a": rec("@x/dep-a"),
      "@x/dep-b": rec("@x/dep-b"),
    };
    const verdict = availabilityFor("@x/root", { "@x/root": "active" }, { catalog });
    expect(verdict.state).toBe("missing-required-dependency");
    if (verdict.state === "missing-required-dependency") {
      // Ordered by packageName so the card's CTA target is stable across renders.
      expect(verdict.missing.map((m) => m.packageName)).toEqual(["@x/dep-a", "@x/dep-b"]);
    }
  });

  it("does NOT walk THROUGH an installed dependency — a deeper break is left to run time", () => {
    // SCOPE, deliberately: the catalog is the image-pinned record set, and for
    // an INSTALLED dependency this layer knows the status but not the installed
    // VERSION — so evaluating that record's own edges could refuse a legitimately
    // upgraded install. Under-refusal is the chosen direction (every other arm of
    // this gate is fail-open); the deeper break still fails at run time.
    const catalog: AgentCatalogView = {
      "@x/root": rec("@x/root", { dependencies: [requiredEdge("@x/mid")] }),
      "@x/mid": rec("@x/mid", { dependencies: [requiredEdge("@x/leaf")] }),
      "@x/leaf": rec("@x/leaf"),
    };
    expect(
      availabilityFor("@x/root", { "@x/root": "active", "@x/mid": "active" }, { catalog }).state,
    ).toBe("runnable");
    // …while the DIRECT edge is still enforced.
    expect(availabilityFor("@x/root", { "@x/root": "active" }, { catalog }).state).toBe(
      "missing-required-dependency",
    );
  });

  it("VERSION FENCE: a catalog record describing a DIFFERENT build never blocks the install", () => {
    // An upgraded (marketplace-installed) agent whose edges the bundled catalog
    // record no longer describes: the dependency arm is skipped, not guessed.
    expect(
      availabilityFor(
        "@cinatra-ai/blog-draft-writer-agent",
        { "@cinatra-ai/blog-draft-writer-agent": "active" },
        { templateVersion: "0.9.9" },
      ).state,
    ).toBe("runnable");
    // The SAME version is still evaluated.
    expect(
      availabilityFor(
        "@cinatra-ai/blog-draft-writer-agent",
        { "@cinatra-ai/blog-draft-writer-agent": "active" },
        { templateVersion: "0.1.2" },
      ).state,
    ).toBe("missing-required-dependency");
  });

  it("AMBIGUOUS versions (two templates, one package) skip the dependency arm", () => {
    // One per-package verdict cannot speak for two builds.
    expect(
      resolveAgentRunAvailability({
        packageName: "@cinatra-ai/blog-draft-writer-agent",
        effectiveStatus: "active",
        templateVersion: "0.1.2",
        versionAmbiguous: true,
        catalog: BLOG_CATALOG,
        statusOf: () => undefined,
        isBlockingEdge: isInstallBlockingEdge,
      }).state,
    ).toBe("runnable");
    // The not-installed arm is version-independent and still applies.
    expect(
      resolveAgentRunAvailability({
        packageName: "@cinatra-ai/blog-draft-writer-agent",
        effectiveStatus: undefined,
        templateVersion: "0.1.2",
        versionAmbiguous: true,
        catalog: BLOG_CATALOG,
        statusOf: () => undefined,
        isBlockingEdge: isInstallBlockingEdge,
      }).state,
    ).toBe("not-installed");
  });

  it("an UNREADABLE catalog degrades to the lifecycle rule — and never resurrects an archive", () => {
    expect(availabilityFor("@cinatra-ai/blog-draft-writer-agent", {}, { catalog: null }).state).toBe(
      "runnable",
    );
    expect(
      availabilityFor(
        "@cinatra-ai/blog-draft-writer-agent",
        { "@cinatra-ai/blog-draft-writer-agent": "archived" },
        { catalog: null },
      ).state,
    ).toBe("archived");
  });
});

describe("resolveAgentRunAvailabilityMap (host wrapper: catalog + status reads)", () => {
  const deps = (statuses: Record<string, "active" | "archived">, seen?: string[][]) => ({
    readCatalog: async () => BLOG_CATALOG,
    isBlockingEdge: isInstallBlockingEdge,
    readStatus: async (names: string[]) => {
      seen?.push(names);
      return new Map(Object.entries(statuses));
    },
  });

  it("reads the status of the required-closure targets too, in ONE call", async () => {
    const seen: string[][] = [];
    await resolveAgentRunAvailabilityMap(
      [{ packageName: "@cinatra-ai/blog-draft-writer-agent", packageVersion: "0.1.2" }],
      deps({}, seen),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([
      "@cinatra-ai/blog-draft-writer-agent",
      "@cinatra-ai/context-selection-agent",
    ]);
  });

  it("maps the issue's two agents to not-installed and a provisioned one to runnable", async () => {
    const map = await resolveAgentRunAvailabilityMap(
      [
        { packageName: "@cinatra-ai/blog-draft-writer-agent", packageVersion: "0.1.2" },
        { packageName: "@cinatra-ai/blog-idea-generator-agent", packageVersion: "0.1.2" },
        { packageName: "@cinatra-ai/author-agent", packageVersion: "0.1.1" },
      ],
      deps({}),
    );
    expect(map.get("@cinatra-ai/blog-draft-writer-agent")?.state).toBe("not-installed");
    expect(map.get("@cinatra-ai/blog-idea-generator-agent")?.state).toBe("not-installed");
    expect(map.get("@cinatra-ai/author-agent")?.state).toBe("runnable");
  });

  it("two templates of one package at DIFFERENT versions: no cross-attributed dependency verdict", async () => {
    const map = await resolveAgentRunAvailabilityMap(
      [
        { packageName: "@cinatra-ai/blog-draft-writer-agent", packageVersion: "0.1.2" },
        { packageName: "@cinatra-ai/blog-draft-writer-agent", packageVersion: "0.9.9" },
      ],
      deps({ "@cinatra-ai/blog-draft-writer-agent": "active" }),
    );
    // Installed at BOTH versions with the dependency missing: the 0.1.2 record's
    // edges must not be attributed to the 0.9.9 template, so the dependency arm
    // is skipped rather than guessed.
    expect(map.get("@cinatra-ai/blog-draft-writer-agent")?.state).toBe("runnable");
  });

  it("fail-OPEN on a canonical-store outage — every input runnable, even a gated one", async () => {
    const map = await resolveAgentRunAvailabilityMap(
      [{ packageName: "@cinatra-ai/blog-draft-writer-agent" }],
      {
        readCatalog: async () => BLOG_CATALOG,
        isBlockingEdge: isInstallBlockingEdge,
        readStatus: async () => {
          throw new Error("canonical store down");
        },
      },
    );
    expect(map.get("@cinatra-ai/blog-draft-writer-agent")?.state).toBe("runnable");
  });

  it("an unreadable CATALOG keeps a proven archive refused (the two failures are independent)", async () => {
    const map = await resolveAgentRunAvailabilityMap(
      [
        { packageName: "@cinatra-ai/blog-draft-writer-agent" },
        { packageName: "@cinatra-ai/blog-idea-generator-agent" },
      ],
      {
        readCatalog: async () => null,
        isBlockingEdge: isInstallBlockingEdge,
        readStatus: async () =>
          new Map<string, "active" | "archived">([
            ["@cinatra-ai/blog-idea-generator-agent", "archived"],
          ]),
      },
    );
    expect(map.get("@cinatra-ai/blog-draft-writer-agent")?.state).toBe("runnable");
    expect(map.get("@cinatra-ai/blog-idea-generator-agent")?.state).toBe("archived");
  });
});

describe("gate consumers apply the SAME provisioning rule (no per-surface drift)", () => {
  const catalogDeps = {
    readCatalog: async () => BLOG_CATALOG,
    isBlockingEdge: isInstallBlockingEdge,
    readStatus: async () => new Map<string, "active" | "archived">(),
  };

  it("agent_list discovery (partitionRunnableAgentPackages) drops a not-installed agent", async () => {
    const kept = await partitionRunnableAgentPackages(
      [
        { packageName: "@cinatra-ai/blog-draft-writer-agent", packageVersion: "0.1.2" },
        { packageName: "@cinatra-ai/author-agent", packageVersion: "0.1.1" },
        { packageName: null },
      ],
      catalogDeps,
    );
    expect(kept.map((t) => t.packageName)).toEqual(["@cinatra-ai/author-agent", null]);
  });

  it("agent_run execution refuses with a state-specific, actionable message", async () => {
    const notInstalled = await assertAgentPackageRunnable(
      "@cinatra-ai/blog-draft-writer-agent",
      "blog-draft-writer",
      { ...catalogDeps, packageVersion: "0.1.2" },
    );
    expect(notInstalled?.error).toMatch(/Agent is not installed: blog-draft-writer/);
    expect(notInstalled?.error).toMatch(/opt-in/);

    const missingDep = await assertAgentPackageRunnable(
      "@cinatra-ai/blog-draft-writer-agent",
      "blog-draft-writer",
      {
        ...catalogDeps,
        packageVersion: "0.1.2",
        readStatus: async () =>
          new Map<string, "active" | "archived">([
            ["@cinatra-ai/blog-draft-writer-agent", "active"],
          ]),
      },
    );
    expect(missingDep?.error).toMatch(/@cinatra-ai\/context-selection-agent/);

    // The ARCHIVED refusal text is the unchanged #659 contract.
    const archived = await assertAgentPackageRunnable("@cinatra-ai/author-agent", "author", {
      ...catalogDeps,
      readStatus: async () =>
        new Map<string, "active" | "archived">([["@cinatra-ai/author-agent", "archived"]]),
    });
    expect(archived?.error).toBe("Agent is not installed (disabled or uninstalled): author");

    // A provisioned agent still runs.
    expect(
      await assertAgentPackageRunnable("@cinatra-ai/author-agent", "author", catalogDeps),
    ).toBeNull();
  });
});
