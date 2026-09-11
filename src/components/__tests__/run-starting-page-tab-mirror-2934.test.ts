/**
 * THE RUN-STARTING PAGE'S TAB MIRRORS ITS OWN TRAIL (cinatra#2934, fix leg 11).
 *
 * The ratified drawing, twice over. The trail: "the page that starts a run reads
 * Agents run, never Run agent alone." And the tab: "The browser-tab
 * title mirrors the resolved trail under the same rules: an id-bearing route
 * never shows a raw id in the tab."
 *
 * The whole-window proof round measured the two apart on this one page: the
 * trail read "Agents > Agent run" while the tab read "Agents | Cinatra" — the
 * AREA's word, one crumb above the page the reader is on. Fix leg 10 taught the
 * trail to append the page's own title beneath the area crumb at depth one; the
 * tab never learned it, because the route exported a static "Agents" and the
 * shell's general branch derived its title from the PATH SEGMENT instead of from
 * the trail already drawn above the page.
 *
 * So the tab is bound to the trail's resolved leaf here, on both sides: the
 * route's own server title is the same word the page's header publishes, and the
 * shell's general branch mirrors the trail rather than re-deriving a word.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  AGENT_RUN_LABEL,
  buildBreadcrumbTrail,
  documentTitleLabelFromTrail,
} from "@/lib/breadcrumb-trail";

const RUN_STARTING_PAGE = "/agents";

describe("the run-starting page: trail and tab say the same word", () => {
  it("the trail reads Agents > Agent run, and its resolved leaf is Agent run", () => {
    const trail = buildBreadcrumbTrail(RUN_STARTING_PAGE, {
      pageTitle: { title: AGENT_RUN_LABEL, pathname: RUN_STARTING_PAGE },
    });
    expect(trail.map((c) => c.label)).toEqual(["Agents", AGENT_RUN_LABEL]);
    expect(documentTitleLabelFromTrail(trail)).toBe(AGENT_RUN_LABEL);
  });

  it("reads that way BEFORE the page publishes anything (convergence round)", () => {
    // The first trail drawn for this page - the one the shell mirrors on its
    // very first render, and again on every soft navigation onto the page -
    // has no published page title yet. It used to read "Agents" alone, so the
    // shell wrote the AREA's word over the route's already-correct title until
    // the page published a frame later. The drawing states this page's reading
    // outright, so the trail states it from the first render.
    const trail = buildBreadcrumbTrail(RUN_STARTING_PAGE);
    expect(trail.map((c) => c.label)).toEqual(["Agents", AGENT_RUN_LABEL]);
    expect(documentTitleLabelFromTrail(trail)).toBe(AGENT_RUN_LABEL);
  });

  it("a page that publishes a different word still wins, and no other area root gains a crumb", () => {
    const renamed = buildBreadcrumbTrail(RUN_STARTING_PAGE, {
      pageTitle: { title: "Start a run", pathname: RUN_STARTING_PAGE },
    });
    expect(renamed.map((c) => c.label)).toEqual(["Agents", "Start a run"]);
    expect(buildBreadcrumbTrail("/connectors").map((c) => c.label)).toEqual([
      "Connectors",
    ]);
  });

  it("a not-found reading of this page still draws the one crumb, and no run word", () => {
    const trail = buildBreadcrumbTrail(RUN_STARTING_PAGE, { notFound: true });
    expect(trail.map((c) => c.label)).not.toContain(AGENT_RUN_LABEL);
  });

  it("the route's own server title is that leaf, not the area word", () => {
    // Read on the source, not through an import: this route mounts the whole
    // plugin route tree, and the tab title is a one-line export that the
    // constant above already binds to the trail's leaf. What can regress here
    // is the route going back to a word of its own.
    const source = readFileSync(
      path.join(process.cwd(), "src/app/agents/page.tsx"),
      "utf8",
    );
    expect(source).toContain("export const metadata: Metadata = { title: AGENT_RUN_LABEL };");
    expect(source).not.toMatch(/metadata[^\n]*title:\s*"Agents"/);
  });

  it("and the page header publishes that same word, from one source", () => {
    // The trail's leaf on this page IS the broadcast page-header title, so the
    // two words are one word: a rename of the header that forgot the tab is the
    // divergence this leg closes.
    const source = readFileSync(
      path.join(process.cwd(), "packages/agents/src/pages.tsx"),
      "utf8",
    );
    expect(source).toMatch(
      new RegExp(String.raw`title=(?:"${AGENT_RUN_LABEL}"|\{AGENT_RUN_LABEL\})`),
    );
  });
});

describe("the shell mirrors the trail instead of re-deriving a word", () => {
  const source = readFileSync(
    path.join(process.cwd(), "src/components/app-shell.tsx"),
    "utf8",
  );

  it("the general branch takes its title from the resolved trail", () => {
    // jsdom cannot measure the live ordering a proof round measures (the sibling
    // suites record why), so the branch is asserted on its source: the general
    // reading must reach the trail-mirroring helper before it falls back to the
    // path-derived word.
    expect(source).toMatch(
      /documentTitleLabelFromTrail\(breadcrumbSegments\)[\s\S]{0,400}deriveDocumentTitle/,
    );
  });

  it("a not-found reading writes the one crumb its trail draws", () => {
    expect(source).toMatch(/if\s*\(pageNotFound\)[\s\S]{0,800}PAGE_NOT_FOUND_CRUMB_LABEL/);
  });
});
