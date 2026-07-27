/**
 * cinatra#2044 S6 (L-D) — the PURE region composition that produces the
 * proposal's picture.
 *
 * The properties that matter:
 *   ADAPTER ANCHORS ONLY — a value is placed only where the ADAPTER marked a
 *     region; nothing is matched by tag, class or position (#2044 forbids
 *     reviewer-side CSS guessing).
 *   HONEST GAPS — a proposed field with no marked region, and a region whose
 *     element cannot be delimited, are REPORTED rather than silently dropped.
 *   NOTHING EXECUTABLE — a proposed value carrying a script/handler is sanitized
 *     on its way in, so composition can never introduce a live construct.
 */
import { describe, expect, it } from "vitest";

import {
  composeProposedRegions,
  findRegionAnchors,
} from "@/lib/artifacts/cms-preview-region-composition";
import { findInertnessViolations } from "@/lib/artifacts/cms-preview-inertness";

const PAGE = [
  "<html><body><header>Site chrome</header>",
  '<h1><span class="cinatra-region" data-cinatra-region="title" data-cinatra-post="42">Old title</span></h1>',
  '<div class="cinatra-region" data-cinatra-region="content" data-cinatra-post="42"><p>Old body</p><div>nested</div></div>',
  '<div class="cinatra-region" data-cinatra-region="excerpt" data-cinatra-post="42">Old excerpt</div>',
  "<footer>Site footer</footer></body></html>",
].join("");

