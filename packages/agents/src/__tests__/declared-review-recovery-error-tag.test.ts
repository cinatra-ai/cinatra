import { describe, it, expect, vi } from "vitest";

// cinatra#4476 — what a failed pause of the upgrade recovery reports of its error
// (`recoveryErrorTag`, declared-review-recovery.ts): a name that passes the
// identifier rule, and a SQLSTATE code of the error or of its cause, never the
// message. The stores the module imports are replaced: these cases call only the
// pure function. The database proof of a failed pause is A FAILED PAUSE in
// resume-upgrade-recovery-4476.integration.test.ts.
vi.mock("../db", () => ({ db: {}, agentBuilderPool: {} }));
vi.mock("../artifact-review-gate-store", () => ({
  listReviewGatesForRun: vi.fn(),
  rearmExhaustedResumeIntent: vi.fn(),
}));
vi.mock("../lifecycle-repair-store", () => ({
  insertRecoveryCarrier: vi.fn(),
  isRepairLineageOpen: vi.fn(),
  RepairLineageStateError: class RepairLineageStateError extends Error {},
}));

const SECRET = "Make the sky darker";

class QueryFailure extends Error {}

async function tag(err: unknown) {
  const { recoveryErrorTag } = await import("../declared-review-recovery");
  const got = recoveryErrorTag(err);
  expect(JSON.stringify(got)).not.toContain(SECRET);
  return got;
}

describe("cinatra#4476 — recoveryErrorTag: a failed pause reports an error name and a SQLSTATE code, never a message", () => {
  it("A THROWN STRING: the name of its type, no code", async () => {
    expect(await tag(`refused carrier: ${SECRET}`)).toEqual({ errorName: "String" });
  });

  it("A THROWN NULL, UNDEFINED OR NUMBER: the name of its type, no code", async () => {
    expect(await tag(null)).toEqual({ errorName: "object" });
    expect(await tag(undefined)).toEqual({ errorName: "undefined" });
    expect(await tag(42)).toEqual({ errorName: "Number" });
  });

  it("A PLAIN ERROR: the generic name Error, no code", async () => {
    expect(await tag(new Error(SECRET))).toEqual({ errorName: "Error" });
  });

  it("A SUBCLASS THAT KEEPS THE GENERIC NAME: its class name", async () => {
    expect(await tag(new QueryFailure(SECRET))).toEqual({ errorName: "QueryFailure" });
  });

  it("AN OWN NAME THAT IS NOT THE GENERIC ONE: that name", async () => {
    expect(await tag(Object.assign(new Error(SECRET), { name: "DatabaseError" }))).toEqual({ errorName: "DatabaseError" });
  });

  it("A NAME THAT FAILS THE IDENTIFIER RULE (a space, a colon): the class name instead", async () => {
    expect(await tag(Object.assign(new QueryFailure(SECRET), { name: `refused carrier: ${SECRET}` }))).toEqual({ errorName: "QueryFailure" });
    expect(await tag(Object.assign(new Error(SECRET), { name: "Database Error" }))).toEqual({ errorName: "Error" });
  });

  it("A NAME OF 65 CHARACTERS: the class name instead; a name of 64 characters is kept", async () => {
    expect(await tag(Object.assign(new Error(SECRET), { name: `E${"x".repeat(64)}` }))).toEqual({ errorName: "Error" });
    expect(await tag(Object.assign(new Error(SECRET), { name: `E${"x".repeat(63)}` }))).toEqual({ errorName: `E${"x".repeat(63)}` });
  });

  it("NO NAME AND NO CLASS NAME THAT PASS THE RULE: the type name", async () => {
    expect(await tag({ name: "a b", constructor: { name: "c d" }, message: SECRET })).toEqual({ errorName: "object" });
    expect(await tag(Object.assign(Object.create(null) as object, { message: SECRET }))).toEqual({ errorName: "object" });
    expect(await tag({ name: 42, message: SECRET })).toEqual({ errorName: "Object" });
  });

  it("THE ERROR'S OWN SQLSTATE CODE", async () => {
    expect(await tag(Object.assign(new Error(SECRET), { code: "23505" }))).toEqual({ errorName: "Error", errorCode: "23505" });
  });

  it("THE CAUSE'S SQLSTATE CODE (a query error wraps the driver's error)", async () => {
    const err = Object.assign(new QueryFailure(`Failed query: insert ... params: ${SECRET}`), { cause: { code: "P0001", message: SECRET } });
    expect(await tag(err)).toEqual({ errorName: "QueryFailure", errorCode: "P0001" });
  });

  it("A CODE THAT IS NOT A SQLSTATE (a node error code, lower case, a number, a missing cause): no code", async () => {
    expect(await tag(Object.assign(new Error(`connect ECONNRESET ${SECRET}`), { code: "ECONNRESET" }))).toEqual({ errorName: "Error" });
    expect(await tag(Object.assign(new Error(SECRET), { code: "p0001" }))).toEqual({ errorName: "Error" });
    expect(await tag(Object.assign(new Error(SECRET), { code: 23505 }))).toEqual({ errorName: "Error" });
    expect(await tag(Object.assign(new Error(SECRET), { cause: null }))).toEqual({ errorName: "Error" });
    expect(await tag(Object.assign(new Error(SECRET), { cause: { code: SECRET } }))).toEqual({ errorName: "Error" });
  });

  it("BOTH CODES: the error's own SQLSTATE code first; an own code that is not one falls to the cause's", async () => {
    expect(await tag(Object.assign(new Error(SECRET), { code: "23505", cause: { code: "P0001" } }))).toEqual({ errorName: "Error", errorCode: "23505" });
    expect(await tag(Object.assign(new Error(SECRET), { code: "ECONNRESET", cause: { code: "P0001" } }))).toEqual({ errorName: "Error", errorCode: "P0001" });
  });
});
