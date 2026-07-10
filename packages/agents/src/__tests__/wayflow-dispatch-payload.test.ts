/**
 * WayFlow initial-message payload builder — spread-then-overwrite (#1193).
 *
 * The dispatch-owned run-identity keys (cinatra_run_id, the optional binding,
 * and the reserved run token) MUST win over any author-supplied flow input, so
 * a malicious or compromised agent input can neither smuggle nor override run
 * identity. Hermetic — no DB, no dispatch machinery.
 */
import { describe, it, expect } from "vitest";
import { buildWayflowInitialMessagePayload } from "../wayflow-dispatch-payload";
import { CINATRA_RUN_TOKEN_MESSAGE_KEY } from "@/lib/agent-run-token";

describe("buildWayflowInitialMessagePayload", () => {
  it("carries the author inputs, run id, binding, and the reserved run token", () => {
    const p = buildWayflowInitialMessagePayload({
      inputParams: { foo: "bar" },
      runId: "run-1",
      runBinding: "payload.sig",
      runToken: "raw-token",
    });
    expect(p.foo).toBe("bar");
    expect(p.cinatra_run_id).toBe("run-1");
    expect(p.cinatra_run_binding).toBe("payload.sig");
    expect(p[CINATRA_RUN_TOKEN_MESSAGE_KEY]).toBe("raw-token");
  });

  it("author inputs can NEVER override the dispatch-owned identity keys", () => {
    const p = buildWayflowInitialMessagePayload({
      inputParams: {
        cinatra_run_id: "FORGED",
        cinatra_run_binding: "FORGED",
        [CINATRA_RUN_TOKEN_MESSAGE_KEY]: "FORGED",
        keep: "me",
      },
      runId: "run-real",
      runBinding: "bind-real",
      runToken: "token-real",
    });
    expect(p.cinatra_run_id).toBe("run-real");
    expect(p.cinatra_run_binding).toBe("bind-real");
    expect(p[CINATRA_RUN_TOKEN_MESSAGE_KEY]).toBe("token-real");
    expect(p.keep).toBe("me"); // unrelated inputs survive
  });

  it("omits the binding key when no binding is supplied, but still carries the token", () => {
    const p = buildWayflowInitialMessagePayload({
      inputParams: null,
      runId: "run-2",
      runToken: "t2",
    });
    expect("cinatra_run_binding" in p).toBe(false);
    expect(p.cinatra_run_id).toBe("run-2");
    expect(p[CINATRA_RUN_TOKEN_MESSAGE_KEY]).toBe("t2");
  });

  it("defeats a token-key override even when no binding is present", () => {
    const p = buildWayflowInitialMessagePayload({
      inputParams: { [CINATRA_RUN_TOKEN_MESSAGE_KEY]: "FORGED" },
      runId: "run-3",
      runToken: "real-3",
    });
    expect(p[CINATRA_RUN_TOKEN_MESSAGE_KEY]).toBe("real-3");
  });
});
