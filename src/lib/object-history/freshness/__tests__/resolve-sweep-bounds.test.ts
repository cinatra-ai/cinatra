// resolveExternalFreshness sweep bounds (cinatra#2022 S7 freshness
// re-point — the bounded-fan-out acceptance criteria for this surface):
//
//   1. an explicit CONCURRENCY-CAP test — at most N distinct instances'
//      sessions in flight at once, same-instance objects strictly sequential;
//   2. a PER-SESSION-TIMEOUT test — a hung instance degrades ITS remaining
//      objects to `unknown` without stalling the sweep or other instances;
//   3. a LOAD-FAILURE degrade test — an adapter throw (the shape a
//      catalog-cache/enrollment-store load failure surfaces as) degrades to
//      the per-object `unknown` verdict, never a sweep-wide abort.
//
// Uses synthetic adapters registered under test-only connector names against
// the real registry (`../contract`), driving the real bucketing/pool/timeout
// machinery in `../resolve` — no mocks of the module under test.

import { afterEach, describe, expect, it } from "vitest";

import { registerFreshnessAdapter, type FreshnessAdapter } from "../contract";
import { resolveExternalFreshness } from "../resolve";
import type { LoadedChangeSet } from "../../eligibility";
import type { ObjectChangeEvent } from "../../types";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function event(
  objectId: string,
  connector: string,
  instanceId: string | null,
): ObjectChangeEvent {
  return {
    id: `evt_${objectId}`,
    objectId,
    remoteRevisionRef: {
      connector,
      kind: "post",
      remoteId: objectId,
      ...(instanceId ? { extra: { instanceId } } : {}),
    },
  } as unknown as ObjectChangeEvent;
}

function loaded(events: ObjectChangeEvent[]): LoadedChangeSet {
  return { changeSet: { id: "cs_1" } as never, events };
}

/** Register a synthetic adapter under a unique connector name; the registry
 * is a module-global Map, so re-registering the same name overwrites — each
 * test uses its own name to stay isolated. */
function register(connectorName: string, check: FreshnessAdapter["check"]): void {
  registerFreshnessAdapter({ connectorName, check });
}

