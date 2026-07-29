/**
 * Recurring-trigger cron validation — parser-contract coverage in the UNIT run.
 *
 * WHY THIS FILE EXISTS. The only existing coverage of `setRunTriggerForActor`'s
 * recurring-trigger validation lives in `trigger-handlers.integration.test.ts`,
 * a DB-backed `*.integration.test.ts` file: the default vitest run excludes it
 * and CI skips the integration step when no test database is provisioned. So a
 * `cron-parser` major that moved the parser entry point would have degraded
 * EVERY recurring trigger to `cron-parser unavailable` with a fully green
 * pipeline, and a major that made timezone validation lazy would have let an
 * unknown IANA zone through arm-time validation to fail at first fire.
 *
 * These tests run in the DEFAULT unit run and use the REAL `cron-parser` (it is
 * deliberately NOT mocked) so both classes fail loudly here. Everything the
 * service touches BEFORE the cron branch — the run read, the schedule/store
 * writes, the PM bridge — is mocked, so the suite needs no database.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const TEST_RUN_ID = "run-cron-validation";
const TEST_USER_ID = "user-cron-validation";

const store = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentTemplateById: vi.fn(async () => null),
  transitionRunStatus: vi.fn(async () => undefined),
  RunTransitionError: class RunTransitionError extends Error {},
}));
const triggerStore = vi.hoisted(() => ({
  createOrUpdateRunTrigger: vi.fn(async () => undefined),
  readRunTriggerByRunId: vi.fn(async () => null),
  deleteRunTriggerByRunId: vi.fn(async () => undefined),
}));
const schedule = vi.hoisted(() => ({
  scheduleTrigger: vi.fn(async () => ({ jobSchedulerId: "sched-cron-validation" })),
  cancelTriggerSchedule: vi.fn(async () => undefined),
}));

vi.mock("../store", () => store);
vi.mock("../trigger-store", () => triggerStore);
vi.mock("../trigger-schedule", () => schedule);
vi.mock("../recommendation-hold", () => ({
  maybeHoldRunForRecommendation: vi.fn(async () => ({ held: false })),
}));
vi.mock("@/lib/org-write/authority", () => ({
  verifySessionAuthority: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/pm-integration-providers", () => ({
  syncRunTriggerPmTask: vi.fn(async () => undefined),
  deleteRunTriggerPmTask: vi.fn(async () => undefined),
}));

import { setRunTriggerForActor } from "../trigger-service";

const actor = { userId: TEST_USER_ID, source: "mcp" as const };

/**
 * Arm a recurring trigger and return the service verdict. The service is
 * driven for real; only its collaborators are stubbed.
 */
async function armRecurring(cronExpression: string | undefined, timezone?: string) {
  return setRunTriggerForActor(actor, {
    runId: TEST_RUN_ID,
    triggerType: "recurring",
    ...(cronExpression === undefined ? {} : { cronExpression }),
    ...(timezone === undefined ? {} : { timezone }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  store.readAgentRunById.mockResolvedValue({
    id: TEST_RUN_ID,
    runBy: TEST_USER_ID,
    templateId: "tmpl-cron-validation",
    orgId: "org-cron-validation",
    status: "pending_input",
  });
  triggerStore.readRunTriggerByRunId.mockResolvedValue(null);
  schedule.scheduleTrigger.mockResolvedValue({ jobSchedulerId: "sched-cron-validation" });
});

describe("setRunTriggerForActor — recurring cron validation", () => {
  it("accepts a standard 5-field expression (the parser entry point resolves)", async () => {
    const result = await armRecurring("0 9 * * MON");
    // The precise failure this guards: an unresolved parser entry point makes
    // the service fail closed on EVERY recurring trigger.
    expect(result).not.toEqual({ ok: false, error: "cron-parser unavailable" });
    expect(result.ok).toBe(true);
  });

  it("accepts a predefined macro expression", async () => {
    await expect(armRecurring("@daily")).resolves.toMatchObject({ ok: true });
  });

  it("accepts an explicit IANA timezone", async () => {
    await expect(armRecurring("0 9 * * MON", "Europe/Berlin")).resolves.toMatchObject({
      ok: true,
    });
  });

  it("rejects an UNKNOWN timezone at arm time, not at first fire", async () => {
    // The parser accepts an unknown zone at parse time and only fails on the
    // first iteration step; validation must not defer that to the moment the
    // schedule comes due.
    const result = await armRecurring("0 9 * * MON", "Not/AZone");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/^invalid cron expression/);
    expect(schedule.scheduleTrigger).not.toHaveBeenCalled();
  });

  it("rejects an unparseable expression", async () => {
    const result = await armRecurring("not a cron expression");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/^invalid cron expression/);
  });

  it("rejects an out-of-range field", async () => {
    const result = await armRecurring("99 * * * *");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/^invalid cron expression/);
  });

  it("rejects a missing expression", async () => {
    await expect(armRecurring(undefined)).resolves.toEqual({
      ok: false,
      error: "cronExpression is required for recurring triggers",
    });
  });

  it("rejects an over-long expression before parsing", async () => {
    await expect(armRecurring("*".repeat(257))).resolves.toEqual({
      ok: false,
      error: "cronExpression too long (max 256 chars)",
    });
  });

  it("does not write a trigger row or a schedule when validation fails", async () => {
    await armRecurring("not a cron expression");
    expect(triggerStore.createOrUpdateRunTrigger).not.toHaveBeenCalled();
    expect(schedule.scheduleTrigger).not.toHaveBeenCalled();
  });
});
