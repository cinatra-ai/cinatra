import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Actor } from "@cinatra-ai/extension-types";

// Order trace proves the fail-closed saga sequence.
const calls: string[] = [];

vi.mock("../quarantine", () => ({
  quarantineExtensionBeforePurge: vi.fn(
    async (input: { versions: string[] }) => {
      calls.push("quarantine");
      return {
        quarantineDir: "/tmp/q",
        tarballs: input.versions.map((v) => `/tmp/q/pkg-${v}.tgz`),
        missingTarballs: [] as string[],
      };
    },
  ),
}));
vi.mock("../audit-log", () => ({
  computeDanglingReferences: vi.fn(async () => ({
    agent_runs_count: 0,
    agent_runs_count_capped: false,
    dependent_extensions: [],
    dependent_extensions_capped: false,
  })),
  writeExtensionLifecycleAuditEntry: vi.fn(async (e: { operation: string }) => {
    calls.push(`audit:${e.operation}`);
  }),
}));

import {
  planExtensionPurge,
  purgeExtension,
  ExtensionPurgeRefused,
  type PurgeDeps,
} from "../purge";
import { quarantineExtensionBeforePurge } from "../quarantine";
import { setExtensionCapabilityTeardownHook } from "../capability-teardown-hook";

const actor: Actor = { actorType: "human", source: "route" };

function makeDeps(over: Partial<PurgeDeps> = {}): PurgeDeps {
  return {
    loadVerdaccioConfig: async () => ({
      registryUrl: "http://localhost:4873",
      packageScope: "@cinatra-ai",
      token: "t",
    }),
    resolvePackageKind: async () => "agent",
    getAgentPackage: async () => ({
      manifest: { cinatra: { kind: "agent" } },
      payload: null,
      origin: { visibility: "private", scope: "@cinatra-ai" },
    }),
    listVersions: async () => ({
      versions: ["0.1.0", "0.1.1"],
      distTags: { latest: "0.1.1" },
    }),
    readTemplateByPackageName: async () => ({ id: "tmpl-1", name: "Foo" }),
    withLifecycleLock: async (_pkg, fn) => fn(),
    dbPurgeAtomic: async () => {
      calls.push("db");
      return { deleted: true, snapshot: { id: "tmpl-1" } };
    },
    extensionDirPresent: () => true,
    strictDiskPurge: async () => {
      calls.push("disk");
      return { dirPresentAtStart: true };
    },
    restoreDirFromTarball: async () => {
      calls.push("restore");
    },
    fetchPackument: async () => ({ name: "@cinatra-ai/foo-agent" }),
    readTemplatesDependingOn: async () => [],
    readTemplatesReferencingChild: async () => [],
    listOnDiskOasDependents: async () => [],
    // Purge MUST NOT call this. Kept on the deps seam (host wiring
    // still supplies it), but a spy here lets every test assert it is NEVER
    // invoked by the saga. If it ever fires it also pushes "verdaccio" so the
    // ordering traces would loudly regress.
    unpublishAllVersions: vi.fn(async () => {
      calls.push("verdaccio");
      return {
        unpublished: ["0.1.0", "0.1.1"],
        notFound: [],
        failed: [],
        remaining: [],
      };
    }),
    downloadTarball: async () => true,
    ...over,
  };
}

async function digestFor(pkg: string, deps: PurgeDeps): Promise<string> {
  return (await planExtensionPurge({ packageName: pkg }, deps)).digest;
}

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
  delete process.env.CINATRA_DB_PROD_HOSTS;
  delete process.env.SUPABASE_DB_URL;
});

