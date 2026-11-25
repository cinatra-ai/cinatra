/**
 * `provenanceFromResolvedMount` — THE MAPPER FROM THE MOUNT THE REVIEW RESOLVED
 * TO THE RENDERER PROVENANCE THE AUDIT ROW CARRIES (cinatra#2926, plan section 6
 * row 25; the mapper's own unit test, which its docblock has always promised).
 *
 * WHY THIS MAPPING NEEDS A TEST OF ITS OWN. A decision writes the provenance it
 * RE-RESOLVES at submit time straight into `artifact_review_audit.renderer_kind`,
 * inside the transaction that resolves the gate. The floor gate counts the rows
 * whose kind is `floor`, so a draft that was drawn by its extension's display and
 * recorded as a floor would be counted as a review that fell through. The mapper
 * is the one place that decides which of the two a mount becomes.
 *
 * THE MARKDOWN ARM. The text rung (the host's own markdown viewer, recorded as
 * `first-party`) retired with the core content arms (cinatra#3319), so a markdown
 * draft resolves to the markdown extension's build-map display and must be
 * recorded as exactly that: `build-map`, naming the package, with no digest (a
 * digest belongs to a runtime load alone). The `first-party` kind stays in the
 * audit table's vocabulary for rows written before the retirement; nothing may
 * write it now, and this file pins that the mapper cannot.
 *
 * The end-to-end half (a real resolution of a markdown draft, its drawing through
 * the extension's display and the audit row a decision commits) is
 * `review-markdown-draft-recorded-as-rendered-2926.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

// The same replaced stores as the sibling suites of this module: nothing here
// reads a database, and none of these is the subject.
vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  readGatePinnedTargets: vi.fn(),
  readReviewGate: vi.fn(),
  readReviewGateState: vi.fn(),
  commitReviewDecision: vi.fn(),
  enforceReviewRunAccess: vi.fn(),
}));
vi.mock("@cinatra-ai/agents/lifecycle-repair-store", () => ({
  readRepairBySuccessorGateId: vi.fn(),
}));
vi.mock("@/lib/artifacts/cms-preview-capture-store", () => ({
  readPinnedPreviewCaptures: vi.fn(),
}));

import type { ResolvedRendererMount } from "@/lib/artifacts/artifact-review-preparation";
import { artifactReviewGateSchemaQueries } from "@/lib/artifacts/artifact-review-gate-schema";
import { provenanceFromResolvedMount } from "../review-gate-ports";

const MARKDOWN_PACKAGE = "@cinatra-ai/markdown-artifact";

/** The mount the review road resolves for a markdown draft today: the markdown
 *  extension's own `detail` display, from the build map. */
const MARKDOWN_MOUNT: ResolvedRendererMount = {
  kind: "build-map",
  slot: "detail",
  packageName: MARKDOWN_PACKAGE,
  generatedKey: `${MARKDOWN_PACKAGE}::detail`,
  propsApiVersion: 5,
};

/** A runtime mount only needs the one field the mapper reads: the admitted
 *  tuple's digest. The rest of the descriptor is the loader's. */
const RUNTIME_MOUNT = {
  kind: "runtime",
  slot: "detail",
  packageName: "@acme/runtime-artifact",
  descriptor: {
    digestPinnedUrl: "/runtime-renderers/by-digest/sha512-abc/client/detail.js",
    tuple: { packageName: "@acme/runtime-artifact", slot: "detail", digest: "sha512-abc" },
  },
} as unknown as ResolvedRendererMount;

