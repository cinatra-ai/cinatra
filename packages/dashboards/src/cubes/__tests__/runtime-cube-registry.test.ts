import { afterEach, describe, expect, it } from "vitest";

import {
  __resetRuntimeCubeRegistryForTests,
  ALL_BUNDLED_CUBE_IDS,
  buildRuntimeRegisteredCubes,
  getRuntimeCubeRegistration,
  isRuntimeCube,
  isRuntimeCubeFromTable,
  listRuntimeCubeIds,
  parseRuntimeCubeDescriptors,
  registerRuntimeCubes,
  RUNTIME_CUBE_FROM_ALLOWLIST,
  unregisterRuntimeCubesForPackage,
  validateRuntimeCubeDescriptor,
} from "../runtime-cube-registry";
import { listBundledCubeNames } from "../platform-singleton";
import {
  createAgentRunsCube,
  type RegisteredCube,
} from "@cinatra-ai/sdk-dashboard/adapters/drizzle-cube";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

const ownerScope = { ownerLevel: "organization", ownerId: "org_1", organizationId: "org_1" };

// agent_runs publishes: agent_id, agent_name, status, created_at (dims) + count, last_run_at (measures)
const PUBLISHED: Record<string, string[]> = {
  agent_runs: ["agent_id", "agent_name", "status", "created_at", "count", "last_run_at"],
  projects: ["id", "name", "slug", "organization_id", "organization_name", "created_at", "count"],
  teams: ["id", "name", "organization_id", "organization_name", "created_at", "count", "member_count"],
  organizations: ["id", "name", "slug", "role", "team_names", "created_at", "count", "member_count"],
};
const publishedMembersOf = (t: string) => PUBLISHED[t] ?? [];

afterEach(() => {
  __resetRuntimeCubeRegistryForTests();
});

