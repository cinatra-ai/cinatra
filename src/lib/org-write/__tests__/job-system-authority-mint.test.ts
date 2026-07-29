/**
 * cinatra#1941 S2, §5 — the cross-job system-authority mint seam
 * (`mintSystemAuthorityForJob`). Pins the issue's "cross-job capability
 * misuse refused" acceptance row end-to-end: no frame; wrong authorityKind;
 * purpose not in allowedPurposes; allowedPurposes ABSENT (deny-all default,
 * including the non-mintable arm); a purpose whose grants exceed the
 * declared capabilities ceiling (independent check, via synthetic metadata);
 * org-hopping under a payload-bound frame; and the positive controls proving
 * each refusal path isn't vacuously green.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

const { logAuditEventMock } = vi.hoisted(() => ({
  logAuditEventMock: vi.fn(async () => undefined),
}));
vi.mock("@/lib/authz/audit", () => ({
  logAuditEvent: logAuditEventMock,
}));

import { ORG_WRITE_CAPABILITIES } from "@cinatra-ai/org-write-kernel";
import type { OrgWriteAuthority, OrgWriteCapability } from "@cinatra-ai/org-write-kernel";
import { runWithJobFrame } from "@/lib/background-jobs-system-frame";
import { mintSystemAuthorityForJob } from "../job-system-authority-mint";
import { OrgWriteAuthorityError } from "../authority";
import type { JobAuthorityMetadata } from "@/lib/background-jobs-registry";

/** Assert `authority` grants EXACTLY `granted` and denies every other kernel
 *  capability — a full-surface pin, matching the house style in
 *  agent-run-authority-mint.test.ts. */
function expectExactGrant(authority: OrgWriteAuthority, granted: readonly OrgWriteCapability[]) {
  for (const cap of ORG_WRITE_CAPABILITIES) {
    expect(authority.can(cap)).toBe(granted.includes(cap));
  }
}

function run<T>(jobName: string, authority: JobAuthorityMetadata, payload: unknown, fn: () => T): Promise<T> {
  return Promise.resolve(
    runWithJobFrame({ jobName, jobId: "job-1", authority, payload }, fn),
  );
}

beforeEach(() => {
  logAuditEventMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Builds a mintable `system-maintenance` fixture. Loosely typed on purpose
 * (a `Record<string, unknown>` cast to `JobAuthorityMetadata`) — these are
 * runtime fixtures for the seam's OWN black-box behavior, including
 * deliberately-invalid combinations (test (c) omits `allowedPurposes`; test
 * (d) declares a purpose whose grants exceed its own capabilities) that the
 * strict discriminated-union type would otherwise reject at compile time.
 * The seam under test never trusts the type system either — it re-derives
 * every check from the object's actual runtime shape.
 */
function mintableMaintenance(overrides: {
  orgExtractor?: Record<string, unknown>;
  capabilities?: string[];
  allowedPurposes?: string[];
} = {}): JobAuthorityMetadata {
  const fields: Record<string, unknown> = {
    authorityKind: "system-maintenance",
    actorSource: "dispatcher-system-identity",
    orgExtractor: overrides.orgExtractor ?? { source: "row-sweep", note: "test sweep" },
    capabilities: overrides.capabilities ?? ["content.write"],
  };
  if ("allowedPurposes" in overrides) {
    fields.allowedPurposes = overrides.allowedPurposes;
  } else {
    fields.allowedPurposes = ["dashboard-twin-backfill"];
  }
  return fields as unknown as JobAuthorityMetadata;
}

const NON_MINTABLE_MAINTENANCE: JobAuthorityMetadata = {
  authorityKind: "system-maintenance",
  actorSource: "dispatcher-system-identity",
  orgExtractor: { source: "global-org-attributed", note: "test global cutoff" },
  capabilities: [],
};

const GRANDFATHERED_RUN: JobAuthorityMetadata = {
  authorityKind: "grandfathered-run",
  actorSource: "run-row",
  orgExtractor: { source: "run-row" },
  runExtractor: { source: "payload", field: "runId" },
  capabilities: ["run.execute", "run.complete"],
  allowedPurposes: ["agent-run-dispatch"],
};

const NO_ORG_WRITE: JobAuthorityMetadata = {
  authorityKind: "no-org-write",
  actorSource: "none",
};

describe("no active job dispatch frame → refused", () => {
  it("throws OrgWriteAuthorityError and emits a denied audit row", () => {
    expect(() => mintSystemAuthorityForJob("dashboard-twin-backfill", "org-1")).toThrow(
      OrgWriteAuthorityError,
    );
    expect(logAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "denied", operation: "org-write.system-mint" }),
    );
  });
});

describe("authorityKind that may never mint system authority → refused", () => {
  it("no-org-write frame refuses any purpose", async () => {
    await run("NO_WRITE_JOB", NO_ORG_WRITE, {}, () => {
      expect(() => mintSystemAuthorityForJob("dashboard-twin-backfill", "org-1")).toThrow(
        OrgWriteAuthorityError,
      );
    });
    expect(logAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "denied" }),
    );
  });
});

describe("(a) purpose not in allowedPurposes → refused", () => {
  it("a job whose allowedPurposes excludes the requested purpose is refused, even though its capabilities happen to exceed it", async () => {
    const authority = mintableMaintenance({
      capabilities: ["content.write"],
      allowedPurposes: ["dashboard-twin-backfill"],
    });
    await run("SOME_JOB", authority, {}, () => {
      expect(() => mintSystemAuthorityForJob("agent-run-dispatch", "org-1")).toThrow(
        OrgWriteAuthorityError,
      );
    });
    expect(logAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "denied",
        metadata: expect.objectContaining({ purpose: "agent-run-dispatch" }),
      }),
    );
  });
});

