import { describe, expect, it } from "vitest";

import {
  parseRuntimeCubeDescriptors,
  validateRuntimeCubeDescriptor,
  MAX_RUNTIME_CUBE_DESCRIPTORS_PER_PACKAGE,
  MAX_MEMBERS_PER_RUNTIME_CUBE_DESCRIPTOR,
  type RuntimeCubeFromTable,
} from "../runtime-cube-registry";

// Publish a large member surface so the ONLY failure under test is the budget,
// not the allowlist/member-subset validation.
const members = Array.from({ length: 200 }, (_, i) => `m${i}`);
const publishedMembersOf = (_t: RuntimeCubeFromTable) => members;

const descriptor = (cubeId: string, memberCount: number) => ({
  cubeId,
  fromTable: "agent_runs" as const,
  members: members.slice(0, memberCount),
});

describe("cube query budget (cinatra#1628, S11c / AC4)", () => {
  it("accepts a declaration at the descriptor-count limit", () => {
    const raw = Array.from({ length: MAX_RUNTIME_CUBE_DESCRIPTORS_PER_PACKAGE }, (_, i) => descriptor(`c${i}`, 4));
    const r = parseRuntimeCubeDescriptors(raw, publishedMembersOf);
    expect(r.ok).toBe(true);
  });

  it("REJECTS a declaration over the descriptor-count limit (fail-closed)", () => {
    const raw = Array.from({ length: MAX_RUNTIME_CUBE_DESCRIPTORS_PER_PACKAGE + 1 }, (_, i) => descriptor(`c${i}`, 4));
    const r = parseRuntimeCubeDescriptors(raw, publishedMembersOf);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("cube_descriptors_budget_exceeded");
  });

  it("accepts a descriptor at the per-descriptor member limit", () => {
    const r = validateRuntimeCubeDescriptor(
      descriptor("c", MAX_MEMBERS_PER_RUNTIME_CUBE_DESCRIPTOR),
      publishedMembersOf,
    );
    expect(r.ok).toBe(true);
  });

  it("REJECTS a descriptor over the per-descriptor member limit (fail-closed)", () => {
    const r = validateRuntimeCubeDescriptor(
      descriptor("c", MAX_MEMBERS_PER_RUNTIME_CUBE_DESCRIPTOR + 1),
      publishedMembersOf,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("cube_members_budget_exceeded");
  });

  it("the member budget rejects BEFORE registration (whole declaration fails)", () => {
    const raw = [descriptor("ok", 4), descriptor("toobig", MAX_MEMBERS_PER_RUNTIME_CUBE_DESCRIPTOR + 1)];
    const r = parseRuntimeCubeDescriptors(raw, publishedMembersOf);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("cube_members_budget_exceeded");
  });
});
