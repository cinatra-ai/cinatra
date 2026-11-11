/**
 * cinatra#3978 — the PRODUCTION binding of the apply-effect writer. The boot
 * binder `bindCmsReviewHostSeamRuntime` builds the real seam deps; this proof
 * reads the deps it hands to `buildCmsReviewHostSeam` and drives
 * `recordCmsApplyEffect`:
 *   - building the deps runs no write (the store is imported at call time);
 *   - a call reaches `@cinatra-ai/agents/artifact-review-effect-store`'s
 *     `recordCmsApplyEffect` with the same input object, and returns its answer.
 * The store itself is proved against real Postgres in
 * packages/agents/src/__tests__/artifact-review-effect-store.integration.test.ts.
 */
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  write: vi.fn<(input: unknown) => Promise<{ ok: true; status: "recorded"; effectId: string }>>(async () => ({
    ok: true,
    status: "recorded",
    effectId: "effect:1",
  })),
}));

vi.mock("@cinatra-ai/agents/artifact-review-effect-store", () => ({ recordCmsApplyEffect: h.write }));
vi.mock("@cinatra-ai/agents/cms-repaired-capture-port", () => ({ publishCmsRepairedCapturePort: vi.fn() }));
vi.mock("@/lib/cms-review-host-seam", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/cms-review-host-seam")>();
  return { ...real, buildCmsReviewHostSeam: vi.fn(real.buildCmsReviewHostSeam), registerBuiltCmsReviewHostSeam: vi.fn() };
});

import { buildCmsReviewHostSeam, registerBuiltCmsReviewHostSeam } from "@/lib/cms-review-host-seam";
import { bindCmsReviewHostSeamRuntime } from "@/lib/register-cms-review-host-seam-runtime";

describe("cinatra#3978 — the boot binder wires the apply-effect writer", () => {
  it("binds recordCmsApplyEffect to the agents store's writer, at call time, with the input unchanged", async () => {
    bindCmsReviewHostSeamRuntime();
    expect(vi.mocked(registerBuiltCmsReviewHostSeam)).toHaveBeenCalledTimes(1);
    const deps = vi.mocked(buildCmsReviewHostSeam).mock.calls[0][0];
    expect(typeof deps.recordCmsApplyEffect).toBe("function");
    expect(h.write).not.toHaveBeenCalled();

    const input = { orgId: "org-1", runId: "run-1", gateId: "gate-1", operationId: "op-1", result: { remoteId: "42" } };
    await expect(deps.recordCmsApplyEffect!(input)).resolves.toEqual({ ok: true, status: "recorded", effectId: "effect:1" });
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(h.write.mock.calls[0][0]).toBe(input);
  });
});
