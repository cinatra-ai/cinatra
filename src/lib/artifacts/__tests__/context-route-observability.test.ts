// #1197 — context-route observability: diagnostic counters + structured logs.
//
// Pins the module contract the routes rely on:
//   - per-(kind, code) outcome counters and per-(kind, via) resolution-path
//     counters, shared process-wide and snapshot-readable;
//   - ONE structured log line per event at the agreed level (warn for
//     rejections, debug for the success lifecycle trace, info for the #1193 W2
//     which-path metric) carrying code + run/context/slot identifiers;
//   - identifier hygiene: caller-supplied ids are charset-sanitized and
//     length-capped (no log-line injection), absent ids render as "-".
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

const {
  extractContextRouteLogIds,
  getContextRouteCounterSnapshot,
  recordContextRouteRejection,
  recordContextRouteResolutionPath,
  recordContextRouteSuccess,
  resetContextRouteCountersForTest,
} = await import("../context-route-observability");

let warnSpy: ReturnType<typeof vi.spyOn>;
let debugSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetContextRouteCountersForTest();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  debugSpy.mockRestore();
  infoSpy.mockRestore();
});

describe("rejection counters + structured warn line", () => {
  it("bumps the per-(kind, code) counter and logs code + run/ctx/slot ids", () => {
    recordContextRouteRejection({
      kind: "resolve",
      code: "context_unresolved",
      status: 403,
      runId: "run-1",
      contextId: "ctx-1",
      slotId: "draftContext",
    });
    recordContextRouteRejection({
      kind: "resolve",
      code: "context_unresolved",
      status: 403,
      runId: "run-2",
      contextId: "ctx-2",
      slotId: "draftContext",
    });
    recordContextRouteRejection({
      kind: "finalize",
      code: "slot_mismatch",
      status: 422,
      runId: "run-1",
      contextId: null,
      slotId: "draftContext",
    });

    expect(getContextRouteCounterSnapshot().outcome).toEqual({
      "resolve.context_unresolved": 2,
      "finalize.slot_mismatch": 1,
    });

    expect(warnSpy).toHaveBeenCalledTimes(3);
    const first = String(warnSpy.mock.calls[0][0]);
    expect(first).toContain("[context-route] rejected");
    expect(first).toContain("kind=resolve");
    expect(first).toContain("code=context_unresolved");
    expect(first).toContain("status=403");
    expect(first).toContain("run=run-1");
    expect(first).toContain("ctx=ctx-1");
    expect(first).toContain("slot=draftContext");
    expect(first).toContain("count=1");
    // Second occurrence of the same key carries the running count.
    expect(String(warnSpy.mock.calls[1][0])).toContain("count=2");
    // Absent context-id renders as "-".
    expect(String(warnSpy.mock.calls[2][0])).toContain("ctx=-");
  });

  it("sanitizes a hostile caller-supplied id (no log-line injection, capped)", () => {
    recordContextRouteRejection({
      kind: "resolve",
      code: "run_missing",
      status: 404,
      runId: "evil\nid injected=true " + "x".repeat(100),
      contextId: undefined,
      slotId: null,
    });
    const line = String(warnSpy.mock.calls[0][0]);
    // Single line: newline, spaces AND `=` were replaced (logfmt-safe), so a
    // hostile id cannot inject fake key=value pairs or extra lines.
    expect(line).not.toContain("\n");
    expect(line).toContain("run=evil?id?injected?true?");
    // Length-capped at 64 chars + ellipsis.
    expect(line).toMatch(/run=[^ ]{64}…/);
  });
});

describe("success lifecycle trace (debug) — quiet on the warn channel", () => {
  it("bumps `${kind}.ok` and logs via/run/ctx/slot at debug level", () => {
    recordContextRouteSuccess({
      kind: "finalize",
      servedBy: "run_token",
      runId: "run-9",
      contextId: "ctx-9",
      slotId: "draftContext",
    });
    expect(getContextRouteCounterSnapshot().outcome).toEqual({
      "finalize.ok": 1,
    });
    expect(warnSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledTimes(1);
    const line = String(debugSpy.mock.calls[0][0]);
    expect(line).toContain("[context-route] ok kind=finalize via=run_token");
    expect(line).toContain("run=run-9");
    expect(line).toContain("ctx=ctx-9");
    expect(line).toContain("slot=draftContext");
    expect(line).toContain("count=1");
  });
});

describe("#1193 W2 which-path metric — token-first vs legacy split", () => {
  it("bumps the per-(kind, via) counter and keeps the info line shape", () => {
    recordContextRouteResolutionPath({
      kind: "resolve",
      via: "run_token",
      runId: "run-1",
      contextId: null,
    });
    recordContextRouteResolutionPath({
      kind: "resolve",
      via: "run_token",
      runId: "run-2",
      contextId: null,
    });
    recordContextRouteResolutionPath({
      kind: "finalize",
      via: "context_id",
      runId: "run-3",
      contextId: "ctx-3",
    });
    recordContextRouteResolutionPath({
      kind: "resolve",
      via: "body",
      runId: "run-4",
      contextId: null,
    });

    expect(getContextRouteCounterSnapshot().resolutionPath).toEqual({
      "resolve.run_token": 2,
      "finalize.context_id": 1,
      "resolve.body": 1,
    });

    const line = String(infoSpy.mock.calls[0][0]);
    // The W3 legacy-removal gate greps this line — keep its shape stable.
    expect(line).toContain("[context-route] run resolved kind=resolve via=run_token");
    expect(line).toContain("run=run-1");
    expect(line).toContain("ctx=-");
    expect(line).toContain("count=1");
  });
});

describe("extractContextRouteLogIds — unvalidated-body id extraction", () => {
  it("picks only string ids and tolerates junk shapes", () => {
    expect(extractContextRouteLogIds(null)).toEqual({ runId: null, slotId: null });
    expect(extractContextRouteLogIds("nope")).toEqual({ runId: null, slotId: null });
    expect(
      extractContextRouteLogIds({ parentRunId: 42, slotId: { evil: true } }),
    ).toEqual({ runId: null, slotId: null });
    expect(
      extractContextRouteLogIds({ parentRunId: "run-1", slotId: "draftContext" }),
    ).toEqual({ runId: "run-1", slotId: "draftContext" });
  });
});

describe("counter registry", () => {
  it("is snapshot-isolated (mutating a snapshot does not touch the registry)", () => {
    recordContextRouteRejection({
      kind: "resolve",
      code: "oas_missing",
      status: 404,
    });
    const snap = getContextRouteCounterSnapshot();
    snap.outcome["resolve.oas_missing"] = 999;
    expect(getContextRouteCounterSnapshot().outcome["resolve.oas_missing"]).toBe(1);
  });

  it("resets to empty for tests", () => {
    recordContextRouteRejection({ kind: "resolve", code: "forbidden", status: 403 });
    resetContextRouteCountersForTest();
    expect(getContextRouteCounterSnapshot()).toEqual({
      outcome: {},
      resolutionPath: {},
    });
  });
});
