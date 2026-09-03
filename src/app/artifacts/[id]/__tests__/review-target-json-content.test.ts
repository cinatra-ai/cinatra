/**
 * THE REVIEW TARGET'S JSON DOCUMENT REACHES ITS DISPLAY (cinatra#3150 item 1,
 * epic #3023 W5).
 *
 * THE DEFECT the fourth graded reading measured, in the dark theme: a review
 * gate raised over this branch's default-road output — an undeclared output the
 * detection ladder typed `application/json` — drew a BLANK SLAB where the
 * document should be. The same target's markdown display read the
 * `content-absent` floor for a revision the ledger confirms was written.
 *
 * THE DRAWING, quoted (§V, "Renderer provenance & the never-blank floor"):
 * "The floor is never a blank. Whenever a target does not resolve to a type
 * renderer, it renders the floor — a sanitized, telemetry-safe one-line
 * diagnostic (package · slot · reason, never a raw error or manifest value) —
 * so the surface never shows an empty panel where a target should be." A target
 * that DOES resolve draws its content; the floor is for the one that does not.
 *
 * THE HOST HALF, pinned here. A display can only draw what it was handed, and
 * the review target handed every display an unconditional `absent` projection —
 * so a JSON output's document never left the server, whatever the display did
 * with the nothing it got. These cases pin the projection for the artifact kind
 * the reading measured: a JSON revision's document reaches the props, at the
 * pinned revision, as text the display can draw.
 *
 * `application/json` IS a projected text form on this channel
 * (`TEXT_PROJECTION_MIMES` in `src/lib/artifacts/artifact-content-channel.ts`),
 * which is what makes this a `text` projection rather than an absence.
 *
 * Run:
 *   npx vitest run "src/app/artifacts/[id]/__tests__/review-target-json-content.test.ts"
 */
import { describe, expect, it } from "vitest";

import { artifactContentCapFor } from "@/lib/artifacts/artifact-content-channel";

import { buildReviewTargetContentProjection } from "../review-target-prepare";

const ARGS = {
  orgId: "org_1",
  artifactId: "art_json_1",
  representationRevisionId: "rev_9a71bd",
};

const DOCUMENT = '{"subject":"Login loop on SSO","priority":"high"}';

describe("a JSON review target's document", () => {
  it("reaches the display as the pinned revision's text, never an absence", async () => {
    const projection = await buildReviewTargetContentProjection(
      { ...ARGS, mime: "application/json", member: { mime: "application/json", form: "file" } },
      {
        readPinnedSubstance: (input) => {
          // The class the channel resolves for a JSON file revision — the read
          // it asks for is a TEXT read, at the revision the gate pinned.
          expect(input.contentClass).toBe("text");
          expect(input.representationRevisionId).toBe("rev_9a71bd");
          return { class: "text", text: DOCUMENT };
        },
      },
    );
    expect(projection.kind).toBe("text");
    expect(projection).toMatchObject({
      representationRevisionId: "rev_9a71bd",
      text: DOCUMENT,
      truncated: false,
    });
  });

  it("says `absent` by name when the revision's bytes cannot be read at all", async () => {
    // Named, never blank and never thrown — the display draws its own floor
    // sentence over this, which is what §V asks a target that cannot resolve for.
    const projection = await buildReviewTargetContentProjection(
      { ...ARGS, mime: "application/json", member: { mime: "application/json", form: "file" } },
      { readPinnedSubstance: () => null },
    );
    expect(projection).toMatchObject({ kind: "none", reason: "absent" });
  });

  it("says `over-cap` rather than a silent prefix that reads as the whole document", async () => {
    const cap = artifactContentCapFor("text");
    const projection = await buildReviewTargetContentProjection(
      { ...ARGS, mime: "application/json", member: { mime: "application/json", form: "file" } },
      { readPinnedSubstance: () => ({ class: "text", text: "x".repeat(cap + 64) }) },
    );
    // A text projection degrades by TRUNCATION and says so on the projection —
    // the display draws the prefix and its own "too large" reading, never a
    // prefix dressed as the whole work.
    expect(projection).toMatchObject({ kind: "text", truncated: true, byteLength: cap + 64 });
  });
});
