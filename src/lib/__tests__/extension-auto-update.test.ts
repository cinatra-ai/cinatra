// In-app extension auto-update loop — cycle unit coverage (cinatra#1042
// slice 1). Full-set injected deps (the module's own contract for tests);
// the default-deps dispatch mirror is covered separately below with the
// heavy host modules mocked.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// defaultExecuteUpdate's lazy imports (host handler wiring + dispatch
// surfaces). Hoisted mocks so BOTH branches are assertable.
const {
  extensionsWiringImported,
  isGatekeptInstallEnabledMock,
  installExtensionWithDependenciesMock,
  registryUpdateMock,
} = vi.hoisted(() => ({
  extensionsWiringImported: vi.fn(),
  isGatekeptInstallEnabledMock: vi.fn(() => false),
  installExtensionWithDependenciesMock: vi.fn(async () => ({})),
  registryUpdateMock: vi.fn(async () => undefined),
}));
vi.mock("@/lib/extensions", () => {
  // The host handler-wiring module is imported for its side effects only —
  // record the import so the bootstrap-before-dispatch contract is asserted.
  extensionsWiringImported();
  return {};
});
vi.mock("@/lib/gatekept-install", () => ({
  isGatekeptInstallEnabled: isGatekeptInstallEnabledMock,
}));
vi.mock("@/lib/extension-install-batch", () => ({
  installExtensionWithDependencies: installExtensionWithDependenciesMock,
}));
vi.mock("@cinatra-ai/extensions", () => ({
  extensionRegistry: { update: registryUpdateMock },
}));

import {
  runExtensionAutoUpdateCycle,
  defaultExecuteUpdate,
  buildExtensionAutoUpdateActor,
  evaluateCandidateRecheck,
  isExtensionAutoUpdateEnabled,
  isWithinMaintenanceWindowSpec,
  parseAutoUpdateDenyList,
  EXTENSION_AUTO_UPDATE_ACTOR_ID,
  EXTENSION_AUTO_UPDATE_READ_MODEL_TTL_MS,
  type AutoUpdateInstalledRow,
  type ExtensionAutoUpdateDeps,
  type AutoUpdateAuditEvent,
} from "@/lib/extension-auto-update";
import type { ExtensionUpdateEntry } from "@cinatra-ai/registries/src/update-read-model";

const NOW = new Date("2026-07-11T12:00:00.000Z");

function makeRow(overrides: Partial<AutoUpdateInstalledRow> = {}): AutoUpdateInstalledRow {
  return {
    id: "row-1",
    packageName: "@acme/foo",
    kind: "connector",
    organizationId: null,
    status: "active",
    source: { type: "verdaccio", version: "1.0.0" },
    ...overrides,
  };
}

function makeEntry(overrides: Partial<ExtensionUpdateEntry> = {}): ExtensionUpdateEntry {
  return {
    packageName: "@acme/foo",
    latestVersion: "1.1.0",
    latestSdkAbiRange: "^2",
    refreshedAt: NOW.toISOString(), // fresh
    ...overrides,
  };
}

function makeStore(entries: ExtensionUpdateEntry[]) {
  const byName = new Map(entries.map((e) => [e.packageName, e]));
  return {
    read: async (names: string[]) => {
      const out = new Map<string, ExtensionUpdateEntry>();
      for (const n of names) {
        const e = byName.get(n);
        if (e) out.set(n, e);
      }
      return out;
    },
    upsert: async () => {},
  };
}

function makeDeps(
  overrides: Partial<ExtensionAutoUpdateDeps> = {},
): ExtensionAutoUpdateDeps & {
  executeUpdate: ReturnType<typeof vi.fn>;
  writeAuditEvent: ReturnType<typeof vi.fn>;
} {
  const deps = {
    isEnabled: () => true,
    // #1042 slice-3 policy deps default to permissive (window open, nothing
    // denied) so the pre-existing coverage is unaffected.
    isWithinMaintenanceWindow: () => true,
    isDenied: () => false,
    listInstalledRows: async () => [makeRow()],
    isRequiredInProd: () => false,
    resolveUpdateReadModelStore: async () => makeStore([makeEntry()]),
    evaluateAbiCompat: () => ({ compatible: true }),
    isSignatureReady: vi.fn(async () => true),
    executeUpdate: vi.fn(async () => {}),
    writeAuditEvent: vi.fn(async (_e: AutoUpdateAuditEvent) => {}),
    now: () => NOW,
    ...overrides,
  };
  return deps as ReturnType<typeof makeDeps>;
}

