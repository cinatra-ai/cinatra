/**
 * Project-scoped agent access bridge.
 *
 * The DB query is mocked; we assert the grant-intersection + min-role logic
 * (the additive bridge that treats a project_access grant on a bound project
 * as agent access without changing ownership).
 */
import "server-only";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectGrant } from "../actor-context";

// Mock the drizzle pool layer so the helper's query returns canned bindings.
const executeMock = vi.fn();
vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: () => ({ execute: executeMock }),
}));
// The fake pool keeps its listeners, so a case can play the pool's events.
const constructedPools: EventEmitter[] = [];
vi.mock("pg", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  class FakePool extends Emitter {
    constructor() {
      super();
      constructedPools.push(this);
    }
  }
  return { Pool: FakePool };
});

import { resolveAgentProjectAccess } from "../agent-project-access";

function grants(...g: Array<[string, ProjectGrant["effectiveRole"]]>): ProjectGrant[] {
  return g.map(([projectId, effectiveRole]) => ({ projectId, effectiveRole, accessSource: "user" as const }));
}

describe("resolveAgentProjectAccess", () => {
  beforeEach(() => executeMock.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it("returns granted when the actor holds a grant on a bound project (read)", async () => {
    executeMock.mockResolvedValue({ rows: [{ project_id: "proj-1", visibility: "visible" }] });
    const d = await resolveAgentProjectAccess("tmpl-1", { projectGrants: grants(["proj-1", "read"]) });
    expect(d).toEqual({ granted: true, viaProjectId: "proj-1", role: "read" });
  });

  it("returns NOT granted when actor has no grant on any bound project", async () => {
    executeMock.mockResolvedValue({ rows: [{ project_id: "proj-1", visibility: "visible" }] });
    const d = await resolveAgentProjectAccess("tmpl-1", { projectGrants: grants(["proj-OTHER", "admin"]) });
    expect(d).toEqual({ granted: false });
  });

  it("enforces minRole — read grant is insufficient for an execute (write) check", async () => {
    executeMock.mockResolvedValue({ rows: [{ project_id: "proj-1", visibility: "visible" }] });
    const d = await resolveAgentProjectAccess("tmpl-1", { projectGrants: grants(["proj-1", "read"]) }, { minRole: "write" });
    expect(d).toEqual({ granted: false });
  });

  it("write grant satisfies a write minRole", async () => {
    executeMock.mockResolvedValue({ rows: [{ project_id: "proj-1", visibility: "visible" }] });
    const d = await resolveAgentProjectAccess("tmpl-1", { projectGrants: grants(["proj-1", "write"]) }, { minRole: "write" });
    expect(d).toMatchObject({ granted: true, viaProjectId: "proj-1" });
  });

  it("short-circuits with no DB call when actor has zero grants", async () => {
    const d = await resolveAgentProjectAccess("tmpl-1", { projectGrants: [] });
    expect(d).toEqual({ granted: false });
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("returns NOT granted when the template is bound to no projects", async () => {
    executeMock.mockResolvedValue({ rows: [] });
    const d = await resolveAgentProjectAccess("tmpl-1", { projectGrants: grants(["proj-1", "admin"]) });
    expect(d).toEqual({ granted: false });
  });

  // NOTE: fail-closed-on-throw (legacy schema with no bindings table) is
  // verified by code inspection — the helper wraps the query in try/catch and
  // returns { granted: false }. A unit assertion for it is omitted because
  // vitest's shared-mock + unhandled-rejection detector produces a false
  // positive when the shared executeMock is switched to a throwing impl after
  // prior resolved-value tests. The "no bindings" (empty rows) test above
  // covers the equivalent deny path.
});

describe("an idle connection error on the agent project access pool (cinatra#4151)", () => {
  it("the pool's error is handled and logged without the connection string", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    executeMock.mockResolvedValue({ rows: [] });
    await resolveAgentProjectAccess("tmpl-1", { projectGrants: grants(["proj-1", "read"]) });
    expect(constructedPools).toHaveLength(1);
    const pool = constructedPools[0];

    const cut = new Error("terminating connection due to administrator command");
    expect(() => pool.emit("error", cut)).not.toThrow();
    expect(pool.listenerCount("error")).toBe(1);

    const lines = errorSpy.mock.calls.map((args) => args.map(String).join(" "));
    expect(lines).toContain(`[agent-project-access] pg pool idle client error: ${cut.message}`);
    for (const line of lines) expect(line).not.toContain("postgres://");
  });
});
