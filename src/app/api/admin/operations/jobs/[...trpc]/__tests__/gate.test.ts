import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as auditModule from "@/lib/authz/audit";
import type { ActorContext } from "@/lib/authz/actor-context";
import {
  authorizeOperatorRequest,
  parseProcedurePaths,
  type ProcedureType,
} from "../gate";

const ENDPOINT = "/api/admin/operations/jobs";

// Minimal procedure-type map mirroring the live QueueDash router.
const PROCEDURE_TYPES: Record<string, ProcedureType> = {
  "queue.list": "query",
  "queue.byName": "query",
  "queue.metrics": "query",
  "job.logs": "query",
  "job.retry": "mutation",
  "job.remove": "mutation",
  "queue.clean": "mutation",
  "job.promote": "mutation",
};
const lookupProcedureType = (p: string): ProcedureType | undefined => PROCEDURE_TYPES[p];

function platformAdmin(): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: "admin-1",
    organizationId: "org-1",
    platformRole: "platform_admin",
    orgRole: "member",
    authSource: "ui",
    policyVersion: "v2",
  };
}

function readerOnly(): ActorContext {
  // A non-platform actor: org_admin in their org. They hold settings.update
  // (org-scoped) but NOT operations.read / operations.execute.
  return {
    principalType: "HumanUser",
    principalId: "user-2",
    organizationId: "org-1",
    platformRole: "member",
    orgRole: "org_admin",
    authSource: "ui",
    policyVersion: "v2",
  };
}

function makeReq(procedurePath: string, opts?: { batch?: boolean; method?: string }): Request {
  const batch = opts?.batch ?? true;
  const qs = batch ? "?batch=1" : "";
  return new Request(`https://app.test${ENDPOINT}/${procedurePath}${qs}`, {
    method: opts?.method ?? "POST",
  });
}

describe("operations gate — parseProcedurePaths", () => {
  it("parses a single non-batch procedure", () => {
    const req = new Request(`https://app.test${ENDPOINT}/queue.list`);
    expect(parseProcedurePaths(req)).toEqual(["queue.list"]);
  });

  it("splits a batch on comma", () => {
    const req = makeReq("queue.list,job.retry");
    expect(parseProcedurePaths(req)).toEqual(["queue.list", "job.retry"]);
  });

  it("decodes an encoded comma in a batch", () => {
    const req = makeReq("queue.list%2Cjob.retry");
    expect(parseProcedurePaths(req)).toEqual(["queue.list", "job.retry"]);
  });

  it("returns null for an empty path", () => {
    const req = new Request(`https://app.test${ENDPOINT}`);
    expect(parseProcedurePaths(req)).toBeNull();
  });

  it("returns null for a foreign endpoint", () => {
    const req = new Request("https://app.test/api/other/queue.list");
    expect(parseProcedurePaths(req)).toBeNull();
  });

  it("returns null when a batch member is empty", () => {
    const req = makeReq("queue.list,");
    expect(parseProcedurePaths(req)).toBeNull();
  });
});