beforeEach(() => {
  // NOTE: extensionsWiringImported is deliberately NOT cleared — the mock
  // factory for "@/lib/extensions" runs once per module cache, so the record
  // asserts "was bootstrapped before any dispatch" across the file.
  isGatekeptInstallEnabledMock.mockReset();
  isGatekeptInstallEnabledMock.mockReturnValue(false);
  installExtensionWithDependenciesMock.mockClear();
  registryUpdateMock.mockClear();
});

describe("master flag (default OFF)", () => {
  it("isExtensionAutoUpdateEnabled: only the literal \"true\" enables", () => {
    const prior = process.env.CINATRA_EXTENSION_AUTO_UPDATE;
    try {
      delete process.env.CINATRA_EXTENSION_AUTO_UPDATE;
      expect(isExtensionAutoUpdateEnabled()).toBe(false);
      process.env.CINATRA_EXTENSION_AUTO_UPDATE = "1";
      expect(isExtensionAutoUpdateEnabled()).toBe(false);
      process.env.CINATRA_EXTENSION_AUTO_UPDATE = "true";
      expect(isExtensionAutoUpdateEnabled()).toBe(true);
    } finally {
      if (prior === undefined) delete process.env.CINATRA_EXTENSION_AUTO_UPDATE;
      else process.env.CINATRA_EXTENSION_AUTO_UPDATE = prior;
    }
  });

  it("flag OFF at cycle time → complete no-op: nothing read, executed, or audited", async () => {
    const listInstalledRows = vi.fn(async () => [makeRow()]);
    const resolveUpdateReadModelStore = vi.fn(async () => makeStore([makeEntry()]));
    const deps = makeDeps({
      isEnabled: () => false,
      listInstalledRows,
      resolveUpdateReadModelStore,
    });

    const summary = await runExtensionAutoUpdateCycle(deps);

    expect(summary.enabled).toBe(false);
    expect(listInstalledRows).not.toHaveBeenCalled();
    expect(resolveUpdateReadModelStore).not.toHaveBeenCalled();
    expect(deps.executeUpdate).not.toHaveBeenCalled();
    expect(deps.writeAuditEvent).not.toHaveBeenCalled();
  });
});

