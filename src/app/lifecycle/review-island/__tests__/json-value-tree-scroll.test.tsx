// @vitest-environment jsdom
//
// THE PINNED JSON DISPLAY SCROLLS ITS OWN VALUE TREE (cinatra#3375).
//
// Measured on a real run parked at its review gate: the json display drawn
// inside the review island cut every one of its value-tree rows at the panel's
// content edge — mid-word on the review route, mid-glyph on the narrower run
// route — with no ellipsis, no wrap and no scroll affordance.
//
// TWO LAYERS carry a pinned target's body, and the drawing's sentence holds on
// both: "a wide representation scrolls inside its own container rather than
// widening the page" (specs/app-artifact-review.html, section III). The island
// body wrapper is the host layer and already carries the road — min-w-0 with
// overflow-x-auto, pinned by island-body-overflow.test.tsx beside this file,
// which this leg does not touch. THIS file pins the OTHER layer: the display's
// own tree root. A root that declares overflow-x without a width bound never
// becomes the scroll box — it takes its width from its widest row, and the
// clipping moves out to whichever ancestor is bounded, which is what sliced the
// glyphs. The bound is what makes the tree itself the container that scrolls.
//
// THE MOUNT ROAD IS THE GENERATED MAP, and deliberately so. Core treats a type's
// view as opaque: an extension renderer module executes ONLY through
// GENERATED_ARTIFACT_RENDERERS (src/lib/generated/artifact-renderers.ts), never
// by importing its entry — the artifact-UI boundary the repository's own lint
// gate enforces (scripts/audit/artifact-ui-boundary-gate.md). Loading the
// display the way the dispatch spine loads it keeps this test on the core side
// of that border, and measures the display the host ACTUALLY mounts rather than
// a second copy of its source.
//
// THE PROPS ARE THE HOST'S OWN, not a hand-written shape: they come out of
// buildArtifactRendererProps with the read-only refusal the review island mints
// (src/app/artifacts/[id]/review-target-prepare.ts) and a text projection
// stamped with the canonical class cap, so a drift in the props contract breaks
// this test at the type level instead of quietly drawing an error floor whose
// markup happens to satisfy the readings below.
//
// jsdom IMPLEMENTS NO LAYOUT, so scrollWidth and clientWidth are 0 on every
// element here and measuring them would assert nothing. What is measured is the
// contract that PRODUCES the scroll in a browser. The live scrollWidth against
// clientWidth reading is taken on a boot, in both palettes, on the two routes.

import { beforeAll, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { GENERATED_ARTIFACT_RENDERERS } from "@/lib/generated/artifact-renderers";
import {
  ARTIFACT_CONTENT_CHANNEL_CAPS_MIRROR,
  ARTIFACT_CONTENT_CHANNEL_VERSION,
  buildArtifactRendererProps,
  readOnlyArtifactEdit,
  type ArtifactRendererProps,
} from "@/lib/artifacts/artifact-renderer-props";
import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";

const MAP_KEY = "@cinatra-ai/json-artifact::detail";
const REVISION_ID = "rev-3375";

// A DOCUMENT FAR WIDER THAN THE FRAME, and NESTED: the two wide values sit at
// different depths, because a container's rows are drawn by the same row
// treatment and a fix that reached only the top level would leave the nested
// line cut exactly as the defect cut it.
const TOP_LEVEL_VALUE = `top-${"x".repeat(4000)}`;
const NESTED_VALUE = `nested-${"y".repeat(2000)}`;
const WIDE_DOCUMENT = JSON.stringify({
  aVeryLongKeyThatDoesNotWrap: TOP_LEVEL_VALUE,
  container: { deeper: [NESTED_VALUE] },
});

type DetailRenderer = (props: ArtifactRendererProps) => ReactNode;

let Detail: DetailRenderer;

beforeAll(async () => {
  const entry = GENERATED_ARTIFACT_RENDERERS[MAP_KEY];
  if (!entry) throw new Error(`${MAP_KEY} is absent from the generated renderer map`);
  const mod = (await entry.load()) as { default?: DetailRenderer };
  if (typeof mod.default !== "function") throw new Error(`${MAP_KEY} exported no renderer`);
  Detail = mod.default;
});

/** The row the host's own library read would carry for this document. */
const SUMMARY: ArtifactSummary = {
  artifactId: "artifact-json",
  latestRepresentationRevisionId: REVISION_ID,
  objectType: "@cinatra-ai/json-artifact:artifact",
  artifactType: "artifact",
  title: "wide.json",
  mime: "application/json",
  size: Buffer.byteLength(WIDE_DOCUMENT, "utf8"),
  originKind: "upload",
  createdAt: "2026-09-16T00:00:00.000Z",
  updatedAt: "2026-09-16T00:00:00.000Z",
  ownerLevel: "organization",
  visibility: "organization",
  ownerId: null,
  organizationId: "org-3375",
  projectId: null,
  eligibleExtensions: ["@cinatra-ai/json-artifact"],
  primaryExtension: "@cinatra-ai/json-artifact",
  effectiveIdentity: { kind: "extension", extension: "@cinatra-ai/json-artifact" },
  presentationIdentity: { kind: "extension", extension: "@cinatra-ai/json-artifact" },
  presentationSuggestions: [],
  sourceUrl: null,
};

/** The host-authorized snapshot, built by the host's own builder. */
function props(): ArtifactRendererProps {
  const byteLength = Buffer.byteLength(WIDE_DOCUMENT, "utf8");
  return buildArtifactRendererProps({
    artifact: SUMMARY,
    representation: { revisionId: REVISION_ID, mime: "application/json" },
    previewHref: null,
    downloadHref: null,
    propsApiVersion: GENERATED_ARTIFACT_RENDERERS[MAP_KEY].propsApiVersion,
    // The review island is read-only BY CONSTRUCTION — the same refusal
    // review-target-prepare.ts mints for a pinned target.
    edit: readOnlyArtifactEdit("read-only-surface"),
    content: {
      kind: "text",
      channelVersion: ARTIFACT_CONTENT_CHANNEL_VERSION,
      representationRevisionId: REVISION_ID,
      text: WIDE_DOCUMENT,
      encoding: "utf-8",
      byteLength,
      projectedByteLength: byteLength,
      cap: ARTIFACT_CONTENT_CHANNEL_CAPS_MIRROR.text,
      truncated: false,
    },
  });
}

/** The display as the host mounts it, drawn into the document. */
function drawTree(): HTMLElement {
  document.body.innerHTML = renderToStaticMarkup(Detail(props()));
  const root = document.body.querySelector<HTMLElement>("[data-json-tree]");
  if (!root) throw new Error("the display drew no value tree");
  return root;
}

/** The tree's rows: every element the tree lays its row treatment on. */
function rowsOf(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>("*")).filter(
    (el) => el.style.whiteSpace === "pre",
  );
}

