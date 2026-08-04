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

describe("extensionKindEmblem — connector arm renders PlugConnectorKind", () => {
  it("renders the recentred lower-plug-half transform, not the lucide Plug outline", () => {
    const html = renderToStaticMarkup(<>{extensionKindEmblem("connector")}</>);
    expect(html).toContain('transform="translate(-1.03,-11.33) scale(1.515)"');
  });

  it("forwards the caller className (e.g. the 13px byline size)", () => {
    const html = renderToStaticMarkup(<>{extensionKindEmblem("connector", "size-[13px]")}</>);
    expect(html).toContain('class="size-[13px]"');
  });
});

describe("extensionKindEmblem — every other kind arm is byte-unchanged", () => {
  it.each(OTHER_KINDS)("renders a non-empty icon for kind=%s without the plug-kind transform", (kind) => {
    const html = renderToStaticMarkup(<>{extensionKindEmblem(kind)}</>);
    expect(html).toContain("<svg");
    expect(html).not.toContain('transform="translate(-1.03,-11.33) scale(1.515)"');
  });
});