describe("candidate selection", () => {
  it("eligible update-available candidate executes through the dispatch with the system actor", async () => {
    const deps = makeDeps();

    const summary = await runExtensionAutoUpdateCycle(deps);

    expect(deps.executeUpdate).toHaveBeenCalledTimes(1);
    expect(deps.executeUpdate).toHaveBeenCalledWith(
      { packageName: "@acme/foo", kind: "connector", toVersion: "1.1.0", fromVersion: "1.0.0" },
      expect.objectContaining({
        actorType: "system",
        source: "worker",
        userId: EXTENSION_AUTO_UPDATE_ACTOR_ID,
        platformRole: "platform_admin",
        orgId: null,
      }),
    );
    expect(summary.applied).toEqual([
      {
        packageName: "@acme/foo",
        rowId: "row-1",
        organizationId: null,
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
      },
    ]);
    expect(summary.failed).toEqual([]);
    expect(summary.scanned).toBe(1);
    expect(summary.readModelWired).toBe(true);
    expect(summary.signatureReady).toBe(true);
  });

  it("a locked row is still updatable (live set = active|locked)", async () => {
    const deps = makeDeps({
      listInstalledRows: async () => [makeRow({ status: "locked" })],
    });
    const summary = await runExtensionAutoUpdateCycle(deps);
    expect(summary.applied).toHaveLength(1);
  });

  it("up-to-date row is skipped (no execution)", async () => {
    const deps = makeDeps({
      resolveUpdateReadModelStore: async () =>
        makeStore([makeEntry({ latestVersion: "1.0.0" })]),
    });
    const summary = await runExtensionAutoUpdateCycle(deps);
    expect(deps.executeUpdate).not.toHaveBeenCalled();
    expect(summary.skipped).toEqual([{ packageName: "@acme/foo", reason: "up-to-date" }]);
  });

  it("installed-newer reads as up-to-date (never a downgrade)", async () => {
    const deps = makeDeps({
      listInstalledRows: async () => [
        makeRow({ source: { type: "verdaccio", version: "2.0.0" } }),
      ],
    });
    const summary = await runExtensionAutoUpdateCycle(deps);
    expect(deps.executeUpdate).not.toHaveBeenCalled();
    expect(summary.skipped).toEqual([{ packageName: "@acme/foo", reason: "up-to-date" }]);
  });

  it("required-in-prod (system) extensions never auto-update", async () => {
    const deps = makeDeps({ isRequiredInProd: () => true });
    const summary = await runExtensionAutoUpdateCycle(deps);
    expect(deps.executeUpdate).not.toHaveBeenCalled();
    expect(summary.skipped).toEqual([
      { packageName: "@acme/foo", reason: "required-in-prod-scope" },
    ]);
  });

  // #1042 slice-2: the org-rows fence is LIFTED (row-scoped compensation). An
  // org-scoped row on the instance no longer halts the whole cycle — the
  // NULL-org candidate proceeds, and the org-scoped package (never a NULL-org
  // candidate) is untouched.
  it("a LIVE org-scoped row no longer fences the cycle — the NULL-org candidate proceeds", async () => {
    const resolveUpdateReadModelStore = vi.fn(async () => makeStore([makeEntry()]));
    const deps = makeDeps({
      listInstalledRows: async () => [
        makeRow(), // an eligible NULL-org candidate (@acme/foo 1.0.0 -> 1.1.0)
        makeRow({ id: "r-org", packageName: "@acme/other", organizationId: "org-1" }),
      ],
      resolveUpdateReadModelStore,
    });

    const summary = await runExtensionAutoUpdateCycle(deps);

    expect(resolveUpdateReadModelStore).toHaveBeenCalled(); // no longer fenced before the read model
    expect(deps.executeUpdate).toHaveBeenCalledTimes(1);
    expect(deps.executeUpdate).toHaveBeenCalledWith(
      { packageName: "@acme/foo", kind: "connector", toVersion: "1.1.0", fromVersion: "1.0.0" },
      expect.anything(),
    );
    // The org-scoped package is never a candidate (structural NULL-org bound).
    expect(
      deps.executeUpdate.mock.calls.some((c) => (c[0] as { packageName: string }).packageName === "@acme/other"),
    ).toBe(false);
    expect(summary.applied.map((a) => a.packageName)).toEqual(["@acme/foo"]);
    expect(summary.skipped).toEqual([]);
  });

  it("an ARCHIVED org row also no longer fences", async () => {
    const deps = makeDeps({
      listInstalledRows: async () => [
        makeRow(),
        makeRow({ id: "r-org", packageName: "@acme/other", organizationId: "org-1", status: "archived" }),
      ],
    });
    const summary = await runExtensionAutoUpdateCycle(deps);
    expect(deps.executeUpdate).toHaveBeenCalledTimes(1);
    expect(summary.applied.map((a) => a.packageName)).toEqual(["@acme/foo"]);
    expect(summary.skipped).toEqual([]);
  });

  it("side-by-side NULL-org rows of one package are ambiguous → skipped", async () => {
    const deps = makeDeps({
      listInstalledRows: async () => [
        makeRow({ id: "r1", source: { type: "verdaccio", version: "1.0.0" } }),
        makeRow({ id: "r2", source: { type: "verdaccio", version: "1.2.0" } }),
      ],
    });
    const summary = await runExtensionAutoUpdateCycle(deps);
    expect(deps.executeUpdate).not.toHaveBeenCalled();
    expect(summary.skipped).toEqual([
      { packageName: "@acme/foo", reason: "ambiguous-install-scope" },
    ]);
  });

  it("non-verdaccio sources are skipped (no registry update semantics)", async () => {
    const deps = makeDeps({
      listInstalledRows: async () => [makeRow({ source: { type: "bundled", version: "1.0.0" } })],
    });
    const summary = await runExtensionAutoUpdateCycle(deps);
    expect(deps.executeUpdate).not.toHaveBeenCalled();
    expect(summary.skipped).toEqual([
      { packageName: "@acme/foo", reason: "non-verdaccio-source" },
    ]);
  });

  it("archived rows are not scanned at all", async () => {
    const deps = makeDeps({
      listInstalledRows: async () => [makeRow({ status: "archived" })],
    });
    const summary = await runExtensionAutoUpdateCycle(deps);
    expect(summary.scanned).toBe(0);
    expect(summary.skipped).toEqual([]);
    expect(deps.executeUpdate).not.toHaveBeenCalled();
  });
});

