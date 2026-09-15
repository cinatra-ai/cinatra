// cinatra#3204 D2 — the skill router switches on DECLARED provenance, and there
// is a `local` source kind.
//
// The heuristic these tests replace read a scoped name OR the presence of a
// version as "verdaccio". Both are statements about how a package is NAMED. The
// cases below are exactly the ones where the name and the truth disagree.

import { describe, expect, it } from "vitest";

import {
  localSkillPackageId,
  resolveSkillPackageSource,
} from "../skill-package-source";

const ref = (over: Record<string, unknown> = {}) => ({
  registryUrl: "https://example.invalid",
  packageName: "owner/repo",
  ...over,
}) as Parameters<typeof resolveSkillPackageSource>[0];

const DIGEST = "a".repeat(64);

describe("declared provenance beats the name shape", () => {
  it("routes a SCOPED name declared local to the local backend (the misclassification the issue names)", () => {
    // `@acme/tools-skill` is scoped, so the name-shape guess said "verdaccio".
    // It was supplied as a file; it is local.
    const r = resolveSkillPackageSource(
      ref({
        packageName: "@acme/tools-skill",
        provenance: { type: "local", path: "snapshots/acme.tgz", contentDigest: DIGEST },
      }),
    );
    expect(r.kind).toBe("local");
    expect(r.declared).toBe(true);
    expect(r.packageId).toBe("local:@acme/tools-skill");
  });

  it("routes a VERSIONED ref declared local to the local backend", () => {
    const r = resolveSkillPackageSource(
      ref({
        packageName: "owner/repo",
        version: "1.2.3",
        provenance: { type: "local", path: "snapshots/x.tgz", contentDigest: DIGEST },
      }),
    );
    expect(r.kind).toBe("local");
    expect(r.packageId).toBe("local:owner/repo");
  });

  it("routes a VERSIONED ref declared github to the github backend", () => {
    const r = resolveSkillPackageSource(
      ref({
        packageName: "owner/repo",
        version: "1.2.3",
        provenance: {
          type: "github",
          repo: "owner/repo",
          ref: "v1.2.3",
          resolvedSha: "b".repeat(40),
          contentDigest: DIGEST,
        },
      }),
    );
    expect(r.kind).toBe("github");
    expect(r.declared).toBe(true);
    expect(r.packageId).toBe("github:owner/repo");
  });

  it("routes an UNSCOPED, unversioned ref declared verdaccio to the registry backend", () => {
    const r = resolveSkillPackageSource(
      ref({ packageName: "owner/repo", provenance: { type: "verdaccio" } }),
    );
    expect(r.kind).toBe("verdaccio");
    expect(r.declared).toBe(true);
    expect(r.packageId).toBe("verdaccio:owner/repo");
  });
});

describe("the legacy name-shape guess survives ONLY for refs that declare nothing", () => {
  it("keeps classifying a bare owner/repo as github, marked as a guess", () => {
    const r = resolveSkillPackageSource(ref({ packageName: "owner/repo" }));
    expect(r.kind).toBe("github");
    expect(r.declared).toBe(false);
  });

  it("keeps classifying a scoped name as verdaccio, marked as a guess", () => {
    const r = resolveSkillPackageSource(ref({ packageName: "@anthropics/skills" }));
    expect(r.kind).toBe("verdaccio");
    expect(r.declared).toBe(false);
  });

  it("keeps classifying a versioned ref as verdaccio, marked as a guess", () => {
    const r = resolveSkillPackageSource(ref({ packageName: "owner/repo", version: "1.0.0" }));
    expect(r.kind).toBe("verdaccio");
    expect(r.declared).toBe(false);
  });
});

describe("the local persisted-id shape", () => {
  it("is `local:<name>`, matching the other two backends' prefix convention", () => {
    expect(localSkillPackageId("@acme/tools-skill")).toBe("local:@acme/tools-skill");
    expect(localSkillPackageId("owner/repo")).toBe("local:owner/repo");
  });
});
