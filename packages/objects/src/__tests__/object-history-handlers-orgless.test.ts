// Orgless-actor rejection tests for the object-history MCP handlers. Every
// user-reachable history / change_set read+write primitive must reject when
// actor.orgId is null unless A2A_DEV_BYPASS === "true".

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/object-history", () => ({
  loadChangeSet: vi.fn(),
  listChangeSets: vi.fn(),
  listEventsForObject: vi.fn(),
  readObjectScopeById: vi.fn(),
  summarizeChangeSetEligibility: vi.fn(),
  restoreChangeSet: vi.fn(),
  restoreObjectToVersion: vi.fn(),
  RestoreNotEligibleError: class extends Error {},
  VersionConflictError: class extends Error {},
}));

vi.mock("@/lib/authz/enforce-resource-access", () => ({
  enforceResourceAccess: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/authz/errors", () => ({
  AuthzError: class extends Error {},
}));

vi.mock("@/lib/authz/resource-ref", () => ({
  normalizeOwnerLevel: (v: string) => v,
}));

import { createObjectHistoryPrimitiveHandlers } from "../mcp/object-history-handlers";

function makeOrglessActor() {
  return {
    actorType: "model" as const,
    source: "agent" as const,
    // orgId intentionally absent
  };
}

const PRIMITIVES_THAT_REQUIRE_ORG = [
  {
    name: "change_set_undo",
    // bypassEligibility is removed from the public input schema. Test
    // exercises the minimal schema-accepted input.
    input: { changeSetId: "cs_x" },
  },
  {
    name: "object_version_restore",
    input: { objectId: "obj_x", targetVersion: 1 },
  },
  { name: "change_set_get", input: { changeSetId: "cs_x", includeEligibility: true } },
  { name: "change_set_list", input: { limit: 10 } },
  { name: "object_history_list", input: { objectId: "obj_x", limit: 50 } },
  { name: "change_set_eligibility_get", input: { changeSetId: "cs_x" } },
];

describe("object-history MCP handlers — orgless actor rejection", () => {
  const originalBypass = process.env.A2A_DEV_BYPASS;

  beforeEach(() => {
    delete process.env.A2A_DEV_BYPASS;
  });
  afterEach(() => {
    if (originalBypass === undefined) {
      delete process.env.A2A_DEV_BYPASS;
    } else {
      process.env.A2A_DEV_BYPASS = originalBypass;
    }
  });

  for (const p of PRIMITIVES_THAT_REQUIRE_ORG) {
    it(`${p.name} rejects when actor.orgId is null`, async () => {
      const handlers = createObjectHistoryPrimitiveHandlers() as Record<
        string,
        (request: { input: unknown; actor: unknown; mode: string; primitiveName: string }) => Promise<unknown>
      >;
      const handler = handlers[p.name];
      expect(handler).toBeDefined();
      await expect(
        handler({
          input: p.input,
          actor: makeOrglessActor(),
          mode: "agentic",
          primitiveName: p.name,
        }),
      ).rejects.toThrow(/requires an authenticated org context/);
    });

    it(`${p.name} allows orgless actor when A2A_DEV_BYPASS === "true"`, async () => {
      process.env.A2A_DEV_BYPASS = "true";
      const handlers = createObjectHistoryPrimitiveHandlers() as Record<
        string,
        (request: { input: unknown; actor: unknown; mode: string; primitiveName: string }) => Promise<unknown>
      >;
      const handler = handlers[p.name];
      // Doesn't have to succeed — only must not throw the
      // "requires an authenticated org context" error. Other failures
      // (missing target row, etc.) are fine here.
      await handler({
        input: p.input,
        actor: makeOrglessActor(),
        mode: "agentic",
        primitiveName: p.name,
      }).catch((e: Error) => {
        expect(e.message).not.toMatch(/requires an authenticated org context/);
      });
    });
  }
});
