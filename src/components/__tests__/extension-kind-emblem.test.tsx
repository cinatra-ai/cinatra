/**
 * Per-kind emblem identity — cinatra#2364 (epic #2360).
 *
 * `extensionKindEmblem` is the single source of truth for "what kind of
 * extension is this" across the marketplace browse cards, the detail modal
 * hero and its dependency list, the installed/agents card family, the registry
 * catalog, the settings header and the conformance fixtures. #2364 swaps ONE
 * arm of it — connector: lucide `Plug` → the first-party `PlugConnectorKind`,
 * the lower half of the joined-plug family (design/specs/app-extensions.html
 * version 0.11.0, pinned at design@c144f39a8) — and that arm had no positive
 * lock at all before this file: the only thing pinning it was
 * `status-glyph-scope.test.ts`, which is a NEGATIVE lock (it says which mark
 * the arm must not be, not which it must).
 *
 * So this suite asserts the whole table, by geometry rather than by name: each
 * arm is compared against the mark it is supposed to draw, which makes "the
 * other five arms are byte-unchanged" an actual assertion instead of a claim in
 * a PR body. The root vitest env is "node", so it renders through
 * `react-dom/server` — enough for the emitted SVG and its `d` set.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import {
  Bot,
  FileText,
  Package,
  Plug,
  Sparkles,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { PlugConnectorKind } from "@cinatra-ai/sdk-ui/icons";
import {
  extensionKindEmblem,
  type ExtensionEmblemKind,
} from "@/components/extension-kind-emblem";

const html = (node: ReactElement) => renderToStaticMarkup(node);
const dsOf = (markup: string) =>
  Array.from(markup.matchAll(/<path[^>]*\sd="([^"]*)"/g)).map((m) => m[1]);
const attr = (markup: string, name: string) =>
  markup.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
const emblem = (kind: ExtensionEmblemKind, className?: string) =>
  renderToStaticMarkup(
    extensionKindEmblem(kind, className) as ReactElement,
  );

/**
 * The full vocabulary. `connector` is the one row #2364 moves; the other five
 * are the regression surface — a find-and-replace sweep across a file this
 * small is exactly how an unrelated arm gets taken along.
 */
const KIND_TABLE: ReadonlyArray<
  readonly [ExtensionEmblemKind, LucideIcon | typeof PlugConnectorKind, string]
> = [
  ["agent", Bot, "lucide-bot"],
  ["skill", Sparkles, "lucide-sparkles"],
  ["connector", PlugConnectorKind, "lucide-plug-connector-kind"],
  ["artifact", FileText, "lucide-file-text"],
  ["workflow", Workflow, "lucide-workflow"],
  ["unknown", Package, "lucide-package"],
];

describe("extensionKindEmblem — one mark per extension kind", () => {
  it.each(KIND_TABLE)(
    "draws %s as the expected mark, geometry-identical",
    (kind, Mark, cls) => {
      const markup = emblem(kind);
      expect(dsOf(markup)).toEqual(dsOf(html(<Mark />)));
      expect((attr(markup, "class") ?? "").split(/\s+/)).toContain(cls);
    },
  );

  it("falls back to the Package mark for an unmapped kind off the marketplace wire", () => {
    // The `default` arm shares its body with "unknown" — a kind slug the
    // catalog can introduce at any time (contexts, dashboards) must not render
    // an empty node.
    const markup = emblem("dashboard" as ExtensionEmblemKind);
    expect(dsOf(markup)).toEqual(dsOf(html(<Package />)));
  });

  it("gives every kind a DISTINCT mark — the emblem is the only kind cue on a card", () => {
    const drawings = KIND_TABLE.map(([kind]) => dsOf(emblem(kind)).join("|"));
    expect(new Set(drawings).size).toBe(KIND_TABLE.length);
  });
});

describe("extensionKindEmblem — the connector arm after #2364", () => {
  it("draws the lower-half-plug KIND mark, not lucide `Plug`", () => {
    const markup = emblem("connector");
    expect(dsOf(markup)).toEqual(dsOf(html(<PlugConnectorKind />)));
    expect(dsOf(markup)).not.toEqual(dsOf(html(<Plug />)));
    // The superseded mark's own geometry, spelled out: neither of lucide
    // `Plug`'s two paths may survive anywhere in the emitted node.
    for (const d of dsOf(html(<Plug />))) {
      expect(markup).not.toContain(`d="${d}"`);
    }
  });

  it("carries the spec's four paths and inherits colour from the byline/pill", () => {
    const markup = emblem("connector");
    expect(markup.match(/<path/g)).toHaveLength(4);
    expect(attr(markup, "stroke")).toBe("currentColor");
    expect(attr(markup, "stroke-width")).toBe("2");
    expect(attr(markup, "viewBox")).toBe("0 0 24 24");
  });

  it("leaves the other five arms on their lucide marks", () => {
    // Stated as its own assertion because it is the acceptance criterion: the
    // swap is single-arm. Compared against lucide directly, so this fails if a
    // later sweep points another arm at the first-party module.
    for (const [kind, Mark] of KIND_TABLE.filter(([k]) => k !== "connector")) {
      expect(dsOf(emblem(kind))).toEqual(dsOf(html(<Mark />)));
    }
  });
});

describe("extensionKindEmblem — sizing contract at the real call sites", () => {
  it("defaults to size-5, the class the tile/pill call sites rely on", () => {
    for (const [kind] of KIND_TABLE) {
      expect((attr(emblem(kind), "class") ?? "").split(/\s+/)).toContain("size-5");
    }
  });

  it("forwards the caller's className at BOTH extremes of the range", () => {
    // 13px is the browse-card byline (`size-[13px]`), 34px the detail-modal
    // hero (`size-8.5`) — the two ends #2364 requires proof at. The lucide
    // classes must survive alongside, since that is what the surrounding
    // `[&_svg]:*` utilities hook onto.
    for (const size of ["size-[13px]", "size-3.5", "size-4", "size-8.5"]) {
      const cls = (attr(emblem("connector", size), "class") ?? "").split(/\s+/);
      expect(cls).toEqual(expect.arrayContaining(["lucide", size]));
      expect(cls).not.toContain("size-5");
    }
  });

  it("keeps the mark decorative — the card's text carries the kind for a11y", () => {
    for (const [kind] of KIND_TABLE) {
      expect(attr(emblem(kind), "aria-hidden")).toBe("true");
    }
  });
});