describe("read model gates", () => {
  it("no persistent store wired → zero candidates, loud warn, readModelWired:false", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = makeDeps({ resolveUpdateReadModelStore: async () => null });

    const summary = await runExtensionAutoUpdateCycle(deps);

    expect(summary.readModelWired).toBe(false);
    expect(deps.executeUpdate).not.toHaveBeenCalled();
    expect(summary.skipped).toEqual([
      { packageName: "@acme/foo", reason: "read-model-unwired" },
    ]);
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("no persistent update read-model store")),
    ).toBe(true);
    // The run summary audit event is still written (not presented as success).
    expect(deps.writeAuditEvent).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("never-synced package (no entry) is stale → skipped", async () => {
    const deps = makeDeps({ resolveUpdateReadModelStore: async () => makeStore([]) });
    const summary = await runExtensionAutoUpdateCycle(deps);
    expect(summary.skipped).toEqual([{ packageName: "@acme/foo", reason: "read-model-stale" }]);
  });

  it("entry older than the TTL is stale → skipped", async () => {
    const old = new Date(NOW.getTime() - EXTENSION_AUTO_UPDATE_READ_MODEL_TTL_MS - 1);
    const deps = makeDeps({
      resolveUpdateReadModelStore: async () =>
        makeStore([makeEntry({ refreshedAt: old.toISOString() })]),
    });
    const summary = await runExtensionAutoUpdateCycle(deps);
    expect(deps.executeUpdate).not.toHaveBeenCalled();
    expect(summary.skipped).toEqual([{ packageName: "@acme/foo", reason: "read-model-stale" }]);
  });

  it("entry with no comparable latest version is skipped", async () => {
    const deps = makeDeps({
      resolveUpdateReadModelStore: async () =>
        makeStore([makeEntry({ latestVersion: null })]),
    });
    const summary = await runExtensionAutoUpdateCycle(deps);
    expect(summary.skipped).toEqual([
      { packageName: "@acme/foo", reason: "no-comparable-latest" },
    ]);
  });
});

describe("ABI compatibility gate", () => {
  it("ABI-incompatible latest is skipped, never executed", async () => {
    const evaluateAbiCompat = vi.fn(() => ({ compatible: false }));
    const deps = makeDeps({ evaluateAbiCompat });

    const summary = await runExtensionAutoUpdateCycle(deps);

    expect(evaluateAbiCompat).toHaveBeenCalledWith("^2"); // the entry's declared range, verbatim
    expect(deps.executeUpdate).not.toHaveBeenCalled();
    expect(summary.skipped).toEqual([{ packageName: "@acme/foo", reason: "abi-incompatible" }]);
  });
});

describe("fleet signature-readiness gate", () => {
  it("NOT-READY → zero candidates executed (all skipped, fail-closed)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = makeDeps({ isSignatureReady: vi.fn(async () => false) });

    const summary = await runExtensionAutoUpdateCycle(deps);

    expect(deps.executeUpdate).not.toHaveBeenCalled();
    expect(summary.signatureReady).toBe(false);
    expect(summary.skipped).toEqual([
      { packageName: "@acme/foo", reason: "signature-readiness" },
    ]);
    warn.mockRestore();
  });

  it("evaluated once per cycle, and ONLY when candidates survived selection", async () => {
    const isSignatureReady = vi.fn(async () => true);
    // No update available → no candidates → the predicate must not run.
    const deps = makeDeps({
      isSignatureReady,
      resolveUpdateReadModelStore: async () =>
        makeStore([makeEntry({ latestVersion: "1.0.0" })]),
    });
    const summary = await runExtensionAutoUpdateCycle(deps);
    expect(isSignatureReady).not.toHaveBeenCalled();
    expect(summary.signatureReady).toBe(null);
  });
});

