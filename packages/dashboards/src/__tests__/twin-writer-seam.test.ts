// Seam contract tests for the dashboards-artifact twin writer (cinatra#1894 B1b).
//
// Proves the FAIL-CLOSED disposition (Q1) and the double-registration guard +
// test-reset (delta D4). No DB — the seam is pure registration/dispatch; the
// substrate-backed kill-tests prove atomicity separately.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DashboardArtifactTwinWriter,
  DashboardTwinContext,
  DashboardTwinWriterConflictError,
  DashboardTwinWriterNotRegisteredError,
  NOOP_DASHBOARD_TWIN_WRITER,
  isDashboardArtifactTwinWriterRegistered,
  pairTwin,
  resetDashboardArtifactTwinWriter,
  setDashboardArtifactTwinWriter,
  type TwinTx,
} from "../twin-writer-seam";

const fakeTx: TwinTx = { execute: async () => undefined };
const ctx: DashboardTwinContext = {
  operation: "upsert",
  dashboardId: "dash-1",
  orgId: "org-1",
  ownerLevel: "user",
  ownerId: "user-1",
  projectId: null,
  actorId: "user-1",
};

// The seam holds process-global state; reset between tests for isolation.
afterEach(() => resetDashboardArtifactTwinWriter());

describe("twin-writer seam — fail-closed (Q1)", () => {
  it("pairTwin THROWS when no writer is registered (never a silent no-op)", async () => {
    expect(isDashboardArtifactTwinWriterRegistered()).toBe(false);
    await expect(pairTwin(fakeTx, ctx)).rejects.toBeInstanceOf(
      DashboardTwinWriterNotRegisteredError,
    );
  });

  it("pairTwin invokes the registered writer with (tx, ctx)", async () => {
    const spy = vi.fn<DashboardArtifactTwinWriter>(async () => {});
    setDashboardArtifactTwinWriter(spy);
    expect(isDashboardArtifactTwinWriterRegistered()).toBe(true);
    await pairTwin(fakeTx, ctx);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(fakeTx, ctx);
  });

  it("propagates a twin-writer throw (poisoned twin rolls back the caller tx)", async () => {
    const boom = new Error("substrate write failed");
    setDashboardArtifactTwinWriter(async () => {
      throw boom;
    });
    await expect(pairTwin(fakeTx, ctx)).rejects.toBe(boom);
  });
});

describe("twin-writer seam — registration guard + reset (D4)", () => {
  it("re-registering the SAME writer reference is idempotent", () => {
    const writer: DashboardArtifactTwinWriter = async () => {};
    setDashboardArtifactTwinWriter(writer);
    expect(() => setDashboardArtifactTwinWriter(writer)).not.toThrow();
    expect(isDashboardArtifactTwinWriterRegistered()).toBe(true);
  });

  it("registering a DIFFERENT writer over an existing one throws", () => {
    setDashboardArtifactTwinWriter(async () => {});
    expect(() => setDashboardArtifactTwinWriter(async () => {})).toThrow(
      DashboardTwinWriterConflictError,
    );
  });

  it("reset clears registration so a distinct writer can register", () => {
    const first: DashboardArtifactTwinWriter = async () => {};
    setDashboardArtifactTwinWriter(first);
    resetDashboardArtifactTwinWriter();
    expect(isDashboardArtifactTwinWriterRegistered()).toBe(false);
    const second: DashboardArtifactTwinWriter = async () => {};
    expect(() => setDashboardArtifactTwinWriter(second)).not.toThrow();
  });

  it("NOOP twin satisfies the fail-closed seam without a substrate", async () => {
    setDashboardArtifactTwinWriter(NOOP_DASHBOARD_TWIN_WRITER);
    await expect(pairTwin(fakeTx, ctx)).resolves.toBeUndefined();
  });
});
