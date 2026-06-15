// #180 PR-2: dependency-BATCH install saga — authorize-once, ledger states,
// inverse-order compensation (newly-installed only), grant TTL/refresh,
// overlap guard, requires-rebuild pass-through, and the boot sweeper.
import { describe, expect, it, vi } from "vitest";

import {
  installExtensionWithDependencies,
  sweepStaleInstallBatches,
  BatchMemberInstallError,
  type InstallBatchSagaDeps,
} from "@/lib/extension-install-batch";
import type {
  InstallBatch,
  InstallBatchMember,
} from "@/lib/extension-install-batch-ops";
import type { DependencyInstallPlan, PlannedMember } from "@/lib/extension-dependency-plan";
import type { GatekeptInstallResolution } from "@/lib/gatekept-install";
import {
  GrantRefreshRefusedError,
  GrantRefreshUnavailableError,
  computeClosureHash,
  refreshGatekeptInstallGrant,
  // Re-exported from the host-side gatekept-install module so the real refresh
  // function can be driven against a real refusal WITHOUT a direct import of the
  // vendored marketplace transport package (the audit gate bans new sites).
  MarketplaceMcpError,
} from "@/lib/gatekept-install";
import type { Actor } from "@cinatra-ai/extension-types";

const actor: Actor = { actorType: "human", source: "ui", userId: "u1", orgId: null };
const ROOT = "@cinatra-ai/root";

function member(packageName: string, over: Partial<PlannedMember> = {}): PlannedMember {
  return {
    packageName,
    version: "1.0.0",
    typeId: "connector",
    edges: [],
    alreadyInstalled: false,
    ...over,
  };
}

function resolution(over: Partial<GatekeptInstallResolution["authorize"]> = {}): GatekeptInstallResolution {
  return {
    config: { registryUrl: "https://broker.example/install", packageScope: "@cinatra-ai", token: "grant-1", uiUrl: null },
    authorize: {
      kind: "connector",
      resolvedVersion: "1.0.0",
      closure: [
        { name: "@cinatra-ai/dep-a", version: "1.0.0" },
        { name: "@cinatra-ai/dep-b", version: "1.0.0" },
      ],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      ...over,
    },
  };
}

/** In-memory ledger + spies; plan injected per test. */
function makeHarness(opts: {
  plan: PlannedMember[];
  gatekept?: boolean;
  authorize?: () => Promise<GatekeptInstallResolution>;
  installFail?: string | ((pkg: string) => boolean);
  installRequiresRebuild?: string;
  activeBatches?: InstallBatch[];
  preInstalled?: string[];
  now?: () => number;
  refreshGrant?: InstallBatchSagaDeps["refreshGrant"];
  /** Simulate a caller-entered grant context (the MCP surface) to ADOPT. */
  adoptCtx?: ReturnType<InstallBatchSagaDeps["getActiveGrantContext"]>;
  ledgerFailOn?: string; // event name prefix that makes the ledger throw
}) {
  const events: string[] = [];
  const ledgerRows = new Map<string, InstallBatch>();
  const authorizeSpy = vi.fn(
    opts.authorize ?? (async () => resolution()),
  );

  const deps: InstallBatchSagaDeps = {
    isGatekeptInstallEnabled: () => opts.gatekept ?? false,
    getActiveGrantContext: () => opts.adoptCtx ?? null,
    authorizeRoot: authorizeSpy,
    refreshGrant:
      opts.refreshGrant ??
      (async () => {
        throw new Error("refresh unavailable (default test harness)");
      }),
    withGrantContext: async (_ctx, fn) => {
      events.push("enter-grant-context");
      return fn();
    },
    withGlobalLifecycleLock: async (fn) => {
      events.push("global-lock");
      return fn();
    },
    withSagaOwnedFanout: async (_root, fn) => {
      events.push("saga-fanout-context");
      return fn();
    },
    triggerAgentRuntimeReload: vi.fn(async () => {
      events.push("agent-reload");
      return { ok: true as const };
    }),
    plan: async () => {
      events.push("plan");
      const plan: DependencyInstallPlan = {
        ordered: opts.plan,
        root: { packageName: ROOT, version: "1.0.0" },
        source: opts.gatekept ? "marketplace-closure" : "manifest-walk",
        memberKinds: new Map(),
      };
      return plan;
    },
    installMember: vi.fn(async (m) => {
      const fail =
        typeof opts.installFail === "function"
          ? opts.installFail(m.packageName)
          : opts.installFail === m.packageName;
      if (fail) {
        events.push(`install-FAIL:${m.packageName}`);
        throw new Error(`materialize/serverEntry gate refused ${m.packageName}`);
      }
      if (opts.installRequiresRebuild === m.packageName) {
        events.push(`install-REBUILD:${m.packageName}`);
        throw Object.assign(new Error(`${m.packageName} requires a host rebuild`), {
          code: "REQUIRES_REBUILD",
        });
      }
      events.push(`install:${m.packageName}`);
    }),
    uninstallMember: vi.fn(async (m) => {
      events.push(`uninstall:${m.packageName}`);
    }),
    readLiveRowVersion: async (pkg) =>
      (opts.preInstalled ?? []).includes(pkg) ? { present: true, version: "0.9.0" } : { present: false },
    readInstallOp: async (pkg) => ({ installOpId: `${pkg}@op`, phase: "finalized" }),
    ledger: {
      begin: async (i) => {
        events.push("ledger:begin");
        const b: InstallBatch = {
          batchId: i.batchId,
          rootPackage: i.rootPackage,
          orgId: i.orgId,
          phase: "planning",
          members: i.members,
          createdAt: "now",
          updatedAt: "now",
        };
        ledgerRows.set(i.batchId, b);
        return b;
      },
      setPhase: async (id, phase) => {
        events.push(`ledger:phase:${phase}`);
        const b = ledgerRows.get(id)!;
        b.phase = phase;
        return b;
      },
      updateMember: async (id, pkg, patch) => {
        if (opts.ledgerFailOn && patch.status === opts.ledgerFailOn) {
          throw new Error(`ledger write failed (${pkg} -> ${patch.status})`);
        }
        const b = ledgerRows.get(id)!;
        b.members = b.members.map((m) => (m.packageName === pkg ? { ...m, ...patch } : m));
        if (patch.status) events.push(`ledger:${pkg}:${patch.status}`);
        return b;
      },
      listActive: async () => opts.activeBatches ?? [],
    },
    now: opts.now ?? (() => Date.now()),
  };
  return { deps, events, ledgerRows, authorizeSpy };
}