describe("planExtensionPurge", () => {
  it("returns kind/versions/digest; stable", async () => {
    const p = await planExtensionPurge(
      { packageName: "@cinatra-ai/foo-agent" },
      makeDeps(),
    );
    expect(p.typeId).toBe("agent");
    expect(p.versions).toEqual(["0.1.0", "0.1.1"]);
    expect(p.blocked).toBe(false);
    expect(p.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(
      (
        await planExtensionPurge(
          { packageName: "@cinatra-ai/foo-agent" },
          makeDeps(),
        )
      ).digest,
    ).toBe(p.digest);
  });

  it("blocks when an active dependent exists", async () => {
    const p = await planExtensionPurge(
      { packageName: "@cinatra-ai/foo-agent" },
      makeDeps({
        readTemplatesReferencingChild: async () => [
          { packageName: "@cinatra-ai/orch-agent" },
        ],
      }),
    );
    expect(p.blocked).toBe(true);
  });

  it("connector with no agent payload resolves typeId=connector (not agent)", async () => {
    const p = await planExtensionPurge(
      { packageName: "@cinatra-ai/foo-connector" },
      makeDeps({
        resolvePackageKind: async () => "connector",
        getAgentPackage: async () => {
          throw new Error("no agent payload");
        },
        readTemplateByPackageName: async () => null,
      }),
    );
    expect(p.typeId).toBe("connector");
  });

  it("no explicit kind + no agent payload + no row => typeId empty", async () => {
    const p = await planExtensionPurge(
      { packageName: "@cinatra-ai/weird" },
      makeDeps({
        resolvePackageKind: async () => null,
        getAgentPackage: async () => {
          throw new Error("none");
        },
        readTemplateByPackageName: async () => null,
      }),
    );
    expect(p.typeId).toBe("");
  });
});

describe("purgeExtension saga — fail-closed gates (nothing destroyed)", () => {
  it("requires a digest", async () => {
    await expect(
      purgeExtension(
        { packageName: "@cinatra-ai/foo-agent", actor },
        makeDeps(),
      ),
    ).rejects.toBeInstanceOf(ExtensionPurgeRefused);
    expect(calls).toEqual([]);
  });
  it("refuses on digest mismatch", async () => {
    await expect(
      purgeExtension(
        {
          packageName: "@cinatra-ai/foo-agent",
          expectedDigest: "stale",
          actor,
        },
        makeDeps(),
      ),
    ).rejects.toBeInstanceOf(ExtensionPurgeRefused);
    expect(calls).toEqual([]);
  });
  it("refuses on prod DB host", async () => {
    process.env.SUPABASE_DB_URL = "postgres://u:p@db.prod.example.com/x";
    process.env.CINATRA_DB_PROD_HOSTS = "prod.example.com";
    const deps = makeDeps();
    await expect(
      purgeExtension(
        {
          packageName: "@cinatra-ai/foo-agent",
          expectedDigest: await digestFor("@cinatra-ai/foo-agent", deps),
          actor,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(ExtensionPurgeRefused);
    expect(calls).toEqual([]);
  });
  it("hard-blocks on active dependents (no mutation)", async () => {
    const deps = makeDeps({
      readTemplatesDependingOn: async () => [
        { packageName: "@cinatra-ai/dep" },
      ],
    });
    await expect(
      purgeExtension(
        {
          packageName: "@cinatra-ai/foo-agent",
          expectedDigest: await digestFor("@cinatra-ai/foo-agent", deps),
          actor,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(ExtensionPurgeRefused);
    expect(calls).toEqual([]);
  });
  it("refuses skill kind (agent-only saga would half-purge skill state)", async () => {
    const deps = makeDeps({ resolvePackageKind: async () => "skill" });
    await expect(
      purgeExtension(
        {
          packageName: "@cinatra-ai/foo-skills",
          expectedDigest: await digestFor("@cinatra-ai/foo-skills", deps),
          actor,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(ExtensionPurgeRefused);
    expect(calls).toEqual([]);
  });

  it("refuses unresolved kind", async () => {
    const deps = makeDeps({
      resolvePackageKind: async () => "totally-unknown",
    });
    await expect(
      purgeExtension(
        {
          packageName: "@cinatra-ai/weird",
          expectedDigest: await digestFor("@cinatra-ai/weird", deps),
          actor,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(ExtensionPurgeRefused);
    expect(calls).toEqual([]);
  });
  it("aborts before disk/DB/Verdaccio when quarantine is incomplete", async () => {
    (
      quarantineExtensionBeforePurge as unknown as { mockImplementationOnce: (f: unknown) => void }
    ).mockImplementationOnce(async () => {
      calls.push("quarantine");
      return {
        quarantineDir: "/tmp/q",
        tarballs: [],
        missingTarballs: ["0.1.1"],
      };
    });
    const deps = makeDeps();
    await expect(
      purgeExtension(
        {
          packageName: "@cinatra-ai/foo-agent",
          expectedDigest: await digestFor("@cinatra-ai/foo-agent", deps),
          actor,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(ExtensionPurgeRefused);
    expect(calls).toEqual(["quarantine"]);
  });
});

describe("purgeExtension saga — ordering + rollback + NO registry unpublish", () => {
  it("quarantine → audit_started → disk → db → audit_committed (NO verdaccio)", async () => {
    const deps = makeDeps();
    const res = await purgeExtension(
      {
        packageName: "@cinatra-ai/foo-agent",
        expectedDigest: await digestFor("@cinatra-ai/foo-agent", deps),
        actor,
      },
      deps,
    );
    expect(calls).toEqual([
      "quarantine",
      "audit:purge_started",
      "disk",
      "db",
      "audit:purge_committed",
    ]);
    expect(calls).not.toContain("verdaccio");
    expect(res.dbDiskDeleted).toBe(true);
    expect(res.stopped).toBe(false);
  });

  it("NEVER calls deps.unpublishAllVersions (registry left intact)", async () => {
    const deps = makeDeps();
    const res = await purgeExtension(
      {
        packageName: "@cinatra-ai/foo-agent",
        expectedDigest: await digestFor("@cinatra-ai/foo-agent", deps),
        actor,
      },
      deps,
    );
    // The deps seam still carries the function, but the saga must not invoke it.
    expect(deps.unpublishAllVersions).not.toHaveBeenCalled();
    expect(calls).not.toContain("verdaccio");
    // Always a clean commit — no registry step can leave it partial.
    expect(calls).toContain("audit:purge_committed");
    expect(calls).not.toContain("audit:purge_partial");
    // The straggler/partial result surface is gone entirely.
    expect(res).not.toHaveProperty("registryPartial");
    expect(res).not.toHaveProperty("versionsUnpublished");
    expect(res).not.toHaveProperty("versionsNotFound");
    expect(res).not.toHaveProperty("versionsRemaining");
  });

  it("connector purge also leaves the registry untouched (no unpublish)", async () => {
    const deps = makeDeps({
      resolvePackageKind: async () => "connector",
      getAgentPackage: async () => {
        throw new Error("no agent payload");
      },
      readTemplateByPackageName: async () => null,
    });
    await purgeExtension(
      {
        packageName: "@cinatra-ai/foo-connector",
        expectedDigest: await digestFor("@cinatra-ai/foo-connector", deps),
        actor,
      },
      deps,
    );
    expect(deps.unpublishAllVersions).not.toHaveBeenCalled();
    expect(calls).not.toContain("verdaccio");
  });

  it("DB-delete failure → restore dir + audit purge_rolled_back + throw; Verdaccio untouched", async () => {
    const deps = makeDeps({
      dbPurgeAtomic: async () => {
        calls.push("db-fail");
        throw new Error("db lock timeout");
      },
    });
    await expect(
      purgeExtension(
        {
          packageName: "@cinatra-ai/foo-agent",
          expectedDigest: await digestFor("@cinatra-ai/foo-agent", deps),
          actor,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(ExtensionPurgeRefused);
    expect(calls).toEqual([
      "quarantine",
      "audit:purge_started",
      "disk",
      "db-fail",
      "restore",
      "audit:purge_rolled_back",
    ]);
    expect(calls).not.toContain("verdaccio");
  });

  it("connector kind: NO disk/DB; quarantine + audit only (NO Verdaccio)", async () => {
    const deps = makeDeps({
      resolvePackageKind: async () => "connector",
      getAgentPackage: async () => {
        throw new Error("no agent payload");
      },
      readTemplateByPackageName: async () => null,
    });
    const res = await purgeExtension(
      {
        packageName: "@cinatra-ai/foo-connector",
        expectedDigest: await digestFor("@cinatra-ai/foo-connector", deps),
        actor,
      },
      deps,
    );
    expect(calls).toEqual([
      "quarantine",
      "audit:purge_started",
      "audit:purge_committed",
    ]);
    expect(calls).not.toContain("verdaccio");
    expect(res.dbDiskDeleted).toBe(false);
  });

  it("repair case: dir already absent → no restore even if DB later fails", async () => {
    const deps = makeDeps({
      extensionDirPresent: () => false, // already removed from source (the 4)
      strictDiskPurge: async () => {
        calls.push("disk");
        return { dirPresentAtStart: false };
      },
      dbPurgeAtomic: async () => {
        calls.push("db-fail");
        throw new Error("db fail");
      },
    });
    await expect(
      purgeExtension(
        {
          packageName: "@cinatra-ai/url-title-fetcher",
          expectedDigest: await digestFor("@cinatra-ai/url-title-fetcher", deps),
          actor,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(ExtensionPurgeRefused);
    expect(calls).toEqual([
      "quarantine",
      "audit:purge_started",
      "disk",
      "db-fail",
      "audit:purge_rolled_back",
    ]);
    expect(calls).not.toContain("restore");
    expect(calls).not.toContain("verdaccio");
  });
});

describe("purgeExtension saga — in-memory capability teardown", () => {
  beforeEach(() => setExtensionCapabilityTeardownHook(null));
  afterEach(() => setExtensionCapabilityTeardownHook(null));

  it("fires the teardown hook with the package name AFTER a committed DB delete", async () => {
    const tornDown: string[] = [];
    setExtensionCapabilityTeardownHook((pkg) => {
      calls.push("teardown");
      tornDown.push(pkg);
    });
    const deps = makeDeps();
    await purgeExtension(
      {
        packageName: "@cinatra-ai/foo-agent",
        expectedDigest: await digestFor("@cinatra-ai/foo-agent", deps),
        actor,
      },
      deps,
    );
    expect(tornDown).toEqual(["@cinatra-ai/foo-agent"]);
    // Teardown fires only after the committed DB delete (ordered after "db",
    // before the final purge_committed audit). There is no Verdaccio step.
    expect(calls.indexOf("teardown")).toBeGreaterThan(calls.indexOf("db"));
    expect(calls.indexOf("teardown")).toBeLessThan(
      calls.indexOf("audit:purge_committed"),
    );
    expect(calls).not.toContain("verdaccio");
  });

  it("does NOT fire teardown when the DB delete fails (rolled back, nothing committed)", async () => {
    const tornDown: string[] = [];
    setExtensionCapabilityTeardownHook((pkg) => tornDown.push(pkg));
    const deps = makeDeps({
      dbPurgeAtomic: async () => {
        calls.push("db-fail");
        throw new Error("db lock timeout");
      },
    });
    await expect(
      purgeExtension(
        {
          packageName: "@cinatra-ai/foo-agent",
          expectedDigest: await digestFor("@cinatra-ai/foo-agent", deps),
          actor,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(ExtensionPurgeRefused);
    expect(tornDown).toEqual([]);
  });

  it("FIRES teardown for a connector purge (in-memory register(ctx) cleanup, no disk/DB delete)", async () => {
    const tornDown: string[] = [];
    setExtensionCapabilityTeardownHook((pkg) => tornDown.push(pkg));
    const deps = makeDeps({
      resolvePackageKind: async () => "connector",
      getAgentPackage: async () => {
        throw new Error("no agent payload");
      },
      readTemplateByPackageName: async () => null,
    });
    await purgeExtension(
      {
        packageName: "@cinatra-ai/foo-connector",
        expectedDigest: await digestFor("@cinatra-ai/foo-connector", deps),
        actor,
      },
      deps,
    );
    // A connector skips the disk/DB delete (removesDiskDb=false), but its
    // in-memory register(ctx) registrations (MCP tools / capability providers /
    // ctx.ui) MUST still be torn down so a purged connector's providers (e.g. the
    // resend email-send provider) do not linger in the running process.
    expect(tornDown).toEqual(["@cinatra-ai/foo-connector"]);
  });

  it("a throwing teardown hook is swallowed — the committed purge still succeeds", async () => {
    setExtensionCapabilityTeardownHook(() => {
      throw new Error("registry teardown boom");
    });
    const deps = makeDeps();
    const res = await purgeExtension(
      {
        packageName: "@cinatra-ai/foo-agent",
        expectedDigest: await digestFor("@cinatra-ai/foo-agent", deps),
        actor,
      },
      deps,
    );
    expect(res.dbDiskDeleted).toBe(true);
    expect(res.stopped).toBe(false);
  });
});
