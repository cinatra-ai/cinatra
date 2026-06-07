/**
 * BullMQ ActorContext propagation tests.
 *
 * Validates the pure helpers (no Redis / no BullMQ runtime) used by the
 * enqueue and dispatch sides:
 *   - `attachActorContextToJobData(data, ctx)` writes `__actorContext` onto
 *     a copy of the job data payload.
 *   - `runJobHandlerWithActorContext(jobData, handler)` runs `handler`
 *     inside `withActorContext(jobData.__actorContext, ...)` when the
 *     property is present, and runs `handler` directly otherwise.
 *
 * The full BullMQ Worker is not exercised here — only the pure ALS-frame
 * wrapper that the worker callback delegates to. This keeps the test
 * Redis-free and portable.
 */
import { describe, it, expect, vi } from "vitest";
import type { ActorContext } from "@/lib/authz/actor-context";
import { getActorContext } from "@cinatra-ai/llm";

// background-jobs.ts has a top-level side-effect import of
// @/lib/notifications-host, which registers the host adapters for the worker
// server path. This pure-helper test imports `../background-jobs`, so no-op
// the host module here to keep it from running real host wiring (DB / auth) on
// module load.
vi.mock("@/lib/notifications-host", () => ({}));

import {
  attachActorContextToJobData,
  runJobHandlerWithActorContext,
} from "../background-jobs";

const ctx: ActorContext = {
  principalType: "ServiceAccount",
  principalId: "svc-1",
  organizationId: "org-1",
  authSource: "worker",
  policyVersion: "v2",
};

describe("background-jobs ActorContext propagation", () => {
  it("attachActorContextToJobData adds __actorContext to a copy", () => {
    const data = { runId: "r-1" };
    const out = attachActorContextToJobData(data, ctx);
    expect(out).toEqual({ runId: "r-1", __actorContext: ctx });
    // Original is untouched.
    expect((data as Record<string, unknown>).__actorContext).toBeUndefined();
  });

  it("attachActorContextToJobData with undefined ctx returns shallow copy with no __actorContext", () => {
    const data = { runId: "r-1" };
    const out = attachActorContextToJobData(data, undefined);
    expect(out).toEqual({ runId: "r-1" });
    expect((out as Record<string, unknown>).__actorContext).toBeUndefined();
  });

  it("runJobHandlerWithActorContext rehydrates ALS frame when __actorContext is present", async () => {
    let captured: ActorContext | undefined = "untouched" as unknown as ActorContext;
    await runJobHandlerWithActorContext({ runId: "r-1", __actorContext: ctx }, async () => {
      captured = getActorContext();
    });
    expect(captured).toEqual(ctx);
  });

  it("runJobHandlerWithActorContext runs handler with no frame when __actorContext is absent", async () => {
    let captured: ActorContext | undefined = "untouched" as unknown as ActorContext;
    await runJobHandlerWithActorContext({ runId: "r-1" }, async () => {
      captured = getActorContext();
    });
    expect(captured).toBeUndefined();
  });
});