describe("cinatra#2044 L-D — proposal composition over adapter region anchors", () => {
  it("places each proposed value into the adapter region of the SAME name, leaving the chrome untouched", () => {
    const out = composeProposedRegions(PAGE, {
      title: "New title",
      content: "<p>New body</p>",
      excerpt: "New excerpt",
    });

    expect(out.substitutedRegions).toEqual(["title", "content", "excerpt"]);
    expect(out.unplacedFields).toEqual([]);
    expect(out.noMatchingAnchors).toBe(false);
    // The proposed values are in.
    expect(out.html).toContain("New title");
    expect(out.html).toContain("<p>New body</p>");
    expect(out.html).toContain("New excerpt");
    // The base values are gone — including the nested subtree inside `content`,
    // which proves the closing tag was matched by DEPTH, not by the first `</div>`.
    expect(out.html).not.toContain("Old title");
    expect(out.html).not.toContain("Old body");
    expect(out.html).not.toContain("nested");
    expect(out.html).not.toContain("Old excerpt");
    // The site's own theme chrome is preserved verbatim — that is the point.
    expect(out.html).toContain("<header>Site chrome</header>");
    expect(out.html).toContain("<footer>Site footer</footer>");
    // The anchors themselves survive, so the renderer can still read geometry.
    expect(out.html).toContain('data-cinatra-region="title"');
    expect(out.html).toContain('data-cinatra-region="content"');
  });

  it("a proposed field the adapter marked NO region for is reported, never guessed into place", () => {
    const out = composeProposedRegions(PAGE, { title: "New title", status: "publish" });
    expect(out.substitutedRegions).toEqual(["title"]);
    // `status` has no owned region on the page — it is stated, not placed.
    expect(out.unplacedFields).toEqual(["status"]);
    expect(out.html).not.toContain("publish");
  });

  it("a region whose element cannot be delimited is REPORTED and left untouched", () => {
    const truncated =
      '<html><body><div data-cinatra-region="content" data-cinatra-post="7"><p>Old body</p></body></html>';
    const out = composeProposedRegions(truncated, { content: "New body" });
    expect(out.substitutedRegions).toEqual([]);
    expect(out.unplacedFields).toEqual(["content"]);
    // The page DID mark the region — it just could not be delimited. The caller
    // needs that distinction to name the right degrade reason.
    expect(out.noMatchingAnchors).toBe(false);
    expect(out.html).toBe(truncated);
  });

  it("marks nothing when the page carries no adapter anchors at all", () => {
    const bare = "<html><body><h1>Old title</h1></body></html>";
    const out = composeProposedRegions(bare, { title: "New title" });
    expect(out.substitutedRegions).toEqual([]);
    expect(out.unplacedFields).toEqual(["title"]);
    expect(out.noMatchingAnchors).toBe(true);
    expect(out.html).toBe(bare);
  });

  it("SANITIZES the proposed value on its way in — composition can never introduce a live construct", () => {
    const out = composeProposedRegions(PAGE, {
      content: '<p onclick="steal()">hi</p><script>alert(1)</script><iframe src="//evil"></iframe>',
    });
    expect(out.substitutedRegions).toEqual(["content"]);
    expect(out.html).not.toContain("<script");
    expect(out.html).not.toContain("<iframe");
    expect(out.html).not.toContain("onclick");
    // And the composed document passes the pipeline's own inertness contract.
    expect(findInertnessViolations(out.html)).toEqual([]);
    // What the sanitizer took out of the VALUE is reported, so the picture's
    // caption can say it (a codex convergence finding).
    expect(out.removedFromValues.scripts).toBeGreaterThan(0);
    expect(out.removedFromValues.frames).toBeGreaterThan(0);
    expect(out.removedFromValues.eventHandlers).toBeGreaterThan(0);
  });

  it("a nested marked region never produces overlapping edits (the outer value wins)", () => {
    const nested =
      '<div data-cinatra-region="content"><span data-cinatra-region="title">t</span>body</div>';
    expect(findRegionAnchors(nested).map((a) => a.region)).toEqual(["content", "title"]);
    const out = composeProposedRegions(nested, { content: "NEW BODY", title: "NEW TITLE" });
    expect(out.html).toBe('<div data-cinatra-region="content">NEW BODY</div>');
    expect(out.substitutedRegions).toEqual(["content"]);
    // The nested field's own value never reached the picture — REPORTED, never
    // silently dropped (a codex convergence finding).
    expect(out.unplacedFields).toEqual(["title"]);
  });

  it("an empty proposed value clears the region rather than leaving the base content behind", () => {
    const out = composeProposedRegions(PAGE, { excerpt: "" });
    expect(out.substitutedRegions).toEqual(["excerpt"]);
    expect(out.html).not.toContain("Old excerpt");
    expect(out.html).toContain("Old title");
  });

  // -------------------------------------------------------------------------
  // Structural traps a raw-substring scanner falls into (all codex convergence
  // findings). Each one previously produced a WRONG picture that still reported
  // a successful substitution.
  // -------------------------------------------------------------------------

  it("never matches the marker as a SUFFIX of a longer attribute name", () => {
    const decoy = '<div x-data-cinatra-region="content">BASE</div>';
    const out = composeProposedRegions(decoy, { content: "PROPOSED" });
    expect(out.substitutedRegions).toEqual([]);
    expect(out.unplacedFields).toEqual(["content"]);
    expect(out.html).toBe(decoy);
  });

  it("never treats close-tag text inside a COMMENT as structure", () => {
    const tricky =
      '<div data-cinatra-region="content">OLD<!-- </div> -->TAIL</div><p>AFTER</p>';
    const out = composeProposedRegions(tricky, { content: "NEW" });
    expect(out.substitutedRegions).toEqual(["content"]);
    expect(out.html).toBe('<div data-cinatra-region="content">NEW</div><p>AFTER</p>');
  });

  it("never treats a '>' inside a QUOTED attribute as the end of the opening tag", () => {
    const tricky = '<div data-cinatra-region="content" title=">">OLD</div><p>AFTER</p>';
    const out = composeProposedRegions(tricky, { content: "NEW" });
    expect(out.substitutedRegions).toEqual(["content"]);
    expect(out.html).toBe(
      '<div data-cinatra-region="content" title=">">NEW</div><p>AFTER</p>',
    );
  });

  it("never treats markup inside a <style> body as structure", () => {
    const tricky =
      '<div data-cinatra-region="content"><style>i::after{content:"</div>"}</style>OLD</div><p>AFTER</p>';
    const out = composeProposedRegions(tricky, { content: "NEW" });
    expect(out.substitutedRegions).toEqual(["content"]);
    expect(out.html).toBe('<div data-cinatra-region="content">NEW</div><p>AFTER</p>');
  });
});
