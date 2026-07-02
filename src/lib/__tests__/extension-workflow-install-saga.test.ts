import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  installWorkflowExtensionSaga,
  compensateOrphanInstallOp,
  WorkflowInstallPreflightError,
  WorkflowInstallRequiresRebuildError,
  type WorkflowInstallSagaDeps,
} from "@/lib/extension-workflow-install-saga";
import { generateExtensionSigningKeyPair, signExtension } from "@/lib/extension-signature";
import { listUnfinalizedInstallOps, type InstallOpsDeps } from "@/lib/extension-install-ops";

// ---------------------------------------------------------------------------
// A fully in-memory DI harness for the saga. Every dep records the call into a
// shared `events[]` so a test can assert ORDER (preflight-before-writes,
// inverse-order rollback) and a per-(package,org) journal so phase advancement
// + idempotent finalize are observable. No registry, no DB.
// ---------------------------------------------------------------------------

const TRUSTED_PKG = "@cinatra-ai/wf-ext"; // from the marketplace host; UNSIGNED → trusted-bootstrap (imports; ports stay pending under the capability split)

// The unsigned bootstrap-trust path is FAIL-CLOSED by default and opt-IN only.
// These saga tests exercise OTHER behavior (journal phases, compensation, edges,
// capability split) using an UNSIGNED bootstrap package as the vehicle, so they
// explicitly opt in. The dedicated REQUIRE_SIGNATURES=true refusal test below
// overrides this within its own scope.
let prevAllowUnsigned: string | undefined;
beforeEach(() => {
  prevAllowUnsigned = process.env.CINATRA_EXTENSION_ALLOW_UNSIGNED_BOOTSTRAP;
  process.env.CINATRA_EXTENSION_ALLOW_UNSIGNED_BOOTSTRAP = "true";
});
afterEach(() => {
  if (prevAllowUnsigned === undefined) delete process.env.CINATRA_EXTENSION_ALLOW_UNSIGNED_BOOTSTRAP;
  else process.env.CINATRA_EXTENSION_ALLOW_UNSIGNED_BOOTSTRAP = prevAllowUnsigned;
});

type JournalRow = { installOpId: string; phase: string; packageName: string; orgId: string | null };
type Harness = {
  deps: WorkflowInstallSagaDeps;
  events: string[];
  journal: Map<string, JournalRow>;
  /** Seed a prior op (cinatra#158 append-only: keyed by op id). */
  seedOp: (pkg: string, org: string | null, installOpId: string, phase: string) => void;
  /** The anchor op (finalized-else-latest) for a (pkg, org), or undefined. */
  anchorOf: (pkg: string, org: string | null) => JournalRow | undefined;
  templates: Set<string>;
};

