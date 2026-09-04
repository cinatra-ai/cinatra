/**
 * THE REVIEW TARGET'S DISPLAY GETS ITS CONTENT (cinatra#3080, PR #3100, fix leg 7).
 *
 * THE DEFECT THE EIGHTH PROOF ROUND MEASURED. A run produced a post — a real
 * `text/markdown` revision, pinned by the gate — and the settled gate's display
 * drew "No markdown is available to show for the revision being viewed." That
 * sentence is the markdown display's `content-absent` floor, and it was TRUE of
 * the props it was handed: the review target's props builder passed
 * `absentArtifactContent(...)` unconditionally, so the versioned server content
 * channel (enabler 0.3) was never called for a review target at all. Every
 * markdown target on every review surface therefore floored, whatever was in it.
 *
 * §V of the ratified review drawing is what that violates: "The floor is never a
 * blank. Whenever a target does not resolve to a type renderer, it renders the
 * floor — a sanitized, telemetry-safe one-line diagnostic". A target that DOES
 * resolve draws its content; the floor is for the target that does not, and a
 * floor drawn over a readable revision tells the reviewer something false about
 * the work they are deciding on.
 *
 * These pin the wiring at the seam: the projection the review target builds for
 * one pinned revision, over an injected substance read.
 */
import { describe, expect, it } from "vitest";

import { buildReviewTargetContentProjection } from "../review-target-content";

const ARGS = {
  orgId: "org_1",
  artifactId: "art_1",
  representationRevisionId: "rev_4c21aa",
};

describe("the review target's content projection", () => {
  it("carries the TEXT of a readable text/markdown revision", async () => {
    const projection = await buildReviewTargetContentProjection(
      { ...ARGS, mime: "text/markdown", member: { mime: "text/markdown", form: "file" } },
      {
        readPinnedSubstance: (input) => {
          expect(input.contentClass).toBe("text");
          expect(input.representationRevisionId).toBe("rev_4c21aa");
          return { class: "text", text: "# Why migrations are the hardest part\n" };
        },
      },
    );
    expect(projection.kind).toBe("text");
    expect(projection).toMatchObject({
      representationRevisionId: "rev_4c21aa",
      text: "# Why migrations are the hardest part\n",
    });
  });

  it("carries a dashboard's pinned CONFIGURATION from the member itself", async () => {
    const projection = await buildReviewTargetContentProjection(
      {
        ...ARGS,
        mime: "application/vnd.cinatra.dashboard+json",
        member: {
          mime: "application/vnd.cinatra.dashboard+json",
          form: "dashboard",
          configuration: { portlets: [] },
          configurationDigest: "sha256:abc",
        },
      },
      // No injected port: the default reader is the point — a dashboard's
      // configuration is on the member the gate resolved, not in the blob store.
    );
    expect(projection).toMatchObject({ kind: "configuration", digest: "sha256:abc" });
  });

  it("says ABSENT — the floor's own honest reason — when the substance cannot be read", async () => {
    const projection = await buildReviewTargetContentProjection(
      { ...ARGS, mime: "text/markdown", member: { mime: "text/markdown", form: "file" } },
      { readPinnedSubstance: () => null },
    );
    expect(projection).toMatchObject({ kind: "none", reason: "absent" });
  });

  it("says UNSUPPORTED-FORM for bytes this channel does not project, never absent", async () => {
    const projection = await buildReviewTargetContentProjection(
      { ...ARGS, mime: "image/png", member: { mime: "image/png", form: "file" } },
      {
        readPinnedSubstance: () => {
          throw new Error("a class-less revision is never read");
        },
      },
    );
    expect(projection).toMatchObject({ kind: "none", reason: "unsupported-form" });
  });
});