describe("installExtensionWithDependencies — happy path", () => {
  it("installs members DEPENDENCIES-FIRST then the root; ledger advances planned→installing→installed→finalized", async () => {
    const h = makeHarness({
      plan: [member("@cinatra-ai/dep-a"), member("@cinatra-ai/dep-b"), member(ROOT)],
    });
    const res = await installExtensionWithDependencies(
      { packageName: ROOT, version: "1.0.0", actor },
      h.deps,
    );
    expect(h.events.filter((e) => e.startsWith("install:"))).toEqual([
      "install:@cinatra-ai/dep-a",
      "install:@cinatra-ai/dep-b",
      `install:${ROOT}`,
    ]);
    expect(h.events).toContain("ledger:phase:finalized");
    expect(res.installed.map((m) => m.packageName)).toEqual([
      "@cinatra-ai/dep-a",
      "@cinatra-ai/dep-b",
      ROOT,
    ]);
    expect(res.batchId).not.toBeNull();
    // The batch ledger carries per-member install-op linkage.
    const batch = [...h.ledgerRows.values()][0]!;
    expect(batch.members.every((m) => m.status === "installed")).toBe(true);
    expect(batch.members[0]!.installOpId).toBe("@cinatra-ai/dep-a@op");
  });

  it("ROOT-ONLY fast path: a depless root installs directly — no ledger row", async () => {
    const h = makeHarness({ plan: [member(ROOT)] });
    const res = await installExtensionWithDependencies(
      { packageName: ROOT, version: "1.0.0", actor },
      h.deps,
    );
    expect(res.batchId).toBeNull();
    expect(h.events).not.toContain("ledger:begin");
    expect(h.events).toContain(`install:${ROOT}`);
  });

  it("already-installed members are SKIPPED (never re-installed)", async () => {
    const h = makeHarness({
      plan: [member("@cinatra-ai/dep-a", { alreadyInstalled: true }), member("@cinatra-ai/dep-b"), member(ROOT)],
    });
    const res = await installExtensionWithDependencies(
      { packageName: ROOT, version: "1.0.0", actor },
      h.deps,
    );
    expect(h.events).not.toContain("install:@cinatra-ai/dep-a");
    expect(res.alreadyInstalled).toEqual(["@cinatra-ai/dep-a"]);
  });
});