describe("validateRuntimeCubeDescriptor", () => {
  it("accepts a valid descriptor over an allowlisted base + published members", () => {
    const r = validateRuntimeCubeDescriptor(
      { cubeId: "ext_summary", fromTable: "agent_runs", members: ["count", "status"] },
      publishedMembersOf as never,
    );
    expect(r.ok).toBe(true);
  });

  it("rejects a non-allowlisted fromTable (artifacts / llm_usage omitted from the runtime floor)", () => {
    for (const t of ["artifacts", "llm_usage", "unknown_table"]) {
      const r = validateRuntimeCubeDescriptor(
        { cubeId: "ext_x", fromTable: t, members: ["count"] },
        publishedMembersOf as never,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("cube_from_not_allowlisted");
    }
  });

  it("rejects a member the base cube does not publish", () => {
    const r = validateRuntimeCubeDescriptor(
      { cubeId: "ext_x", fromTable: "agent_runs", members: ["count", "secret_column"] },
      publishedMembersOf as never,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("cube_member_unknown");
  });

  it("rejects an empty / dotted / blank cubeId", () => {
    expect(validateRuntimeCubeDescriptor({ cubeId: "", fromTable: "agent_runs", members: ["count"] }, publishedMembersOf as never).ok).toBe(false);
    expect(validateRuntimeCubeDescriptor({ cubeId: "ext.bad", fromTable: "agent_runs", members: ["count"] }, publishedMembersOf as never).ok).toBe(false);
    expect(validateRuntimeCubeDescriptor({ cubeId: "  ", fromTable: "agent_runs", members: ["count"] }, publishedMembersOf as never).ok).toBe(false);
  });

  it("rejects a cubeId that shadows a bundled base cube id", () => {
    const r = validateRuntimeCubeDescriptor(
      { cubeId: "agent_runs", fromTable: "agent_runs", members: ["count"] },
      publishedMembersOf as never,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("cube_id_shadows_base");
  });

  it("rejects a cubeId that shadows a NON-allowlisted bundled cube (artifacts / llm_usage)", () => {
    for (const id of ["artifacts", "llm_usage"]) {
      const r = validateRuntimeCubeDescriptor(
        { cubeId: id, fromTable: "agent_runs", members: ["count"] },
        publishedMembersOf as never,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("cube_id_shadows_base");
    }
  });

  it("rejects an empty members array", () => {
    const r = validateRuntimeCubeDescriptor(
      { cubeId: "ext_x", fromTable: "agent_runs", members: [] },
      publishedMembersOf as never,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("cube_members_empty");
  });
});

describe("parseRuntimeCubeDescriptors", () => {
  it("rejects a non-array payload", () => {
    const r = parseRuntimeCubeDescriptors({ not: "array" }, publishedMembersOf as never);
    expect(r.ok).toBe(false);
  });

  it("rejects a duplicate cubeId within the declaration", () => {
    const r = parseRuntimeCubeDescriptors(
      [
        { cubeId: "ext_a", fromTable: "agent_runs", members: ["count"] },
        { cubeId: "ext_a", fromTable: "projects", members: ["count"] },
      ],
      publishedMembersOf as never,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("cube_id_duplicate");
  });

  it("parses + dedupes members on success", () => {
    const r = parseRuntimeCubeDescriptors(
      [{ cubeId: "ext_a", fromTable: "agent_runs", members: ["count", "count", "status"] }],
      publishedMembersOf as never,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.descriptors[0].members).toEqual(["count", "status"]);
  });
});

describe("register / unregister", () => {
  const descriptors = [{ cubeId: "ext_a", fromTable: "agent_runs" as const, members: ["count"] }];

  it("registers + looks up + lists + unregisters by package", () => {
    const reg = registerRuntimeCubes({ sourcePackageName: "@x/pkg", ownerScope, descriptors, activationGeneration: 1 });
    expect(reg.ok).toBe(true);
    expect(isRuntimeCube("ext_a")).toBe(true);
    expect(listRuntimeCubeIds()).toContain("ext_a");
    expect(getRuntimeCubeRegistration("ext_a")?.sourcePackageName).toBe("@x/pkg");

    const removed = unregisterRuntimeCubesForPackage("@x/pkg");
    expect(removed).toEqual(["ext_a"]);
    expect(isRuntimeCube("ext_a")).toBe(false);
  });

  it("rejects a cross-package alias collision", () => {
    registerRuntimeCubes({ sourcePackageName: "@x/pkg", ownerScope, descriptors, activationGeneration: 1 });
    const reg = registerRuntimeCubes({ sourcePackageName: "@y/other", ownerScope, descriptors, activationGeneration: 1 });
    expect(reg.ok).toBe(false);
    if (!reg.ok) expect(reg.code).toBe("cube_id_collision");
  });

  it("register defensively rejects a bundled-id alias (defense-in-depth)", () => {
    const reg = registerRuntimeCubes({
      sourcePackageName: "@x/pkg",
      ownerScope,
      descriptors: [{ cubeId: "artifacts", fromTable: "agent_runs", members: ["count"] }],
      activationGeneration: 1,
    });
    expect(reg.ok).toBe(false);
    if (!reg.ok) expect(reg.code).toBe("cube_id_shadows_base");
  });

  it("re-register from the SAME package replaces idempotently", () => {
    registerRuntimeCubes({ sourcePackageName: "@x/pkg", ownerScope, descriptors, activationGeneration: 1 });
    const reg2 = registerRuntimeCubes({
      sourcePackageName: "@x/pkg",
      ownerScope,
      descriptors: [{ cubeId: "ext_a", fromTable: "agent_runs", members: ["count", "status"] }],
      activationGeneration: 2,
    });
    expect(reg2.ok).toBe(true);
    expect(getRuntimeCubeRegistration("ext_a")?.descriptor.members).toEqual(["count", "status"]);
  });
});

describe("buildRuntimeRegisteredCubes", () => {
  function baseAgentRunsCube(): RegisteredCube {
    const agentRuns = pgTable("agent_runs", {
      id: text("id").primaryKey(),
      templateId: text("template_id"),
      status: text("status"),
      createdAt: timestamp("created_at"),
      orgId: text("org_id"),
      runBy: text("run_by"),
    });
    const agentTemplates = pgTable("agent_templates", { id: text("id").primaryKey(), name: text("name") });
    return createAgentRunsCube({
      tableRef: agentRuns,
      columns: { id: agentRuns.id, templateId: agentRuns.templateId, status: agentRuns.status, createdAt: agentRuns.createdAt, orgId: agentRuns.orgId, runBy: agentRuns.runBy },
      templatesTableRef: agentTemplates,
      templateColumns: { id: agentTemplates.id, name: agentTemplates.name },
    });
  }

  it("aliases a registered runtime cube over its allowlisted base under the alias id + member subset", () => {
    registerRuntimeCubes({
      sourcePackageName: "@x/pkg",
      ownerScope,
      descriptors: [{ cubeId: "ext_summary", fromTable: "agent_runs", members: ["count", "status"] }],
      activationGeneration: 1,
    });
    const base = baseAgentRunsCube();
    const aliased = buildRuntimeRegisteredCubes(new Map([["agent_runs", base]]));
    expect(aliased).toHaveLength(1);
    expect(aliased[0].descriptor.id).toBe("ext_summary");
    const memberIds = [
      ...aliased[0].descriptor.dimensions.map((d) => d.id),
      ...aliased[0].descriptor.measures.map((m) => m.id),
    ];
    expect(new Set(memberIds)).toEqual(new Set(["count", "status"]));
  });

  it("SKIPS a runtime cube whose base table is not in the provided base map (fail-closed)", () => {
    registerRuntimeCubes({
      sourcePackageName: "@x/pkg",
      ownerScope,
      descriptors: [{ cubeId: "ext_summary", fromTable: "agent_runs", members: ["count"] }],
      activationGeneration: 1,
    });
    const aliased = buildRuntimeRegisteredCubes(new Map());
    expect(aliased).toHaveLength(0);
  });
});

describe("allowlist constants", () => {
  it("exposes the runtime FROM-allowlist floor (no artifacts / llm_usage)", () => {
    expect([...RUNTIME_CUBE_FROM_ALLOWLIST].sort()).toEqual(["agent_runs", "organizations", "projects", "teams"]);
    expect(isRuntimeCubeFromTable("artifacts")).toBe(false);
    expect(isRuntimeCubeFromTable("llm_usage")).toBe(false);
    expect(isRuntimeCubeFromTable("agent_runs")).toBe(true);
  });

  it("ALL_BUNDLED_CUBE_IDS stays in sync with the platform bundled cube names (no-drift assertion)", () => {
    expect([...ALL_BUNDLED_CUBE_IDS].sort()).toEqual([...listBundledCubeNames()].sort());
  });
});