describe("execution isolation + audit trail", () => {
  it("one candidate's failure never aborts the rest; both outcomes audited", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const rows = [
      makeRow({ id: "r1", packageName: "@acme/foo" }),
      makeRow({ id: "r2", packageName: "@acme/bar", kind: "skill" }),
    ];
    const entries = [
      makeEntry({ packageName: "@acme/foo" }),
      makeEntry({ packageName: "@acme/bar", latestVersion: "1.5.0" }),
    ];
    const executeUpdate = vi
      .fn(async () => {})
      .mockRejectedValueOnce(new Error("member install failed; batch compensated"));
    const deps = makeDeps({
      listInstalledRows: async () => rows,
      resolveUpdateReadModelStore: async () => makeStore(entries),
      executeUpdate,
    });

    const summary = await runExtensionAutoUpdateCycle(deps);

    expect(executeUpdate).toHaveBeenCalledTimes(2);
    expect(summary.failed).toEqual([
      {
        packageName: "@acme/foo",
        rowId: "r1",
        organizationId: null,
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
        error: "member install failed; batch compensated",
      },
    ]);
    expect(summary.applied).toEqual([
      {
        packageName: "@acme/bar",
        rowId: "r2",
        organizationId: null,
        fromVersion: "1.0.0",
        toVersion: "1.5.0",
      },
    ]);

    // Audit rows: one failed event, one applied event, one run summary — every
    // one carrying the defined system principal.
    const events = deps.writeAuditEvent.mock.calls.map((c) => c[0] as AutoUpdateAuditEvent);
    expect(events).toHaveLength(3);
    for (const e of events) {
      expect(e.actorPrincipalId).toBe(EXTENSION_AUTO_UPDATE_ACTOR_ID);
      expect(e.actorPrincipalType).toBe("system");
      expect(e.authSource).toBe("worker");
    }
    const failedEvent = events.find((e) => e.operation === "extension_auto_update_failed");
    expect(failedEvent).toMatchObject({
      resourceId: "@acme/foo",
      metadata: expect.objectContaining({
        rowId: "r1",
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
        error: "member install failed; batch compensated",
      }),
    });
    const appliedEvent = events.find((e) => e.operation === "extension_auto_update_applied");
    expect(appliedEvent).toMatchObject({
      resourceId: "@acme/bar",
      decision: "allowed",
      metadata: expect.objectContaining({ rowId: "r2", toVersion: "1.5.0" }),
    });
    const runEvent = events.find((e) => e.operation === "extension_auto_update_run");
    expect(runEvent).toMatchObject({
      metadata: expect.objectContaining({ applied: 1, failed: 1, scanned: 2 }),
    });
    error.mockRestore();
  });

  it("an audit-write failure never flips an update outcome (counted, warned)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = makeDeps({
      writeAuditEvent: vi.fn(async () => {
        throw new Error("audit db down");
      }),
    });

    const summary = await runExtensionAutoUpdateCycle(deps);

    expect(summary.applied).toHaveLength(1);
    expect(summary.failed).toHaveLength(0);
    expect(summary.auditWriteFailures).toBe(2); // applied event + run event
    warn.mockRestore();
  });
});

describe("pre-dispatch TOCTOU recheck (state-drift)", () => {
  it("a candidate archived between selection and dispatch is skipped state-drift; the rest still applies", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const initialRows = [
      makeRow({ id: "r1", packageName: "@acme/foo" }),
      makeRow({ id: "r2", packageName: "@acme/bar" }),
    ];
    let reads = 0;
    const deps = makeDeps({
      listInstalledRows: async () => {
        reads += 1;
        // Read 1 = the selection scan; later reads = the pre-dispatch
        // rechecks — @acme/foo has been archived in between.
        return reads === 1
          ? initialRows
          : [
              makeRow({ id: "r1", packageName: "@acme/foo", status: "archived" }),
              makeRow({ id: "r2", packageName: "@acme/bar" }),
            ];
      },
      resolveUpdateReadModelStore: async () =>
        makeStore([
          makeEntry({ packageName: "@acme/foo" }),
          makeEntry({ packageName: "@acme/bar", latestVersion: "1.5.0" }),
        ]),
    });

    const summary = await runExtensionAutoUpdateCycle(deps);

    expect(deps.executeUpdate).toHaveBeenCalledTimes(1);
    expect(deps.executeUpdate.mock.calls[0][0]).toMatchObject({ packageName: "@acme/bar" });
    expect(summary.skipped).toContainEqual({ packageName: "@acme/foo", reason: "state-drift" });
    expect(summary.applied).toEqual([
      {
        packageName: "@acme/bar",
        rowId: "r2",
        organizationId: null,
        fromVersion: "1.0.0",
        toVersion: "1.5.0",
      },
    ]);
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("pre-dispatch recheck refused")),
    ).toBe(true);
    warn.mockRestore();
  });

  it("a manual advance beyond the cached target is refused (never overwritten/downgraded)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let reads = 0;
    const deps = makeDeps({
      listInstalledRows: async () => {
        reads += 1;
        return reads === 1
          ? [makeRow()] // selected at 1.0.0 (cached target 1.1.0)
          : [makeRow({ source: { type: "verdaccio", version: "3.0.0" } })];
      },
    });
    const summary = await runExtensionAutoUpdateCycle(deps);
    expect(deps.executeUpdate).not.toHaveBeenCalled();
    expect(summary.skipped).toContainEqual({ packageName: "@acme/foo", reason: "state-drift" });
    warn.mockRestore();
  });

  it("a recheck re-read THROW is a per-candidate failure (fail closed), never an execution", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let reads = 0;
    const deps = makeDeps({
      listInstalledRows: async () => {
        reads += 1;
        if (reads === 1) return [makeRow()];
        throw new Error("db unavailable");
      },
    });
    const summary = await runExtensionAutoUpdateCycle(deps);
    expect(deps.executeUpdate).not.toHaveBeenCalled();
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0]).toMatchObject({
      packageName: "@acme/foo",
      error: "db unavailable",
    });
    error.mockRestore();
  });

  it("evaluateCandidateRecheck — the drift verdict matrix", () => {
    const selected = {
      rowId: "row-1",
      packageName: "@acme/foo",
      kind: "connector",
      expectedVersion: "1.0.0",
    };
    // Exact match → ok.
    expect(evaluateCandidateRecheck([makeRow()], selected)).toEqual({ ok: true });
    const refusals: [AutoUpdateInstalledRow[], string][] = [
      // Row gone (uninstall race).
      [[], "row removed"],
      // New NULL-org sibling (side-by-side race) — every status counts.
      [[makeRow(), makeRow({ id: "row-2", status: "archived" })], "ambiguous"],
      // Row replaced (uninstall + reinstall race).
      [[makeRow({ id: "row-9" })], "different rowId"],
      // No longer live (archive race).
      [[makeRow({ status: "archived" })], "no longer live"],
      // Kind changed.
      [[makeRow({ kind: "agent" })], "kind changed"],
      // Source switched off verdaccio.
      [[makeRow({ source: { type: "github" } })], "source switched"],
      // Version moved FORWARD (manual advance beyond the cached target).
      [[makeRow({ source: { type: "verdaccio", version: "3.0.0" } })], "1.0.0 -> 3.0.0"],
      // Version moved BACKWARD.
      [[makeRow({ source: { type: "verdaccio", version: "0.9.0" } })], "1.0.0 -> 0.9.0"],
    ];
    for (const [rows, needle] of refusals) {
      const verdict = evaluateCandidateRecheck(rows, selected);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.detail).toContain(needle);
    }
    // #1042 slice-2: an org-scoped row of a DIFFERENT package appearing since
    // selection no longer refuses (the fence is lifted; the recheck is
    // package-scoped to the candidate's own unchanged NULL-org row).
    expect(
      evaluateCandidateRecheck(
        [makeRow(), makeRow({ id: "r-org", packageName: "@acme/other", organizationId: "org-1" })],
        selected,
      ),
    ).toEqual({ ok: true });
  });
});