describe("installExtensionWithDependencies — #157 saga owns fan-out + single agent reload", () => {
  it("every member install runs INSIDE the saga-owned-fan-out context (agent handler installs root-only)", async () => {
    const h = makeHarness({
      plan: [member("@cinatra-ai/dep-a"), member("@cinatra-ai/dep-b"), member(ROOT)],
    });
    await installExtensionWithDependencies({ packageName: ROOT, version: "1.0.0", actor }, h.deps);
    // The fan-out context wraps EACH install dispatch.
    const fanoutEnters = h.events.filter((e) => e === "saga-fanout-context").length;
    const installs = h.events.filter((e) => e.startsWith("install:")).length;
    expect(installs).toBe(3);
    expect(fanoutEnters).toBe(3);
  });

  it("fires the SINGLE agent reload ONCE when an agent member is installed — after finalize", async () => {
    const h = makeHarness({
      plan: [member("@cinatra-ai/dep-a", { typeId: "skill" }), member(ROOT, { typeId: "agent" })],
    });
    await installExtensionWithDependencies({ packageName: ROOT, version: "1.0.0", actor }, h.deps);
    expect(h.events.filter((e) => e === "agent-reload")).toHaveLength(1);
    // Reload is the LAST step (after the batch is finalized).
    expect(h.events.indexOf("agent-reload")).toBeGreaterThan(h.events.indexOf("ledger:phase:finalized"));
  });

  it("does NOT reload when NO agent member was installed (connector/skill-only batch)", async () => {
    const h = makeHarness({
      plan: [member("@cinatra-ai/dep-a", { typeId: "skill" }), member(ROOT, { typeId: "connector" })],
    });
    await installExtensionWithDependencies({ packageName: ROOT, version: "1.0.0", actor }, h.deps);
    expect(h.events).not.toContain("agent-reload");
  });

  it("ROOT-ONLY fast path: an agent root reloads exactly once", async () => {
    const h = makeHarness({ plan: [member(ROOT, { typeId: "agent" })] });
    const res = await installExtensionWithDependencies({ packageName: ROOT, version: "1.0.0", actor }, h.deps);
    expect(res.batchId).toBeNull();
    expect(h.events.filter((e) => e === "saga-fanout-context")).toHaveLength(1);
    expect(h.events.filter((e) => e === "agent-reload")).toHaveLength(1);
  });

  it("ROOT-ONLY fast path: a NON-agent root does not reload", async () => {
    const h = makeHarness({ plan: [member(ROOT, { typeId: "connector" })] });
    await installExtensionWithDependencies({ packageName: ROOT, version: "1.0.0", actor }, h.deps);
    expect(h.events).not.toContain("agent-reload");
  });

  it("does NOT reload when a member install FAILS (batch compensates instead)", async () => {
    const h = makeHarness({
      plan: [member("@cinatra-ai/dep-a", { typeId: "agent" }), member(ROOT, { typeId: "agent" })],
      installFail: ROOT,
    });
    await expect(
      installExtensionWithDependencies({ packageName: ROOT, version: "1.0.0", actor }, h.deps),
    ).rejects.toThrow();
    expect(h.events).not.toContain("agent-reload");
  });

  it("a reload that THROWS is best-effort: the completed install still succeeds", async () => {
    const h = makeHarness({
      plan: [member("@cinatra-ai/dep-a", { typeId: "skill" }), member(ROOT, { typeId: "agent" })],
    });
    // The reload seam REJECTS (not just ok:false) — must be swallowed.
    h.deps.triggerAgentRuntimeReload = vi.fn(async () => {
      throw new Error("wayflow unreachable");
    });
    const res = await installExtensionWithDependencies(
      { packageName: ROOT, version: "1.0.0", actor },
      h.deps,
    );
    // Batch finalized + returned despite the reload throw.
    expect(res.batchId).not.toBeNull();
    expect(h.events).toContain("ledger:phase:finalized");
  });
});

describe("installExtensionWithDependencies — authorize-once (P2-4, test-asserted)", () => {
  it("gatekept: authorize is called EXACTLY ONCE for the whole batch; everything runs inside the grant context", async () => {
    const h = makeHarness({
      plan: [member("@cinatra-ai/dep-a"), member(ROOT)],
      gatekept: true,
    });
    await installExtensionWithDependencies({ packageName: ROOT, version: "1.0.0", actor }, h.deps);
    expect(h.authorizeSpy).toHaveBeenCalledTimes(1);
    // Context entered BEFORE planning/installs.
    expect(h.events.indexOf("enter-grant-context")).toBeLessThan(h.events.indexOf("plan"));
  });

  it("dev path: no authorize at all", async () => {
    const h = makeHarness({ plan: [member("@cinatra-ai/dep-a"), member(ROOT)], gatekept: false });
    await installExtensionWithDependencies({ packageName: ROOT, actor }, h.deps);
    expect(h.authorizeSpy).not.toHaveBeenCalled();
  });
});

