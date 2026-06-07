/**
 * WayFlow health integration test.
 *
 * GET ${WAYFLOW_HEALTH_URL || http://localhost:3010/.health} and assert that
 * `failed_agents` is an empty array. Locally, this catches agents whose HITL
 * InputMessageNodes violate the OAS 26.1.0 contract (free-form `inputs[]` with
 * no `{{}}` placeholders + >1 outputs[]).
 *
 * This test guards that all registered WayFlow agents satisfy health
 * validation before the health endpoint reports success.
 *
 * The describe block is skipped when neither WAYFLOW_HEALTH_URL nor
 * LOCAL_WAYFLOW is set so CI without a live WayFlow stays green
 * (mirrors the `skipIf(!HAS_REAL_DB)` pattern from
 * `src/lib/__tests__/agent-templates-schema.test.ts`).
 */
import { describe, expect, it } from "vitest";

const HEALTH_URL =
  process.env.WAYFLOW_HEALTH_URL ??
  (process.env.LOCAL_WAYFLOW ? "http://localhost:3010/.health" : null);

const SHOULD_RUN = HEALTH_URL !== null;

describe.skipIf(!SHOULD_RUN)("WayFlow /.health contract", () => {
  it("reports failed_agents: [] (no contract violations)", async () => {
    const res = await fetch(HEALTH_URL as string);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { failed_agents?: unknown };
    expect(Array.isArray(body.failed_agents)).toBe(true);
    expect(body.failed_agents).toEqual([]);
  });
});