describe("resolveExternalFreshness sweep bounds", () => {
  afterEach(() => {
    // No unregister API — unique per-test connector names keep tests isolated.
  });

  it("caps concurrent instance sessions at maxConcurrentInstanceSessions", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    register("cap-test", async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(15);
      inFlight -= 1;
      return { state: "fresh", baseRevision: "r" };
    });
    // 8 distinct instances, one object each → 8 buckets.
    const events = Array.from({ length: 8 }, (_, i) =>
      event(`obj_${i}`, "cap-test", `inst_${i}`),
    );
    const out = await resolveExternalFreshness(loaded(events), {
      orgId: "org_1",
      maxConcurrentInstanceSessions: 2,
    });
    expect(out.size).toBe(8);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThan(1); // the pool actually parallelizes
  });

  it("checks same-instance objects sequentially (one session per instance, never parallel probes)", async () => {
    const perInstanceInFlight = new Map<string, number>();
    let violated = false;
    register("seq-test", async ({ remoteRevisionRef }) => {
      const inst = String(
        (remoteRevisionRef as { extra?: { instanceId?: string } }).extra?.instanceId,
      );
      const current = (perInstanceInFlight.get(inst) ?? 0) + 1;
      perInstanceInFlight.set(inst, current);
      if (current > 1) violated = true;
      await sleep(5);
      perInstanceInFlight.set(inst, current - 1);
      return { state: "fresh", baseRevision: "r" };
    });
    // 2 instances x 4 objects each — plenty of chances to overlap if buggy.
    const events = [
      ...Array.from({ length: 4 }, (_, i) => event(`a_${i}`, "seq-test", "inst_a")),
      ...Array.from({ length: 4 }, (_, i) => event(`b_${i}`, "seq-test", "inst_b")),
    ];
    const out = await resolveExternalFreshness(loaded(events), {
      orgId: "org_1",
      maxConcurrentInstanceSessions: 4,
    });
    expect(out.size).toBe(8);
    expect(violated).toBe(false);
  });

  it("degrades a hung instance's remaining objects to 'unknown' on session timeout without stalling other instances", async () => {
    register("timeout-test", async ({ objectId, remoteRevisionRef }) => {
      const inst = (remoteRevisionRef as { extra?: { instanceId?: string } }).extra?.instanceId;
      if (inst === "inst_hung") {
        if (objectId === "hung_1") return { state: "fresh", baseRevision: "r" };
        // The second object of the hung instance never resolves (a hung
        // remote / a cache load that hangs instead of throwing).
        return new Promise(() => {});
      }
      return { state: "fresh", baseRevision: "r" };
    });
    const events = [
      event("hung_1", "timeout-test", "inst_hung"),
      event("hung_2", "timeout-test", "inst_hung"),
      event("hung_3", "timeout-test", "inst_hung"),
      event("ok_1", "timeout-test", "inst_ok"),
    ];
    const out = await resolveExternalFreshness(loaded(events), {
      orgId: "org_1",
      instanceSessionTimeoutMs: 100,
    });
    // The object checked before the hang keeps its real verdict…
    expect(out.get("hung_1")).toEqual({ state: "fresh", baseRevision: "r" });
    // …the in-flight and the never-reached objects both degrade to unknown…
    expect(out.get("hung_2")?.state).toBe("unknown");
    expect(out.get("hung_3")?.state).toBe("unknown");
    const hung3 = out.get("hung_3");
    if (hung3?.state === "unknown") {
      expect(hung3.reason).toContain("timed out");
    }
    // …and the OTHER instance is untouched by the hung one's budget.
    expect(out.get("ok_1")).toEqual({ state: "fresh", baseRevision: "r" });
  });

  it("discards a probe result that lands AFTER the session timeout — the returned map can never late-flip to fresh", async () => {
    register("late-flip-test", async ({ objectId }) => {
      if (objectId === "slow") {
        // Resolves fresh well AFTER the 40ms session timeout.
        await sleep(150);
        return { state: "fresh", baseRevision: "late" };
      }
      return { state: "fresh", baseRevision: "r" };
    });
    const events = [event("slow", "late-flip-test", "inst_slow")];
    const out = await resolveExternalFreshness(loaded(events), {
      orgId: "org_1",
      instanceSessionTimeoutMs: 40,
    });
    expect(out.get("slow")?.state).toBe("unknown");
    // Let the in-flight probe actually resolve, then assert the map the
    // caller holds was NOT mutated by the late result.
    await sleep(200);
    expect(out.get("slow")?.state).toBe("unknown");
  });

  it("resolves duplicate objectIds across buckets deterministically: the LATEST event in change-set order wins", async () => {
    register("dup-test", async ({ remoteRevisionRef }) => {
      const inst = (remoteRevisionRef as { extra?: { instanceId?: string } }).extra?.instanceId;
      if (inst === "inst_early") {
        // The EARLIER event's bucket finishes LAST — under naive
        // last-bucket-write-wins its verdict would clobber the later event's.
        await sleep(60);
        return { state: "changed", baseRevision: "early", changedFields: ["content"] };
      }
      return { state: "fresh", baseRevision: "later" };
    });
    const e1 = { ...event("obj_dup", "dup-test", "inst_early"), id: "evt_first" };
    const e2 = { ...event("obj_dup", "dup-test", "inst_late"), id: "evt_second" };
    const out = await resolveExternalFreshness(loaded([e1, e2]), { orgId: "org_1" });
    // Pre-re-point sequential semantics: the later event's verdict wins.
    expect(out.get("obj_dup")).toEqual({ state: "fresh", baseRevision: "later" });
  });

  it("degrades an adapter throw (catalog/cache load-failure shape) to per-object 'unknown', never a sweep abort", async () => {
    register("throw-test", async ({ objectId }) => {
      if (objectId === "bad") {
        throw new Error("the server-enrollment read failed; refusing to serve any catalog");
      }
      return { state: "fresh", baseRevision: "r" };
    });
    const events = [
      event("bad", "throw-test", "inst_x"),
      event("good_same_instance", "throw-test", "inst_x"),
      event("good_other_instance", "throw-test", "inst_y"),
    ];
    const out = await resolveExternalFreshness(loaded(events), { orgId: "org_1" });
    expect(out.get("bad")?.state).toBe("unknown");
    // The SAME instance's next object still gets checked (no bucket abort)…
    expect(out.get("good_same_instance")).toEqual({ state: "fresh", baseRevision: "r" });
    // …and other instances are unaffected.
    expect(out.get("good_other_instance")).toEqual({ state: "fresh", baseRevision: "r" });
  });

  it("keeps the pre-re-point contract: unregistered connectors map to 'unsupported', local-only events are skipped", async () => {
    const events = [
      event("obj_unregistered", "no-such-connector", "inst_1"),
      { id: "evt_local", objectId: "obj_local", remoteRevisionRef: null } as ObjectChangeEvent,
    ];
    const out = await resolveExternalFreshness(loaded(events), { orgId: "org_1" });
    expect(out.get("obj_unregistered")).toEqual({ state: "unsupported" });
    expect(out.has("obj_local")).toBe(false);
  });

  it("buckets instanceId-less refs as singletons (no artificial serialization behind unrelated events)", async () => {
    const seen: string[] = [];
    register("noinst-test", async ({ objectId }) => {
      seen.push(objectId);
      return { state: "fresh", baseRevision: "r" };
    });
    const events = [
      event("obj_1", "noinst-test", null),
      event("obj_2", "noinst-test", null),
    ];
    const out = await resolveExternalFreshness(loaded(events), { orgId: "org_1" });
    expect(out.size).toBe(2);
    expect(seen.sort()).toEqual(["obj_1", "obj_2"]);
  });
});