describe("installExtensionWithDependencies — member failure ⇒ abort + inverse-order compensation", () => {
  it("a mid-batch member failure (e.g. the serverEntry gate) aborts the queue and uninstalls ONLY newly-installed members, inverse order", async () => {
    const h = makeHarness({
      plan: [member("@cinatra-ai/dep-a"), member("@cinatra-ai/dep-b"), member("@cinatra-ai/dep-c"), member(ROOT)],
      installFail: "@cinatra-ai/dep-c",
    });
    await expect(
      installExtensionWithDependencies({ packageName: ROOT, version: "1.0.0", actor }, h.deps),
    ).rejects.toBeInstanceOf(BatchMemberInstallError);
    // dep-a and dep-b installed, then dep-c failed → compensate b, then a (inverse).
    expect(h.events.filter((e) => e.startsWith("uninstall:"))).toEqual([
      "uninstall:@cinatra-ai/dep-b",
      "uninstall:@cinatra-ai/dep-a",
    ]);
    // The root never installed.
    expect(h.events).not.toContain(`install:${ROOT}`);
    const batch = [...h.ledgerRows.values()][0]!;
    expect(batch.phase).toBe("compensated");
    expect(batch.members.find((m) => m.packageName === "@cinatra-ai/dep-c")!.status).toBe("failed");
    expect(batch.members.find((m) => m.packageName === "@cinatra-ai/dep-a")!.status).toBe("compensated");
  });

  it("PRE-EXISTING members are NEVER uninstalled by compensation (pre-state discriminator)", async () => {
    const h = makeHarness({
      plan: [member("@cinatra-ai/dep-a"), member("@cinatra-ai/dep-b"), member(ROOT)],
      installFail: ROOT,
      // dep-a existed BEFORE the batch (e.g. an interrupted previous attempt
      // left it installed; the planner re-plans it after manual cleanup).
      preInstalled: ["@cinatra-ai/dep-a"],
    });
    await expect(
      installExtensionWithDependencies({ packageName: ROOT, version: "1.0.0", actor }, h.deps),
    ).rejects.toBeInstanceOf(BatchMemberInstallError);
    expect(h.events).toContain("uninstall:@cinatra-ai/dep-b");
    expect(h.events).not.toContain("uninstall:@cinatra-ai/dep-a");
  });

  it("a failed compensation marks the member compensation-failed, the batch failed, and the error says ROLLBACK INCOMPLETE", async () => {
    const h = makeHarness({
      plan: [member("@cinatra-ai/dep-a"), member(ROOT)],
      installFail: ROOT,
    });
    (h.deps.uninstallMember as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("uninstall refused"),
    );
    try {
      await installExtensionWithDependencies({ packageName: ROOT, version: "1.0.0", actor }, h.deps);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(BatchMemberInstallError);
      expect((e as BatchMemberInstallError).compensationFailures).toEqual(["@cinatra-ai/dep-a"]);
      expect((e as Error).message).toContain("ROLLBACK INCOMPLETE");
    }
    const batch = [...h.ledgerRows.values()][0]!;
    expect(batch.phase).toBe("failed");
    expect(batch.members.find((m) => m.packageName === "@cinatra-ai/dep-a")!.status).toBe(
      "compensation-failed",
    );
  });
});