function makeHarness(overrides: Partial<WorkflowInstallSagaDeps> = {}, opts: { preExistingTemplate?: boolean } = {}): Harness {
  const events: string[] = [];
  // cinatra#158 APPEND-ONLY journal: keyed by install_op_id (one row per attempt),
  // each row carries its (pkg, org). `journal.set(opId, {...})` seeds a prior op.
  const journal = new Map<string, { installOpId: string; phase: string; packageName: string; orgId: string | null }>();
  const templates = new Set<string>(opts.preExistingTemplate ? ["tpl-existing"] : []);

  const key = (pkg: string, org: string | null) => `${pkg}::${org ?? "(global)"}`;
  const scopeOf = (row: { packageName: string; orgId: string | null }) => key(row.packageName, row.orgId);
  // ANCHOR reader: the single finalized op for the scope, else the latest seeded.
  const anchorFor = (pkg: string, org: string | null) => {
    const matching = [...journal.values()].filter((r) => scopeOf(r) === key(pkg, org));
    return matching.find((r) => r.phase === "finalized") ?? matching[matching.length - 1] ?? null;
  };

  const base: WorkflowInstallSagaDeps = {
    withInstallLock: async (_pkg, fn) => fn(),

    beginInstallOp: async ({ installOpId, packageName, orgId }) => {
      events.push("begin");
      // APPEND: never destroy a sibling op for the same (pkg, org).
      journal.set(installOpId, { installOpId, phase: "materialized", packageName, orgId: orgId ?? null });
    },
    advanceInstallOpPhase: async ({ installOpId, phase }) => {
      events.push(`phase:${phase}`);
      const row = journal.get(installOpId);
      if (row) row.phase = phase;
    },
    // cinatra#158: finalize is the SUPERSESSION seam — demote the prior finalized
    // op for the same (pkg, org), then promote this op.
    finalizeInstallOp: async (installOpId) => {
      events.push("finalize");
      const self = journal.get(installOpId);
      if (!self) throw new Error(`finalize: no op ${installOpId}`);
      for (const row of journal.values()) {
        if (row.installOpId !== installOpId && scopeOf(row) === scopeOf(self) && row.phase === "finalized") row.phase = "superseded";
      }
      self.phase = "finalized";
    },
    failInstallOp: async (installOpId) => {
      events.push("fail");
      const row = journal.get(installOpId);
      if (row) row.phase = "failed";
    },
    readInstallOp: async (pkg, org) => {
      const row = anchorFor(pkg, org ?? null);
      return row ? { phase: row.phase, installOpId: row.installOpId } : null;
    },
    // cinatra#158 (d): structured operational-event sink (spy).
    emitOperationalEvent: (e) => { events.push(`op-event:${e.step}`); },

    resolveIntegrity: async () => ({ integrity: "sha512-abc", registryUrl: "https://registry.cinatra.ai", sha256: "deadbeef" }),
    materialize: async () => {
      events.push("materialize");
      return { storeDir: "/store/dir", digest: "dgst", integrity: "sha512-abc", contentHash: "ch" };
    },

    preflightFromStore: async () => {
      events.push("preflight");
      return { manifest: { key: "wf", version: 1 }, dashboardConfig: { ok: true } };
    },

    installWorkflowTemplate: async () => {
      events.push("write:template");
      templates.add("tpl-new");
      return { templateId: "tpl-new", wasReinstall: opts.preExistingTemplate === true };
    },
    materializeDashboardTemplate: async () => {
      events.push("write:dashboard-template");
    },
    listOrgProjectIds: async () => ["proj-1", "proj-2"],
    materializeInstanceForProject: async ({ projectId }) => {
      events.push(`write:instance:${projectId}`);
    },
    restoreDashboards: async () => {
      events.push("write:restore");
    },

    readRequestedPorts: async () => ["settings"],
    recordRequestedGrant: async () => {
      events.push("grant:request");
    },
    approveGrant: async () => {
      events.push("grant:approve");
    },
    recordProvenance: async () => {
      events.push("provenance");
    },

    registerRuntimeContributions: async () => {
      events.push("register-runtime-contributions");
    },
    unregisterRuntimeContributions: async () => {
      events.push("compensate:unregister-runtime-contributions");
    },
    archiveDashboards: async () => {
      events.push("compensate:archive-dashboards");
    },
    deleteWorkflowTemplate: async (templateId) => {
      events.push(`compensate:delete-template:${templateId}`);
      templates.delete(templateId);
      return { deleted: true };
    },
  };

  const seedOp = (pkg: string, org: string | null, installOpId: string, phase: string) =>
    journal.set(installOpId, { installOpId, phase, packageName: pkg, orgId: org });
  const anchorOf = (pkg: string, org: string | null) => anchorFor(pkg, org) ?? undefined;
  return { deps: { ...base, ...overrides }, events, journal, seedOp, anchorOf, templates };
}

const actor = { userId: "u1", orgId: "org-1" };

