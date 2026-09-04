import { describe, expect, it } from "vitest";

import { hostArtifactContentBuilder } from "@/app/artifacts/[id]/review-surface-roads";

// THE FORWARD MERGE OF main INTO cinatra#3091 (lifecycle-d W3), AND THE ONE
// THING IT MUST NOT DROP.
//
// Two sides built the SAME seam at once. main bound the versioned content
// channel (enabler 0.3) straight onto the shared review preparation path, as
// VALUE imports, and its reader answers two classes and takes the bound the
// caller names. Wave 3 moved that same read off the shared path and onto the
// road a surface hands in — which is what keeps the four routes whose
// first-party module count the route-graph ratchet locks from carrying the
// channel's graph at all.
//
// Resolving that conflict by taking wave 3's SEAM is right; taking wave 3's
// narrower READER with it would have silently un-shipped main's fix, because
// that reader answers the text class alone and forces every read live. Nothing
// in either side's suites would have caught it: main's tests exercise its
// reader directly, and wave 3's exercise the road's shape. This file is that
// missing pin — the road must carry the CHANNEL'S OWN read, classes and bound
// and all.
describe("the review surface's content road carries the channel's whole read (forward of main into #3091)", () => {
  const target = {
    orgId: "org-1",
    artifactId: "art-1",
    representationRevisionId: "rev-1",
    // A dashboard's form is the `configuration` class — the arm wave 3's own
    // port answers `null` for.
    form: "dashboard" as const,
    mime: "application/json",
  };

  it("projects a dashboard's PINNED configuration record, never the named absence", async () => {
    const projection = await hostArtifactContentBuilder()({
      ...target,
      carriedConfiguration: { configuration: { widgets: [{ id: "w-1" }] }, digest: "sha256:abc" },
    });

    expect(projection.kind).toBe("configuration");
    expect(projection).toMatchObject({
      representationRevisionId: "rev-1",
      configuration: { widgets: [{ id: "w-1" }] },
      digest: "sha256:abc",
    });
  });

  it("takes the CARRIED record rather than reading the same row a second time", async () => {
    // No substrate is reachable in this test, so a projection that carries the
    // record proves the carried arm answered — a re-read would have failed to
    // an absence instead.
    const projection = await hostArtifactContentBuilder()({
      ...target,
      carriedConfiguration: { configuration: { from: "the membership answer" }, digest: "sha256:def" },
    });

    expect(projection).toMatchObject({
      kind: "configuration",
      configuration: { from: "the membership answer" },
    });
  });

  it("a carried record with NO digest is the channel's named absence, never a half-record", async () => {
    const projection = await hostArtifactContentBuilder()({
      ...target,
      carriedConfiguration: { configuration: { widgets: [] }, digest: null },
    });

    expect(projection).toMatchObject({ kind: "none", reason: "absent" });
  });

  it("the caller's BOUND is accepted on the road (a historical reading is expressible)", async () => {
    // The forward widened the road's input so the bound the membership answer
    // was made under travels with the read. A road that ignored it would force
    // every reading live and quietly re-open what enabler 0.9 closed.
    const projection = await hostArtifactContentBuilder()({
      ...target,
      liveOnly: false,
      carriedConfiguration: { configuration: { historical: true }, digest: "sha256:ghi" },
    });

    expect(projection).toMatchObject({
      kind: "configuration",
      configuration: { historical: true },
    });
  });
});
