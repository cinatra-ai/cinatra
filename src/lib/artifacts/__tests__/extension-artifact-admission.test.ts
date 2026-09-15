/**
 * The admission a flow's artifact reads are bounded by (cinatra#3031, epic
 * #3023 W7; plan (C) enabler 0.26 and the epic's #2817 ruling).
 *
 * "only for types the calling extension declares as artifact dependencies — an
 * admission bound to the declaration and the version, the shape the delegated
 * chat's perimeter already has". The epic's ruling: "#2817 (landed) made the
 * delegated chat's tool perimeter declaration- and version-bound; W7's artifact
 * reads on the run's road take the same shape."
 *
 * So: by name, never by wildcard; nothing admitted without a declaration; and
 * the digest carries WHICH declaration, at WHICH version, allowed the read.
 */
import { describe, expect, it } from "vitest";

import {
  admitsArtifactType,
  admittedArtifactTypes,
  artifactTypeOwnerPackage,
  resolveArtifactDependencyAdmission,
} from "@/lib/artifacts/extension-artifact-admission";

const CALLER = "@cinatra-ai/blog-pipeline-agent";

const manifest = (deps: unknown) => ({ dependencies: deps }) as Record<string, unknown>;

const ADMISSION = resolveArtifactDependencyAdmission({
  packageName: CALLER,
  packageVersion: "1.4.0",
  cinatra: manifest([
    {
      packageName: "@cinatra-ai/blog-idea-artifact",
      kind: "artifact",
      edgeType: "runtime",
      versionConstraint: { kind: "semver-range", range: "^1.0.0" },
      requirement: "required",
    },
    {
      packageName: "@cinatra-ai/email-connector",
      kind: "connector",
      edgeType: "runtime",
      versionConstraint: { kind: "semver-range", range: "^2.0.0" },
      requirement: "required",
    },
  ]),
});

describe("who owns a type", () => {
  it("reads the owner package off the type id", () => {
    expect(artifactTypeOwnerPackage("@cinatra-ai/blog-idea-artifact:idea")).toBe(
      "@cinatra-ai/blog-idea-artifact",
    );
  });
  it("refuses to guess at anything that is not a `@vendor/package:type` id", () => {
    for (const bad of ["idea", "@scope:type", "", "no-colon", "@a/b/c:type"]) {
      expect(artifactTypeOwnerPackage(bad)).toBeNull();
    }
  });
});

describe("what the declaration admits", () => {
  it("admits the artifact packages the caller declares, and only those", () => {
    expect(ADMISSION.admittedPackages).toEqual(["@cinatra-ai/blog-idea-artifact"]);
    expect(admitsArtifactType(ADMISSION, "@cinatra-ai/blog-idea-artifact:idea")).toBe(true);
  });

  it("does NOT admit a connector dependency's namespace", () => {
    expect(admitsArtifactType(ADMISSION, "@cinatra-ai/email-connector:message")).toBe(false);
  });

  it("does NOT admit an UNDECLARED artifact type", () => {
    expect(admitsArtifactType(ADMISSION, "@cinatra-ai/blog-post-artifact:post")).toBe(false);
  });

  it("admits nothing at all when the caller declares nothing", () => {
    const none = resolveArtifactDependencyAdmission({
      packageName: CALLER,
      packageVersion: "1.4.0",
      cinatra: {},
    });
    expect(none.admittedPackages).toEqual([]);
    expect(admitsArtifactType(none, "@cinatra-ai/blog-idea-artifact:idea")).toBe(false);
  });

  it("never admits a wildcard, however it is spelled", () => {
    const wild = resolveArtifactDependencyAdmission({
      packageName: CALLER,
      packageVersion: "1.4.0",
      cinatra: manifest([
        { packageName: "*", kind: "artifact", edgeType: "runtime", requirement: "required" },
        { packageName: "@cinatra-ai/*", kind: "artifact", edgeType: "runtime", requirement: "required" },
      ]),
    });
    expect(wild.admittedPackages).toEqual(["@cinatra-ai/*"]);
    expect(admitsArtifactType(wild, "@cinatra-ai/blog-idea-artifact:idea")).toBe(false);
  });

  it("filters a candidate type set down to the admitted ones", () => {
    expect(
      admittedArtifactTypes(ADMISSION, [
        "@cinatra-ai/blog-idea-artifact:idea",
        "@cinatra-ai/blog-post-artifact:post",
        "cinatra:file",
      ]),
    ).toEqual(["@cinatra-ai/blog-idea-artifact:idea"]);
  });
});

describe("the admission is bound to the declaration AND the version", () => {
  it("a different pinned version is a different admission record", () => {
    const other = resolveArtifactDependencyAdmission({
      packageName: CALLER,
      packageVersion: "1.5.0",
      cinatra: manifest([
        {
          packageName: "@cinatra-ai/blog-idea-artifact",
          kind: "artifact",
          edgeType: "runtime",
          versionConstraint: { kind: "semver-range", range: "^1.0.0" },
          requirement: "required",
        },
      ]),
    });
    expect(other.declarationDigest).not.toBe(ADMISSION.declarationDigest);
  });

  it("a widened version constraint is a different admission record", () => {
    const widened = resolveArtifactDependencyAdmission({
      packageName: CALLER,
      packageVersion: "1.4.0",
      cinatra: manifest([
        {
          packageName: "@cinatra-ai/blog-idea-artifact",
          kind: "artifact",
          edgeType: "runtime",
          versionConstraint: { kind: "semver-range", range: "*" },
          requirement: "required",
        },
      ]),
    });
    expect(widened.declarationDigest).not.toBe(ADMISSION.declarationDigest);
  });

  it("is stable for the same declaration, whatever order the edges are written in", () => {
    const reordered = resolveArtifactDependencyAdmission({
      packageName: CALLER,
      packageVersion: "1.4.0",
      cinatra: manifest([
        {
          packageName: "@cinatra-ai/email-connector",
          kind: "connector",
          edgeType: "runtime",
          versionConstraint: { kind: "semver-range", range: "^2.0.0" },
          requirement: "required",
        },
        {
          packageName: "@cinatra-ai/blog-idea-artifact",
          kind: "artifact",
          edgeType: "runtime",
          versionConstraint: { kind: "semver-range", range: "^1.0.0" },
          requirement: "required",
        },
      ]),
    });
    expect(reordered.declarationDigest).toBe(ADMISSION.declarationDigest);
  });
});