describe("installExtensionWithDependencies — grant TTL / refresh (P2-5)", () => {
  it("near-expiry triggers the refresh seam; the refreshed grant continues the batch", async () => {
    const refreshed = resolution({ expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    refreshed.config.token = "grant-2";
    const refresh = vi.fn(async (_cur: unknown, root: { closureHash?: string }) => {
      // P2-5 binding: the seam receives the CURRENT closure's hash.
      expect(root.closureHash).toMatch(/^[0-9a-f]{64}$/);
      return refreshed;
    });
    const h = makeHarness({
      plan: [member("@cinatra-ai/dep-a"), member(ROOT)],
      gatekept: true,
      // The grant expires in 10s — inside the refresh margin.
      authorize: async () => resolution({ expiresAt: new Date(Date.now() + 10_000).toISOString() }),
      refreshGrant: refresh,
    });
    await installExtensionWithDependencies({ packageName: ROOT, version: "1.0.0", actor }, h.deps);
    expect(refresh).toHaveBeenCalled();
    expect(h.events).toContain(`install:${ROOT}`);
  });

  it("refresh UNAVAILABLE near expiry ⇒ abort + compensate (never proceeds under an expired grant)", async () => {
    const h = makeHarness({
      plan: [member("@cinatra-ai/dep-a"), member("@cinatra-ai/dep-b"), member(ROOT)],
      gatekept: true,
      authorize: async () => resolution({ expiresAt: new Date(Date.now() + 10_000).toISOString() }),
      // default harness refreshGrant throws "refresh unavailable"
    });
    await expect(
      installExtensionWithDependencies({ packageName: ROOT, version: "1.0.0", actor }, h.deps),
    ).rejects.toBeInstanceOf(BatchMemberInstallError);
    // Nothing installed before the first member's TTL check → nothing to uninstall.
    expect(h.events.filter((e) => e.startsWith("install:"))).toEqual([]);
    const batch = [...h.ledgerRows.values()][0]!;
    expect(["compensated", "failed"]).toContain(batch.phase);
  });

  it("a refresh that returns a DIFFERENT closure is refused (closure-hash binding)", async () => {
    const drifted = resolution();
    drifted.authorize.closure = [{ name: "@cinatra-ai/dep-a", version: "9.9.9" }];
    const h = makeHarness({
      plan: [member("@cinatra-ai/dep-a"), member(ROOT)],
      gatekept: true,
      authorize: async () => resolution({ expiresAt: new Date(Date.now() + 10_000).toISOString() }),
      refreshGrant: async () => drifted,
    });
    await expect(
      installExtensionWithDependencies({ packageName: ROOT, version: "1.0.0", actor }, h.deps),
    ).rejects.toBeInstanceOf(BatchMemberInstallError);
  });

  it("a rate-limited refresh refusal near expiry ⇒ abort + compensate (never proceeds)", async () => {
    const h = makeHarness({
      plan: [member("@cinatra-ai/dep-a"), member("@cinatra-ai/dep-b"), member(ROOT)],
      gatekept: true,
      authorize: async () => resolution({ expiresAt: new Date(Date.now() + 10_000).toISOString() }),
      refreshGrant: async () => {
        throw new GrantRefreshRefusedError("rate_limited", 429);
      },
    });
    await expect(
      installExtensionWithDependencies({ packageName: ROOT, version: "1.0.0", actor }, h.deps),
    ).rejects.toBeInstanceOf(BatchMemberInstallError);
    // Refusal hits the FIRST member's TTL check → nothing installed yet.
    expect(h.events.filter((e) => e.startsWith("install:"))).toEqual([]);
    const batch = [...h.ledgerRows.values()][0]!;
    expect(["compensated", "failed"]).toContain(batch.phase);
  });

  it("an op-deadline refresh refusal near expiry ⇒ abort + compensate", async () => {
    const h = makeHarness({
      plan: [member("@cinatra-ai/dep-a"), member(ROOT)],
      gatekept: true,
      authorize: async () => resolution({ expiresAt: new Date(Date.now() + 10_000).toISOString() }),
      refreshGrant: async () => {
        throw new GrantRefreshRefusedError("op_deadline", 403);
      },
    });
    await expect(
      installExtensionWithDependencies({ packageName: ROOT, version: "1.0.0", actor }, h.deps),
    ).rejects.toBeInstanceOf(BatchMemberInstallError);
  });

  it("an UNPARSEABLE active grant expiry ⇒ abort + compensate (never proceeds; refresh NOT even attempted)", async () => {
    const refresh = vi.fn(async () => resolution());
    const h = makeHarness({
      plan: [member("@cinatra-ai/dep-a"), member("@cinatra-ai/dep-b"), member(ROOT)],
      gatekept: true,
      // A garbage expiry that Date.parse → NaN: the saga must fail closed, NOT
      // silently skip the TTL check and run under an unprovable grant.
      authorize: async () => resolution({ expiresAt: "not-a-date" }),
      refreshGrant: refresh,
    });
    await expect(
      installExtensionWithDependencies({ packageName: ROOT, version: "1.0.0", actor }, h.deps),
    ).rejects.toBeInstanceOf(BatchMemberInstallError);
    expect(h.events.filter((e) => e.startsWith("install:"))).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
    const batch = [...h.ledgerRows.values()][0]!;
    expect(["compensated", "failed"]).toContain(batch.phase);
  });
});

// END-TO-END TTL-CROSSING PROOF (#209.1): unlike the stub-seam tests above (which
// inject a `vi.fn` for `deps.refreshGrant`), these drive the REAL
// `refreshGatekeptInstallGrant` through the saga — the actual wire path that
// presents the opaque grant to the marketplace `extension_install_grant_refresh`
// ability, validates the closure-hash binding + re-mint/version/closure
// invariants, and maps refusal-class errors. The marketplace ability is faked by
// an INLINE refresh-client (so this non-allowlisted test never imports the
// vendored marketplace transport package by name); the grant crosses its TTL
// mid-batch and the batch either completes under the refreshed grant (positive)
// or compensates on a real-mapped refusal (negative).
describe("installExtensionWithDependencies — REAL refreshGatekeptInstallGrant through the saga (P2-5 e2e)", () => {
  // The 3rd param of `refreshGatekeptInstallGrant` is the injectable marketplace
  // client; deriving the type from the function signature avoids naming the
  // vendored package (the import-ban audit forbids new vendored call sites here).
  type RefreshClient = NonNullable<Parameters<typeof refreshGatekeptInstallGrant>[2]>;
  type RefreshOutput = Awaited<ReturnType<RefreshClient["extensionInstallGrantRefresh"]>>;

  /** The closure the harness `resolution()` authorizes (dep-a@1.0.0, dep-b@1.0.0). */
  const CLOSURE = [
    { name: "@cinatra-ai/dep-a", version: "1.0.0" },
    { name: "@cinatra-ai/dep-b", version: "1.0.0" },
  ];
  const CLOSURE_HASH = computeClosureHash(CLOSURE);

  /** An inline marketplace refresh-client whose single tool the real function calls. */
  function refreshClient(
    impl: (input: { grant: string }) => Promise<RefreshOutput>,
  ): { client: RefreshClient; spy: ReturnType<typeof vi.fn> } {
    const spy = vi.fn(impl);
    return { client: { extensionInstallGrantRefresh: spy } as unknown as RefreshClient, spy };
  }

  it("a batch that CROSSES the grant TTL drives the real refresh: presents the opaque grant, swaps it in-place, and completes", async () => {
    const refreshedGrant = "refreshed-opaque-grant";
    const { client, spy } = refreshClient(async () => ({
      grant: refreshedGrant,
      resolved_version: "1.0.0",
      broker_base_url: "https://broker.example/install/refreshed",
      closure: CLOSURE,
      // Epoch SECONDS well past the 60s near-expiry margin (the real function
      // converts *1000 → ISO and rejects anything still inside the margin).
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      closure_hash: CLOSURE_HASH,
      op: "op-refresh-xyz",
    }));

    // Capture the SAME resolution object the saga holds by reference (it mutates
    // `config`/`authorize` in place after a refresh), expiring inside the margin.
    const current = resolution({ expiresAt: new Date(Date.now() + 10_000).toISOString() });
    current.config.token = "original-opaque-grant";

    const h = makeHarness({
      plan: [member("@cinatra-ai/dep-a"), member(ROOT)],
      gatekept: true,
      authorize: async () => current,
      // The DEFAULT factory passes refreshGrant positionally as (current, root);
      // wrap the REAL function with the inline client (its optional 3rd param).
      refreshGrant: (cur, root) => refreshGatekeptInstallGrant(cur, root, client),
    });

    // Observe the grant token the saga has live at each member install — proves
    // the in-place mutation reached member reads BEFORE the install dispatched.
    const tokensAtInstall: string[] = [];
    const baseInstall = h.deps.installMember;
    h.deps.installMember = async (m, a) => {
      tokensAtInstall.push(current.config.token!);
      return baseInstall(m, a);
    };

    await installExtensionWithDependencies({ packageName: ROOT, version: "1.0.0", actor }, h.deps);

    // The REAL wire call fired with the ORIGINAL opaque grant (presented, never decoded).
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ grant: "original-opaque-grant" });
    // In-place mutation: the saga swapped the resolution to the refreshed grant.
    expect(current.config.token).toBe(refreshedGrant);
    expect(current.config.registryUrl).toBe("https://broker.example/install/refreshed");
    // Every member install ran under the REFRESHED grant (the first member's TTL
    // check refreshed before any install dispatched).
    expect(tokensAtInstall).toEqual([refreshedGrant, refreshedGrant]);
    // The batch completed.
    expect(h.events).toContain(`install:${ROOT}`);
    expect(h.events).toContain("ledger:phase:finalized");
  });

  it("a rate-limited (429) marketplace refusal flows through the REAL function ⇒ GrantRefreshRefusedError ⇒ abort + compensate (nothing installed)", async () => {
    const { client, spy } = refreshClient(async () => {
      throw new MarketplaceMcpError("rate_limited", 429, "");
    });
    const current = resolution({ expiresAt: new Date(Date.now() + 10_000).toISOString() });
    current.config.token = "original-opaque-grant";

    const h = makeHarness({
      plan: [member("@cinatra-ai/dep-a"), member("@cinatra-ai/dep-b"), member(ROOT)],
      gatekept: true,
      authorize: async () => current,
      refreshGrant: (cur, root) => refreshGatekeptInstallGrant(cur, root, client),
    });

    const err = await installExtensionWithDependencies(
      { packageName: ROOT, version: "1.0.0", actor },
      h.deps,
    ).catch((e) => e);

    // The real function mapped the 429 into the REFUSAL class; the saga wrapped
    // the abort into a BatchMemberInstallError whose cause is that refusal.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(BatchMemberInstallError);
    expect((err as BatchMemberInstallError).cause).toBeInstanceOf(GrantRefreshRefusedError);
    expect(((err as BatchMemberInstallError).cause as GrantRefreshRefusedError).httpStatus).toBe(429);
    // Refusal hit the FIRST member's TTL check → nothing installed yet.
    expect(h.events.filter((e) => e.startsWith("install:"))).toEqual([]);
    const batch = [...h.ledgerRows.values()][0]!;
    expect(["compensated", "failed"]).toContain(batch.phase);
  });

  it("a 503 (unreachable) refusal flows through the REAL function ⇒ GrantRefreshUnavailableError ⇒ abort + compensate", async () => {
    const { client } = refreshClient(async () => {
      throw new MarketplaceMcpError("internal", 503, "");
    });
    const current = resolution({ expiresAt: new Date(Date.now() + 10_000).toISOString() });
    current.config.token = "original-opaque-grant";

    const h = makeHarness({
      plan: [member("@cinatra-ai/dep-a"), member(ROOT)],
      gatekept: true,
      authorize: async () => current,
      refreshGrant: (cur, root) => refreshGatekeptInstallGrant(cur, root, client),
    });

    const err = await installExtensionWithDependencies(
      { packageName: ROOT, version: "1.0.0", actor },
      h.deps,
    ).catch((e) => e);

    expect(err).toBeInstanceOf(BatchMemberInstallError);
    expect((err as BatchMemberInstallError).cause).toBeInstanceOf(GrantRefreshUnavailableError);
    expect(h.events.filter((e) => e.startsWith("install:"))).toEqual([]);
  });

  it("a refresh that re-mints a DIFFERENT closure is refused by the REAL function (closure-hash binding) ⇒ abort + compensate", async () => {
    const { client, spy } = refreshClient(async () => ({
      grant: "refreshed-opaque-grant",
      resolved_version: "1.0.0",
      // A closure that does NOT hash-equal the authorized set.
      closure: [{ name: "@cinatra-ai/dep-a", version: "9.9.9" }],
      broker_base_url: "https://broker.example/install/refreshed",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      closure_hash: computeClosureHash([{ name: "@cinatra-ai/dep-a", version: "9.9.9" }]),
      op: "op-refresh-xyz",
    }));
    const current = resolution({ expiresAt: new Date(Date.now() + 10_000).toISOString() });
    current.config.token = "original-opaque-grant";

    const h = makeHarness({
      plan: [member("@cinatra-ai/dep-a"), member(ROOT)],
      gatekept: true,
      authorize: async () => current,
      refreshGrant: (cur, root) => refreshGatekeptInstallGrant(cur, root, client),
    });

    const err = await installExtensionWithDependencies(
      { packageName: ROOT, version: "1.0.0", actor },
      h.deps,
    ).catch((e) => e);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(BatchMemberInstallError);
    expect((err as BatchMemberInstallError).cause).toBeInstanceOf(GrantRefreshRefusedError);
    expect(h.events.filter((e) => e.startsWith("install:"))).toEqual([]);
    // The original grant was never swapped — the saga still holds it.
    expect(current.config.token).toBe("original-opaque-grant");
  });
});