describe("defaultExecuteUpdate — the manual-update dispatch mirror", () => {
  const actor = buildExtensionAutoUpdateActor();
  const candidate = {
    packageName: "@acme/foo",
    kind: "connector",
    toVersion: "1.1.0",
    fromVersion: "1.0.0",
  };

  it("non-gatekept: routes through the planner/batch as a committed in-place update; threads the CAS + row-scoped compensation", async () => {
    isGatekeptInstallEnabledMock.mockReturnValue(false);

    await defaultExecuteUpdate(candidate, actor);

    // Host handler wiring is bootstrapped BEFORE dispatch (worker process).
    expect(extensionsWiringImported).toHaveBeenCalled();
    // #1042 slice-1: the expected-version CAS rides `expectedRootInstalledVersion`.
    // #1042 slice-2: row-scoped compensation is opted in.
    expect(installExtensionWithDependenciesMock).toHaveBeenCalledWith({
      packageName: "@acme/foo",
      version: "1.1.0",
      actor,
      rootAction: "update",
      expectedRootInstalledVersion: "1.0.0",
      rowScopedCompensation: true,
    });
    expect(registryUpdateMock).not.toHaveBeenCalled();
  });

  it("gatekept: keeps the direct in-place registry update (batch fenced, #1296); threads the CAS option", async () => {
    isGatekeptInstallEnabledMock.mockReturnValue(true);

    await defaultExecuteUpdate(candidate, actor);

    expect(extensionsWiringImported).toHaveBeenCalled();
    // #1042 slice-1: the CAS precondition rides the update's fourth options arg.
    expect(registryUpdateMock).toHaveBeenCalledWith(
      "connector",
      { registryUrl: "", packageName: "@acme/foo", version: "1.1.0" },
      actor,
      { expectedInstalledVersion: "1.0.0" },
    );
    expect(installExtensionWithDependenciesMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// #1042 slice-1 — expected-version CAS: a concurrent update that won the race
// makes THIS cached target lose CLEANLY (a benign skip, never a failure or a
// double-apply). The atomic CAS lives in the shared registry dispatch; the loop
// only has to classify the refusal it throws.
// ---------------------------------------------------------------------------
describe("#1042 slice-1: expected-version CAS lost race", () => {
  function casMismatch(): Error {
    // Mirror ExpectedInstalledVersionMismatchError's discriminant without the
    // cross-package class import (exactly how the loop duck-types it).
    const err = new Error(
      "expected-version CAS refused the update of @acme/foo: a concurrent update won",
    );
    (err as unknown as { code: string }).code = "EXPECTED_VERSION_MISMATCH";
    return err;
  }

  it("a CAS mismatch is recorded as `cas-version-lost` (a skip), not `failed`", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const executeUpdate = vi.fn(async () => {
      throw casMismatch();
    });
    const deps = makeDeps({ executeUpdate });

    const summary = await runExtensionAutoUpdateCycle(deps);

    expect(executeUpdate).toHaveBeenCalledTimes(1);
    expect(summary.failed).toEqual([]); // NOT a failure
    expect(summary.applied).toEqual([]); // never double-applied
    expect(summary.skipped).toContainEqual({
      packageName: "@acme/foo",
      reason: "cas-version-lost",
    });
    // No `extension_auto_update_failed` audit event for a benign lost race.
    const ops = deps.writeAuditEvent.mock.calls.map(
      (c) => (c[0] as AutoUpdateAuditEvent).operation,
    );
    expect(ops).not.toContain("extension_auto_update_failed");
    warn.mockRestore();
  });

  it("one candidate losing the CAS never aborts the rest", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows = [
      makeRow({ id: "r1", packageName: "@acme/foo" }),
      makeRow({ id: "r2", packageName: "@acme/bar", kind: "skill" }),
    ];
    const entries = [
      makeEntry({ packageName: "@acme/foo" }),
      makeEntry({ packageName: "@acme/bar", latestVersion: "1.5.0" }),
    ];
    const executeUpdate = vi
      .fn(async () => {})
      .mockRejectedValueOnce(casMismatch()); // @acme/foo loses the CAS
    const deps = makeDeps({
      listInstalledRows: async () => rows,
      resolveUpdateReadModelStore: async () => makeStore(entries),
      executeUpdate,
    });

    const summary = await runExtensionAutoUpdateCycle(deps);

    expect(executeUpdate).toHaveBeenCalledTimes(2);
    expect(summary.skipped).toContainEqual({
      packageName: "@acme/foo",
      reason: "cas-version-lost",
    });
    expect(summary.applied.map((a) => a.packageName)).toEqual(["@acme/bar"]);
    expect(summary.failed).toEqual([]);
    warn.mockRestore();
  });

  it("the CAS from-version is exactly the selected currentVersion", async () => {
    const executeUpdate = vi.fn(async () => {});
    const deps = makeDeps({
      listInstalledRows: async () => [
        makeRow({ source: { type: "verdaccio", version: "2.3.4" } }),
      ],
      resolveUpdateReadModelStore: async () =>
        makeStore([makeEntry({ latestVersion: "2.4.0" })]),
      executeUpdate,
    });

    await runExtensionAutoUpdateCycle(deps);

    expect(executeUpdate).toHaveBeenCalledWith(
      { packageName: "@acme/foo", kind: "connector", toVersion: "2.4.0", fromVersion: "2.3.4" },
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// #1042 slice-3 — policy knobs (maintenance window + deny list). Additive
// suppressors UNDER the master flag: default OFF stays OFF.
// ---------------------------------------------------------------------------
describe("#1042 slice-3: maintenance-window + deny-list policy knobs", () => {
  it("outside the maintenance window the whole cycle is suppressed (no reads, no dispatch)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const listInstalledRows = vi.fn(async () => [makeRow()]);
    const deps = makeDeps({
      isWithinMaintenanceWindow: () => false,
      listInstalledRows,
    });

    const summary = await runExtensionAutoUpdateCycle(deps);

    expect(summary.maintenanceWindowOpen).toBe(false);
    expect(listInstalledRows).not.toHaveBeenCalled(); // no reads at all
    expect(deps.executeUpdate).not.toHaveBeenCalled();
    expect(summary.applied).toEqual([]);
    expect(summary.skipped).toEqual([]);
    // A suppressed run is still observable — the per-run audit fires.
    const runEvents = deps.writeAuditEvent.mock.calls
      .map((c) => c[0] as AutoUpdateAuditEvent)
      .filter((e) => e.operation === "extension_auto_update_run");
    expect(runEvents).toHaveLength(1);
    expect(runEvents[0]!.metadata).toMatchObject({ maintenanceWindowOpen: false });
    warn.mockRestore();
  });

  it("inside the window the cycle runs normally (windowOpen:true)", async () => {
    const deps = makeDeps({ isWithinMaintenanceWindow: () => true });
    const summary = await runExtensionAutoUpdateCycle(deps);
    expect(summary.maintenanceWindowOpen).toBe(true);
    expect(deps.executeUpdate).toHaveBeenCalledTimes(1);
  });

  it("a deny-listed package never auto-updates even when otherwise eligible", async () => {
    const deps = makeDeps({
      listInstalledRows: async () => [
        makeRow({ id: "r1", packageName: "@acme/foo" }),
        makeRow({ id: "r2", packageName: "@acme/bar", kind: "skill" }),
      ],
      resolveUpdateReadModelStore: async () =>
        makeStore([
          makeEntry({ packageName: "@acme/foo" }),
          makeEntry({ packageName: "@acme/bar", latestVersion: "1.5.0" }),
        ]),
      isDenied: (p) => p === "@acme/foo",
    });

    const summary = await runExtensionAutoUpdateCycle(deps);

    expect(summary.skipped).toContainEqual({
      packageName: "@acme/foo",
      reason: "deny-listed",
    });
    expect(deps.executeUpdate).toHaveBeenCalledTimes(1);
    expect(deps.executeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ packageName: "@acme/bar" }),
      expect.anything(),
    );
  });

  it("DEFAULT OFF STAYS OFF: with the flag off, the policy knobs are never even consulted", async () => {
    const isWithinMaintenanceWindow = vi.fn(() => true);
    const isDenied = vi.fn(() => false);
    const listInstalledRows = vi.fn(async () => [makeRow()]);
    const deps = makeDeps({
      isEnabled: () => false,
      isWithinMaintenanceWindow,
      isDenied,
      listInstalledRows,
    });

    const summary = await runExtensionAutoUpdateCycle(deps);

    expect(summary.enabled).toBe(false);
    expect(summary.maintenanceWindowOpen).toBeNull(); // never evaluated
    expect(isWithinMaintenanceWindow).not.toHaveBeenCalled();
    expect(isDenied).not.toHaveBeenCalled();
    expect(listInstalledRows).not.toHaveBeenCalled();
    expect(deps.writeAuditEvent).not.toHaveBeenCalled(); // no run audit either
  });

  it("isWithinMaintenanceWindowSpec — unset opens, malformed/degenerate fail-closed, ranges + wrap", () => {
    const at = (h: number) => new Date(Date.UTC(2026, 6, 11, h, 30, 0));
    // Unset / empty → open (no restriction).
    expect(isWithinMaintenanceWindowSpec(undefined, at(3))).toBe(true);
    expect(isWithinMaintenanceWindowSpec("", at(3))).toBe(true);
    expect(isWithinMaintenanceWindowSpec("   ", at(3))).toBe(true);
    // Malformed → FAIL-CLOSED (closed).
    for (const bad of ["abc", "1", "1-2-3", "1:00-5:00", "-1-5", "1-24", "24-1", "9-nine"]) {
      expect(isWithinMaintenanceWindowSpec(bad, at(3))).toBe(false);
    }
    // Degenerate start==end → fail-closed.
    expect(isWithinMaintenanceWindowSpec("3-3", at(3))).toBe(false);
    // Non-wrap window "1-5" = hours 1,2,3,4 (end exclusive).
    expect(isWithinMaintenanceWindowSpec("1-5", at(0))).toBe(false);
    expect(isWithinMaintenanceWindowSpec("1-5", at(1))).toBe(true);
    expect(isWithinMaintenanceWindowSpec("1-5", at(4))).toBe(true);
    expect(isWithinMaintenanceWindowSpec("1-5", at(5))).toBe(false);
    // Wrap window "22-6" = 22,23,0,1,2,3,4,5.
    expect(isWithinMaintenanceWindowSpec("22-6", at(23))).toBe(true);
    expect(isWithinMaintenanceWindowSpec("22-6", at(0))).toBe(true);
    expect(isWithinMaintenanceWindowSpec("22-6", at(5))).toBe(true);
    expect(isWithinMaintenanceWindowSpec("22-6", at(6))).toBe(false);
    expect(isWithinMaintenanceWindowSpec("22-6", at(12))).toBe(false);
  });

  it("parseAutoUpdateDenyList — trims, drops empties, unset → empty", () => {
    expect(parseAutoUpdateDenyList(undefined)).toEqual(new Set());
    expect(parseAutoUpdateDenyList("")).toEqual(new Set());
    expect(parseAutoUpdateDenyList(" @a/b , ,@c/d ,, ")).toEqual(
      new Set(["@a/b", "@c/d"]),
    );
  });
});
