import { describe, it, expect, beforeAll } from "vitest";

// ---------------------------------------------------------------------------
// The CMS content-snapshot HOST object type (cinatra#2044 S6 L-A3 live-walk
// finding). `captureCmsContentSnapshot` writes its immutable snapshot identity
// row under `@cinatra-ai/objects:cms-content-snapshot`, but nothing registered
// the type — so `artifactObjectTypeIds()` did not admit it, `readArtifactForDetail`
// answered `not-found`, and every captured snapshot floored the review gate at
// "review target unavailable — unknown-or-tombstoned" BEFORE the renderer
// dispatch ran. Two things have to hold, and they are two DIFFERENT gates:
//   * an `isArtifact` DESCRIPTOR — the serve path
//     (`resolveArtifactVersionForServe`) admits a representation only for a type
//     in `objectTypeRegistry.listArtifacts()`; a disposition alone left the
//     pinned revision unresolvable ("revision-not-member");
//   * an `artifact-safe` DISPOSITION — the library/type-admission seam.
// ---------------------------------------------------------------------------

import { objectTypeRegistry } from "@cinatra-ai/objects";
import { CMS_SNAPSHOT_OBJECT_TYPE } from "@/lib/artifacts/cms-content-snapshot-capture";

beforeAll(async () => {
  const { registerAllObjectTypes } = await import("@/lib/register-all-object-types");
  registerAllObjectTypes();
});

describe("@cinatra-ai/objects:cms-content-snapshot is a registered host artifact type", () => {
  it("the capture writer's constant is the registered id (no drift)", () => {
    expect(CMS_SNAPSHOT_OBJECT_TYPE).toBe("@cinatra-ai/objects:cms-content-snapshot");
    expect(objectTypeRegistry.resolve(CMS_SNAPSHOT_OBJECT_TYPE)).toBeTruthy();
  });

  it("carries an isArtifact descriptor — the SERVE-path gate", () => {
    const listed = objectTypeRegistry.listArtifacts().map((d) => d.type);
    expect(listed).toContain(CMS_SNAPSHOT_OBJECT_TYPE);
  });

  it("declares the CMS-fields representation form the capture actually writes", () => {
    const def = objectTypeRegistry.resolve(CMS_SNAPSHOT_OBJECT_TYPE);
    expect(def?.isArtifact?.accepts?.file?.mimeTypes).toEqual([
      "application/vnd.cinatra.cms-fields+json",
    ]);
  });

  it("is artifact-safe by disposition — the library/type-admission gate", () => {
    const def = objectTypeRegistry.resolve(CMS_SNAPSHOT_OBJECT_TYPE);
    expect(def?.dispositions?.projection).toBe("artifact-safe");
  });

  it("is IMMUTABLE — a captured snapshot the decision binds to is never mutated", () => {
    const def = objectTypeRegistry.resolve(CMS_SNAPSHOT_OBJECT_TYPE);
    expect(def?.lifecycle.mutableBy).toEqual([]);
    expect(def?.dispositions?.mutability).toBe("record");
  });

  it("ships NO semantic renderer — presentation resolves through the org-scoped representation provider", () => {
    const def = objectTypeRegistry.resolve(CMS_SNAPSHOT_OBJECT_TYPE);
    expect(def?.renderers.detail).toBeNull();
    expect(def?.isArtifact?.ui).toBeUndefined();
  });
});
