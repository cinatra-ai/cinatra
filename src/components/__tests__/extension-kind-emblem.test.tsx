/**
 * extensionKindEmblem — per-kind icon helper (cinatra#2364, epic #2360).
 *
 * No existing lock pinned this helper before #2364 (only the agent arm was
 * source-pinned elsewhere, and the `PlugZap` tests pin the separate
 * connection-status glyph) — this is that small per-kind emblem test, added
 * while swapping the connector arm to the lower-half-plug mark.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { extensionKindEmblem, type ExtensionEmblemKind } from "../extension-kind-emblem";

const OTHER_KINDS: ExtensionEmblemKind[] = ["agent", "skill", "artifact", "workflow", "unknown"];

// The registry glyph's stable render markers (packages/sdk-ui/src/icons.tsx):
// the lucide class hook createLucideIcon stamps, plus one baked-geometry
// anchor (the socket half's start point under the spec's applied transform —
// derivation-locked in the sdk-ui registry tests).
const KIND_GLYPH_CLASS = "lucide-plug-connector-kind";
const KIND_GLYPH_GEOMETRY_ANCHOR = 'd="M13.0595 14.8795';

describe("extensionKindEmblem — connector arm renders PlugConnectorKind", () => {
  it("renders the registry's recentred lower-plug-half mark, not the lucide Plug outline", () => {
    const html = renderToStaticMarkup(<>{extensionKindEmblem("connector")}</>);
    expect(html).toContain(KIND_GLYPH_CLASS);
    expect(html).toContain(KIND_GLYPH_GEOMETRY_ANCHOR);
  });

  it("forwards the caller className (e.g. the 13px byline size) alongside the lucide hooks", () => {
    const html = renderToStaticMarkup(<>{extensionKindEmblem("connector", "size-[13px]")}</>);
    const cls = html.match(/class="([^"]*)"/)?.[1]?.split(/\s+/) ?? [];
    expect(cls).toEqual(expect.arrayContaining([KIND_GLYPH_CLASS, "size-[13px]"]));
  });
});

describe("extensionKindEmblem — every other kind arm is byte-unchanged", () => {
  it.each(OTHER_KINDS)("renders a non-empty icon for kind=%s without the plug-kind mark", (kind) => {
    const html = renderToStaticMarkup(<>{extensionKindEmblem(kind)}</>);
    expect(html).toContain("<svg");
    expect(html).not.toContain(KIND_GLYPH_CLASS);
    expect(html).not.toContain(KIND_GLYPH_GEOMETRY_ANCHOR);
  });
});
