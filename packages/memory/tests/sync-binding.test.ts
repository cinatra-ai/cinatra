/**
 * The bundle sync binding (cinatra#1378).
 *
 * `bundle.yaml` decides where a sync run writes, so it is parsed STRICTLY —
 * unlike concept frontmatter, which OKF says to consume tolerantly. The tests
 * that matter here are the refusals: a bundle file is untrusted input, and a
 * forged key that is silently ignored lets an author believe a sync landed
 * somewhere it did not.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { initMemoryBundle, loadMemoryBundleConfig } from "../src/bundle.ts";
import {
  memoryVisibilityRank,
  parseMemorySyncBinding,
  resolveMemoryConceptScopeRequest,
} from "../src/sync-binding.ts";
import { MemorySyncError, type MemoryConcept } from "../src/types.ts";

const roots: string[] = [];

function tempBundle(configYaml?: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "memory-sync-binding-"));
  roots.push(root);
  initMemoryBundle(root, { name: "test" });
  if (configYaml !== undefined) {
    writeFileSync(path.join(root, "bundle.yaml"), configYaml, "utf8");
  }
  return root;
}

function concept(frontmatter: Record<string, unknown>): MemoryConcept {
  return {
    id: "c",
    path: "c.md",
    type: "convention",
    tags: [],
    frontmatter: { type: "convention", ...frontmatter },
    body: "",
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("parseMemorySyncBinding", () => {
  it("returns undefined when the bundle declares no sync block", () => {
    expect(parseMemorySyncBinding({ bundleId: "b" })).toBeUndefined();
    expect(parseMemorySyncBinding({ bundleId: "b", sync: null })).toBeUndefined();
  });

  it("reads the project binding and the default scope", () => {
    const binding = parseMemorySyncBinding({
      sync: {
        projectId: "proj-1",
        ownerLevel: "team",
        ownerId: "team-7",
        visibility: "team",
      },
    });
    expect(binding).toEqual({
      projectId: "proj-1",
      defaultScope: { ownerLevel: "team", ownerId: "team-7", visibility: "team" },
    });
  });

  it("refuses an orgId in the bundle — the organization is actor-derived", () => {
    // The refusal is the point. A silently-dropped orgId would let a bundle
    // author believe rows landed in an organization they named.
    expect(() => parseMemorySyncBinding({ sync: { orgId: "org-victim" } })).toThrow(
      MemorySyncError,
    );
    expect(() => parseMemorySyncBinding({ sync: { organizationId: "org-victim" } })).toThrow(
      /derived from the authenticated caller/,
    );
  });

  it("refuses a forged externalId — the server recomputes row identity", () => {
    expect(() =>
      parseMemorySyncBinding({ sync: { externalId: "a".repeat(64) } }),
    ).toThrow(/recomputed by the server/);
  });

  it("refuses an unknown key rather than ignoring it", () => {
    expect(() => parseMemorySyncBinding({ sync: { ownerLevle: "user" } })).toThrow(
      /unknown key sync.ownerLevle/,
    );
  });

  it("refuses a value outside the enum", () => {
    expect(() => parseMemorySyncBinding({ sync: { ownerLevel: "platform" } })).toThrow(
      /sync.ownerLevel must be one of/,
    );
    expect(() => parseMemorySyncBinding({ sync: { visibility: "world" } })).toThrow(
      /sync.visibility must be one of/,
    );
  });

  it("refuses a non-mapping sync block", () => {
    expect(() => parseMemorySyncBinding({ sync: ["user"] })).toThrow(
      /sync must be a YAML mapping/,
    );
  });
});

describe("loadMemoryBundleConfig — the sync block round-trips off disk", () => {
  it("carries a declared binding onto the config", () => {
    const root = tempBundle(
      ["bundleId: 11111111-2222-4333-8444-555555555555", "sync:", "  projectId: proj-9", "  visibility: organization", ""].join("\n"),
    );
    const config = loadMemoryBundleConfig(root);
    expect(config.sync).toEqual({
      projectId: "proj-9",
      defaultScope: { visibility: "organization" },
    });
  });

  it("fails the whole load on a forged sync block", () => {
    const root = tempBundle(
      ["bundleId: 11111111-2222-4333-8444-555555555555", "sync:", "  orgId: org-victim", ""].join("\n"),
    );
    expect(() => loadMemoryBundleConfig(root)).toThrow(MemorySyncError);
  });
});

describe("resolveMemoryConceptScopeRequest — bundle default < frontmatter", () => {
  it("uses the bundle default when the concept asks for nothing", () => {
    const binding = parseMemorySyncBinding({
      sync: { ownerLevel: "user", visibility: "private" },
    });
    expect(resolveMemoryConceptScopeRequest(binding, concept({}))).toEqual({
      ownerLevel: "user",
      visibility: "private",
    });
  });

  it("lets a concept request a different scope than the bundle default", () => {
    const binding = parseMemorySyncBinding({
      sync: { ownerLevel: "user", visibility: "private" },
    });
    expect(
      resolveMemoryConceptScopeRequest(
        binding,
        concept({ ownerLevel: "organization", visibility: "organization" }),
      ),
    ).toEqual({ ownerLevel: "organization", visibility: "organization" });
  });

  it("ignores an unusable frontmatter value instead of failing the run", () => {
    // Frontmatter is CONCEPT content and is consumed tolerantly. The value is
    // dropped, not obeyed, and the bundle default stands.
    const binding = parseMemorySyncBinding({ sync: { visibility: "private" } });
    expect(
      resolveMemoryConceptScopeRequest(binding, concept({ visibility: "world" })),
    ).toEqual({ visibility: "private" });
  });

  it("never lets frontmatter name an organization", () => {
    const resolved = resolveMemoryConceptScopeRequest(
      undefined,
      concept({ orgId: "org-victim", organizationId: "org-victim" }),
    );
    expect(resolved).not.toHaveProperty("orgId");
    expect(resolved).not.toHaveProperty("organizationId");
    expect(Object.keys(resolved)).toEqual([]);
  });
});

describe("memoryVisibilityRank", () => {
  it("orders the ladder and ranks an unknown value below every real one", () => {
    expect(memoryVisibilityRank("private")).toBeLessThan(memoryVisibilityRank("team"));
    expect(memoryVisibilityRank("team")).toBeLessThan(memoryVisibilityRank("organization"));
    expect(memoryVisibilityRank("organization")).toBeLessThan(memoryVisibilityRank("public"));
    expect(memoryVisibilityRank(undefined)).toBeLessThan(memoryVisibilityRank("private"));
  });
});
