/**
 * Regression coverage: bridge run-binding.
 *
 * The bridge token authenticates only the caller CLASS. bindBridgeRunId binds a
 * body-selected agent_run_id to the run actually executing this callback, proven
 * by the auth-injected X-Cinatra-A2A-Context-Id header (set server-side by the
 * WayFlow runtime, NOT writable by the OAS author). It MUST fail closed on a
 * missing header, an unresolvable context id, or a body/context mismatch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@cinatra-ai/agents", () => ({
  readAgentRunByContextId: vi.fn(),
}));

import { bindBridgeRunId } from "../bridge-run-binding";
import { readAgentRunByContextId } from "@cinatra-ai/agents";

const readByCtx = readAgentRunByContextId as ReturnType<typeof vi.fn>;

function req(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/agents/passthrough", {
    method: "POST",
    headers,
  });
}

describe("bindBridgeRunId", () => {
  beforeEach(() => vi.clearAllMocks());

  it("denies (403) when the context-id header is absent", async () => {
    const res = await bindBridgeRunId(req({}), "run-1");
    expect(res.ok).toBe(false);
    expect(readByCtx).not.toHaveBeenCalled();
    if (!res.ok) expect(res.status).toBe(403);
  });

  it("denies (403) when the context id does not resolve to a run", async () => {
    readByCtx.mockResolvedValue(null);
    const res = await bindBridgeRunId(
      req({ "x-cinatra-a2a-context-id": "ctx-unknown" }),
      "run-1",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(403);
  });

  it("denies (403) when the body agent_run_id does not match the executing run", async () => {
    // The attacker presents a valid bridge token + the context id of THEIR OWN
    // run, but selects a different (victim) run id in the body.
    readByCtx.mockResolvedValue({ id: "attacker-run" });
    const res = await bindBridgeRunId(
      req({ "x-cinatra-a2a-context-id": "ctx-attacker" }),
      "victim-run",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(403);
  });

  it("allows when the body agent_run_id equals the context-resolved run", async () => {
    readByCtx.mockResolvedValue({ id: "run-1" });
    const res = await bindBridgeRunId(
      req({ "x-cinatra-a2a-context-id": "ctx-1" }),
      "run-1",
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.runId).toBe("run-1");
  });

  it("fails closed (403) when readAgentRunByContextId throws", async () => {
    readByCtx.mockRejectedValue(new Error("db down"));
    const res = await bindBridgeRunId(
      req({ "x-cinatra-a2a-context-id": "ctx-1" }),
      "run-1",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(403);
  });
});