describe("installWorkflowExtensionSaga — happy path + journal phases", () => {
  it("advances begin → materialized → granted → preflighted → ... → finalized; provenance is LATE", async () => {
    const h = makeHarness();
    const res = await installWorkflowExtensionSaga({ packageName: TRUSTED_PKG, version: "1.0.0", actor }, h.deps);

    expect(res.status).toBe("installed");
    expect(res.templateId).toBe("tpl-new");
    expect(res.dashboardMaterialized).toBe(true);

    // Journal phase order — exactly the committed INSTALL_OP_PHASES sequence.
    const phases = h.events.filter((e) => e === "begin" || e.startsWith("phase:") || e === "finalize");
    expect(phases).toEqual(["begin", "phase:materialized", "phase:granted", "phase:preflighted", "phase:writing", "finalize"]);

    // Preflight runs BEFORE the first write; provenance + finalize are LAST.
    const preflightIdx = h.events.indexOf("preflight");
    const firstWriteIdx = h.events.findIndex((e) => e.startsWith("write:"));
    expect(preflightIdx).toBeLessThan(firstWriteIdx);
    expect(h.events.indexOf("provenance")).toBeLessThan(h.events.indexOf("finalize"));
    expect(h.events.indexOf("provenance")).toBeGreaterThan(h.events.lastIndexOf("write:restore"));

    // Per-project instance fan-out happened for every org project.
    expect(h.events).toContain("write:instance:proj-1");
    expect(h.events).toContain("write:instance:proj-2");

    // Capability split: an UNSIGNED bootstrap-trusted workflow
    // package still installs (templates + dashboards written), but its requested
    // ports stay PENDING — the grant is requested, NOT auto-approved (only
    // `trusted-signed` auto-approves).
    expect(h.events).toContain("grant:request");
    expect(h.events).not.toContain("grant:approve");
  });

  it("CAPABILITY SPLIT: a trusted-SIGNED workflow package DOES auto-approve its grant", async () => {
    const kp = generateExtensionSigningKeyPair();
    const signature = signExtension(
      { packageName: TRUSTED_PKG, version: "1.0.0", integrity: "sha512-abc" },
      kp.privateKeyPkcs8DerB64,
    );
    const prev = process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS;
    process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS = kp.publicKeyDerB64;
    try {
      const h = makeHarness({
        resolveIntegrity: async () => ({
          integrity: "sha512-abc",
          registryUrl: "https://registry.cinatra.ai",
          sha256: "deadbeef",
          signature,
        }),
      });
      const res = await installWorkflowExtensionSaga({ packageName: TRUSTED_PKG, version: "1.0.0", actor }, h.deps);
      expect(res.status).toBe("installed");
      expect(h.events).toContain("grant:approve");
    } finally {
      if (prev === undefined) delete process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS;
      else process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS = prev;
    }
  });

  it("SIGNATURE PROPAGATION: a dist-tag workflow install binds the RESOLVED version (result, signature, provenance)", async () => {
    // resolveIntegrity resolves the "latest" tag to 2.0.0 and signs the RESOLVED
    // version. The signed grant + the recorded provenance version prove the saga
    // bound identity to the resolved version, not the tag (a payload bound to
    // "latest" would NOT verify, leaving the grant pending).
    const kp = generateExtensionSigningKeyPair();
    const signature = signExtension(
      { packageName: TRUSTED_PKG, version: "2.0.0", integrity: "sha512-abc" },
      kp.privateKeyPkcs8DerB64,
    );
    const prev = process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS;
    process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS = kp.publicKeyDerB64;
    try {
      const provenanceVersions: string[] = [];
      const h = makeHarness({
        resolveIntegrity: async () => ({
          integrity: "sha512-abc",
          registryUrl: "https://registry.cinatra.ai",
          sha256: "deadbeef",
          signature,
          resolvedVersion: "2.0.0",
        }),
        recordProvenance: async (p) => {
          provenanceVersions.push((p as { version: string }).version);
        },
      });
      const res = await installWorkflowExtensionSaga({ packageName: TRUSTED_PKG, version: "latest", actor }, h.deps);
      expect(res.status).toBe("installed");
      expect(res.version).toBe("2.0.0"); // resolved, not "latest"
      expect(provenanceVersions).toEqual(["2.0.0"]);
      expect(h.events).toContain("grant:approve"); // signed against the resolved-version payload
    } finally {
      if (prev === undefined) delete process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS;
      else process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS = prev;
    }
  });
});

describe("installWorkflowExtensionSaga — preflight-all rejects BEFORE any write", () => {
  const cases: Array<{ name: string; preflight: WorkflowInstallSagaDeps["preflightFromStore"]; assert: (e: unknown) => void }> = [
    {
      name: "bad BPMN",
      preflight: async () => {
        throw new WorkflowInstallPreflightError("BPMN_INVALID", "bad bpmn");
      },
      assert: (e) => expect((e as WorkflowInstallPreflightError).code).toBe("BPMN_INVALID"),
    },
    {
      name: "unknown portlet kind",
      preflight: async () => {
        throw new WorkflowInstallPreflightError("DASHBOARD_INVALID", "unknown portlet kind");
      },
      assert: (e) => expect((e as WorkflowInstallPreflightError).code).toBe("DASHBOARD_INVALID"),
    },
    {
      name: "unknown cube ref",
      preflight: async () => {
        throw new WorkflowInstallPreflightError("CUBE_UNKNOWN", "unregistered cube: foo");
      },
      assert: (e) => expect((e as WorkflowInstallPreflightError).code).toBe("CUBE_UNKNOWN"),
    },
    {
      name: "requires-rebuild (declared cube contributions)",
      preflight: async () => {
        throw new WorkflowInstallRequiresRebuildError("needs rebuild", ["new_cube"]);
      },
      assert: (e) => {
        expect(e).toBeInstanceOf(WorkflowInstallRequiresRebuildError);
        expect((e as WorkflowInstallRequiresRebuildError).offendingCubes).toEqual(["new_cube"]);
      },
    },
  ];

  for (const c of cases) {
    it(`rejects on ${c.name} with NO write + NO finalize`, async () => {
      const h = makeHarness({ preflightFromStore: c.preflight });
      await expect(installWorkflowExtensionSaga({ packageName: TRUSTED_PKG, version: "1.0.0", actor }, h.deps)).rejects.toSatisfy((e) => {
        c.assert(e);
        return true;
      });
      // No write of any kind; never finalized.
      expect(h.events.some((e) => e.startsWith("write:"))).toBe(false);
      expect(h.events).not.toContain("finalize");
      expect(h.events).not.toContain("provenance");
      // The op is failed + rolled back (no template was created → no delete).
      expect(h.events).toContain("fail");
      expect(h.events).toContain("phase:rolled_back");
      expect(h.events.some((e) => e.startsWith("compensate:delete-template"))).toBe(false);
    });
  }
});