describe("installExtensionWithDependencies — concurrency contract", () => {
  it("refuses when an ACTIVE batch overlaps the planned member set (same org scope)", async () => {
    const active: InstallBatch = {
      batchId: "other-batch",
      rootPackage: "@cinatra-ai/other-root",
      orgId: null,
      phase: "installing",
      members: [
        {
          packageName: "@cinatra-ai/dep-a",
          version: "1.0.0",
          typeId: "connector",
          status: "installing",
          preState: { present: false },
        },
      ],
      createdAt: "now",
      updatedAt: "now",
    };
    const h = makeHarness({
      plan: [member("@cinatra-ai/dep-a"), member(ROOT)],
      activeBatches: [active],
    });
    await expect(
      installExtensionWithDependencies({ packageName: ROOT, version: "1.0.0", actor }, h.deps),
    ).rejects.toThrow(/another install batch .* overlaps this install on: @cinatra-ai\/dep-a/);
    expect(h.events).not.toContain("ledger:begin");
    expect(h.events.filter((e) => e.startsWith("install:"))).toEqual([]);
  });

  it("the overlap guard ALSO covers the root-only fast path (a member of an in-flight batch cannot be reset by a direct install)", async () => {
    const active: InstallBatch = {
      batchId: "other-batch",
      rootPackage: "@cinatra-ai/other-root",
      orgId: null,
      phase: "installing",
      members: [
        {
          packageName: ROOT, // the direct install's target is a MEMBER of the in-flight batch
          version: "1.0.0",
          typeId: "connector",
          status: "installing",
          preState: { present: false },
        },
      ],
      createdAt: "now",
      updatedAt: "now",
    };
    const h = makeHarness({ plan: [member(ROOT)], activeBatches: [active] });
    await expect(
      installExtensionWithDependencies({ packageName: ROOT, version: "1.0.0", actor }, h.deps),
    ).rejects.toThrow(/overlaps this install on/);
    expect(h.events).not.toContain(`install:${ROOT}`);
  });

  it("planning + ledger-begin happen under the GLOBAL lifecycle lock", async () => {
    const h = makeHarness({ plan: [member("@cinatra-ai/dep-a"), member(ROOT)] });
    await installExtensionWithDependencies({ packageName: ROOT, version: "1.0.0", actor }, h.deps);
    expect(h.events.indexOf("global-lock")).toBeLessThan(h.events.indexOf("plan"));
    expect(h.events.indexOf("plan")).toBeLessThan(h.events.indexOf("ledger:begin"));
    // Member installs run AFTER the lock-scoped block (the lock callback only
    // wraps plan+begin in this harness, mirroring the real saga).
  });
});

