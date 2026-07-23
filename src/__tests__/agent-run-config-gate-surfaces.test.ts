// cinatra #1057 ruling (b) — wiring guards: every real DISPATCH surface must
// route through the shared configuration-needs run gate
// (`assertAgentRunReadyByPackage`) so an agent whose REQUIRED connectors are not
// configured cannot be RUN. Behavioral semantics are proven in
// `src/lib/__tests__/agent-run-readiness.test.ts` (the shared predicate). These
// SOURCE assertions (same convention as the runtime-lifecycle
// `runtime-discovery-surface-wiring.test.ts`) catch a future refactor silently
// dropping the gate from a surface.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("chat explicit-dispatch surface routes through the config-needs run gate", () => {
  const src = read("app/api/chat/explicit-dispatch-server.ts");

  it("calls assertAgentRunReadyByPackage before dispatch", () => {
    expect(src).toMatch(/assertAgentRunReadyByPackage/);
    expect(src).toMatch(/agent-run-readiness/);
  });

  it("fails closed with a TERMINAL result (no LLM fallthrough) naming the connectors", () => {
    // A terminal:true short-circuit is how runner.ts early-returns without the
    // LLM fallback; the unconfigured connectors are surfaced in the SSE.
    expect(src).toMatch(/terminal:\s*true[\s\S]*notConfigured\.error|notConfigured\.error[\s\S]*terminal:\s*true/);
    expect(src).toMatch(/unconfiguredConnectors/);
  });

  it("gates BEFORE the input-extraction LLM round-trip", () => {
    const gateIdx = src.indexOf("assertAgentRunReadyByPackage");
    const extractIdx = src.indexOf("extractInputsFromPrompt(packageName, input.userPrompt");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(extractIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(extractIdx);
  });
});

describe("chat runner is covered transitively by its two gated dispatch mechanisms", () => {
  // cinatra#1037 P2a extracted the conversational orchestration out of
  // app/api/chat/runner.ts into the assistant-config-parameterized runtime
  // (lib/assistant-runtime/runtime.ts); runner.ts is now a thin binding that
  // delegates to it, so the dispatch surface these assertions pin lives in the
  // runtime module.
  const runner = read("app/api/chat/runner.ts");
  const runtime = read("lib/assistant-runtime/runtime.ts");

  it("dispatches only via serverSideExplicitDispatch (gated) or the MCP agent_run primitive (gated)", () => {
    // the runtime has no un-gated dispatch path of its own: the explicit path
    // goes through serverSideExplicitDispatch (config-gated), and the LLM path
    // goes through the MCP agent_run primitive (config-gated in handlers.ts).
    expect(runtime).toMatch(/serverSideExplicitDispatch/);
    // and it honours the terminal short-circuit the gate returns.
    expect(runtime).toMatch(/terminal/);
    // runner.ts stays the thin delegate onto that runtime — it must not grow a
    // dispatch path of its own outside the gated runtime.
    expect(runner).toMatch(/runAssistantTurn/);
    expect(runner).not.toMatch(/serverSideExplicitDispatch/);
  });
});

// NOTE (cinatra#1221, owner ruling 2026-07-22 (groganz)): the legacy widget
// relay surface `app/api/agents/[agentSlug]/stream/route.ts` was DELETED — the
// public-site widget moved onto the unified assistant broker
// (`app/api/assistants/chat/route.ts`), which pre-creates its OBO-carrier run
// through the same MCP agent_run primitive (config-gated in the handler barrel).
// Its dedicated config-needs-gate source assertion was removed with the route.
