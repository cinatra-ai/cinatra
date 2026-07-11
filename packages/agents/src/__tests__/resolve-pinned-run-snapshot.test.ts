import { describe, it, expect, vi } from "vitest";
import {
  resolvePinnedRunSnapshot,
  PinnedRunSnapshotUnreachableError,
  type PinnedVersionRow,
  type ResolvePinnedRunSnapshotDeps,
} from "../execution";

// cinatra#1040 S7 — fail-closed pinned-run snapshot resolution (DI-unit; no DB).
// Proves refuse-with-evidence END-TO-END at the worker's snapshot-selection seam:
// a REQUIRED pin (versionId + packageVersion both set) is served ONLY its exact,
// bound, structured snapshot — otherwise the run is refused, NEVER served the
// live template; every non-required run keeps the pre-S7 best-effort behavior.

const TEMPLATE = "tmpl-a";
const SEMVER = "1.2.3";
const SNAP_ID = "snap-123";

function validSnapshotRow(over: Partial<PinnedVersionRow> = {}): PinnedVersionRow {
  return {
    templateId: TEMPLATE,
    semver: SEMVER,
    snapshot: { compiledPlan: [{ step: 1 }], taskSpec: "do the thing" },
    ...over,
  };
}

function deps(over: Partial<ResolvePinnedRunSnapshotDeps> = {}): ResolvePinnedRunSnapshotDeps {
  return {
    readAgentTemplateVersionById: vi.fn(async () => null),
    readAgentTemplateVersionBySemver: vi.fn(async () => null),
    ...over,
  };
}