describe("(b) positive control — purpose ∈ allowedPurposes AND grants ⊆ capabilities → minted", () => {
  it("mints an authority whose can() honors exactly the purpose's grants", async () => {
    const authority = mintableMaintenance({
      capabilities: ["content.write"],
      allowedPurposes: ["dashboard-twin-backfill"],
    });
    await run("SOME_JOB", authority, {}, () => {
      const minted = mintSystemAuthorityForJob("dashboard-twin-backfill", "org-1");
      expect(minted.orgId).toBe("org-1");
      expectExactGrant(minted, ["content.write"]);
      expect(minted.can("org.lifecycle")).toBe(false);
    });
    expect(logAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "allowed" }),
    );
  });

  it("also mints through a grandfathered-run frame for its agent-run-dispatch purpose", async () => {
    await run("AGENT_BUILDER_EXECUTION", GRANDFATHERED_RUN, { runId: "run-1" }, () => {
      const minted = mintSystemAuthorityForJob("agent-run-dispatch", "org-1");
      expectExactGrant(minted, ["run.execute", "run.complete"]);
    });
  });
});

describe("(c) allowedPurposes ABSENT → every purpose refused (deny-all default)", () => {
  it("a mintable-shaped job that omits allowedPurposes refuses even a capability-compatible purpose", async () => {
    const authority = mintableMaintenance({
      capabilities: ["content.write"],
      allowedPurposes: undefined,
    });
    await run("SOME_JOB", authority, {}, () => {
      expect(() => mintSystemAuthorityForJob("dashboard-twin-backfill", "org-1")).toThrow(
        OrgWriteAuthorityError,
      );
    });
  });

  it("the non-mintable arm (allowedPurposes forbidden by type) refuses every purpose — proves caps:[] jobs can never mint", async () => {
    await run("AUDIT_RETENTION_ENFORCE", NON_MINTABLE_MAINTENANCE, {}, () => {
      expect(() => mintSystemAuthorityForJob("dashboard-twin-backfill", "org-1")).toThrow(
        OrgWriteAuthorityError,
      );
      expect(() => mintSystemAuthorityForJob("agent-run-dispatch", "org-1")).toThrow(
        OrgWriteAuthorityError,
      );
    });
  });
});

describe("(d) purpose ∈ allowedPurposes but grants ⊄ capabilities → refused (independent check)", () => {
  it("a synthetic job declaring a purpose beyond its own capabilities ceiling is refused even though membership passes", async () => {
    // Deliberately mis-declared: allowedPurposes names "agent-run-dispatch"
    // (grants run.execute + run.complete) but capabilities only ceiling
    // content.write — proves the capability-subset check is independent of,
    // not implied by, purpose membership.
    const authority = mintableMaintenance({
      capabilities: ["content.write"],
      allowedPurposes: ["agent-run-dispatch"],
    });
    await run("MISDECLARED_JOB", authority, {}, () => {
      expect(() => mintSystemAuthorityForJob("agent-run-dispatch", "org-1")).toThrow(
        OrgWriteAuthorityError,
      );
    });
    expect(logAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "denied",
        metadata: expect.objectContaining({ purpose: "agent-run-dispatch" }),
      }),
    );
  });
});

describe("(f) org-hopping defense — payload-bound frame's orgId must match the request", () => {
  const PAYLOAD_BOUND = mintableMaintenance({
    orgExtractor: { source: "payload", field: "orgId" },
    capabilities: ["content.write"],
    allowedPurposes: ["dashboard-twin-backfill"],
  });

  it("refuses when the requested orgId does not match the job's own payload-bound org field", async () => {
    await run("ARTIFACT_MATCH_RUN", PAYLOAD_BOUND, { orgId: "org-A" }, () => {
      expect(() => mintSystemAuthorityForJob("dashboard-twin-backfill", "org-B")).toThrow(
        OrgWriteAuthorityError,
      );
    });
    expect(logAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "denied", organizationId: "org-B" }),
    );
  });

  it("mints when the requested orgId MATCHES — proves the check isn't vacuously refusing everything", async () => {
    await run("ARTIFACT_MATCH_RUN", PAYLOAD_BOUND, { orgId: "org-A" }, () => {
      const minted = mintSystemAuthorityForJob("dashboard-twin-backfill", "org-A");
      expectExactGrant(minted, ["content.write"]);
    });
  });

  it("row-sweep-bound jobs have no payload org field and skip this check by declaration", async () => {
    const rowSweep = mintableMaintenance({
      orgExtractor: { source: "row-sweep", note: "per-row org" },
      capabilities: ["content.write"],
      allowedPurposes: ["dashboard-twin-backfill"],
    });
    // No "orgId" in the payload at all — a payload-bound job would refuse
    // this, but a row-sweep job's org comes from its own row reads, so the
    // seam never compares against the (absent) payload field.
    await run("GRAPHITI_PROJECTION_REPAIR", rowSweep, { unrelated: true }, () => {
      const minted = mintSystemAuthorityForJob("dashboard-twin-backfill", "org-anything");
      expectExactGrant(minted, ["content.write"]);
    });
  });
});
