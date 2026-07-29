// #180 PR-2: dependency-BATCH install saga — authorize-once, ledger states,
// inverse-order compensation (newly-installed only), grant TTL/refresh,
// overlap guard, requires-rebuild pass-through, and the boot sweeper.
import { describe, expect, it, vi } from "vitest";

import {
  installExtensionWithDependencies,
  sweepStaleInstallBatches,
  gcOrphanedSideBySideCapsules,
  resolveRowScopedCompensationTarget,
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
    // cinatra#1039: the resolved rowOwnership tuple (decision 4). Default to the
    // platform tuple for the batch harness; overridable per test via `over`.
    rowOwnership: { ownerLevel: "platform", ownerId: null, organizationId: null },
    action: "install",
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
  installContractViolation?: string;
  activeBatches?: InstallBatch[];
  preInstalled?: string[];
  now?: () => number;
  refreshGrant?: InstallBatchSagaDeps["refreshGrant"];
  /** Simulate a caller-entered grant context (the MCP surface) to ADOPT. */
  adoptCtx?: ReturnType<InstallBatchSagaDeps["getActiveGrantContext"]>;
  ledgerFailOn?: string; // event name prefix that makes the ledger throw
  /** cinatra#1927: packages whose OWN declaration marks them protected — the
   *  saga must never tear one down on either compensation inverse. */
  protectedPackages?: string[];
  /** cinatra#1927: make the protection reader THROW (present-but-unreadable
   *  declaration) so the fail-closed skip can be asserted. */
  protectionReadFails?: boolean;
}) {
  const events: string[] = [];
  const sbsTeardownCapsules: Array<{ packageName: string; capsule: unknown }> = [];
  // #1042 slice-1/2 captures.
  const updateExpectedVersions: Array<{ packageName: string; expected: string | undefined }> = [];
  const rowScopedUninstalls: string[] = [];
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
      if (opts.installContractViolation === m.packageName) {
        events.push(`install-CONTRACT:${m.packageName}`);
        throw Object.assign(
          new Error(
            `Agent package "${m.packageName}" fails the metadata contract — ` +
              `missing or invalid required field(s): cinatra.riskLevel, cinatra.toolAccess.`,
          ),
          {
            code: "AGENT_PACKAGE_CONTRACT_VIOLATION",
            packageName: m.packageName,
            missingFields: ["cinatra.riskLevel", "cinatra.toolAccess"],
          },
        );
      }
      events.push(`install:${m.packageName}`);
    }),
    updateMemberPackage: vi.fn(async (m, _actor, expectedInstalledVersion) => {
      // #1042 slice-1: record the CAS precondition the batch forwarded.
      updateExpectedVersions.push({ packageName: m.packageName, expected: expectedInstalledVersion });
      const fail =
        typeof opts.installFail === "function"
          ? opts.installFail(m.packageName)
          : opts.installFail === m.packageName;
      if (fail) {
        events.push(`update-FAIL:${m.packageName}`);
        throw new Error(`update pipeline refused ${m.packageName}`);
      }
      events.push(`update:${m.packageName}`);
    }),
    uninstallMember: vi.fn(async (m) => {
      events.push(`uninstall:${m.packageName}`);
    }),
    // cinatra#1927: the declaration-driven protection verdict the saga consults
    // before EITHER compensation inverse.
    isMemberProtected: vi.fn(async (packageName: string) => {
      if (opts.protectionReadFails) {
        // The real default dep swallows a reader throw and answers PROTECTED
        // (fail-closed); the harness models that resolved answer directly.
        events.push(`protection-unreadable:${packageName}`);
        return true;
      }
      return (opts.protectedPackages ?? []).includes(packageName);
    }),
    // #1042 slice-2: row-scoped compensation inverse.
    uninstallMemberRowScoped: vi.fn(async (m) => {
      rowScopedUninstalls.push(m.packageName);
      events.push(`uninstall-row-scoped:${m.packageName}`);
    }),
    // cinatra#1040 S3: version-scoped side-by-side install + teardown seams.
    installMemberSideBySide: vi.fn(async (m) => {
      const fail =
        typeof opts.installFail === "function"
          ? opts.installFail(m.packageName)
          : opts.installFail === m.packageName;
      if (fail) {
        events.push(`side-by-side-FAIL:${m.packageName}`);
        throw new Error(`side-by-side installer refused ${m.packageName}`);
      }
      // cinatra#1040 S6: the real installer captures the ownership DECLARATION
      // CAPSULE via the injected sink BEFORE it mutates the grant. Simulate it.
      await m.persistCapsule?.({ v: 1, declaredTokenKeys: [`${m.packageName}__k`] });
      events.push(`side-by-side:${m.packageName}@${m.version}@scope=${m.scopeOrgId ?? "(platform)"}`);
    }),
    uninstallSideBySideMember: vi.fn(async (m) => {
      // cinatra#1040 S6: record the capsule the teardown received (for reconcile).
      sbsTeardownCapsules.push({ packageName: m.packageName, capsule: m.capsule ?? null });
      events.push(
        `uninstall-side-by-side:${m.packageName}@${m.version}@scope=${m.scopeOrgId ?? "(platform)"}`,
      );
    }),
    readInstallOpForVersion: async (pkg, _oid, version) => ({
      installOpId: `${pkg}@${version}@op`,
      phase: "finalized",
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
  return {
    deps,
    events,
    ledgerRows,
    authorizeSpy,
    sbsTeardownCapsules,
    updateExpectedVersions,
    rowScopedUninstalls,
  };
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

// #1039 Option B — leave-at-NEW committed dedupe-upward on the dev/non-gatekept path.
describe("installExtensionWithDependencies — #1039 Option B committed dedupe-upward", () => {
  it("an action:'update' member is routed through the UPDATE pipeline (not install) and surfaced in result.updated", async () => {
    const h = makeHarness({
      // The shared dep is pre-installed at 0.9.0 and planned as a committed upgrade.
      preInstalled: ["@cinatra-ai/shared"],
      plan: [
        member("@cinatra-ai/shared", { action: "update", version: "1.0.0" }),
        member(ROOT),
      ],
    });
    const res = await installExtensionWithDependencies({ packageName: ROOT, version: "1.0.0", actor }, h.deps);
    // Dispatched via the update pipeline, never the install one.
    expect(h.events).toContain("update:@cinatra-ai/shared");
    expect(h.events).not.toContain("install:@cinatra-ai/shared");
    expect(h.events).toContain(`install:${ROOT}`);
    // Partitioned in the result.
    expect(res.updated).toEqual([{ packageName: "@cinatra-ai/shared", version: "1.0.0" }]);
    expect(res.installed.map((m) => m.packageName)).toEqual([ROOT]);
  });

  it("COMMITTED: a later member's failure rolls back fresh members but LEAVES the upgraded shared dep (never uninstalled)", async () => {
    const h = makeHarness({
      preInstalled: ["@cinatra-ai/shared"],
      // dep-a is a fresh install; shared is a committed update; the ROOT fails.
      plan: [
        member("@cinatra-ai/shared", { action: "update", version: "1.0.0" }),
        member("@cinatra-ai/dep-a"),
        member(ROOT),
      ],
      installFail: ROOT,
    });
    await expect(
      installExtensionWithDependencies({ packageName: ROOT, version: "1.0.0", actor }, h.deps),
    ).rejects.toThrow();
    // The committed upgrade ran and was NEVER compensated (pre-existing member).
    expect(h.events).toContain("update:@cinatra-ai/shared");
    expect(h.events).not.toContain("uninstall:@cinatra-ai/shared");
    // The fresh member IS rolled back.
    expect(h.events).toContain("uninstall:@cinatra-ai/dep-a");
  });

  it("the boot sweeper leaves a committed update member untouched (preState.present)", async () => {
    // A stale batch whose shared-dep update reached 'installed' must NOT be
    // uninstalled by the sweeper — it is a pre-existing (preState.present)
    // member, so it is committed exactly like the mid-batch compensation path.
    const swept: string[] = [];
    const stale: InstallBatch = {
      batchId: "b-stale",
      rootPackage: ROOT,
      orgId: null,
      phase: "installing",
      members: [
        {
          packageName: "@cinatra-ai/shared",
          version: "1.0.0",
          typeId: "connector",
          status: "installed",
          action: "update",
          preState: { present: true, version: "0.9.0" },
        },
        {
          packageName: "@cinatra-ai/dep-a",
          version: "1.0.0",
          typeId: "connector",
          status: "installed",
          action: "install",
          preState: { present: false },
        },
      ],
      createdAt: "now",
      updatedAt: "now",
    };
    const { swept: n } = await sweepStaleInstallBatches(
      { olderThanMs: 0 },
      {
        listStale: async () => [stale],
        setPhase: async (_id, _p) => stale,
        updateMember: async (_id, _pkg, _patch) => stale,
        uninstallMember: async (m) => {
          swept.push(m.packageName);
        },
      },
    );
    expect(n).toBe(1);
    // Only the fresh member is compensated; the committed update stays.
    expect(swept).toEqual(["@cinatra-ai/dep-a"]);
    expect(swept).not.toContain("@cinatra-ai/shared");
  });
});

// #1039 Option B — UPDATE-TIME slice: updateExtensionPackage / extensions_update
// route the ROOT through the durable UPDATE pipeline as a COMMITTED member while
// the new version's newly required deps auto-install FRESH dependencies-first.
describe("installExtensionWithDependencies — #1039 Option B update-time (rootAction:'update')", () => {
  it("root-only fast path: a committed root update routes through the UPDATE pipeline and surfaces in result.updated", async () => {
    const h = makeHarness({
      preInstalled: [ROOT], // the root is already installed (an in-place update)
      plan: [member(ROOT, { action: "update" })],
    });
    const res = await installExtensionWithDependencies(
      { packageName: ROOT, version: "1.0.0", actor, rootAction: "update" },
      h.deps,
    );
    // No ledger row (depless), dispatched via the update pipeline, not install.
    expect(res.batchId).toBeNull();
    expect(h.events).toContain(`update:${ROOT}`);
    expect(h.events).not.toContain(`install:${ROOT}`);
    // Surfaced under `updated`, never `installed`.
    expect(res.updated).toEqual([{ packageName: ROOT, version: "1.0.0" }]);
    expect(res.installed).toEqual([]);
  });

  it("batched: the new version's new dep installs FRESH, the root updates in place; result partitions install vs update", async () => {
    const h = makeHarness({
      // The root is already installed; the new required dep is fresh.
      preInstalled: [ROOT],
      plan: [member("@cinatra-ai/new-dep"), member(ROOT, { action: "update" })],
    });
    const res = await installExtensionWithDependencies(
      { packageName: ROOT, version: "1.0.0", actor, rootAction: "update" },
      h.deps,
    );
    expect(h.events).toContain("install:@cinatra-ai/new-dep");
    expect(h.events).toContain(`update:${ROOT}`);
    expect(h.events).not.toContain(`install:${ROOT}`);
    // Dependencies-first: the fresh dep installs BEFORE the root update.
    expect(h.events.indexOf("install:@cinatra-ai/new-dep")).toBeLessThan(
      h.events.indexOf(`update:${ROOT}`),
    );
    expect(res.installed.map((m) => m.packageName)).toEqual(["@cinatra-ai/new-dep"]);
    expect(res.updated.map((m) => m.packageName)).toEqual([ROOT]);
  });

  it("a fresh new-dep failure aborts BEFORE the root update — the root is never touched", async () => {
    const h = makeHarness({
      preInstalled: [ROOT],
      plan: [member("@cinatra-ai/new-dep"), member(ROOT, { action: "update" })],
      installFail: "@cinatra-ai/new-dep",
    });
    await expect(
      installExtensionWithDependencies(
        { packageName: ROOT, version: "1.0.0", actor, rootAction: "update" },
        h.deps,
      ),
    ).rejects.toThrow();
    expect(h.events).toContain("install-FAIL:@cinatra-ai/new-dep");
    // The root update is LAST — a pre-root member failure means it never ran.
    expect(h.events).not.toContain(`update:${ROOT}`);
  });

  it("boot sweeper leaves a committed ROOT update member untouched (preState.present); only fresh deps roll back", async () => {
    const swept: string[] = [];
    const stale: InstallBatch = {
      batchId: "b-stale-update",
      rootPackage: ROOT,
      orgId: null,
      phase: "installing",
      members: [
        {
          packageName: "@cinatra-ai/new-dep",
          version: "1.0.0",
          typeId: "connector",
          status: "installed",
          action: "install",
          preState: { present: false },
        },
        {
          packageName: ROOT,
          version: "1.0.0",
          typeId: "connector",
          status: "installed",
          action: "update",
          preState: { present: true, version: "0.9.0" },
        },
      ],
      createdAt: "now",
      updatedAt: "now",
    };
    const { swept: n } = await sweepStaleInstallBatches(
      { olderThanMs: 0 },
      {
        listStale: async () => [stale],
        setPhase: async (_id, _p) => stale,
        updateMember: async (_id, _pkg, _patch) => stale,
        uninstallMember: async (m) => {
          swept.push(m.packageName);
        },
      },
    );
    expect(n).toBe(1);
    // The committed root update stays; only the fresh dep is compensated.
    expect(swept).toEqual(["@cinatra-ai/new-dep"]);
    expect(swept).not.toContain(ROOT);
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

describe("installExtensionWithDependencies — #1042 slice-2 row-scoped compensation", () => {
  it("with rowScopedCompensation:true, freshly-installed members compensate via the ROW-SCOPED inverse (never the package-global uninstall), inverse order", async () => {
    const h = makeHarness({
      plan: [member("@cinatra-ai/dep-a"), member("@cinatra-ai/dep-b"), member(ROOT)],
      installFail: ROOT,
    });
    await expect(
      installExtensionWithDependencies(
        { packageName: ROOT, version: "1.0.0", actor, rowScopedCompensation: true },
        h.deps,
      ),
    ).rejects.toBeInstanceOf(BatchMemberInstallError);
    // Row-scoped, inverse order — and NEVER the package-global uninstall.
    expect(h.rowScopedUninstalls).toEqual(["@cinatra-ai/dep-b", "@cinatra-ai/dep-a"]);
    expect(h.events.filter((e) => e.startsWith("uninstall:"))).toEqual([]);
    expect(h.deps.uninstallMember).not.toHaveBeenCalled();
    expect(h.deps.uninstallMemberRowScoped).toHaveBeenCalledTimes(2);
    const batch = [...h.ledgerRows.values()][0]!;
    expect(batch.members.find((m) => m.packageName === "@cinatra-ai/dep-a")!.status).toBe(
      "compensated",
    );
  });

  it("WITHOUT the flag (default), compensation stays package-scoped (uninstallMember) — byte-unchanged", async () => {
    const h = makeHarness({
      plan: [member("@cinatra-ai/dep-a"), member(ROOT)],
      installFail: ROOT,
    });
    await expect(
      installExtensionWithDependencies({ packageName: ROOT, version: "1.0.0", actor }, h.deps),
    ).rejects.toBeInstanceOf(BatchMemberInstallError);
    expect(h.events).toContain("uninstall:@cinatra-ai/dep-a");
    expect(h.rowScopedUninstalls).toEqual([]);
    expect(h.deps.uninstallMemberRowScoped).not.toHaveBeenCalled();
  });

  it("a PRE-EXISTING member is never row-scoped-compensated either (pre-state discriminator still holds)", async () => {
    const h = makeHarness({
      plan: [member("@cinatra-ai/dep-a"), member("@cinatra-ai/dep-b"), member(ROOT)],
      installFail: ROOT,
      preInstalled: ["@cinatra-ai/dep-a"],
    });
    await expect(
      installExtensionWithDependencies(
        { packageName: ROOT, version: "1.0.0", actor, rowScopedCompensation: true },
        h.deps,
      ),
    ).rejects.toBeInstanceOf(BatchMemberInstallError);
    // Only the freshly-installed dep-b is torn down; the pre-existing dep-a is left.
    expect(h.rowScopedUninstalls).toEqual(["@cinatra-ai/dep-b"]);
  });
});

describe("installExtensionWithDependencies — #1042 slice-1 expected-version CAS forwarding", () => {
  it("forwards expectedRootInstalledVersion to the ROOT update member ONLY (never a dedupe-upward member)", async () => {
    const h = makeHarness({
      plan: [member("@cinatra-ai/shared", { action: "update" }), member(ROOT, { action: "update" })],
      preInstalled: ["@cinatra-ai/shared", ROOT],
    });
    await installExtensionWithDependencies(
      { packageName: ROOT, rootAction: "update", expectedRootInstalledVersion: "0.9.0", actor },
      h.deps,
    );
    expect(h.updateExpectedVersions).toContainEqual({ packageName: ROOT, expected: "0.9.0" });
    expect(h.updateExpectedVersions).toContainEqual({
      packageName: "@cinatra-ai/shared",
      expected: undefined,
    });
  });

  it("the depless root update (fast path) forwards the CAS precondition", async () => {
    const h = makeHarness({ plan: [member(ROOT, { action: "update" })], preInstalled: [ROOT] });
    await installExtensionWithDependencies(
      { packageName: ROOT, rootAction: "update", expectedRootInstalledVersion: "0.9.0", actor },
      h.deps,
    );
    expect(h.updateExpectedVersions).toEqual([{ packageName: ROOT, expected: "0.9.0" }]);
  });

  it("a manual update (no expectedRootInstalledVersion) forwards undefined — byte-unchanged", async () => {
    const h = makeHarness({ plan: [member(ROOT, { action: "update" })], preInstalled: [ROOT] });
    await installExtensionWithDependencies(
      { packageName: ROOT, rootAction: "update", actor },
      h.deps,
    );
    expect(h.updateExpectedVersions).toEqual([{ packageName: ROOT, expected: undefined }]);
  });
});

describe("resolveRowScopedCompensationTarget (#1042 slice-2 — precise + fail-closed)", () => {
  const row = (over: Partial<{
    id: string;
    organizationId: string | null;
    status: string;
    source: { version?: string } | null;
  }> = {}) => ({
    id: "r1",
    organizationId: null as string | null,
    status: "active",
    source: { version: "1.1.0" },
    ...over,
  });

  it("resolves the single (scope, version) live row exactly", () => {
    expect(resolveRowScopedCompensationTarget([row()], null, "1.1.0")).toEqual({
      rowId: "r1",
      ambiguous: false,
      count: 1,
    });
  });

  it("returns null (idempotent) when no live row carries the version at the scope", () => {
    expect(resolveRowScopedCompensationTarget([], null, "1.1.0")).toEqual({
      rowId: null,
      ambiguous: false,
      count: 0,
    });
    // a live row of a DIFFERENT version is not the freshly-installed one.
    expect(
      resolveRowScopedCompensationTarget([row({ source: { version: "9.9.9" } })], null, "1.1.0"),
    ).toEqual({ rowId: null, ambiguous: false, count: 0 });
  });

  it("FAILS CLOSED (ambiguous) on >1 live rows carrying the version at the scope — never picks arbitrarily", () => {
    const res = resolveRowScopedCompensationTarget(
      [row({ id: "r1" }), row({ id: "r2" })],
      null,
      "1.1.0",
    );
    expect(res.ambiguous).toBe(true);
    expect(res.rowId).toBeNull();
    expect(res.count).toBe(2);
  });

  it("ignores other-scope rows and non-live rows", () => {
    // An org-scoped row of the same package+version is NOT a NULL-org target.
    expect(
      resolveRowScopedCompensationTarget(
        [row({ id: "r1" }), row({ id: "r-org", organizationId: "org-1" })],
        null,
        "1.1.0",
      ),
    ).toEqual({ rowId: "r1", ambiguous: false, count: 1 });
    // An archived row carrying the version is not live → not a target.
    expect(
      resolveRowScopedCompensationTarget([row({ status: "archived" })], null, "1.1.0"),
    ).toEqual({ rowId: null, ambiguous: false, count: 0 });
  });

  it("resolves an org-scope target when the actor scope is an org", () => {
    expect(
      resolveRowScopedCompensationTarget(
        [row({ id: "r-null" }), row({ id: "r-org", organizationId: "org-1" })],
        "org-1",
        "1.1.0",
      ),
    ).toEqual({ rowId: "r-org", ambiguous: false, count: 1 });
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

describe("installExtensionWithDependencies — AGENT_PACKAGE_CONTRACT_VIOLATION is rethrown RAW (cinatra#1163)", () => {
  it("a closure MEMBER's metadata-contract violation propagates raw (not wrapped) AFTER newly-installed deps are compensated, so the MCP surface renders it structured", async () => {
    const h = makeHarness({
      plan: [
        member("@cinatra-ai/dep-a"),
        member("@cinatra-ai/dep-b"),
        member(ROOT),
      ],
      installContractViolation: "@cinatra-ai/dep-b",
    });
    try {
      await installExtensionWithDependencies(
        { packageName: ROOT, version: "1.0.0", actor },
        h.deps,
      );
      expect.unreachable("a member contract violation must propagate");
    } catch (e) {
      // RAW (un-wrapped) so the MCP surface keeps its { contractViolation } result
      // instead of an opaque 500.
      expect((e as { code?: string }).code).toBe("AGENT_PACKAGE_CONTRACT_VIOLATION");
      expect(e).not.toBeInstanceOf(BatchMemberInstallError);
      expect((e as { packageName?: string }).packageName).toBe("@cinatra-ai/dep-b");
      expect((e as { missingFields?: string[] }).missingFields).toEqual([
        "cinatra.riskLevel",
        "cinatra.toolAccess",
      ]);
    }
    // dep-a installed before the failing member → compensated; nothing durable,
    // ROOT never installed.
    const batch = [...h.ledgerRows.values()][0]!;
    expect(batch.phase).toBe("compensated");
    expect(h.events.filter((e) => e.startsWith("uninstall:"))).toEqual([
      "uninstall:@cinatra-ai/dep-a",
    ]);
    expect(h.events).not.toContain(`install:${ROOT}`);
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

// cinatra#1040 S3 — SIDE-BY-SIDE members (disjoint-dependents on the non-gatekept path).
describe("installExtensionWithDependencies — #1040 S3 side-by-side members", () => {
  const SHARED = "@cinatra-ai/shared";

  it("an action:'install-side-by-side' member routes through installMemberSideBySide (never installMember/updateMemberPackage) and is surfaced in result.installedSideBySide", async () => {
    const h = makeHarness({
      preInstalled: [SHARED], // the DEFAULT row exists at another version
      plan: [
        member(SHARED, {
          version: "2.0.0",
          action: "install-side-by-side",
          sideBySideEvidence: { dependents: ["@cinatra-ai/dep-old"], detail: "dep-old requires ^0.9.0" },
        }),
        member(ROOT),
      ],
    });
    const res = await installExtensionWithDependencies(
      { packageName: ROOT, version: "1.0.0", actor },
      h.deps,
    );
    expect(h.events).toContain(`side-by-side:${SHARED}@2.0.0@scope=(platform)`);
    expect(h.events).not.toContain(`install:${SHARED}`);
    expect(h.events).not.toContain(`update:${SHARED}`);
    expect(res.installedSideBySide).toEqual([
      { packageName: SHARED, version: "2.0.0", evidence: "dep-old requires ^0.9.0" },
    ]);
    // Disjoint partitions: not double-reported as a fresh install or an update.
    expect(res.installed.map((m) => m.packageName)).toEqual([ROOT]);
    expect(res.updated).toEqual([]);
    // Ledger linkage uses the VERSION-SCOPED journal read.
    const batch = [...h.ledgerRows.values()][0]!;
    const ledgerMember = batch.members.find((m) => m.packageName === SHARED)!;
    expect(ledgerMember.installOpId).toBe(`${SHARED}@2.0.0@op`);
  });

  it("a LATER member failure compensates the side-by-side member through the VERSION-SCOPED teardown (never the package uninstall), even though preState.present is true", async () => {
    const h = makeHarness({
      preInstalled: [SHARED],
      installFail: ROOT,
      plan: [
        member(SHARED, { version: "2.0.0", action: "install-side-by-side" }),
        member(ROOT),
      ],
    });
    await expect(
      installExtensionWithDependencies({ packageName: ROOT, version: "1.0.0", actor }, h.deps),
    ).rejects.toThrow(BatchMemberInstallError);
    expect(h.events).toContain(`uninstall-side-by-side:${SHARED}@2.0.0@scope=(platform)`);
    // The package-scoped uninstall is NEVER used for the side-by-side member
    // (it would tear down the DEFAULT install).
    expect(h.events).not.toContain(`uninstall:${SHARED}`);
    const batch = [...h.ledgerRows.values()][0]!;
    expect(batch.members.find((m) => m.packageName === SHARED)!.status).toBe("compensated");
  });

  it("PLATFORM-FALLBACK scope: an ORG actor's side-by-side member installs (and compensates) at the member's RESOLVED scope, not the actor's org", async () => {
    const orgActor: Actor = { actorType: "human", source: "ui", userId: "u1", orgId: "org-9" };
    const h = makeHarness({
      preInstalled: [SHARED],
      installFail: ROOT,
      plan: [
        // The planner resolved the conflict against the PLATFORM default.
        member(SHARED, {
          version: "2.0.0",
          action: "install-side-by-side",
          sideBySideScopeOrgId: null,
        }),
        member(ROOT),
      ],
    });
    await expect(
      installExtensionWithDependencies({ packageName: ROOT, version: "1.0.0", actor: orgActor }, h.deps),
    ).rejects.toThrow(BatchMemberInstallError);
    // Install AND compensation both addressed the PLATFORM scope.
    expect(h.events).toContain(`side-by-side:${SHARED}@2.0.0@scope=(platform)`);
    expect(h.events).toContain(`uninstall-side-by-side:${SHARED}@2.0.0@scope=(platform)`);
    // The ledger member carries the resolved scope for the boot sweeper.
    const batch = [...h.ledgerRows.values()][0]!;
    expect(batch.members.find((m) => m.packageName === SHARED)!.scopeOrgId).toBeNull();
  });

  it("a committed dedupe-upward ('update') member stays committed while a side-by-side member compensates", async () => {
    const OTHER = "@cinatra-ai/other-shared";
    const h = makeHarness({
      preInstalled: [SHARED, OTHER],
      installFail: ROOT,
      plan: [
        member(OTHER, { version: "1.5.0", action: "update" }),
        member(SHARED, { version: "2.0.0", action: "install-side-by-side" }),
        member(ROOT),
      ],
    });
    await expect(
      installExtensionWithDependencies({ packageName: ROOT, version: "1.0.0", actor }, h.deps),
    ).rejects.toThrow(BatchMemberInstallError);
    // Update member: committed (pre-existing) — never compensated.
    expect(h.events).not.toContain(`uninstall:${OTHER}`);
    expect(h.events.filter((e) => e.startsWith("uninstall-side-by-side:"))).toEqual([
      `uninstall-side-by-side:${SHARED}@2.0.0@scope=(platform)`,
    ]);
  });
});

describe("sweepStaleInstallBatches — #1040 S3 side-by-side members", () => {
  function staleBatch(members: InstallBatchMember[]): InstallBatch {
    return {
      batchId: "stale-sbs-1",
      rootPackage: ROOT,
      orgId: "org-1",
      phase: "installing",
      members,
      createdAt: "then",
      updatedAt: "then",
    };
  }

  it("sweeps an installed side-by-side member through the VERSION-SCOPED teardown despite preState.present, at the batch's org scope", async () => {
    const swept: string[] = [];
    const packageUninstalls: string[] = [];
    const batch = staleBatch([
      {
        packageName: "@cinatra-ai/shared",
        version: "2.0.0",
        typeId: "connector",
        status: "installed",
        action: "install-side-by-side",
        // A legacy ledger row WITHOUT scopeOrgId falls back to the batch org.
        preState: { present: true, version: "0.9.0" },
      },
      {
        packageName: "@cinatra-ai/platform-shared",
        version: "3.0.0",
        typeId: "connector",
        status: "installed",
        action: "install-side-by-side",
        // The RESOLVED platform scope from the ledger wins over the batch org.
        scopeOrgId: null,
        preState: { present: true, version: "1.0.0" },
      },
      { packageName: ROOT, version: "1.0.0", typeId: "connector", status: "planned", preState: { present: false } },
    ]);
    const res = await sweepStaleInstallBatches(
      { olderThanMs: 1000 },
      {
        listStale: async () => [batch],
        setPhase: async (_id, _phase) => batch,
        updateMember: async () => batch,
        uninstallMember: async (m) => {
          packageUninstalls.push(m.packageName);
        },
        uninstallSideBySideMember: async (m) => {
          swept.push(`${m.packageName}@${m.version}@${m.orgId}`);
        },
      },
    );
    expect(res.swept).toBe(1);
    // Inverse ledger order; the resolved platform scope wins over the batch org.
    expect(swept).toEqual([
      "@cinatra-ai/platform-shared@3.0.0@null",
      "@cinatra-ai/shared@2.0.0@org-1",
    ]);
    expect(packageUninstalls).toEqual([]);
  });

  it("a PRE-EXISTING non-side-by-side member (preState.present) is still never swept", async () => {
    const packageUninstalls: string[] = [];
    const sbs: string[] = [];
    const batch = staleBatch([
      {
        packageName: "@cinatra-ai/pre",
        version: "1.0.0",
        typeId: "connector",
        status: "installed",
        action: "install",
        preState: { present: true, version: "0.9.0" },
      },
    ]);
    await sweepStaleInstallBatches(
      { olderThanMs: 1000 },
      {
        listStale: async () => [batch],
        setPhase: async (_id, _phase) => batch,
        updateMember: async () => batch,
        uninstallMember: async (m) => {
          packageUninstalls.push(m.packageName);
        },
        uninstallSideBySideMember: async (m) => {
          sbs.push(m.packageName);
        },
      },
    );
    expect(packageUninstalls).toEqual([]);
    expect(sbs).toEqual([]);
  });
});

describe("installExtensionWithDependencies — #1040 S6 ownership capsule choreography", () => {
  const SHARED = "@cinatra-ai/shared";

  it("PERSISTS the declaration capsule to the ledger member during install, then RELEASES it on batch finalize", async () => {
    const h = makeHarness({
      preInstalled: [SHARED],
      plan: [
        member(SHARED, { version: "2.0.0", action: "install-side-by-side" }),
        member(ROOT),
      ],
    });
    await installExtensionWithDependencies({ packageName: ROOT, version: "1.0.0", actor }, h.deps);
    // The batch finalized; the spent capsule was released (cleared to null).
    const batch = [...h.ledgerRows.values()][0]!;
    const sbsMember = batch.members.find((m) => m.packageName === SHARED)!;
    expect(sbsMember.grantCapsule).toBeNull();
  });

  it("passes the member's DURABLE capsule to the compensation teardown (reconcile on a later failure)", async () => {
    const h = makeHarness({
      preInstalled: [SHARED],
      installFail: ROOT, // a LATER member fails → the side-by-side member compensates
      plan: [
        member(SHARED, { version: "2.0.0", action: "install-side-by-side" }),
        member(ROOT),
      ],
    });
    await expect(
      installExtensionWithDependencies({ packageName: ROOT, version: "1.0.0", actor }, h.deps),
    ).rejects.toThrow(BatchMemberInstallError);
    // The teardown received the capsule captured at install time (the ownership
    // grant reconcile depends on it).
    const passed = h.sbsTeardownCapsules.find((c) => c.packageName === SHARED);
    expect(passed?.capsule).toEqual({ v: 1, declaredTokenKeys: [`${SHARED}__k`] });
  });
});

describe("sweepStaleInstallBatches — #1040 S6 passes the durable capsule to boot teardown", () => {
  it("forwards the swept member's grantCapsule to the version-scoped teardown", async () => {
    const received: Array<{ pkg: string; capsule: unknown }> = [];
    const batch: InstallBatch = {
      batchId: "stale-sbs-s6",
      rootPackage: ROOT,
      orgId: null,
      phase: "installing",
      members: [
        {
          packageName: "@cinatra-ai/shared",
          version: "2.0.0",
          typeId: "connector",
          status: "installed",
          action: "install-side-by-side",
          scopeOrgId: null,
          preState: { present: true, version: "0.9.0" },
          grantCapsule: { v: 1, declaredTokenKeys: ["wp_widget_auth"] },
        },
        { packageName: ROOT, version: "1.0.0", typeId: "connector", status: "planned", preState: { present: false } },
      ],
      createdAt: "then",
      updatedAt: "then",
    };
    const res = await sweepStaleInstallBatches(
      { olderThanMs: 1000 },
      {
        listStale: async () => [batch],
        setPhase: async (_id, _p) => batch,
        updateMember: async () => batch,
        uninstallMember: async () => {},
        uninstallSideBySideMember: async (m) => {
          received.push({ pkg: m.packageName, capsule: m.capsule ?? null });
        },
      },
    );
    expect(res.swept).toBe(1);
    expect(received).toEqual([
      { pkg: "@cinatra-ai/shared", capsule: { v: 1, declaredTokenKeys: ["wp_widget_auth"] } },
    ]);
  });
});

describe("gcOrphanedSideBySideCapsules — orphan GC of spent capsules on terminal batches", () => {
  it("clears a non-null capsule left on a terminal side-by-side member (with evidence)", async () => {
    const cleared: Array<{ batchId: string; pkg: string; patch: unknown }> = [];
    const terminal: InstallBatch = {
      batchId: "terminal-1",
      rootPackage: ROOT,
      orgId: null,
      phase: "finalized",
      members: [
        {
          packageName: "@cinatra-ai/shared",
          version: "2.0.0",
          typeId: "connector",
          status: "installed",
          action: "install-side-by-side",
          preState: { present: true },
          grantCapsule: { v: 1, declaredTokenKeys: ["wp_widget_auth"] },
        },
        // A non-side-by-side member with no capsule — untouched.
        { packageName: ROOT, version: "1.0.0", typeId: "connector", status: "installed", preState: { present: false } },
      ],
      createdAt: "t",
      updatedAt: "t",
    };
    const res = await gcOrphanedSideBySideCapsules({
      listTerminalWithCapsules: async () => [terminal],
      updateMember: async (batchId, pkg, patch) => {
        cleared.push({ batchId, pkg, patch });
        return terminal;
      },
    });
    expect(res.cleared).toBe(1);
    expect(cleared).toEqual([
      { batchId: "terminal-1", pkg: "@cinatra-ai/shared", patch: { grantCapsule: null } },
    ]);
  });

  it("no-op when no terminal batch carries a capsule", async () => {
    const res = await gcOrphanedSideBySideCapsules({
      listTerminalWithCapsules: async () => [],
      updateMember: async () => {
        throw new Error("should not be called");
      },
    });
    expect(res.cleared).toBe(0);
  });

  it("KEEPS an UNPROVEN capsule (a failed member is the only durable record of the shared-grant prior state) — cinatra#1391", async () => {
    const cleared: Array<{ batchId: string; pkg: string }> = [];
    const failed: InstallBatch = {
      batchId: "failed-1",
      rootPackage: ROOT,
      orgId: null,
      phase: "failed",
      members: [
        {
          packageName: "@cinatra-ai/shared",
          version: "2.0.0",
          typeId: "connector",
          status: "failed",
          action: "install-side-by-side",
          preState: { present: false },
          // Carries the ports prior-state capsule — the ONLY recovery evidence.
          grantCapsule: {
            v: 1,
            declaredTokenKeys: [],
            declaredPorts: ["p2"],
            portsPrior: { exists: true, status: "approved", approvedPorts: ["p1"], requestedPortsHash: "h1", approvedBy: "admin" },
          },
        },
      ],
      createdAt: "t",
      updatedAt: "t",
    };
    const res = await gcOrphanedSideBySideCapsules({
      listTerminalWithCapsules: async () => [failed],
      updateMember: async (batchId, pkg) => {
        cleared.push({ batchId, pkg });
        return failed;
      },
    });
    expect(res.cleared).toBe(0);
    expect(cleared).toEqual([]); // never cleared an unproven capsule
  });

  it("clears a COMPENSATED member's capsule (the teardown already reconciled from it) — proven-spent", async () => {
    const cleared: Array<{ batchId: string; pkg: string; patch: unknown }> = [];
    const comp: InstallBatch = {
      batchId: "comp-1",
      rootPackage: ROOT,
      orgId: null,
      phase: "failed",
      members: [
        {
          packageName: "@cinatra-ai/shared",
          version: "2.0.0",
          typeId: "connector",
          status: "compensated",
          action: "install-side-by-side",
          preState: { present: false },
          grantCapsule: { v: 1, declaredTokenKeys: ["k"] },
        },
      ],
      createdAt: "t",
      updatedAt: "t",
    };
    const res = await gcOrphanedSideBySideCapsules({
      listTerminalWithCapsules: async () => [comp],
      updateMember: async (batchId, pkg, patch) => {
        cleared.push({ batchId, pkg, patch });
        return comp;
      },
    });
    expect(res.cleared).toBe(1);
    expect(cleared).toEqual([
      { batchId: "comp-1", pkg: "@cinatra-ai/shared", patch: { grantCapsule: null } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// cinatra#1927 — DECLARATION-DRIVEN PROTECTION in the install saga.
//
// The saga's compensation inverse is the one place core TEARS DOWN an extension
// outside the removal surfaces, and one of its two routes
// (`uninstallMemberRowScoped` → `deleteScopedCanonicalRow`) BYPASSES the
// dispatcher, so the dispatcher's refusal does not cover it. The saga therefore
// consults the same declaration verdict itself and SKIPS a protected member.
// ---------------------------------------------------------------------------
describe("installExtensionWithDependencies — protected members are never compensated (#1927)", () => {
  const PROTECTED_DEP = "@cinatra-ai/protected-dep";

  it("SKIPS the dispatcher-route teardown of a protected member when a later member fails", async () => {
    const h = makeHarness({
      plan: [member(PROTECTED_DEP), member("@cinatra-ai/dep-b"), member(ROOT)],
      installFail: ROOT,
      protectedPackages: [PROTECTED_DEP],
    });
    await expect(
      installExtensionWithDependencies({ packageName: ROOT, version: "1.0.0", actor }, h.deps),
    ).rejects.toBeInstanceOf(BatchMemberInstallError);

    // The ordinary member IS compensated; the protected one is left installed.
    expect(h.events).toContain("uninstall:@cinatra-ai/dep-b");
    expect(h.events).not.toContain(`uninstall:${PROTECTED_DEP}`);
    expect(h.deps.uninstallMember).not.toHaveBeenCalledWith(
      expect.objectContaining({ packageName: PROTECTED_DEP }),
      expect.anything(),
    );
  });

  it("SKIPS the ROW-SCOPED teardown too — the route that bypasses the dispatcher", async () => {
    const h = makeHarness({
      plan: [member(PROTECTED_DEP), member("@cinatra-ai/dep-b"), member(ROOT)],
      installFail: ROOT,
      protectedPackages: [PROTECTED_DEP],
    });
    await expect(
      installExtensionWithDependencies(
        { packageName: ROOT, version: "1.0.0", actor, rowScopedCompensation: true },
        h.deps,
      ),
    ).rejects.toBeInstanceOf(BatchMemberInstallError);

    expect(h.rowScopedUninstalls).toEqual(["@cinatra-ai/dep-b"]);
    expect(h.rowScopedUninstalls).not.toContain(PROTECTED_DEP);
  });

  it("records the skip HONESTLY on the ledger (not a silent compensation gap)", async () => {
    const h = makeHarness({
      plan: [member(PROTECTED_DEP), member(ROOT)],
      installFail: ROOT,
      protectedPackages: [PROTECTED_DEP],
    });
    await expect(
      installExtensionWithDependencies({ packageName: ROOT, version: "1.0.0", actor }, h.deps),
    ).rejects.toBeInstanceOf(BatchMemberInstallError);

    const batch = [...h.ledgerRows.values()][0]!;
    const protectedMember = batch.members.find((m) => m.packageName === PROTECTED_DEP)!;
    expect(protectedMember.detail).toMatch(/protected-declaration/);
    // A skip is NOT a compensation failure — the member never entered the
    // failed-teardown class.
    expect(protectedMember.status).not.toBe("compensation-failed");
  });

  it("FAILS CLOSED: an unreadable protection declaration also skips the teardown", async () => {
    const h = makeHarness({
      plan: [member("@cinatra-ai/dep-a"), member(ROOT)],
      installFail: ROOT,
      protectionReadFails: true,
    });
    await expect(
      installExtensionWithDependencies({ packageName: ROOT, version: "1.0.0", actor }, h.deps),
    ).rejects.toBeInstanceOf(BatchMemberInstallError);
    expect(h.events).toContain("protection-unreadable:@cinatra-ai/dep-a");
    expect(h.events).not.toContain("uninstall:@cinatra-ai/dep-a");
  });

  it("an UNPROTECTED batch compensates exactly as before (no behavior change)", async () => {
    const h = makeHarness({
      plan: [member("@cinatra-ai/dep-a"), member("@cinatra-ai/dep-b"), member(ROOT)],
      installFail: ROOT,
    });
    await expect(
      installExtensionWithDependencies({ packageName: ROOT, version: "1.0.0", actor }, h.deps),
    ).rejects.toBeInstanceOf(BatchMemberInstallError);
    // Inverse install order, every fresh member torn down.
    expect(h.events.filter((e) => e.startsWith("uninstall:"))).toEqual([
      "uninstall:@cinatra-ai/dep-b",
      "uninstall:@cinatra-ai/dep-a",
    ]);
  });

  it("BOOT RECOVERY skips a protected member too", async () => {
    const swept: string[] = [];
    const staleBatch: InstallBatch = {
      batchId: "b-protected",
      rootPackage: ROOT,
      orgId: null,
      phase: "installing",
      members: [
        {
          packageName: PROTECTED_DEP,
          version: "1.0.0",
          typeId: "connector",
          status: "installed",
          action: "install",
          preState: { present: false },
        },
        {
          packageName: "@cinatra-ai/dep-b",
          version: "1.0.0",
          typeId: "connector",
          status: "installed",
          action: "install",
          preState: { present: false },
        },
      ],
      createdAt: "now",
      updatedAt: "now",
    };

    const res = await sweepStaleInstallBatches({ olderThanMs: 0 }, {
      listStale: async () => [staleBatch],
      setPhase: async () => staleBatch,
      updateMember: async () => staleBatch,
      isMemberProtected: async (pkg: string) => pkg === PROTECTED_DEP,
      uninstallMember: async (m) => {
        swept.push(m.packageName);
      },
    });
    expect(res.swept).toBe(1);
    expect(swept).toEqual(["@cinatra-ai/dep-b"]);
  });
});
