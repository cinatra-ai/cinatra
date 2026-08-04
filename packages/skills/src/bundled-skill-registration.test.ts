/**
 * cinatra#2398 — the ALWAYS-ON registration path.
 *
 * The REGRESSION PIN the issue asks for lives here and in
 * `src/lib/__tests__/bundled-skill-registration-boot-phase.test.ts`: the
 * registrar must not carry a runtime-mode gate of its own, and the boot phase
 * that drives it must not be `dev-only`. Before this slice the equivalent scan
 * was reachable only through `loadAllSkillPackagesAtBoot`, whose first line is
 * `if (process.env.CINATRA_RUNTIME_MODE !== "development") return;` — so a
 * production boot registered nothing at all.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  strictScan: vi.fn(),
  softScan: vi.fn(),
  filterRetired: vi.fn(),
  registerColocated: vi.fn(),
  retire: vi.fn(),
  snapshot: vi.fn(),
  leaseCalls: [] as unknown[],
  events: [] as string[],
}));

vi.mock("./extension-skill-resolver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./extension-skill-resolver")>();
  return {
    ...actual,
    scanSkillExtensions: vi.fn(async (opts?: { strict?: boolean }) =>
      opts?.strict ? h.strictScan() : h.softScan(),
    ),
    filterRetiredSkillExtensions: vi.fn(async (exts: unknown[]) => h.filterRetired(exts)),
    registerColocatedWorkspaceSkills: vi.fn(async (input: { pkgName: string }) => {
      h.events.push(`register:${input.pkgName}`);
      return h.registerColocated(input);
    }),
    retireExtensionSkillsByExactId: vi.fn(
      async (ids: readonly string[], opts?: { require?: (s: unknown) => boolean }) => {
        h.events.push(`retire:${ids.join(",")}`);
        return h.retire(ids, opts);
      },
    ),
  };
});

vi.mock("./skill-packages", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./skill-packages")>();
  return {
    ...actual,
    readSkillsCatalogSnapshot: vi.fn(async () => h.snapshot()),
    withSkillsCatalogRebuildLease: vi.fn(
      async (fn: () => Promise<unknown>, options: unknown) => {
        h.leaseCalls.push(options);
        h.events.push("lease:acquired");
        try {
          return await fn();
        } finally {
          h.events.push("lease:released");
        }
      },
    ),
  };
});

import {
  registerBundledColocatedSkills,
  isSweepableBundledRow,
} from "./bundled-skill-registration";
import { retireExtensionSkillsByExactId } from "./extension-skill-resolver";
import type { PersistedSkill } from "./skills-store";

type Desc = {
  pkgDir: string;
  pkgName: string;
  pkgDirName: string;
  kind: string;
  dependencies: never[];
  capabilities: Record<string, string>;
  slugs: string[];
};

function ext(pkgName: string, pkgDirName: string, kind: string, slugs: string[]): Desc {
  return {
    pkgDir: `/img/extensions/cinatra-ai/${pkgDirName}`,
    pkgName,
    pkgDirName,
    kind,
    dependencies: [],
    capabilities: {},
    slugs,
  };
}

/** A catalog row in the shape an extension registrar writes. */
function bundledRow(id: string, over: Partial<PersistedSkill> = {}): PersistedSkill {
  return {
    id,
    name: id,
    slug: id.split(":").pop() ?? id,
    description: "",
    content: "body",
    packageId: "custom:x",
    packageName: "@cinatra-ai/x",
    packageSlug: "cinatra-ai-x",
    usedBy: [],
    isCustom: false,
    level: "workspace",
    source: {
      origin: "extension",
      scope: null,
      packageRef: "custom:x",
      revision: { kind: "digest", value: "d" },
      relativePath: "SKILL.md",
    },
    ...over,
  } as PersistedSkill;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.events.length = 0;
  h.leaseCalls.length = 0;
  h.filterRetired.mockImplementation((exts: Desc[]) => exts);
  h.registerColocated.mockImplementation(async () => []);
  h.retire.mockImplementation(async (ids: string[]) => [...ids]);
  h.snapshot.mockResolvedValue({ skillPackages: [], skills: [] });
  h.softScan.mockResolvedValue([]);
  h.strictScan.mockResolvedValue([]);
});