describe("resolvePinnedRunSnapshot — REQUIRED pin (versionId + packageVersion)", () => {
  it("serves the exact bound snapshot's execution fields", async () => {
    const byId = vi.fn(async () => validSnapshotRow());
    const bySemver = vi.fn(async () => validSnapshotRow());
    const out = await resolvePinnedRunSnapshot(
      { templateId: TEMPLATE, packageVersion: SEMVER, versionId: SNAP_ID },
      deps({ readAgentTemplateVersionById: byId, readAgentTemplateVersionBySemver: bySemver }),
    );
    expect(out).toEqual({ compiledPlan: [{ step: 1 }], taskSpec: "do the thing" });
    // Loads by id ONLY — never the semver best-effort path.
    expect(byId).toHaveBeenCalledWith(SNAP_ID);
    expect(bySemver).not.toHaveBeenCalled();
  });

  it("normalizes a valid snapshot's absent taskSpec to null (full overlay)", async () => {
    const out = await resolvePinnedRunSnapshot(
      { templateId: TEMPLATE, packageVersion: SEMVER, versionId: SNAP_ID },
      deps({
        readAgentTemplateVersionById: vi.fn(async () =>
          validSnapshotRow({ snapshot: { compiledPlan: [] } }),
        ),
      }),
    );
    expect(out).toEqual({ compiledPlan: [], taskSpec: null });
  });

  it("REFUSES (fail-closed) when the pinned snapshot was purged mid-flight", async () => {
    const err = await resolvePinnedRunSnapshot(
      { templateId: TEMPLATE, packageVersion: SEMVER, versionId: SNAP_ID },
      deps({ readAgentTemplateVersionById: vi.fn(async () => null) }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(PinnedRunSnapshotUnreachableError);
    expect(err.code).toBe("PINNED_RUN_SNAPSHOT_UNREACHABLE");
    expect(err.templateId).toBe(TEMPLATE);
    expect(err.packageVersion).toBe(SEMVER);
    expect(err.versionId).toBe(SNAP_ID);
    expect(err.reason).toContain("purged");
    expect(err.message).toContain("Refusing rather than");
  });

  it("REFUSES when loading/deserializing the snapshot throws (corrupt row)", async () => {
    const err = await resolvePinnedRunSnapshot(
      { templateId: TEMPLATE, packageVersion: SEMVER, versionId: SNAP_ID },
      deps({
        readAgentTemplateVersionById: vi.fn(async () => {
          throw new SyntaxError("Unexpected token in JSON");
        }),
      }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(PinnedRunSnapshotUnreachableError);
    expect(err.reason).toContain("load/deserialize failed");
    expect(err.reason).toContain("Unexpected token");
  });

  it("REFUSES a mis-bound snapshot (wrong templateId) rather than serving a different plan", async () => {
    const err = await resolvePinnedRunSnapshot(
      { templateId: TEMPLATE, packageVersion: SEMVER, versionId: SNAP_ID },
      deps({
        readAgentTemplateVersionById: vi.fn(async () =>
          validSnapshotRow({ templateId: "tmpl-OTHER" }),
        ),
      }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(PinnedRunSnapshotUnreachableError);
    expect(err.reason).toContain("binds to tmpl-OTHER");
  });

  it("REFUSES a mis-bound snapshot (wrong semver)", async () => {
    const err = await resolvePinnedRunSnapshot(
      { templateId: TEMPLATE, packageVersion: SEMVER, versionId: SNAP_ID },
      deps({
        readAgentTemplateVersionById: vi.fn(async () => validSnapshotRow({ semver: "9.9.9" })),
      }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(PinnedRunSnapshotUnreachableError);
    expect(err.reason).toContain("@9.9.9");
  });

  it("REFUSES a structurally unusable snapshot (scalar payload)", async () => {
    const err = await resolvePinnedRunSnapshot(
      { templateId: TEMPLATE, packageVersion: SEMVER, versionId: SNAP_ID },
      deps({
        readAgentTemplateVersionById: vi.fn(async () =>
          validSnapshotRow({ snapshot: "not-an-object" }),
        ),
      }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(PinnedRunSnapshotUnreachableError);
    expect(err.reason).toContain("structurally unusable");
  });

  it("REFUSES a structurally incomplete snapshot (object missing compiledPlan)", async () => {
    const err = await resolvePinnedRunSnapshot(
      { templateId: TEMPLATE, packageVersion: SEMVER, versionId: SNAP_ID },
      deps({
        readAgentTemplateVersionById: vi.fn(async () =>
          validSnapshotRow({ snapshot: { taskSpec: "orphaned" } }),
        ),
      }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(PinnedRunSnapshotUnreachableError);
    expect(err.reason).toContain("missing compiledPlan");
  });

  it("REFUSES a snapshot whose compiledPlan is present-but-undefined (closes the overlay fail-open)", async () => {
    // The worker overlays a field only when `!== undefined`; a snapshot with an
    // undefined compiledPlan would leave the LIVE plan in place — the exact
    // fail-open a required pin must refuse.
    const err = await resolvePinnedRunSnapshot(
      { templateId: TEMPLATE, packageVersion: SEMVER, versionId: SNAP_ID },
      deps({
        readAgentTemplateVersionById: vi.fn(async () =>
          validSnapshotRow({ snapshot: { compiledPlan: undefined, taskSpec: "x" } }),
        ),
      }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(PinnedRunSnapshotUnreachableError);
    expect(err.reason).toContain("missing compiledPlan");
  });

  it("serves a valid snapshot with an empty-array compiledPlan (leaf template — not over-strict)", async () => {
    const out = await resolvePinnedRunSnapshot(
      { templateId: TEMPLATE, packageVersion: SEMVER, versionId: SNAP_ID },
      deps({
        readAgentTemplateVersionById: vi.fn(async () =>
          validSnapshotRow({ snapshot: { compiledPlan: [], taskSpec: "leaf work" } }),
        ),
      }),
    );
    expect(out).toEqual({ compiledPlan: [], taskSpec: "leaf work" });
  });
});

describe("resolvePinnedRunSnapshot — NON-required runs keep pre-S7 behavior", () => {
  it("default resolution (packageVersion only) serves the best-effort semver snapshot", async () => {
    const byId = vi.fn(async () => null);
    const out = await resolvePinnedRunSnapshot(
      { templateId: TEMPLATE, packageVersion: SEMVER, versionId: null },
      deps({
        readAgentTemplateVersionById: byId,
        readAgentTemplateVersionBySemver: vi.fn(async () => validSnapshotRow()),
      }),
    );
    expect(out).toEqual({ compiledPlan: [{ step: 1 }], taskSpec: "do the thing" });
    expect(byId).not.toHaveBeenCalled(); // never the fail-closed path
  });

  it("default resolution with NO snapshot falls back to live template (null, not a throw)", async () => {
    const out = await resolvePinnedRunSnapshot(
      { templateId: TEMPLATE, packageVersion: SEMVER, versionId: null },
      deps({ readAgentTemplateVersionBySemver: vi.fn(async () => null) }),
    );
    expect(out).toBeNull();
  });

  it("default resolution with an unstructured snapshot falls back to live (null)", async () => {
    const out = await resolvePinnedRunSnapshot(
      { templateId: TEMPLATE, packageVersion: SEMVER, versionId: null },
      deps({
        readAgentTemplateVersionBySemver: vi.fn(async () => validSnapshotRow({ snapshot: 42 })),
      }),
    );
    expect(out).toBeNull();
  });

  it("versionId-ONLY (inert pending-input / registry pin) is NOT strict — reads nothing, serves live", async () => {
    const byId = vi.fn(async () => validSnapshotRow());
    const bySemver = vi.fn(async () => validSnapshotRow());
    const out = await resolvePinnedRunSnapshot(
      { templateId: TEMPLATE, packageVersion: null, versionId: SNAP_ID },
      deps({ readAgentTemplateVersionById: byId, readAgentTemplateVersionBySemver: bySemver }),
    );
    expect(out).toBeNull();
    // No fail-closed treatment for a versionId-only pin — it stays inert exactly
    // as before S7 (no regression to pending-input / runFromRegistry / dispatch).
    expect(byId).not.toHaveBeenCalled();
    expect(bySemver).not.toHaveBeenCalled();
  });

  it("neither marker set → live template (null)", async () => {
    const out = await resolvePinnedRunSnapshot(
      { templateId: TEMPLATE, packageVersion: null, versionId: null },
      deps(),
    );
    expect(out).toBeNull();
  });
});
