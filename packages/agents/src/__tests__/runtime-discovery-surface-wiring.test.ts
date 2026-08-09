// cinatra#659 (+ cinatra#2605) — wiring guards: every AGENT consumer
// DISCOVERY/EXECUTION surface must route through the shared runtime gate
// (`resolveRunnableAgentPackageNames` / `resolveAgentRunAvailabilityMap`) so a
// disabled/uninstalled agent disappears + refuses without a rebuild — and, since
// #2605, so does an agent that is NOT INSTALLED or whose required dependency
// closure is not installed. The behavioral semantics are proven in
// `runtime-install-gate.test.ts` (the pure gate) and
// `release-workflow-agent-executor.test.ts` (the workflow agent_task executor).
// These SOURCE assertions (same convention as `pages.test.tsx`) catch a future
// refactor silently dropping the gate from a surface — a regression the
// `discovery-dispatcher-bypass-ban` audit gate does not cover (it bans direct
// native-reader use; it does not require the lifecycle intersect).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

describe("agent_run (MCP execution) routes through the runtime-lifecycle gate", () => {
  const handlers = read("mcp/handlers.ts");
  const gate = read("runtime-install-gate.ts");

  it("handleAgentBuilderRun intersects the resolved template against the shared gate", () => {
    // Gate present, sourced from the shared module via the named call-site helper
    // (which itself wraps resolveRunnableAgentPackageNames / isAgentRuntimeRunnable).
    expect(handlers).toMatch(/assertAgentPackageRunnable/);
    expect(handlers).toMatch(/runtime-install-gate/);
    // The call-site helper is the one that reads the canonical source of truth
    // (since #2605 through the availability layer, which carries BOTH the
    // lifecycle rule and the provisioning rule).
    expect(gate).toMatch(/assertAgentPackageRunnable[\s\S]*resolveAgentRunAvailabilityMap/);
  });

  it("refuses execution when the agent is not runnable (fail-closed return)", () => {
    // The refusal texts are the gate contract — kept in the shared gate module.
    // The ARCHIVED wording is unchanged (#659); the two provisioning states get
    // their own actionable text (#2605) instead of being misreported as
    // "disabled".
    expect(gate).toMatch(/Agent is not installed \(disabled or uninstalled\)/);
    expect(gate).toMatch(/Agent is not installed: \$\{identifierForError\}/);
    expect(gate).toMatch(/Agent cannot run: \$\{identifierForError\} requires/);
  });
});

describe("agent_list (MCP discovery) filters by the runtime-lifecycle gate", () => {
  const handlers = read("mcp/handlers.ts");
  const gate = read("runtime-install-gate.ts");

  it("post-filters the listed items by the runnable set (both run + list route through the gate)", () => {
    // agent_run uses assertAgentPackageRunnable; agent_list uses
    // partitionRunnableAgentPackages — both shared-gate call-site helpers.
    expect(handlers).toMatch(/assertAgentPackageRunnable/);
    expect(handlers).toMatch(/partitionRunnableAgentPackages/);
    // The list helper itself must route through the canonical source-of-truth read.
    expect(gate).toMatch(/partitionRunnableAgentPackages[\s\S]*resolveAgentRunAvailabilityMap/);
  });

  it("keeps null-packageName + CG-1 no-row items (the bundled floor) in the list", () => {
    // The keep predicate is the gate contract — kept in the shared gate module.
    // A null package is always kept; every other item is kept only on the
    // `runnable` verdict (#2605: discovery must not advertise what agent_run
    // refuses).
    expect(gate).toMatch(/t\.packageName == null \|\|\s*\n?\s*\(availability\.get\(t\.packageName\)\?\.state \?\? "runnable"\) === "runnable"/);
  });
});

describe("the interactive run-start (/agents/<package>/new) applies the same verdict", () => {
  const runActions = read("run-actions.ts");

  it("createAndTriggerRunCore refuses a non-runnable package before any run row exists", () => {
    // The picker's Run link lands here; a bookmark or a typed URL reaches it
    // without the picker. Same shared gate, same refusal text (#2605).
    expect(runActions).toMatch(/assertAgentPackageRunnable/);
    expect(runActions).toMatch(/runtime-install-gate/);
    // Refused BEFORE the create (no orphan run row for a run that cannot start).
    const gateAt = runActions.indexOf("assertAgentPackageRunnable(");
    const createAt = runActions.indexOf("createAgentRunPendingInput(", gateAt);
    expect(gateAt).toBeGreaterThan(-1);
    expect(createAt).toBeGreaterThan(gateAt);
  });
});

describe("NewAgentPage (the /agents All-Agents picker) intersects against the runtime gate", () => {
  const pages = read("pages.tsx");

  it("resolves run availability over the local (non-external) templates", () => {
    expect(pages).toMatch(/resolveAgentRunAvailabilityMap/);
    expect(pages).toMatch(/sourceType !== "external"/);
  });

  it("keeps external A2A templates + null-package + CG-1 no-row templates", () => {
    expect(pages).toMatch(/t\.sourceType === "external"/);
    expect(pages).toMatch(/t\.sourceType === "external" \|\| t\.packageName == null/);
  });

  it("only an ARCHIVED verdict removes a row; a non-runnable one keeps the card (#2605)", () => {
    expect(pages).toMatch(/availabilityOf\(t\)\.state !== "archived"/);
    expect(pages).toMatch(/buildUnavailableAction\(/);
  });
});