/**
 * The innermost element that holds `text` WHOLE — found by position in the
 * drawn tree, never by a style, so that a change of row treatment cannot make
 * this reading select a different element and pass while the value is cut.
 */
function holderOf(root: HTMLElement, text: string): HTMLElement {
  const holders = Array.from(root.querySelectorAll<HTMLElement>("*")).filter((el) =>
    (el.textContent ?? "").includes(text),
  );
  const innermost = holders.at(-1);
  if (!innermost) throw new Error(`the tree drew no element holding this value whole`);
  return innermost;
}

/** The chain from an element up to (and including) the tree root. */
function chainToRoot(el: HTMLElement, root: HTMLElement): HTMLElement[] {
  const chain: HTMLElement[] = [];
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    chain.push(node);
    if (node === root) break;
  }
  return chain;
}

describe("a wide json value tree scrolls inside its own container", () => {
  it("draws the wide document as rows at all", () => {
    // The precondition every sweep below stands on: a tree with no rows would
    // satisfy a per-row assertion vacuously and prove nothing.
    expect(rowsOf(drawTree()).length).toBeGreaterThan(0);
  });

  it("the tree root is a horizontal scroll container", () => {
    expect(drawTree().style.overflowX).toBe("auto");
  });

  it("the tree root may shrink below its content", () => {
    // Without this the root takes its width from its widest row: the overflow
    // moves out to an ancestor and the glyphs are sliced there instead.
    expect(["0", "0px"]).toContain(drawTree().style.minWidth);
  });

  it("the tree root never widens the page", () => {
    // "rather than widening the page" (section III).
    expect(drawTree().style.maxWidth).toBe("100%");
  });

  it.each([
    ["the top-level value", TOP_LEVEL_VALUE],
    ["the nested value", NESTED_VALUE],
  ])("%s is drawn whole in a row as wide as its text", (_name, value) => {
    const root = drawTree();
    const holder = holderOf(root, value);
    // The glyphs are all there in the markup — the defect was never a shorter
    // string, it was a row narrower than the string.
    expect(holder.textContent).toContain(value);
    const chain = chainToRoot(holder, root);
    const widened = chain.find((el) => el.style.width === "max-content");
    expect(widened, "no element between this value and the tree root is as wide as its text").toBeDefined();
    expect(widened!.style.minWidth).toBe("100%");
    // And that row is one of the rows the sweeps below measure, so a row
    // treatment that stopped matching them could not go unnoticed.
    expect(rowsOf(root)).toContain(widened!);
  });

  it("every row is as wide as its own text", () => {
    // A row narrower than its text is a row cut at the content edge.
    for (const row of rowsOf(drawTree())) expect(row.style.width).toBe("max-content");
  });

  it("every row still fills the box when its text is narrow", () => {
    for (const row of rowsOf(drawTree())) expect(row.style.minWidth).toBe("100%");
  });
});
