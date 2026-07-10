// #1197 acceptance — a context-route rejection produces the expected
// structured log + counter for a representative stable code, end-to-end
// through the ROUTE handler (the observability module is the REAL one; only
// the heavy IO derivation is mocked). Also pins the success-path debug trace
// and the invalid_body rejection accounting.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

const deriveContextRouteContext = vi.fn();
const loadTrustedSlot = vi.fn();
const resolveCandidates = vi.fn();

vi.mock("@/lib/artifacts/context-route-io", () => ({
  deriveContextRouteContext: (...args: unknown[]) =>
    deriveContextRouteContext(...args),
  loadTrustedSlot: (...args: unknown[]) => loadTrustedSlot(...args),
  resolveCandidates: (...args: unknown[]) => resolveCandidates(...args),
}));

// Importing AFTER vi.mock so the route picks up the mocked IO module. The
// observability module + ContextRouteError are the REAL implementations.
const { POST } = await import("../route");
const { ContextRouteError } = await import("@/lib/artifacts/context-route-support");
const {
  getContextRouteCounterSnapshot,
  resetContextRouteCountersForTest,
} = await import("@/lib/artifacts/context-route-observability");

function makeRequest(over: {
  body?: unknown;
  headers?: Record<string, string>;
} = {}): Request {
  return new Request("http://localhost/api/context-resolve", {
    method: "POST",
    headers: { "content-type": "application/json", ...(over.headers ?? {}) },
    body: JSON.stringify(
      over.body ?? {
        parentRunId: "run-1",
        parentPackageName: "@cinatra-ai/blog-draft-writer-agent",
        slotId: "draftContext",
      },
    ),
  });
}

let warnSpy: ReturnType<typeof vi.spyOn>;
let debugSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  resetContextRouteCountersForTest();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  debugSpy.mockRestore();
});

describe("/api/context-resolve — #1197 rejection observability", () => {
  it("a context_unresolved rejection logs the structured line and bumps the per-code counter", async () => {
    deriveContextRouteContext.mockRejectedValue(
      new ContextRouteError(
        403,
        "context_unresolved",
        "x-cinatra-a2a-context-id did not resolve to a run",
      ),
    );

    const res = await POST(
      makeRequest({ headers: { "x-cinatra-a2a-context-id": "ctx-dead" } }),
    );

    // The route contract is unchanged: stable code + status in the response.
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "context_unresolved" });

    // Counter: keyed by (kind, code).
    expect(
      getContextRouteCounterSnapshot().outcome["resolve.context_unresolved"],
    ).toBe(1);

    // ONE structured warn line with code + run/context/slot identifiers.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = String(warnSpy.mock.calls[0][0]);
    expect(line).toContain("[context-route] rejected kind=resolve");
    expect(line).toContain("code=context_unresolved");
    expect(line).toContain("status=403");
    expect(line).toContain("run=run-1");
    expect(line).toContain("ctx=ctx-dead");
    expect(line).toContain("slot=draftContext");
  });

  it("an invalid body is counted + logged as invalid_body with best-effort ids", async () => {
    const res = await POST(
      makeRequest({ body: { parentRunId: "run-1", slotId: "draftContext" } }),
    );
    expect(res.status).toBe(400);
    expect(
      getContextRouteCounterSnapshot().outcome["resolve.invalid_body"],
    ).toBe(1);
    const line = String(warnSpy.mock.calls[0][0]);
    expect(line).toContain("code=invalid_body");
    expect(line).toContain("run=run-1");
    expect(line).toContain("slot=draftContext");
    // The derive chain is never reached on a malformed body.
    expect(deriveContextRouteContext).not.toHaveBeenCalled();
  });

  it("success bumps `resolve.ok` and emits ONLY the debug lifecycle trace", async () => {
    deriveContextRouteContext.mockResolvedValue({
      actor: { sub: "user-1", organizationId: "org-1" },
      run: { id: "run-1", orgId: "org-1", runBy: "user-1" },
      servedBy: "run_token",
      projectId: undefined,
      trustedPackageName: "@cinatra-ai/blog-draft-writer-agent",
      trustedSlotPackageName: "@cinatra-ai/blog-draft-writer-agent",
    });
    loadTrustedSlot.mockResolvedValue({
      slotId: "draftContext",
      acceptedArtifactExtensions: ["@cinatra-ai/blog-idea-artifact"],
      selectionMode: "autonomous",
      resolutionMode: "accumulate",
      minItems: 0,
      readableOnly: true,
    });
    resolveCandidates.mockReturnValue([]);

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    expect(getContextRouteCounterSnapshot().outcome["resolve.ok"]).toBe(1);
    // Not noisy on the queryable rejection channel.
    expect(warnSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledTimes(1);
    const line = String(debugSpy.mock.calls[0][0]);
    expect(line).toContain("[context-route] ok kind=resolve via=run_token");
    expect(line).toContain("run=run-1");
    expect(line).toContain("slot=draftContext");
  });
});