describe("operations gate — authorizeOperatorRequest", () => {
  let strictSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    strictSpy = vi
      .spyOn(auditModule, "logAuditEventStrict")
      .mockResolvedValue({ id: "audit-1" });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("operations.read holder can list but a destructive op needs execute (admin has both)", async () => {
    const d = await authorizeOperatorRequest({
      req: makeReq("queue.list"),
      actor: platformAdmin(),
      lookupProcedureType,
    });
    expect(d.kind).toBe("allow");
    // Reads emit NO audit row (noise).
    expect(strictSpy).not.toHaveBeenCalled();
  });

  it("a non-platform actor (org_admin) is denied even for a read (operations.read is platform-only)", async () => {
    const d = await authorizeOperatorRequest({
      req: makeReq("queue.list"),
      actor: readerOnly(),
      lookupProcedureType,
    });
    expect(d).toMatchObject({ kind: "deny", status: 403 });
    expect(strictSpy).not.toHaveBeenCalled();
  });

  it("platform admin can retry, and exactly one audit row is written per destructive op", async () => {
    const d = await authorizeOperatorRequest({
      req: makeReq("job.retry"),
      actor: platformAdmin(),
      lookupProcedureType,
      requestId: "req-9",
    });
    expect(d).toMatchObject({ kind: "allow", destructiveProcedures: ["job.retry"] });
    expect(strictSpy).toHaveBeenCalledTimes(1);
    expect(strictSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "job.retry",
        resourceType: "background_job",
        authSource: "route",
        decision: "allowed",
        metadata: expect.objectContaining({ requestId: "req-9", batchIndex: 0, procedure: "job.retry" }),
      }),
    );
  });

  it("a batch of N destructive ops emits N audit rows, one per op", async () => {
    const d = await authorizeOperatorRequest({
      req: makeReq("job.retry,queue.clean,job.promote"),
      actor: platformAdmin(),
      lookupProcedureType,
    });
    expect(d).toMatchObject({ kind: "allow" });
    expect(strictSpy).toHaveBeenCalledTimes(3);
  });

  it("an UNKNOWN procedure fails closed — denies and writes NO audit (never forwarded)", async () => {
    const d = await authorizeOperatorRequest({
      req: makeReq("job.nuke"),
      actor: platformAdmin(),
      lookupProcedureType,
    });
    expect(d).toMatchObject({ kind: "deny", status: 403 });
    expect(strictSpy).not.toHaveBeenCalled();
  });

  it("a non-query/mutation procedure type fails closed (the lookup must yield undefined, never a default-to-read)", async () => {
    // route.ts's lookupProcedureType returns `undefined` for any runtime type
    // that is not exactly "query" | "mutation" (e.g. a future "subscription"),
    // so such a procedure is treated as unknown and DENIED — it must never
    // silently default to the cheaper `operations.read`. Here we mirror that
    // contract: a lookup that yields `undefined` for an unexpected type denies.
    const subscriptionLookup = (p: string): ProcedureType | undefined =>
      p === "job.tail" ? undefined : PROCEDURE_TYPES[p];
    const d = await authorizeOperatorRequest({
      req: makeReq("job.tail"),
      actor: platformAdmin(),
      lookupProcedureType: subscriptionLookup,
    });
    expect(d).toMatchObject({ kind: "deny", status: 403 });
    expect(strictSpy).not.toHaveBeenCalled();
  });

  it("an unknown proc anywhere in a batch denies the WHOLE batch before any audit", async () => {
    const d = await authorizeOperatorRequest({
      req: makeReq("job.retry,job.nuke"),
      actor: platformAdmin(),
      lookupProcedureType,
    });
    expect(d.kind).toBe("deny");
    // Authorization/classification fails closed BEFORE any audit write.
    expect(strictSpy).not.toHaveBeenCalled();
  });

  it("aborts the WHOLE batch if an audit insert throws (no partial unaudited execution)", async () => {
    strictSpy
      .mockResolvedValueOnce({ id: "audit-a" })
      .mockRejectedValueOnce(new Error("db down"));
    const d = await authorizeOperatorRequest({
      req: makeReq("job.retry,queue.clean"),
      actor: platformAdmin(),
      lookupProcedureType,
    });
    expect(d).toMatchObject({ kind: "deny", status: 503 });
  });

  it("denies an unparseable request (no procedure path)", async () => {
    const d = await authorizeOperatorRequest({
      req: new Request(`https://app.test${ENDPOINT}`),
      actor: platformAdmin(),
      lookupProcedureType,
    });
    expect(d).toMatchObject({ kind: "deny", status: 400 });
  });

  it("classifies by NAME not method: a mutation sent via GET still needs execute + audits", async () => {
    const d = await authorizeOperatorRequest({
      req: makeReq("job.retry", { method: "GET" }),
      actor: platformAdmin(),
      lookupProcedureType,
    });
    expect(d.kind).toBe("allow");
    expect(strictSpy).toHaveBeenCalledTimes(1);
  });
});
