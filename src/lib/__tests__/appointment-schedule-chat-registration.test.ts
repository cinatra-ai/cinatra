/**
 * DECLARING A PRIMITIVE DOES NOT REGISTER IT.
 *
 * The sibling test (`appointment-schedule-chat-reachability`) pins that the
 * host DECLARES `appointment_schedule_add` for delegated chat and that the real
 * evaluator would admit it. That is necessary and it is NOT sufficient, and the
 * gap is the exact fault this file exists to close.
 *
 * The chat catalog is derived from ONE delegated-chat registration pass:
 * `buildDelegatedChatCapabilityPlan` runs `registerAllCapabilities` and the
 * catalog IS `plan.servable` — the set `registerTool` accepted. A primitive
 * that lives only in `collectAllPrimitiveHandlers()` (the deterministic
 * passthrough registry the agent-run road dispatches through) is never seen by
 * that pass, so it can never enter `plan.servable`, so the assistant is never
 * offered it — no matter what class `capability-plan.ts` declares for it. A
 * declaration-only fix therefore reads as complete on every projection and
 * changes nothing about what the model can call.
 *
 * `core-delegated-chat-surface.ts` says so in its own header: it is a
 * PROJECTION over the declaration table, "not authorization, and production
 * never calls it". Asserting only against that projection is how a
 * declaration-only change passes a reachability test while the live catalog
 * stays exactly as it was.
 *
 * So this file asserts the OTHER half, against artifacts derived from the real
 * registration sites rather than from the declaration table:
 *
 *   1. the generated authz inventory — built by statically scanning every
 *      `server.registerTool("<name>"` site across packages/, extensions/ and
 *      src/ — contains the name. Nothing but a real registration puts it there.
 *   2. the module that registers it is composed into the platform module list
 *      `registerAllCapabilities` iterates, so the registration is on the pass
 *      the chat plan is captured from and not on some other server.
 *   3. the passthrough registry and the MCP registration share ONE
 *      implementation, so the agent-run road and the chat road cannot answer
 *      differently.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const ADD = "appointment_schedule_add";

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), "utf8");
}

describe("appointment_schedule_add — registered on the pass the chat catalog is built from", () => {
  it("appears in the generated authz inventory, which is derived from real registerTool sites", () => {
    const inventory = JSON.parse(read("src/lib/authz/__generated__/inventory.json")) as {
      primitives?: { primitiveName: string }[];
    };
    const names = (inventory.primitives ?? []).map((p) => p.primitiveName);
    // Vacuity guard: an empty or reshaped inventory must fail loudly rather
    // than let the membership assertion below pass over nothing.
    expect(names.length).toBeGreaterThan(100);
    expect(names).toContain(ADD);
  });

  it("is registered by a module composed into the registration pass", () => {
    const module = read("src/lib/appointment-schedule-add-mcp.ts");
    expect(module).toContain(`server.registerTool(\n    "${ADD}"`);
    const server = read("src/lib/mcp-server.ts");
    expect(server).toContain("createAppointmentScheduleAddMcpModule()");
    // On the PRE-connector platform list specifically: that list is iterated by
    // `registerAllCapabilities`, which is the function
    // `buildDelegatedChatCapabilityPlan` runs. A module added anywhere else
    // would register on a different server and never reach the plan.
    const preList = server.slice(
      server.indexOf("const preConnectorPlatformModules = ["),
      server.indexOf("const postConnectorPlatformModules = ["),
    );
    expect(preList).toContain("createAppointmentScheduleAddMcpModule()");
  });

  it("shares ONE implementation with the deterministic passthrough registry", () => {
    // Two surfaces, one behaviour. If either road ever inlines its own add
    // logic again, the connector's tests prove only one of them.
    const shared = "addAppointmentScheduleForUser";
    expect(read("src/lib/primitive-handlers.ts")).toContain(shared);
    expect(read("src/lib/appointment-schedule-add-mcp.ts")).toContain(shared);
    expect(read("src/lib/appointment-schedule-add.server.ts")).toContain(
      `export async function ${shared}(`,
    );
  });

  it("the host declares the class the registration will inherit", () => {
    // The registration carries no `delegatedChat` of its own, so the planner
    // falls back to the HOST declaration for a host-owned name. Registration
    // and declaration are two halves of one fix; this pins that both are the
    // same name.
    expect(read("packages/mcp-server/src/capability-plan.ts")).toContain(
      `${ADD}: "dispatch"`,
    );
  });
});