describe("registerBundledColocatedSkills — always-on registration", () => {
  it("registers the co-located bundles of skill- and artifact-kind packages", async () => {
    const scan = [
      ext("@cinatra-ai/web-research-skill", "web-research-skill", "skill", ["web-research"]),
      ext("@acme/thing-artifact", "thing-artifact", "artifact", ["thing-matcher"]),
    ];
    h.strictScan.mockResolvedValue(scan);
    h.registerColocated.mockImplementation(async (input: { pkgName: string }) =>
      input.pkgName === "@cinatra-ai/web-research-skill"
        ? ["@cinatra-ai/web-research-skill:web-research"]
        : ["@acme/thing-artifact:thing-matcher"],
    );

    const result = await registerBundledColocatedSkills();

    expect(result.registered.sort()).toEqual([
      "@acme/thing-artifact:thing-matcher",
      "@cinatra-ai/web-research-skill:web-research",
    ]);
  });

  it("runs with NO runtime-mode gate — the whole point of the fix", async () => {
    const prior = process.env.CINATRA_RUNTIME_MODE;
    process.env.CINATRA_RUNTIME_MODE = "production";
    try {
      h.strictScan.mockResolvedValue([
        ext("@cinatra-ai/web-research-skill", "web-research-skill", "skill", ["web-research"]),
      ]);
      h.registerColocated.mockResolvedValue(["@cinatra-ai/web-research-skill:web-research"]);

      const result = await registerBundledColocatedSkills();
      expect(result.registered).toEqual(["@cinatra-ai/web-research-skill:web-research"]);
    } finally {
      if (prior === undefined) delete process.env.CINATRA_RUNTIME_MODE;
      else process.env.CINATRA_RUNTIME_MODE = prior;
    }
  });

  it("does NOT register connector- or agent-kind co-located bundles", async () => {
    h.strictScan.mockResolvedValue([
      ext("@cinatra-ai/wordpress-mcp-connector", "wordpress-mcp-connector", "connector", ["w"]),
      ext("@cinatra-ai/media-transcript-agent", "media-transcript-agent", "agent", ["t"]),
    ]);

    const result = await registerBundledColocatedSkills();

    expect(result.registered).toEqual([]);
    expect(h.events.filter((e) => e.startsWith("register:"))).toEqual([]);
  });

  it("skips an extension the lifecycle store reports RETIRED", async () => {
    const live = ext("@cinatra-ai/web-research-skill", "web-research-skill", "skill", ["web-research"]);
    const dead = ext("@cinatra-ai/gone-skill", "gone-skill", "skill", ["gone"]);
    h.strictScan.mockResolvedValue([live, dead]);
    h.filterRetired.mockImplementation((exts: Desc[]) => exts.filter((e) => e !== dead));

    await registerBundledColocatedSkills();

    expect(h.events.filter((e) => e.startsWith("register:"))).toEqual([
      "register:@cinatra-ai/web-research-skill",
    ]);
  });

  it("keeps one bad package from stopping the rest", async () => {
    h.strictScan.mockResolvedValue([
      ext("@acme/broken-skill", "broken-skill", "skill", ["a"]),
      ext("@acme/good-skill", "good-skill", "skill", ["b"]),
    ]);
    h.registerColocated.mockImplementation(async (input: { pkgName: string }) => {
      if (input.pkgName === "@acme/broken-skill") throw new Error("disk on fire");
      return ["@acme/good-skill:b"];
    });

    const result = await registerBundledColocatedSkills();
    expect(result.registered).toEqual(["@acme/good-skill:b"]);
  });

  it("runs the WHOLE pass inside the catalog-rebuild lease, and releases it", async () => {
    h.strictScan.mockResolvedValue([
      ext("@acme/a-skill", "a-skill", "skill", ["a"]),
      ext("@acme/gone-skill", "gone-skill", "skill", []),
    ]);
    h.snapshot.mockResolvedValue({ skillPackages: [], skills: [bundledRow("@acme/gone-skill:x")] });

    await registerBundledColocatedSkills();

    expect(h.events[0]).toBe("lease:acquired");
    expect(h.events.at(-1)).toBe("lease:released");
    expect(h.events).toContain("register:@acme/a-skill");
    expect(h.events).toContain("retire:@acme/gone-skill:x");
    // Narrow claim: the lease is TAKEN around the pass and RELEASED after it,
    // with a wait above the TTL so a crashed holder always expires inside the
    // wait. Cross-process EXCLUSION is the lease primitive's own contract (and
    // its residual — an overrun loses the lease — is documented on the wrapper).
    const opts = h.leaseCalls[0] as { leaseTtlMs: number; leaseWaitMs: number };
    expect(opts.leaseWaitMs).toBeGreaterThan(opts.leaseTtlMs);
  });
});

