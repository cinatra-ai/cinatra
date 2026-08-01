/**
 * WayFlow initial-message payload builder — spread-then-overwrite (#1193).
 *
 * The dispatch-owned run-identity keys (cinatra_run_id and the reserved run
 * token) MUST win over any author-supplied flow input, so a malicious or
 * compromised agent input can neither smuggle nor override run identity.
 * Hermetic — no DB, no dispatch machinery.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildWayflowInitialMessagePayload } from "../wayflow-dispatch-payload";
import { CINATRA_RUN_TOKEN_MESSAGE_KEY } from "@/lib/agent-run-token";

describe("buildWayflowInitialMessagePayload", () => {
  it("carries the author inputs, the run id, and the reserved run token", () => {
    const p = buildWayflowInitialMessagePayload({
      inputParams: { foo: "bar" },
      runId: "run-1",
      runToken: "raw-token",
    });
    expect(p.foo).toBe("bar");
    expect(p.cinatra_run_id).toBe("run-1");
    expect(p[CINATRA_RUN_TOKEN_MESSAGE_KEY]).toBe("raw-token");
  });

  it("author inputs can NEVER override the dispatch-owned identity keys", () => {
    const p = buildWayflowInitialMessagePayload({
      inputParams: {
        cinatra_run_id: "FORGED",
        [CINATRA_RUN_TOKEN_MESSAGE_KEY]: "FORGED",
        keep: "me",
      },
      runId: "run-real",
      runToken: "token-real",
    });
    expect(p.cinatra_run_id).toBe("run-real");
    expect(p[CINATRA_RUN_TOKEN_MESSAGE_KEY]).toBe("token-real");
    expect(p.keep).toBe("me"); // unrelated inputs survive
  });

  it("carries the token with null input params", () => {
    const p = buildWayflowInitialMessagePayload({
      inputParams: null,
      runId: "run-2",
      runToken: "t2",
    });
    expect(p.cinatra_run_id).toBe("run-2");
    expect(p[CINATRA_RUN_TOKEN_MESSAGE_KEY]).toBe("t2");
  });

  // --- #1193 DELETION LOCK ---------------------------------------------------
  // The dispatcher-signed `cinatra_run_binding` was a SECOND run selector for
  // /api/llm-bridge. It is retired with that selection precedence: the run token
  // is the only accepted identity, so the binding was dead signed material that —
  // unlike the token — was never scrubbed, and so persisted into the WayFlow
  // conversation and the A2A task history. Re-adding it would reintroduce both a
  // parallel identity channel and that exposure.

  it("NEVER emits a cinatra_run_binding key (retired selector)", () => {
    const p = buildWayflowInitialMessagePayload({
      inputParams: { cinatra_run_binding: "FORGED" },
      runId: "run-3",
      runToken: "real-3",
    });
    // An author input of that name is NOT a dispatch-owned key any more, so it
    // is left alone as an ordinary input rather than overwritten with a signed
    // value — what matters is that the BUILDER never mints one.
    expect(p.cinatra_run_binding).toBe("FORGED");
    expect(p[CINATRA_RUN_TOKEN_MESSAGE_KEY]).toBe("real-3");
  });

  it("the builder source carries no binding mint", () => {
    const src = readFileSync(
      join(__dirname, "..", "wayflow-dispatch-payload.ts"),
      "utf8",
    );
    // Only the retirement note may mention it; no code may assign it.
    expect(src).not.toMatch(/input\.runBinding/);
    expect(src).not.toMatch(/cinatra_run_binding:/);
  });
});
