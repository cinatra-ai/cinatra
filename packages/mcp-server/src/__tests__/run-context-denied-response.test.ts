/**
 * cinatra#1195 — the ENFORCEMENT POINT paired with `failClosed: true`.
 *
 * The pure decision (`resolveRequestRunContext` → `denied`) is covered in
 * run-context-resolution.test.ts. This suite pins the OTHER half, which had to
 * land in the SAME change or the flip would be fail-OPEN: the transport's
 * refusal answer for a request whose only run-identity claim arrived through a
 * retired, forgeable channel.
 *
 * The invariant under test is that `denied` produces a REFUSAL — not a served
 * request with the run id merely dropped, which would let a run-scoped write
 * persist unattributed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { runContextDeniedResponse } from "../inbound-era";
import { resolveRequestRunContext } from "../request-context";

const TRANSPORT_SRC = readFileSync(
  join(__dirname, "..", "index.tsx"),
  "utf8",
);

describe("runContextDeniedResponse", () => {
  it("is a 403 JSON-RPC error, not a served response", async () => {
    const res = runContextDeniedResponse();
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      jsonrpc: string;
      error: { code: number; message: string };
      id: null;
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error.code).toBe(-32001);
    expect(body.id).toBeNull();
  });

  it("names the retired header and the supported alternative, and leaks nothing", async () => {
    const body = (await runContextDeniedResponse().json()) as {
      error: { message: string };
    };
    const message = body.error.message;
    expect(message).toContain("x-cinatra-run-id");
    expect(message).toContain("on-behalf-of");
    // Ids-only discipline: the refusal must not echo caller-supplied values.
    expect(message).not.toMatch(/Bearer|token=|hash/i);
  });
});

describe("the transport posture the refusal enforces", () => {
  it("a header-only run-identity claim is DENIED under the production failClosed:true wiring", () => {
    // Exactly what index.tsx passes: failClosed true, no registry input at all.
    const r = resolveRequestRunContext({
      failClosed: true,
      durable: { outcome: "absent" },
      headerRunId: "run-forged",
      headerAgentId: "agent-forged",
    });
    expect(r.denied).toBe(true);
    expect(r.deniedChannel).toBe("header");
    // …and the id is dropped, so serving it WITHOUT the refusal would be an
    // unattributed write — the fail-OPEN outcome this pairing exists to prevent.
    expect(r.runId).toBeUndefined();
  });

  it("a verified caller is never denied, so the refusal cannot fire for it", () => {
    for (const r of [
      resolveRequestRunContext({
        failClosed: true,
        delegatedRunId: "run-obo",
        headerRunId: "run-forged",
      }),
      resolveRequestRunContext({
        failClosed: true,
        durable: { outcome: "resolved", ctx: { runId: "run-durable" } },
        headerRunId: "run-forged",
      }),
    ]) {
      expect(r.denied).toBe(false);
      expect(r.runId).toBeTruthy();
    }
  });

  it("a request with no run-identity claim at all is not denied (nothing to refuse)", () => {
    const r = resolveRequestRunContext({
      failClosed: true,
      durable: { outcome: "absent" },
    });
    expect(r.denied).toBe(false);
    expect(r.servedBy).toBe("none");
  });
});

describe("transport wiring: the refusal is reached BEFORE any handler runs", () => {
  // The whole point of pairing the flag with an enforcement point is that a
  // denied request never reaches a handler — otherwise a run-scoped write could
  // still persist unattributed (fail-OPEN). Booting the real transport needs
  // Next + better-auth + a DB, so this asserts the property structurally, on
  // the transport source: the refusal must SHORT-CIRCUIT (return) ahead of both
  // the request-store frame and the era dispatch.
  const enforcement = TRANSPORT_SRC.indexOf("if (runContext.denied) {");
  const refusalReturn = TRANSPORT_SRC.indexOf("runContextDeniedResponse()");
  const requestStore = TRANSPORT_SRC.indexOf("const requestStore: McpRequestContext");
  const handlerDispatch = TRANSPORT_SRC.indexOf("mcpRequestContextStorage.run(");

  it("production wiring passes failClosed: true", () => {
    expect(TRANSPORT_SRC).toContain("failClosed: true");
  });

  it("the denied branch exists and returns the refusal", () => {
    expect(enforcement).toBeGreaterThan(-1);
    expect(refusalReturn).toBeGreaterThan(enforcement);
    expect(TRANSPORT_SRC.slice(enforcement, refusalReturn)).toContain("return");
  });

  it("it short-circuits ahead of the request-store frame and the era dispatch", () => {
    expect(requestStore).toBeGreaterThan(-1);
    expect(handlerDispatch).toBeGreaterThan(-1);
    expect(enforcement).toBeLessThan(requestStore);
    expect(enforcement).toBeLessThan(handlerDispatch);
  });

  it("the in-process registry option is gone from the transport", () => {
    expect(TRANSPORT_SRC).not.toContain("options.getRunContext");
    expect(TRANSPORT_SRC).not.toContain("registryCtx:");
  });
});