describe("cinatra#2926 row 25 — provenanceFromResolvedMount, the markdown-artifact build-map mount", () => {
  it("records a markdown draft's display as build-map, naming the package, with no digest", () => {
    expect(provenanceFromResolvedMount(MARKDOWN_MOUNT)).toStrictEqual({
      kind: "build-map",
      packageName: MARKDOWN_PACKAGE,
      digest: null,
    });
  });

  it("carries only the audit columns: the generated key, the slot and the props version never reach the row", () => {
    const provenance = provenanceFromResolvedMount(MARKDOWN_MOUNT);
    expect(Object.keys(provenance).sort()).toEqual(["digest", "kind", "packageName"]);
  });

  it("is never a floor and never the retired first-party kind", () => {
    const { kind } = provenanceFromResolvedMount(MARKDOWN_MOUNT);
    expect(kind).not.toBe("floor");
    expect(kind).not.toBe("first-party");
  });

  it("is a pure function of the mount: the same mount answers the same row, and the mount is left as it was", () => {
    const before = JSON.stringify(MARKDOWN_MOUNT);
    const first = provenanceFromResolvedMount(MARKDOWN_MOUNT);
    const second = provenanceFromResolvedMount(MARKDOWN_MOUNT);
    expect(second).toStrictEqual(first);
    expect(first).not.toBe(second);
    expect(JSON.stringify(MARKDOWN_MOUNT)).toBe(before);
  });
});

describe("cinatra#2926 row 25 — the other arms, so the markdown arm is told apart from a fallback", () => {
  it("a runtime mount is recorded as runtime with the admitted tuple's digest", () => {
    expect(provenanceFromResolvedMount(RUNTIME_MOUNT)).toStrictEqual({
      kind: "runtime",
      packageName: "@acme/runtime-artifact",
      digest: "sha512-abc",
    });
  });

  it("a floor mount is recorded as a floor and keeps the package its type names", () => {
    expect(
      provenanceFromResolvedMount({
        kind: "floor",
        slot: "detail",
        packageName: MARKDOWN_PACKAGE,
        reason: "requires-rebuild",
      }),
    ).toStrictEqual({ kind: "floor", packageName: MARKDOWN_PACKAGE, digest: null });
  });

  it("a floor mount whose type names no package is recorded with a null package", () => {
    expect(
      provenanceFromResolvedMount({
        kind: "floor",
        slot: "detail",
        packageName: null,
        reason: "no-semantic-renderer",
      }),
    ).toStrictEqual({ kind: "floor", packageName: null, digest: null });
  });

  it("the same package is a build-map row when it draws and a floor row when it does not: the kind follows the mount, not the package", () => {
    const drawn = provenanceFromResolvedMount(MARKDOWN_MOUNT);
    const notBuilt = provenanceFromResolvedMount({
      kind: "floor",
      slot: "detail",
      packageName: MARKDOWN_PACKAGE,
      reason: "requires-rebuild",
    });
    expect(drawn.packageName).toBe(notBuilt.packageName);
    expect(drawn.kind).toBe("build-map");
    expect(notBuilt.kind).toBe("floor");
  });
});

describe("cinatra#2926 row 25 — every kind the mapper can write is one the audit table admits", () => {
  // `renderer_kind` carries a CHECK, and the decision core writes the mapper's
  // answer inside the gate's own transaction: a kind the CHECK refuses does not
  // degrade the row, it rolls the whole decision back.
  const bootstrap = artifactReviewGateSchemaQueries("cinatra")
    .map((q) => q.text)
    .join("\n");
  const check = /renderer_kind\s+text NOT NULL CHECK \(renderer_kind IN \(([^)]*)\)\)/.exec(bootstrap);

  it("reads the audit table's vocabulary", () => {
    expect(check).not.toBeNull();
  });

  it.each([
    ["the markdown build-map mount", MARKDOWN_MOUNT],
    ["a runtime mount", RUNTIME_MOUNT],
    [
      "a floor mount",
      { kind: "floor", slot: "detail", packageName: null, reason: "no-semantic-renderer" } as ResolvedRendererMount,
    ],
  ])("%s", (_label, mount) => {
    const { kind } = provenanceFromResolvedMount(mount);
    expect(check![1]).toContain(`'${kind}'`);
    // And never the retired reading: no arm of the mapper writes it.
    expect(kind).not.toBe("first-party");
  });
});
