/**
 * Multi-scope access W4 (#1073): the catalog normalizers must PRESERVE the
 * canonical `accessPolicy` blob. Before this fix they dropped it, so after a
 * `syncInstalledSkillsToDatabase` round-trip every policy reader saw `null` and
 * enforcement silently fell back to the lossy (level, scope) tuple.
 *
 * `syncInstalledSkillsToDatabase` maps every stored record through these exact
 * normalizers before writing back and re-reading, so preserving the field here
 * is what makes the DB sync round-trip it.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeStoredSkill,
  normalizeStoredSkillPackage,
} from "../skills-store";

const T1 = "team:11111111-1111-1111-1111-111111111111";
const P2 = "project:22222222-2222-2222-2222-222222222222";

const OR_POLICY = {
  runListVisibility: [T1, P2],
  runDataVisibility: [T1, P2],
  runExecuteVisibility: [T1, P2],
  allowRunSharing: false,
};

describe("accessPolicy survives catalog normalize (W4 round-trip)", () => {
  it("preserves a per-skill accessPolicy override with a multi-token union", () => {
    const record = {
      id: "@pkg/s",
      slug: "s",
      name: "S",
      description: "d",
      content: "c",
      packageId: "@pkg",
      packageName: "pkg",
      packageSlug: "pkg",
      level: "team",
      scope: "11111111-1111-1111-1111-111111111111",
      accessPolicy: OR_POLICY,
    };
    const normalized = normalizeStoredSkill(record);
    expect(normalized).not.toBeNull();
    expect(normalized!.accessPolicy).toEqual(OR_POLICY);
    // The (level, scope) tuple is retained as a label/index hint alongside it.
    expect(normalized!.level).toBe("team");
  });

  it("coerces a stored SCALAR visibility to the one-element array form", () => {
    const record = {
      id: "@pkg/s",
      slug: "s",
      name: "S",
      description: "d",
      content: "c",
      packageId: "@pkg",
      packageName: "pkg",
      packageSlug: "pkg",
      level: "organization",
      scope: "org",
      // Pre-multi-scope scalar policy — the schema coerces to ["owner"].
      accessPolicy: {
        runListVisibility: "owner",
        runDataVisibility: "owner",
        runExecuteVisibility: "owner",
        allowRunSharing: false,
      },
    };
    const normalized = normalizeStoredSkill(record);
    expect(normalized!.accessPolicy?.runListVisibility).toEqual(["owner"]);
  });

  it("drops a genuinely malformed accessPolicy blob (fail closed to tuple fallback)", () => {
    const record = {
      id: "@pkg/s",
      slug: "s",
      name: "S",
      description: "d",
      content: "c",
      packageId: "@pkg",
      packageName: "pkg",
      packageSlug: "pkg",
      level: "team",
      scope: "t",
      accessPolicy: { garbage: true },
    };
    const normalized = normalizeStoredSkill(record);
    expect(normalized!.accessPolicy).toBeUndefined();
  });

  it("preserves a package-level accessPolicy + installedByUserId", () => {
    const record = {
      id: "pkg-row-id",
      packageId: "@pkg",
      slug: "pkg",
      name: "pkg",
      description: "d",
      accessPolicy: OR_POLICY,
      installedByUserId: "user-9",
    };
    const normalized = normalizeStoredSkillPackage(record);
    expect(normalized).not.toBeNull();
    expect(normalized!.accessPolicy).toEqual(OR_POLICY);
    expect(normalized!.installedByUserId).toBe("user-9");
  });

  it("leaves accessPolicy undefined when the stored row has none", () => {
    const record = {
      id: "@pkg/s",
      slug: "s",
      name: "S",
      description: "d",
      content: "c",
      packageId: "@pkg",
      packageName: "pkg",
      packageSlug: "pkg",
      level: "team",
      scope: "t",
    };
    expect(normalizeStoredSkill(record)!.accessPolicy).toBeUndefined();
  });
});
