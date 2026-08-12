/**
 * cinatra#2683 (epic #2564 S8f) — the seed drivers CALL THE SHIPPED WRITERS, in
 * the shipped order, for a subject they AUTHORIZED FIRST, and report only what
 * those writers returned.
 *
 * The REAL-ROW proof is the sibling integration suite
 * (`lifecycle-seed-changeset.integration.test.ts`, real Postgres) and, for the
 * repair pipeline, the store's own
 * `packages/agents/src/__tests__/lifecycle-verification.integration.test.ts`.
 * What THIS suite pins is what those two cannot: that the seed is a SEQUENCE
 * OVER THOSE WRITERS and nothing else — no raw table write, no caller-shaped row
 * content, no invented verdict, no unauthorized subject, and no id it did not get
 * back from a writer.
 *
 * That is the whole security argument for the route, so it is tested rather than
 * asserted in a comment.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const calls: string[] = [];

const createSemanticArtifact = vi.fn(async (input: { title?: string }) => {
  calls.push("createSemanticArtifact");
  const n = calls.filter((c) => c === "createSemanticArtifact").length;
  return {
    objectId: `art-${n}`,
    artifactId: `art-${n}`,
    resourceId: `res-${n}`,
    representationRevisionId: `rev-${n}`,
    representationRevision: n,
    ref: { title: input.title } as never,
  };
});
const resolveUploadArtifactType = vi.fn((mime: string | undefined) =>
  mime === "application/x-nope"
    ? { ok: false as const, kind: "no_type", reason: "nothing accepts it", matched: [] }
    : { ok: true as const, objectTypeId: "@cinatra-ai/text-artifact:text" },
);
const emitArtifactReviewGate = vi.fn(async (_input?: unknown) => {
  calls.push("emitArtifactReviewGate");
  return { gateId: "gate-base", targets: [], idempotent: false };
});
const readReviewGate = vi.fn(async () => ({ id: "gate-successor", status: "pending" }));
const enforceReviewRunAccess = vi.fn(async (): Promise<{ ok: boolean }> => {
  calls.push("enforceReviewRunAccess");
  return { ok: true };
});
const recordChangesRequested = vi.fn(
  async (_input?: unknown): Promise<Record<string, unknown>> => {
    calls.push("recordChangesRequested");
    return { ok: true, repairId: "repair-1", status: "requested", escalated: false };
  },
);
const submitRepairResponse = vi.fn(async (_input?: unknown) => {
  calls.push("submitRepairResponse");
  return { ok: true as const, successorGateId: "gate-successor", successorTaskId: "task-successor" };
});
const readVerificationRecordForGate = vi.fn(
  async (_gateId?: unknown): Promise<Record<string, unknown> | null> => {
    calls.push("readVerificationRecordForGate");
    return { id: "verify:gate-successor", gateId: "gate-successor", outcome: "verified" };
  },
);
const readAgentRunById = vi.fn(async (): Promise<Record<string, unknown> | null> => {
  calls.push("readAgentRunById");
  return { id: "run-1", orgId: "org-1", runBy: "user-1" };
});
const resolveActorGrantsForUserInOrg = vi.fn(
  async (): Promise<Record<string, unknown>> => {
    calls.push("resolveActorGrantsForUserInOrg");
    return { orgRole: "member", teamIds: [], projectGrants: [] };
  },
);

vi.mock("@/lib/artifacts/artifact-creation", () => ({
  createSemanticArtifact: (...a: unknown[]) =>
    (createSemanticArtifact as unknown as (...x: unknown[]) => unknown)(...a),
}));
vi.mock("@/lib/artifacts/upload-artifact-type-map", () => ({
  resolveUploadArtifactType: (...a: unknown[]) =>
    (resolveUploadArtifactType as unknown as (...x: unknown[]) => unknown)(...a),
}));
vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  emitArtifactReviewGate: (...a: unknown[]) =>
    (emitArtifactReviewGate as unknown as (...x: unknown[]) => unknown)(...a),
  readReviewGate: (...a: unknown[]) =>
    (readReviewGate as unknown as (...x: unknown[]) => unknown)(...a),
  enforceReviewRunAccess: (...a: unknown[]) =>
    (enforceReviewRunAccess as unknown as (...x: unknown[]) => unknown)(...a),
}));
vi.mock("@cinatra-ai/agents/store", () => ({
  readAgentRunById: (...a: unknown[]) =>
    (readAgentRunById as unknown as (...x: unknown[]) => unknown)(...a),
}));
vi.mock("@/lib/auth-session", () => ({
  resolveActorGrantsForUserInOrg: (...a: unknown[]) =>
    (resolveActorGrantsForUserInOrg as unknown as (...x: unknown[]) => unknown)(...a),
}));
vi.mock("@/lib/lifecycle/widget-lifecycle-frame-actor", () => ({
  buildWidgetLifecycleRoleHints: (input: { orgRole?: string }) => ({
    platformRole: "member",
    orgRole: input.orgRole,
  }),
}));
vi.mock("@cinatra-ai/agents/lifecycle-repair-store", () => ({
  recordChangesRequested: (...a: unknown[]) =>
    (recordChangesRequested as unknown as (...x: unknown[]) => unknown)(...a),
  submitRepairResponse: (...a: unknown[]) =>
    (submitRepairResponse as unknown as (...x: unknown[]) => unknown)(...a),
}));
vi.mock("@cinatra-ai/agents/lifecycle-verification-store", () => ({
  readVerificationRecordForGate: (...a: unknown[]) =>
    (readVerificationRecordForGate as unknown as (...x: unknown[]) => unknown)(...a),
}));
vi.mock("@/lib/lifecycle/lifecycle-card-ref", () => ({
  encodeLifecycleGateRef: () => "REF_" + "a".repeat(60),
}));

const openChangeSet = vi.fn(() => {
  calls.push("openChangeSet");
  return { changeSetId: "cs-1" };
});
const closeChangeSet = vi.fn(() => {
  calls.push("closeChangeSet");
  return {
    id: "cs-1",
    effectRollup: "reversible-internal",
    restorable: true,
    closedAt: "2026-08-13T00:00:00.000Z",
  };
});
const loadChangeSet = vi.fn(() => ({
  changeSet: { id: "cs-1", restorable: true },
  events: [{ id: "ev-1", restoreEligible: true }],
}));
const historyAwareUpsert = vi.fn((_input?: unknown, _options?: unknown) => {
  calls.push("historyAwareUpsert");
  return { objectId: "obj-1", resultVersion: 1, event: { id: "ev-1" }, changeSetId: "cs-1" };
});
const verifySessionAuthority = vi.fn(async () => {
  calls.push("verifySessionAuthority");
  return { orgId: "org-1", can: () => true };
});

vi.mock("@/lib/object-history", () => ({
  openChangeSet: (...a: unknown[]) => (openChangeSet as unknown as (...x: unknown[]) => unknown)(...a),
  closeChangeSet: (...a: unknown[]) => (closeChangeSet as unknown as (...x: unknown[]) => unknown)(...a),
  loadChangeSet: (...a: unknown[]) => (loadChangeSet as unknown as (...x: unknown[]) => unknown)(...a),
}));
vi.mock("@/lib/object-history/canonical-writer", () => ({
  historyAwareUpsert: (...a: unknown[]) =>
    (historyAwareUpsert as unknown as (...x: unknown[]) => unknown)(...a),
}));
vi.mock("@/lib/org-write/authority", () => ({
  verifySessionAuthority: (...a: unknown[]) =>
    (verifySessionAuthority as unknown as (...x: unknown[]) => unknown)(...a),
}));

const SUBJECT = { orgId: "org-1", actorId: "user-1", runId: "run-1" };

beforeEach(() => {
  calls.length = 0;
});

describe("the repair-verification fixture drives the shipped pipeline", () => {
  it("AUTHORIZES the subject before it writes, then calls exactly the five writers in order", async () => {
    const { seedRepairVerification } = await import("../lifecycle-seed-drivers");
    const result = await seedRepairVerification(SUBJECT);

    expect(calls).toEqual([
      // The run and the reader's live standing, BEFORE any row exists.
      "readAgentRunById",
      "resolveActorGrantsForUserInOrg",
      // BOTH axes: the READ the card will run, and the `approveHitl` that
      // `changes_requested` actually is.
      "enforceReviewRunAccess",
      "enforceReviewRunAccess",
      // Then the pipeline.
      "createSemanticArtifact",
      "emitArtifactReviewGate",
      "recordChangesRequested",
      "createSemanticArtifact",
      "submitRepairResponse",
      "readVerificationRecordForGate",
    ]);
    expect(result.baseArtifactId).toBe("art-1");
    expect(result.successorArtifactId).toBe("art-2");
    expect(result.successorGateId).toBe("gate-successor");
  });

  it("refuses a run that does not exist — nothing is written", async () => {
    readAgentRunById.mockImplementationOnce(async () => {
      calls.push("readAgentRunById");
      return null;
    });
    const { seedRepairVerification } = await import("../lifecycle-seed-drivers");
    await expect(seedRepairVerification(SUBJECT)).rejects.toThrow(/does not exist/);
    expect(calls).not.toContain("createSemanticArtifact");
  });

  it("refuses a run that belongs to ANOTHER org — nothing is written", async () => {
    readAgentRunById.mockImplementationOnce(async () => {
      calls.push("readAgentRunById");
      return { id: "run-1", orgId: "org-somebody-else" };
    });
    const { seedRepairVerification } = await import("../lifecycle-seed-drivers");
    await expect(seedRepairVerification(SUBJECT)).rejects.toThrow(/another org/);
    expect(calls).not.toContain("createSemanticArtifact");
  });

  it("refuses a subject who is not a member — nothing is written", async () => {
    resolveActorGrantsForUserInOrg.mockImplementationOnce(async () => {
      calls.push("resolveActorGrantsForUserInOrg");
      return { teamIds: [], projectGrants: [] };
    });
    const { seedRepairVerification } = await import("../lifecycle-seed-drivers");
    await expect(seedRepairVerification(SUBJECT)).rejects.toThrow(/not a member/);
    expect(calls).not.toContain("createSemanticArtifact");
  });

  it("refuses a reader who may not READ the run — a card they could never open", async () => {
    enforceReviewRunAccess.mockImplementationOnce(async () => {
      calls.push("enforceReviewRunAccess");
      return { ok: false };
    });
    const { seedRepairVerification } = await import("../lifecycle-seed-drivers");
    await expect(seedRepairVerification(SUBJECT)).rejects.toThrow(/may not read run/);
    expect(calls).not.toContain("createSemanticArtifact");
  });

  it("refuses a reader who may not DECIDE — changes_requested would be recorded as theirs", async () => {
    // The read passes, the decide axis does not. `changes_requested` is terminal
    // and carries `decidedBy`, so attributing it to this subject would be a
    // fabricated decision record.
    enforceReviewRunAccess.mockImplementationOnce(async () => {
      calls.push("enforceReviewRunAccess");
      return { ok: true };
    });
    enforceReviewRunAccess.mockImplementationOnce(async () => {
      calls.push("enforceReviewRunAccess");
      return { ok: false };
    });
    const { seedRepairVerification } = await import("../lifecycle-seed-drivers");
    await expect(seedRepairVerification(SUBJECT)).rejects.toThrow(/may not decide on run/);
    expect(calls).not.toContain("createSemanticArtifact");
  });

  it("passes the MEASURED run-read verdict as `reauthorized`, never a literal", async () => {
    const { seedRepairVerification } = await import("../lifecycle-seed-drivers");
    await seedRepairVerification(SUBJECT);
    const responseArgs = submitRepairResponse.mock.calls.at(-1)?.[0] as unknown as {
      reauthorized: boolean;
    };
    expect(responseArgs.reauthorized).toBe(true);
    // And the value is READ from the check: the driver refuses before it gets
    // here when the check says no (covered above), so `reauthorized` can never
    // be `true` for a reader the check denied.
    expect(enforceReviewRunAccess).toHaveBeenCalled();
  });

  it("LINKS the steps: the gate pins revision 1, the decision CASes on it, the response pins revision 2", async () => {
    const { seedRepairVerification } = await import("../lifecycle-seed-drivers");
    await seedRepairVerification(SUBJECT);

    const gateArgs = emitArtifactReviewGate.mock.calls.at(-1)?.[0] as unknown as {
      targets: Array<{ artifactId: string; representationRevisionId: string }>;
      runId: string;
    };
    expect(gateArgs.targets).toEqual([
      { artifactId: "art-1", representationRevisionId: "rev-1" },
    ]);
    expect(gateArgs.runId).toBe("run-1");

    const decisionArgs = recordChangesRequested.mock.calls.at(-1)?.[0] as unknown as {
      currentBaseRevisionId: string;
      request: { gateId: string; expectedBaseRevisionId: string };
    };
    expect(decisionArgs.request.gateId).toBe("gate-base");
    expect(decisionArgs.request.expectedBaseRevisionId).toBe("rev-1");
    expect(decisionArgs.currentBaseRevisionId).toBe("rev-1");

    const responseArgs = submitRepairResponse.mock.calls.at(-1)?.[0] as unknown as {
      repairId: string;
      response: { successorTarget: { representationRevisionId: string } };
    };
    expect(responseArgs.repairId).toBe("repair-1");
    expect(responseArgs.response.successorTarget.representationRevisionId).toBe("rev-2");
  });

  it("READS THE RECORD BACK — a repair that returned ok but wrote no record reports absent", async () => {
    // The verification trigger is best-effort by design: a verification failure
    // must never fail a repair. So "the repair said ok" is not evidence the
    // record exists, and the fixture must not claim it is.
    readVerificationRecordForGate.mockImplementationOnce(async () => {
      calls.push("readVerificationRecordForGate");
      return null;
    });
    const { seedRepairVerification } = await import("../lifecycle-seed-drivers");
    const result = await seedRepairVerification(SUBJECT);
    expect(result.verificationRecordPresent).toBe(false);
    expect(result.verificationOutcome).toBeNull();
  });

  it("reports the verdict the PIPELINE computed — the caller never supplies one", async () => {
    const { seedRepairVerification } = await import("../lifecycle-seed-drivers");
    const result = await seedRepairVerification(SUBJECT);
    expect(result.verificationRecordPresent).toBe(true);
    expect(result.verificationOutcome).toBe("verified");
  });

  it("REFUSES when the pinned MIME maps to no installed artifact type", async () => {
    resolveUploadArtifactType.mockImplementationOnce(() => ({
      ok: false as const,
      kind: "no_type",
      reason: "nothing accepts it",
      matched: [],
    }));
    const { seedRepairVerification } = await import("../lifecycle-seed-drivers");
    await expect(seedRepairVerification(SUBJECT)).rejects.toThrow(
      /maps to no installed artifact type/,
    );
    expect(calls).toEqual([]);
  });

  it("REFUSES a decision the store refused — it does not carry on to the repair", async () => {
    recordChangesRequested.mockImplementationOnce(async () => {
      calls.push("recordChangesRequested");
      return { ok: false, code: "stale-base", error: "base revision moved" };
    });
    const { seedRepairVerification } = await import("../lifecycle-seed-drivers");
    await expect(seedRepairVerification(SUBJECT)).rejects.toThrow(/stale-base/);
    expect(calls).not.toContain("submitRepairResponse");
  });
});

describe("the restorable-change-set fixture drives the shipped writers", () => {
  it("mints the authority from a LIVE membership read BEFORE it opens anything", async () => {
    const { seedRestorableChangeSet } = await import("../lifecycle-seed-drivers");
    await seedRestorableChangeSet(SUBJECT);
    expect(calls).toEqual([
      // The run is authorized here TOO — an earlier draft checked it only in the
      // repair fixture, so this one would stamp any caller-named run id onto the
      // change_set and its event.
      "readAgentRunById",
      "resolveActorGrantsForUserInOrg",
      "enforceReviewRunAccess",
      "enforceReviewRunAccess",
      "verifySessionAuthority",
      "openChangeSet",
      "historyAwareUpsert",
      "closeChangeSet",
    ]);
    expect(verifySessionAuthority).toHaveBeenCalledWith("user-1", "org-1");
  });

  it("refuses when the subject is not a member — nothing is opened", async () => {
    verifySessionAuthority.mockImplementationOnce(async () => {
      calls.push("verifySessionAuthority");
      throw new Error("user user-1 is not a member of org-1");
    });
    const { seedRestorableChangeSet } = await import("../lifecycle-seed-drivers");
    await expect(seedRestorableChangeSet(SUBJECT)).rejects.toThrow(/not a member/);
    expect(calls).not.toContain("openChangeSet");
  });

  it("refuses a run in ANOTHER org — the id is never stamped onto the set", async () => {
    readAgentRunById.mockImplementationOnce(async () => {
      calls.push("readAgentRunById");
      return { id: "run-1", orgId: "org-somebody-else" };
    });
    const { seedRestorableChangeSet } = await import("../lifecycle-seed-drivers");
    await expect(seedRestorableChangeSet(SUBJECT)).rejects.toThrow(/another org/);
    expect(calls).not.toContain("openChangeSet");
  });

  it("refuses a run the reader may not read — nothing is opened", async () => {
    enforceReviewRunAccess.mockImplementationOnce(async () => {
      calls.push("enforceReviewRunAccess");
      return { ok: false };
    });
    const { seedRestorableChangeSet } = await import("../lifecycle-seed-drivers");
    await expect(seedRestorableChangeSet(SUBJECT)).rejects.toThrow(/may not read run/);
    expect(calls).not.toContain("openChangeSet");
  });

  it("writes a PINNED type and a PINNED payload under the explicit handle", async () => {
    const { seedRestorableChangeSet } = await import("../lifecycle-seed-drivers");
    await seedRestorableChangeSet(SUBJECT);
    const [input, options] = historyAwareUpsert.mock.calls.at(-1) as unknown as [
      {
        type: string;
        data: Record<string, unknown>;
        ownerId: string;
        runId: string;
        visibility: string;
      },
      {
        changeSet: { changeSetId: string };
        expectedBaseVersion: null;
        historyEffect: string;
      },
    ];
    // The type comes from the SAME resolver the repair fixture uses — one type
    // source, and never a caller-supplied string.
    expect(input.type).toBe("@cinatra-ai/text-artifact:text");
    expect(resolveUploadArtifactType).toHaveBeenCalledWith("text/plain");
    expect(Object.keys(input.data).sort()).toEqual(["body", "title"]);
    expect(input.runId).toBe("run-1");
    // The reader OWNS the object, which is what makes the per-event restore
    // authorization the chip runs answer `yes` for that reader and nobody else.
    expect(input.ownerId).toBe("user-1");
    expect(input.visibility).toBe("private");
    expect(options.changeSet.changeSetId).toBe("cs-1");
    expect(options.expectedBaseVersion).toBeNull();
    expect(options.historyEffect).toBe("reversible-internal");
  });

  it("REPORTS the member-event count read back from the set", async () => {
    // Zero is the state this slice refused to photograph (`bool_and` over zero
    // rows is not `false`, so an event-less set would still draw the chip). The
    // fixture therefore reports the count rather than leaving it implicit.
    const { seedRestorableChangeSet } = await import("../lifecycle-seed-drivers");
    const ok = await seedRestorableChangeSet(SUBJECT);
    expect(ok.memberEventCount).toBe(1);
    expect(ok.restorable).toBe(true);
    expect(ok.effectRollup).toBe("reversible-internal");

    loadChangeSet.mockImplementationOnce(() => ({
      changeSet: { id: "cs-1", restorable: true },
      events: [],
    }));
    const empty = await seedRestorableChangeSet(SUBJECT);
    expect(empty.memberEventCount).toBe(0);
  });
});

describe("the drivers module holds no persistence and no caller-shaped content", () => {
  const source = readFileSync(
    path.join(__dirname, "..", "lifecycle-seed-drivers.ts"),
    "utf8",
  );
  // Comments in this file legitimately discuss SQL, so scan the CODE only.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  it("contains no SQL and reaches no query runner", () => {
    for (const forbidden of [
      "INSERT INTO",
      "UPDATE ",
      "DELETE FROM",
      "runPostgresQueriesSync",
      "getPostgresConnectionString",
      "postgresSchema",
      "drizzle",
    ]) {
      expect(code, `the seed must not reach ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("accepts ONLY a subject — the row content is pinned in the module", () => {
    // codex round 0, finding 4: an earlier draft took `objectType` and `data`
    // from the request body, which made this a generic authenticated
    // object-create primitive. The subject type is the contract, so pin it.
    const subjectFields = /export interface LifecycleSeedSubject \{([\s\S]*?)\n\}/.exec(
      source,
    )?.[1];
    expect(subjectFields).toBeTruthy();
    const fields = [...(subjectFields ?? "").matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
    expect(fields.sort()).toEqual(["actorId", "orgId", "runId"]);
    // And neither driver takes anything else.
    expect(code).toContain("seedRepairVerification(\n  subject: LifecycleSeedSubject,");
    expect(code).toContain("seedRestorableChangeSet(\n  subject: LifecycleSeedSubject,");
  });
});
