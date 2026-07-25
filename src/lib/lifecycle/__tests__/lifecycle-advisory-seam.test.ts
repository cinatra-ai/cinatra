/**
 * cinatra#2038 (epic #2037 S0) — the advisory-seam contract: authenticated,
 * provenance-stamped, decision-free validation. Pure.
 */
import { describe, it, expect } from "vitest";

import {
  validateAdvisoryAttach,
  type AdvisoryAttachRequest,
} from "../lifecycle-advisory-seam";

function mk(over: Partial<AdvisoryAttachRequest> = {}): AdvisoryAttachRequest {
  return {
    gateId: "gate-1",
    author: { id: "advisor-1", kind: "agent" },
    body: "consider the tone of the second paragraph",
    idempotencyKey: "idem-1",
    runCausation: "run-9",
    ...over,
  };
}

describe("advisory attach validation", () => {
  it("accepts a well-formed, authenticated, decision-free attach", () => {
    expect(validateAdvisoryAttach(mk()).ok).toBe(true);
  });
  it("requires a gate id", () => {
    expect(validateAdvisoryAttach(mk({ gateId: "" })).ok).toBe(false);
  });
  it("requires an authenticated author", () => {
    expect(validateAdvisoryAttach(mk({ author: { id: "", kind: "agent" } })).ok).toBe(false);
  });
  it("rejects an unknown author kind", () => {
    const bad = mk();
    (bad.author as { kind: string }).kind = "admin";
    expect(validateAdvisoryAttach(bad).ok).toBe(false);
  });
  it("requires a non-empty body + an idempotency key", () => {
    expect(validateAdvisoryAttach(mk({ body: "  " })).ok).toBe(false);
    expect(validateAdvisoryAttach(mk({ idempotencyKey: "" })).ok).toBe(false);
  });
  it("rejects a smuggled decision field (the seam must be decision-free)", () => {
    const bad = mk();
    (bad as unknown as Record<string, unknown>).disposition = "approve";
    const r = validateAdvisoryAttach(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/decision-free/);
  });
});
