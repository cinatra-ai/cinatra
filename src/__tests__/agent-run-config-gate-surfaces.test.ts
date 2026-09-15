// cinatra #1057 ruling (b) — wiring guards: every real DISPATCH surface must
// route through the shared configuration-needs run gate
// (`assertAgentRunReadyByPackage`) so an agent whose REQUIRED connectors are not
// configured cannot be RUN. Behavioral semantics are proven in
// `src/lib/__tests__/agent-run-readiness.test.ts` (the shared predicate). These
// SOURCE assertions (same convention as the runtime-lifecycle
// `runtime-discovery-surface-wiring.test.ts`) catch a future refactor silently
// dropping the gate from a surface.
//
// AMENDED for cinatra#2935 (lifecycle-b W5d). The chat's server-side
// sentence-matcher used to be a dispatch surface of its own and carried its own
// copy of this gate; it is gone, and with it the second surface these guards had
// to watch. There is now ONE gated start core — the `agent_run` primitive — and
// two doors onto it: the assistant's own tool call in the chat, and the widget's
// one narrowly scoped start. So the guards below follow the surfaces that exist:
// the core still gates, and neither door bypasses it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const REPO = join(ROOT, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const readRepo = (rel: string) => readFileSync(join(REPO, rel), "utf8");

describe("the ONE start core routes through the config-needs run gate", () => {
  const src = readRepo("packages/agents/src/mcp/handlers.ts");

  it("agent_run calls assertAgentRunReadyByPackage before it launches", () => {
    expect(src).toMatch(/assertAgentRunReadyByPackage/);
    expect(src).toMatch(/agent-run-readiness/);
  });

  it("the gate runs BEFORE the launch, and fails closed by returning its refusal", () => {
    const gateIdx = src.indexOf("assertAgentRunReadyByPackage");
    const launchIdx = src.indexOf("await createAgentRunForLaunchFrame({");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(launchIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(launchIdx);
    expect(src).toMatch(/if \(notConfigured\) return notConfigured;/);
  });

  it("the agent-creation preflight moved onto the same road with it", () => {
    // It used to run ONLY on the removed chat pre-router, so a run started any
    // other way skipped it. It now guards every start.
    expect(src).toMatch(/refuseIfCreationPreflightFails/);
    const preflightIdx = src.indexOf(
      "await refuseIfCreationPreflightFails(template.packageName, identifierForError)",
    );
    const launchIdx = src.indexOf("await createAgentRunForLaunchFrame({");
    expect(preflightIdx).toBeGreaterThan(-1);
    expect(preflightIdx).toBeLessThan(launchIdx);
  });
});

describe("neither door onto that core carries a start path of its own", () => {
  const runtime = read("lib/assistant-runtime/runtime.ts");
  const runner = read("app/api/chat/runner.ts");
  const widgetStart = read("lib/lifecycle/named-agent-start-mcp.ts");

  it("the chat runtime has NO pre-model dispatcher left", () => {
    // The removed pair, named so a reintroduction is caught by name.
    expect(runtime).not.toMatch(/serverSideExplicitDispatch/);
    expect(runtime).not.toMatch(/detectExplicitDispatchPackage/);
    expect(runtime).not.toMatch(/detectExplicitDispatchDirective/);
    // runner.ts stays the thin delegate onto the runtime.
    expect(runner).toMatch(/runAssistantTurn/);
    expect(runner).not.toMatch(/serverSideExplicitDispatch/);
  });

  it("the widget's start invokes the gated primitive rather than creating a run", () => {
    expect(widgetStart).toMatch(/primitiveName: "agent_run"/);
    // No creation call of its own — the run-creation fence sees one producer.
    expect(widgetStart).not.toMatch(/createAgentRun\(/);
    expect(widgetStart).not.toMatch(/launchAgentRun\(/);
    expect(widgetStart).not.toMatch(/enqueueAgentRun\(/);
  });
});