describe("registerBundledColocatedSkills — the retirement sweep", () => {
  it("retires an extension-provenance row whose bundle no extension ships any more", async () => {
    h.strictScan.mockResolvedValue([
      ext("@acme/kept-skill", "kept-skill", "skill", ["kept"]),
      ext("@acme/gone-skill", "gone-skill", "skill", []),
    ]);
    h.snapshot.mockResolvedValue({
      skillPackages: [],
      skills: [bundledRow("@acme/kept-skill:kept"), bundledRow("@acme/gone-skill:gone")],
    });

    const result = await registerBundledColocatedSkills();

    expect(result.retired).toEqual(["@acme/gone-skill:gone"]);
    expect(result.sweepSkippedReason).toBeNull();
  });

  it("KEEPS a row shipped by a kind this pass does not register (the keep-set is wider)", async () => {
    // A connector's widget-chat bundle registers through the LAZY resolver, not
    // through this pass — its rows must never be swept for being absent from
    // the register-set.
    h.strictScan.mockResolvedValue([
      ext("@cinatra-ai/wp-connector", "wp-connector", "connector", ["wordpress-widget-chat"]),
    ]);
    h.snapshot.mockResolvedValue({
      skillPackages: [],
      skills: [bundledRow("@cinatra-ai/wp-connector:wordpress-widget-chat")],
    });

    const result = await registerBundledColocatedSkills();
    expect(result.retired).toEqual([]);
  });

  it("KEEPS a row in a namespace NO registered-kind package mints — the llm-bridge's own registrations", async () => {
    // The bridge registers a mounted bundle under a PATH-derived package name:
    // for the provider package `@cinatra-ai/web-research-skill` shipping
    // `skills/web-research/`, that derivation yields `@cinatra-ai/web-research`.
    // The row carries extension provenance and is absent from the keep-set, and
    // it is STILL not the boot registrar's to delete.
    h.strictScan.mockResolvedValue([
      ext("@cinatra-ai/web-research-skill", "web-research-skill", "skill", ["web-research"]),
    ]);
    h.snapshot.mockResolvedValue({
      skillPackages: [],
      skills: [bundledRow("@cinatra-ai/web-research:web-research")],
    });

    const result = await registerBundledColocatedSkills();
    expect(result.retired).toEqual([]);
  });

  it("KEEPS a row under an AGENT package's namespace (agent kind is not a sweepable namespace)", async () => {
    h.strictScan.mockResolvedValue([
      ext("@cinatra-ai/media-transcript-agent", "media-transcript-agent", "agent", []),
    ]);
    h.snapshot.mockResolvedValue({
      skillPackages: [],
      skills: [bundledRow("@cinatra-ai/media-transcript-agent:transcribe-media")],
    });

    const result = await registerBundledColocatedSkills();
    expect(result.retired).toEqual([]);
  });

  it("SWEEPS a slug a still-installed package stopped shipping — including its LAST one", async () => {
    // The package is scanned (so its namespace is sweepable) but ships nothing.
    h.strictScan.mockResolvedValue([
      ext("@acme/emptied-skill", "emptied-skill", "skill", []),
    ]);
    h.snapshot.mockResolvedValue({
      skillPackages: [],
      skills: [bundledRow("@acme/emptied-skill:gone")],
    });

    const result = await registerBundledColocatedSkills();
    expect(result.retired).toEqual(["@acme/emptied-skill:gone"]);
  });

  it("SKIPS the sweep entirely when the strict scan could not answer", async () => {
    h.strictScan.mockRejectedValue(new Error("EACCES: mount unreadable"));
    h.softScan.mockResolvedValue([ext("@acme/a-skill", "a-skill", "skill", ["a"])]);
    h.registerColocated.mockResolvedValue(["@acme/a-skill:a"]);
    h.snapshot.mockResolvedValue({ skillPackages: [], skills: [bundledRow("@acme/a-skill:gone")] });

    const result = await registerBundledColocatedSkills();

    // Registration still happened, from the fail-soft scan…
    expect(result.registered).toEqual(["@acme/a-skill:a"]);
    // …and NOTHING was deleted on the strength of an unanswerable scan.
    expect(result.retired).toEqual([]);
    expect(result.sweepSkippedReason).toContain("not answerable");
    expect(h.events.some((e) => e.startsWith("retire:"))).toBe(false);
  });

  it("sweeps id-by-id, so one undeletable row does not block the others", async () => {
    h.strictScan.mockResolvedValue([
      ext("@acme/blocked-skill", "blocked-skill", "skill", []),
      ext("@acme/gone-skill", "gone-skill", "skill", []),
    ]);
    h.snapshot.mockResolvedValue({
      skillPackages: [],
      skills: [bundledRow("@acme/blocked-skill:x"), bundledRow("@acme/gone-skill:y")],
    });
    h.retire.mockImplementation(async (ids: string[]) => {
      // e.g. skill_co_owners.skill_id is ON DELETE RESTRICT.
      if (ids[0] === "@acme/blocked-skill:x") throw new Error("FK violation");
      return [...ids];
    });

    const result = await registerBundledColocatedSkills();
    expect(result.retired).toEqual(["@acme/gone-skill:y"]);
  });

  it("hands the retire helper the SAME predicate that selected the candidate", async () => {
    // Narrow claim, deliberately: this asserts the wiring. That the predicate is
    // then re-evaluated against the FRESHLY READ row is the retire helper's own
    // contract, proven directly in
    // `extension-skill-resolver.retention.test.ts`.
    h.strictScan.mockResolvedValue([ext("@acme/gone-skill", "gone-skill", "skill", [])]);
    h.snapshot.mockResolvedValue({ skillPackages: [], skills: [bundledRow("@acme/gone-skill:x")] });

    await registerBundledColocatedSkills();

    const call = vi.mocked(retireExtensionSkillsByExactId).mock.calls[0];
    expect(call?.[1]?.require).toBe(isSweepableBundledRow);
  });
});