describe("installExtensionWithDependencies — REQUIRES_REBUILD is a REFUSAL (nothing durable installed)", () => {
  it("the RAW structured error is rethrown (surface contract) AFTER newly-installed deps are compensated", async () => {
    const h = makeHarness({
      plan: [member("@cinatra-ai/dep-a"), member(ROOT)],
      installRequiresRebuild: ROOT,
    });
    try {
      await installExtensionWithDependencies({ packageName: ROOT, version: "1.0.0", actor }, h.deps);
      expect.unreachable("root rebuild refusal must propagate");
    } catch (e) {
      // RAW (un-wrapped) so the MCP surface keeps its { requiresRebuild } result.
      expect((e as { code?: string }).code).toBe("REQUIRES_REBUILD");
      expect(e).not.toBeInstanceOf(BatchMemberInstallError);
    }
    // The dispatcher rolled back the refusing package's placeholder row —
    // nothing durable installed for it — so the batch compensates the deps
    // it DID install and never reports success.
    const batch = [...h.ledgerRows.values()][0]!;
    expect(batch.phase).toBe("compensated");
    expect(h.events.filter((e) => e.startsWith("uninstall:"))).toEqual(["uninstall:@cinatra-ai/dep-a"]);
  });
});

describe("installExtensionWithDependencies — ledger failures route into the SAME abort/compensation path", () => {
  it("a ledger write failing AFTER members installed compensates them and surfaces BatchMemberInstallError", async () => {
    const h = makeHarness({
      plan: [member("@cinatra-ai/dep-a"), member("@cinatra-ai/dep-b"), member(ROOT)],
      // The 'installed' transition for dep-b throws AFTER its install succeeded.
      ledgerFailOn: "installed",
    });
    // dep-a's 'installed' write fails first — so dep-a installs, then the
    // ledger throws, then compensation uninstalls dep-a.
    await expect(
      installExtensionWithDependencies({ packageName: ROOT, version: "1.0.0", actor }, h.deps),
    ).rejects.toBeInstanceOf(BatchMemberInstallError);
    expect(h.events).toContain("install:@cinatra-ai/dep-a");
    expect(h.events).toContain("uninstall:@cinatra-ai/dep-a");
    expect(h.events).not.toContain(`install:${ROOT}`);
  });
});