describe("installWorkflowExtensionSaga — inverse-order compensating rollback", () => {
  it("on a second-write throw: archives dashboards THEN deletes the just-created template (in that order)", async () => {
    const h = makeHarness({
      materializeDashboardTemplate: async () => {
        throw new Error("dashboard pool transient failure");
      },
    });

    await expect(installWorkflowExtensionSaga({ packageName: TRUSTED_PKG, version: "1.0.0", actor }, h.deps)).rejects.toThrow(
      "dashboard pool transient failure",
    );

    // WRITE 1 happened (template created); WRITE 2 threw.
    expect(h.events).toContain("write:template");
    // Inverse order: archive-dashboards BEFORE delete-template.
    const archiveIdx = h.events.indexOf("compensate:archive-dashboards");
    const deleteIdx = h.events.indexOf("compensate:delete-template:tpl-new");
    expect(archiveIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(archiveIdx).toBeLessThan(deleteIdx);
    // Never finalized; op marked failed → rolled_back.
    expect(h.events).not.toContain("finalize");
    expect(h.events).toContain("fail");
    expect(h.events).toContain("phase:rolled_back");
    // The created template was deleted by compensation.
    expect(h.templates.has("tpl-new")).toBe(false);
  });

  it("on a re-install (wasReinstall) rollback: does NOT delete the pre-existing template", async () => {
    const h = makeHarness(
      {
        materializeDashboardTemplate: async () => {
          throw new Error("boom on write 2");
        },
      },
      { preExistingTemplate: true },
    );

    await expect(installWorkflowExtensionSaga({ packageName: TRUSTED_PKG, version: "1.0.0", actor }, h.deps)).rejects.toThrow("boom on write 2");

    // The upsert "created" nothing new → rollback archives dashboards but never
    // deletes the pre-existing template.
    expect(h.events).toContain("compensate:archive-dashboards");
    expect(h.events.some((e) => e.startsWith("compensate:delete-template"))).toBe(false);
    expect(h.templates.has("tpl-existing")).toBe(true);
  });

  it("a failed compensation step does NOT mask the original error", async () => {
    const h = makeHarness({
      materializeDashboardTemplate: async () => {
        throw new Error("ORIGINAL error");
      },
      archiveDashboards: async () => {
        throw new Error("compensation also failed");
      },
    });
    // The ORIGINAL error propagates, not the compensation failure.
    await expect(installWorkflowExtensionSaga({ packageName: TRUSTED_PKG, version: "1.0.0", actor }, h.deps)).rejects.toThrow("ORIGINAL error");
    // Compensation continued to the template delete despite the archive throw.
    expect(h.events).toContain("compensate:delete-template:tpl-new");
  });
});

describe("installWorkflowExtensionSaga — idempotent finalize", () => {
  it("short-circuits an already-finalized op for the SAME artifact (no writes, no provenance)", async () => {
    const h = makeHarness();
    // Seed a finalized journal row whose install-op id MATCHES this exact
    // (package, version, org) — the only case that is a true idempotent no-op.
    h.seedOp(TRUSTED_PKG, "org-1", `${TRUSTED_PKG}@1.0.0:wf:org-1`, "finalized");

    const res = await installWorkflowExtensionSaga({ packageName: TRUSTED_PKG, version: "1.0.0", actor }, h.deps);
    expect(res.status).toBe("already-finalized");
    expect(h.events).toEqual([]); // nothing ran — pure no-op
  });

  it("does NOT short-circuit a version UPDATE — a finalized prior version must re-install", async () => {
    const h = makeHarness();
    // A finalized row for v1.0.0; installing v1.0.1 must proceed (re-materialize,
    // preflight, write the new template/dashboards) rather than no-op.
    h.seedOp(TRUSTED_PKG, "org-1", `${TRUSTED_PKG}@1.0.0:wf:org-1`, "finalized");
    const res = await installWorkflowExtensionSaga({ packageName: TRUSTED_PKG, version: "1.0.1", actor }, h.deps);
    expect(res.status).toBe("installed");
    expect(h.events).toContain("finalize");
  });

  it("REQUIRE_SIGNATURES=true + unsigned → refuses FULLY INERTLY (no journal begin, no grant, no template/dashboard)", async () => {
    const prev = process.env.CINATRA_EXTENSION_REQUIRE_SIGNATURES;
    process.env.CINATRA_EXTENSION_REQUIRE_SIGNATURES = "true";
    try {
      const h = makeHarness(); // harness resolveIntegrity returns no signature
      await expect(installWorkflowExtensionSaga({ packageName: TRUSTED_PKG, version: "1.0.0", actor }, h.deps)).rejects.toThrow(/trust\/signature gate/);
      expect(h.events).not.toContain("write:template");
      expect(h.events).not.toContain("write:dashboard-template");
      expect(h.events).not.toContain("finalize");
      // cinatra#181: the trust gate now refuses BEFORE
      // `beginInstallOp` (the journal UPSERT would destroy a prior install's
      // `finalized` boot anchor) and BEFORE `recordRequestedGrant` (a changed
      // request would reset a prior APPROVED grant) — the refusal is fully
      // inert, so there is NO journal row and NOTHING to roll back.
      expect(h.events).not.toContain("begin");
      expect(h.events).not.toContain("phase:rolled_back");
      expect(h.events).not.toContain("grant:request");
    } finally {
      if (prev === undefined) delete process.env.CINATRA_EXTENSION_REQUIRE_SIGNATURES;
      else process.env.CINATRA_EXTENSION_REQUIRE_SIGNATURES = prev;
    }
  });

  it("re-converges a non-finalized (preflighted) op rather than short-circuiting", async () => {
    const h = makeHarness();
    h.seedOp(TRUSTED_PKG, "org-1", "stale", "preflighted");
    const res = await installWorkflowExtensionSaga({ packageName: TRUSTED_PKG, version: "1.0.0", actor }, h.deps);
    expect(res.status).toBe("installed");
    expect(h.events).toContain("finalize");
  });
});

describe("installWorkflowExtensionSaga — recordProvenance only on the finalized path", () => {
  it("never records provenance when preflight rejects", async () => {
    const h = makeHarness({
      preflightFromStore: async () => {
        throw new WorkflowInstallPreflightError("BPMN_INVALID", "bad");
      },
    });
    await expect(installWorkflowExtensionSaga({ packageName: TRUSTED_PKG, version: "1.0.0", actor }, h.deps)).rejects.toThrow();
    expect(h.events).not.toContain("provenance");
  });

  it("never records provenance when a write throws", async () => {
    const h = makeHarness({
      installWorkflowTemplate: async () => {
        throw new Error("write 1 failed");
      },
    });
    await expect(installWorkflowExtensionSaga({ packageName: TRUSTED_PKG, version: "1.0.0", actor }, h.deps)).rejects.toThrow("write 1 failed");
    expect(h.events).not.toContain("provenance");
    expect(h.events).not.toContain("finalize");
  });

  it("records provenance exactly once, on the finalized path", async () => {
    const h = makeHarness();
    await installWorkflowExtensionSaga({ packageName: TRUSTED_PKG, version: "1.0.0", actor }, h.deps);
    expect(h.events.filter((e) => e === "provenance").length).toBe(1);
  });
});

describe("installWorkflowExtensionSaga — org-context guard", () => {
  it("fails closed before any IO when org/user context is missing", async () => {
    const h = makeHarness();
    await expect(
      installWorkflowExtensionSaga({ packageName: TRUSTED_PKG, version: "1.0.0", actor: { userId: "u1", orgId: null } }, h.deps),
    ).rejects.toBeInstanceOf(WorkflowInstallPreflightError);
    expect(h.events).toEqual([]);
  });
});

describe("compensateOrphanInstallOp (boot cleanup)", () => {
  it("archives dashboards (op reached `writing`) then marks the op failed → rolled_back", async () => {
    const events: string[] = [];
    await compensateOrphanInstallOp(
      { installOpId: "op-x", packageName: TRUSTED_PKG, orgId: "org-1", phase: "writing" },
      {
        archiveDashboards: async () => {
          events.push("archive");
        },
        failInstallOp: async () => {
          events.push("fail");
        },
        advanceInstallOpPhase: async ({ phase }) => {
          events.push(`phase:${phase}`);
        },
      },
    );
    expect(events).toEqual(["archive", "fail", "phase:rolled_back"]);
  });

  it("does NOT archive dashboards for an op that crashed BEFORE the write region (phase preflighted) — protects a prior healthy install", async () => {
    const events: string[] = [];
    await compensateOrphanInstallOp(
      { installOpId: "op-p", packageName: TRUSTED_PKG, orgId: "org-1", phase: "preflighted" },
      {
        archiveDashboards: async () => {
          events.push("archive");
        },
        failInstallOp: async () => {
          events.push("fail");
        },
        advanceInstallOpPhase: async ({ phase }) => {
          events.push(`phase:${phase}`);
        },
      },
    );
    expect(events).toEqual(["fail", "phase:rolled_back"]); // no archive
  });

  it("skips dashboard archive for a global (org-less) op but still rolls the journal back", async () => {
    const events: string[] = [];
    await compensateOrphanInstallOp(
      { installOpId: "op-g", packageName: TRUSTED_PKG, orgId: null },
      {
        archiveDashboards: async () => {
          events.push("archive");
        },
        failInstallOp: async () => {
          events.push("fail");
        },
        advanceInstallOpPhase: async ({ phase }) => {
          events.push(`phase:${phase}`);
        },
      },
    );
    expect(events).toEqual(["fail", "phase:rolled_back"]);
  });
});

// ---------------------------------------------------------------------------
// listUnfinalizedInstallOps — the boot-cleanup reader. Drives the store's query
// shape with an in-memory fake (mirrors the existing ops test harness).
// ---------------------------------------------------------------------------

describe("listUnfinalizedInstallOps", () => {
  function fakeDeps(rows: Array<{ install_op_id: string; package_name: string; org_id: string | null; phase: string }>): InstallOpsDeps {
    const TERMINAL = new Set(["finalized", "failed", "rolled_back"]);
    const query: InstallOpsDeps["query"] = async <T,>(text: string) => {
      if (/phase <> ALL/.test(text)) {
        return rows
          .filter((r) => !TERMINAL.has(r.phase))
          .map((r) => ({ ...r, started_at: "t0", updated_at: "t0", digest: null })) as T[];
      }
      return [] as T[];
    };
    return { query };
  }

  it("returns only ops in a non-terminal phase (materialized/granted/preflighted)", async () => {
    const deps = fakeDeps([
      { install_op_id: "a", package_name: "@cinatra-ai/a", org_id: "org-1", phase: "materialized" },
      { install_op_id: "b", package_name: "@cinatra-ai/b", org_id: null, phase: "granted" },
      { install_op_id: "c", package_name: "@cinatra-ai/c", org_id: "org-1", phase: "preflighted" },
      { install_op_id: "d", package_name: "@cinatra-ai/d", org_id: "org-1", phase: "finalized" },
      { install_op_id: "e", package_name: "@cinatra-ai/e", org_id: "org-1", phase: "failed" },
      { install_op_id: "f", package_name: "@cinatra-ai/f", org_id: "org-1", phase: "rolled_back" },
    ]);
    const ops = await listUnfinalizedInstallOps(0, deps);
    expect(ops.map((o) => o.installOpId).sort()).toEqual(["a", "b", "c"]);
    expect(ops.every((o) => ["materialized", "granted", "preflighted"].includes(o.phase))).toBe(true);
  });

  it("maps rows to the InstallOp shape (camelCase) and carries org scope", async () => {
    const deps = fakeDeps([{ install_op_id: "a", package_name: "@cinatra-ai/a", org_id: null, phase: "materialized" }]);
    const [op] = await listUnfinalizedInstallOps(0, deps);
    expect(op).toMatchObject({ installOpId: "a", packageName: "@cinatra-ai/a", orgId: null, phase: "materialized" });
  });
});

// ---------------------------------------------------------------------------
// HOST-COMPAT GATE — a workflow package whose declared `cinatra.sdkAbiRange`
// this host's SDK ABI does not satisfy is refused right after materialize,
// BEFORE the grant request, preflight, and any template/dashboard writes.
// ---------------------------------------------------------------------------
describe("installWorkflowExtensionSaga — HOST-COMPAT GATE (cinatra.sdkAbiRange)", () => {
  it("REFUSES an incompatible package PRE-MUTATION (no journal begin, no grant, no preflight, no writes) with an actionable HOST_SDK_INCOMPATIBLE error; the bad dir is GC'd", async () => {
    const gcd: string[] = [];
    const h = makeHarness({
      readDeclaredCompat: async () => ({ sdkAbiRange: "^99" }),
      gcStoreDir: async (dir) => {
        gcd.push(dir);
      },
    });
    let caught: unknown;
    try {
      await installWorkflowExtensionSaga({ packageName: TRUSTED_PKG, version: "1.0.0", actor }, h.deps);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WorkflowInstallPreflightError);
    expect((caught as WorkflowInstallPreflightError).code).toBe("HOST_SDK_INCOMPATIBLE");
    expect((caught as Error).message).toMatch(/install of @cinatra-ai\/wf-ext@1\.0\.0 refused[^]*sdkAbiRange "\^99"/);
    expect((caught as Error).message).toContain("@cinatra-ai/sdk-extensions ABI");

    // Refused BEFORE the journal begin, the grant request, the preflight, and
    // every write — the refusal mutates NOTHING durable.
    expect(h.events).toContain("materialize");
    expect(h.events).not.toContain("begin");
    expect(h.events.some((e) => e.startsWith("phase:"))).toBe(false);
    expect(h.events).not.toContain("grant:request");
    expect(h.events).not.toContain("preflight");
    expect(h.events.some((e) => e.startsWith("write:"))).toBe(false);
    expect(h.events).not.toContain("finalize");
    expect(h.events).not.toContain("fail");
    // The incompatible materialized dir was GC'd.
    expect(gcd).toEqual(["/store/dir"]);
  });

  it("a refused UPDATE preserves the PREVIOUS install's finalized journal op (and reports op:update)", async () => {
    const h = makeHarness({
      readDeclaredCompat: async () => ({ sdkAbiRange: "^99" }),
    });
    // Seed a PRIOR finalized op for this (package, org) at a DIFFERENT version —
    // the update target (2.0.0) must not destroy it on refusal.
    const priorOpId = `${TRUSTED_PKG}@1.0.0:wf:${actor.orgId}`;
    h.seedOp(TRUSTED_PKG, actor.orgId, priorOpId, "finalized");

    let caught: unknown;
    try {
      await installWorkflowExtensionSaga({ packageName: TRUSTED_PKG, version: "2.0.0", actor }, h.deps);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WorkflowInstallPreflightError);
    expect((caught as Error).message).toContain("update of @cinatra-ai/wf-ext@2.0.0 refused");

    // The prior finalized op is untouched — the previous install stays
    // boot-anchorable (begin never ran; append-only would not have destroyed it anyway).
    expect(h.anchorOf(TRUSTED_PKG, actor.orgId)).toMatchObject({
      installOpId: priorOpId,
      phase: "finalized",
    });
    expect(h.events).not.toContain("begin");
  });

  it("PASSES a compatible / unpinned range (install proceeds to finalize)", async () => {
    for (const range of ["*", null] as const) {
      const h = makeHarness({ readDeclaredCompat: async () => ({ sdkAbiRange: range }) });
      const res = await installWorkflowExtensionSaga({ packageName: TRUSTED_PKG, version: "1.0.0", actor }, h.deps);
      expect(res.status).toBe("installed");
      expect(h.events).toContain("finalize");
    }
  });

  it("no readDeclaredCompat wired (legacy/unit deps) → no install-time gate", async () => {
    const h = makeHarness();
    const res = await installWorkflowExtensionSaga({ packageName: TRUSTED_PKG, version: "1.0.0", actor }, h.deps);
    expect(res.status).toBe("installed");
  });
});

// ---------------------------------------------------------------------------
// #180 PR-1: dependency edges on the WORKFLOW saga path — dual-read (pre-
// journal, fail-loud), persistence at the finalize seam, fresh-install
// forward gate routing into the inverse-order compensation.
// ---------------------------------------------------------------------------

describe("installWorkflowExtensionSaga — dependency edges become real (#180)", () => {
  const EDGES = [
    {
      packageName: "@cinatra-ai/dep-a",
      kind: "connector" as const,
      edgeType: "runtime" as const,
      versionConstraint: { kind: "semver-range" as const, range: "*" },
      requirement: "required" as const,
    },
  ];

  function withEdgeSeams(h: Harness, over: Partial<WorkflowInstallSagaDeps> = {}) {
    const persisted: unknown[] = [];
    const gated: unknown[] = [];
    const gcd: string[] = [];
    h.deps = {
      ...h.deps,
      readDependencyEdges: async (storeDir) => {
        h.events.push(`readEdges:${storeDir}`);
        return EDGES;
      },
      persistDependencyEdges: async (i) => {
        h.events.push("persistEdges");
        persisted.push(i);
      },
      assertForwardInstallClosure: async (i) => {
        h.events.push("forwardGate");
        gated.push(i);
      },
      gcStoreDir: async (d) => {
        gcd.push(d);
      },
      ...over,
    };
    return { persisted, gated, gcd };
  }

  it("edges are read pre-journal and persisted at the FINALIZE SEAM (provenance → persist → gate → finalize)", async () => {
    const h = makeHarness();
    const { persisted, gated } = withEdgeSeams(h);
    const res = await installWorkflowExtensionSaga({ packageName: TRUSTED_PKG, version: "1.0.0", actor }, h.deps);
    expect(res.status).toBe("installed");
    expect(h.events.indexOf("readEdges:/store/dir")).toBeLessThan(h.events.indexOf("begin"));
    const provenanceIdx = h.events.indexOf("provenance");
    expect(h.events.slice(provenanceIdx)).toEqual(["provenance", "persistEdges", "forwardGate", "finalize"]);
    expect(persisted).toEqual([{ packageName: TRUSTED_PKG, orgId: "org-1", dependencies: EDGES }]);
    expect(gated).toEqual([{ packageName: TRUSTED_PKG, orgId: "org-1" }]);
  });

  it("a FORWARD-GATE refusal on a FRESH install routes into the inverse-order compensation (never finalized)", async () => {
    const h = makeHarness();
    withEdgeSeams(h, {
      assertForwardInstallClosure: async () => {
        h.events.push("forwardGate");
        throw new Error(`Cannot install ${TRUSTED_PKG} — it requires @cinatra-ai/dep-a (missing).`);
      },
    });
    await expect(
      installWorkflowExtensionSaga({ packageName: TRUSTED_PKG, version: "1.0.0", actor }, h.deps),
    ).rejects.toThrow(/requires @cinatra-ai\/dep-a/);
    // Edges were persisted (the row carries truth even for the refused install),
    // then the gate threw → compensation ran in inverse order; never finalized.
    expect(h.events).toContain("persistEdges");
    expect(h.events).not.toContain("finalize");
    expect(h.events).toContain("compensate:archive-dashboards");
    expect(h.events).toContain("compensate:delete-template:tpl-new");
    expect(h.events).toContain("fail");
    expect(h.events).toContain("phase:rolled_back");
  });

  it("a DUAL-READ failure throws BEFORE beginInstallOp (journal untouched) and GCs the materialized dir", async () => {
    const h = makeHarness();
    const { gcd } = withEdgeSeams(h, {
      readDependencyEdges: async () => {
        throw new Error(`${TRUSTED_PKG}: cinatra.dependencies and legacy cinatra.agentDependencies disagree`);
      },
    });
    await expect(
      installWorkflowExtensionSaga({ packageName: TRUSTED_PKG, version: "1.0.0", actor }, h.deps),
    ).rejects.toThrow(/disagree/);
    expect(h.events).not.toContain("begin");
    expect(h.events.filter((e) => e.startsWith("write:"))).toEqual([]);
    expect(gcd).toEqual(["/store/dir"]);
    expect(h.journal.size).toBe(0);
  });

  it("an UPDATE (prior finalized op, different version) refreshes edges but skips the forward gate", async () => {
    const h = makeHarness();
    // Seed a PRIOR finalized op at a DIFFERENT version's op id.
    h.seedOp(TRUSTED_PKG, "org-1", `${TRUSTED_PKG}@0.9.0:wf:org-1`, "finalized");
    const { persisted, gated } = withEdgeSeams(h);
    const res = await installWorkflowExtensionSaga({ packageName: TRUSTED_PKG, version: "1.0.0", actor }, h.deps);
    expect(res.status).toBe("installed");
    expect(persisted).toHaveLength(1);
    expect(gated).toEqual([]);
  });

  it("cinatra#158: a FAILED UPDATE terminalizes the NEW op + leaves the OLD finalized op intact (no re-begin) + restores OLD provenance/edges", async () => {
    const OLD_EDGES = [
      {
        packageName: "@cinatra-ai/old-dep",
        edgeType: "runtime" as const,
        versionConstraint: { kind: "semver-range" as const, range: "*" },
        requirement: "required" as const,
      },
    ];
    const priorOpId = `${TRUSTED_PKG}@1.0.0:wf:org-1`;
    const provenanceVersions: string[] = [];
    const persisted: unknown[] = [];
    const h = makeHarness();
    withEdgeSeams(h, {
      readCurrentSource: async () => ({
        registryUrl: "https://registry.cinatra.ai",
        version: "1.0.0",
        integrity: "sha512-old",
        contentHash: "ch-old",
      }),
      readCurrentDependencies: async () => OLD_EDGES,
      persistDependencyEdges: async (i) => {
        h.events.push("persistEdges");
        persisted.push(i.dependencies);
      },
      recordProvenance: async (i) => {
        h.events.push("provenance");
        provenanceVersions.push(i.version);
      },
      // The NEW attempt's finalize FAILS (post-provenance, post-edges).
      finalizeInstallOp: async () => {
        throw new Error("finalize-failed");
      },
    });
    // A prior FINALIZED install at 1.0.0; this attempt is the 1.0.1 UPDATE.
    h.seedOp(TRUSTED_PKG, "org-1", priorOpId, "finalized");

    await expect(
      installWorkflowExtensionSaga({ packageName: TRUSTED_PKG, version: "1.0.1", actor }, h.deps),
    ).rejects.toThrow("finalize-failed");

    // cinatra#158: the OLD finalized op is UNTOUCHED (append-only never destroyed
    // it) and is the anchor — NOT re-begun, NOT re-finalized.
    expect(h.anchorOf(TRUSTED_PKG, "org-1")).toMatchObject({ installOpId: priorOpId, phase: "finalized" });
    // The NEW attempt's op was TERMINALIZED (fail → rolled_back).
    const newOpId = `${TRUSTED_PKG}@1.0.1:wf:org-1`;
    expect(h.journal.get(newOpId)?.phase).toBe("rolled_back");
    expect(h.events).toContain("fail");
    expect(h.events).toContain("phase:rolled_back");
    // …the OLD provenance was re-recorded (forward write was 1.0.1, restore is 1.0.0)…
    expect(provenanceVersions[provenanceVersions.length - 1]).toBe("1.0.0");
    // …and the OLD edges were re-persisted LAST (the failed version's edges never survive).
    expect(persisted[0]).toEqual(EDGES);
    expect(persisted[persisted.length - 1]).toEqual(OLD_EDGES);
    // The attempt's own writes were still compensated in inverse order.
    expect(h.events).toContain("compensate:archive-dashboards");
  });

  it("harnesses without the #180 seams behave exactly as before", async () => {
    const h = makeHarness();
    const res = await installWorkflowExtensionSaga({ packageName: TRUSTED_PKG, version: "1.0.0", actor }, h.deps);
    expect(res.status).toBe("installed");
    expect(h.events).not.toContain("persistEdges");
  });
});