describe("isSweepableBundledRow — every refusal, pinned separately", () => {
  it("accepts an unowned extension-provenance row", () => {
    expect(isSweepableBundledRow(bundledRow("@acme/a:b"))).toBe(true);
  });

  it("refuses a row with no RECORDED extension provenance", () => {
    expect(isSweepableBundledRow(bundledRow("@acme/a:b", { source: null }))).toBe(false);
    expect(
      isSweepableBundledRow(
        bundledRow("@acme/a:b", {
          source: {
            origin: "custom",
            scope: null,
            packageRef: null,
            revision: { kind: "activeHead", value: null },
            relativePath: null,
          },
        }),
      ),
    ).toBe(false);
  });

  it("refuses a personally-owned, agent-bound or scoped row", () => {
    expect(isSweepableBundledRow(bundledRow("@acme/a:b", { isCustomSkill: true }))).toBe(false);
    expect(isSweepableBundledRow(bundledRow("@acme/a:b", { ownerUserId: "u1" }))).toBe(false);
    expect(isSweepableBundledRow(bundledRow("@acme/a:b", { agentId: "@acme/an-agent" }))).toBe(false);
    expect(isSweepableBundledRow(bundledRow("@acme/a:b", { scope: "team-7" }))).toBe(false);
  });
});