describe("installExtensionWithDependencies — caller-context ADOPTION (MCP surface)", () => {
  it("an active grant context for the SAME root is adopted: NO second authorize, kinds filled into the caller's map", async () => {
    const callerKinds = new Map<string, "agent" | "skill" | "connector" | "artifact" | "workflow">();
    const adoptCtx = {
      rootPackageName: ROOT,
      resolution: resolution(),
      memberKinds: callerKinds,
    };
    const h = makeHarness({
      plan: [member("@cinatra-ai/dep-a"), member(ROOT)],
      gatekept: true,
      adoptCtx,
    });
    await installExtensionWithDependencies({ packageName: ROOT, version: "1.0.0", actor }, h.deps);
    expect(h.authorizeSpy).not.toHaveBeenCalled(); // the caller's authorize was THE one
    expect(h.events).not.toContain("enter-grant-context"); // runs inside the adopted context
    expect(h.events).toContain(`install:${ROOT}`);
  });

  it("an active context for a DIFFERENT root is NOT adopted — the batch authorizes its own root", async () => {
    const adoptCtx = {
      rootPackageName: "@cinatra-ai/some-other-root",
      resolution: resolution(),
      memberKinds: new Map<string, "agent" | "skill" | "connector" | "artifact" | "workflow">(),
    };
    const h = makeHarness({
      plan: [member("@cinatra-ai/dep-a"), member(ROOT)],
      gatekept: true,
      adoptCtx,
    });
    await installExtensionWithDependencies({ packageName: ROOT, version: "1.0.0", actor }, h.deps);
    expect(h.authorizeSpy).toHaveBeenCalledTimes(1);
    expect(h.events).toContain("enter-grant-context");
  });
});

describe("sweepStaleInstallBatches — boot recovery (compensate-never-resume)", () => {
  function staleBatch(members: InstallBatchMember[]): InstallBatch {
    return {
      batchId: "stale-1",
      rootPackage: ROOT,
      orgId: null,
      phase: "installing",
      members,
      createdAt: "then",
      updatedAt: "then",
    };
  }

  it("uninstalls newly-installed (and mid-flight) members in INVERSE ledger order; pre-existing members untouched; batch → compensated", async () => {
    const uninstalled: string[] = [];
    const phases: string[] = [];
    const batch = staleBatch([
      { packageName: "@cinatra-ai/dep-a", version: "1.0.0", typeId: "connector", status: "installed", preState: { present: false } },
      { packageName: "@cinatra-ai/dep-b", version: "1.0.0", typeId: "connector", status: "installing", preState: { present: false } },
      { packageName: "@cinatra-ai/pre", version: "1.0.0", typeId: "connector", status: "installed", preState: { present: true, version: "0.9.0" } },
      { packageName: ROOT, version: "1.0.0", typeId: "connector", status: "planned", preState: { present: false } },
    ]);
    const res = await sweepStaleInstallBatches(
      { olderThanMs: 1000 },
      {
        listStale: async () => [batch],
        setPhase: async (_id, phase) => {
          phases.push(phase);
          return batch;
        },
        updateMember: async (_id, _pkg, _patch) => batch,
        uninstallMember: async (m) => {
          uninstalled.push(m.packageName);
        },
      },
    );
    expect(res.swept).toBe(1);
    // Inverse ledger order; `planned` (never began) and pre-existing skipped.
    expect(uninstalled).toEqual(["@cinatra-ai/dep-b", "@cinatra-ai/dep-a"]);
    expect(phases).toEqual(["compensated"]);
  });

  it("a failed sweep-compensation marks the batch failed (operator attention), not compensated", async () => {
    const phases: string[] = [];
    const batch = staleBatch([
      { packageName: "@cinatra-ai/dep-a", version: "1.0.0", typeId: "connector", status: "installed", preState: { present: false } },
    ]);
    await sweepStaleInstallBatches(
      { olderThanMs: 1000 },
      {
        listStale: async () => [batch],
        setPhase: async (_id, phase) => {
          phases.push(phase);
          return batch;
        },
        updateMember: async () => batch,
        uninstallMember: async () => {
          throw new Error("uninstall refused");
        },
      },
    );
    expect(phases).toEqual(["failed"]);
  });
});
