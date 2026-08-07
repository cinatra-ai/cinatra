import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, it, expect } from "vitest";

import {
  sanitizeSvgToDataUri,
  MAX_LOGO_BYTES,
} from "../../../../../scripts/extensions/generate-extension-manifest.mjs";
import {
  SEEDED_ABSENT_LOGO_CARDS,
  SEEDED_AGENT_LOGO_DATA_URI,
  SEEDED_ARTIFACT_LOGO_DATA_URI,
  SEEDED_BRAND_GATE_CONNECTOR_BASENAME,
  SEEDED_BRAND_GATE_NON_CONNECTOR_BASENAME,
  SEEDED_DECLARED_LOGO_CARDS,
  SEEDED_GRID_CARDS,
  SEEDED_GRID_CARD_COUNT,
  SEEDED_SKILL_LOGO_DATA_URI,
} from "../seed-data";
import { connectorBrandIcon } from "@/components/connector-brand-icons";
import {
  deriveIconSlug,
  safeManifestLogoSrc,
} from "@cinatra-ai/extensions/screens/marketplace-card-model";

// The seeded grid's declared-logo cells (cinatra#2469) exist so the live design
// e2e can prove, on the real running surface, that a self-declared
// `cinatra.logo` renders for the three kinds #2469 newly admitted — agent,
// skill and artifact — the render half of #2469 that the code change alone
// could not show. (The connector kind is out of scope here: it could always
// declare one and its glyph render shipped with cinatra#1482; the seeded
// connector card is spent on the brand-gate cells instead.)
//
// The one way that proof could lie is if the harness fed the card a value the
// real manifest generator would never emit (a hand-typed data URI, a raster, an
// unsanitized payload). This file forecloses that: every literal in seed-data.ts
// is re-derived HERE from its committed .svg source through the generator's OWN
// `sanitizeSvgToDataUri` — the same function that fills
// `STATIC_EXTENSION_MANIFEST[pkg].logo` — and must match byte for byte.
const LOGO_DIR = path.join(__dirname, "..", "logos");

const CASES = [
  { kind: "agent", file: "agent-glyph.svg", literal: SEEDED_AGENT_LOGO_DATA_URI },
  { kind: "skill", file: "skill-glyph.svg", literal: SEEDED_SKILL_LOGO_DATA_URI },
  { kind: "artifact", file: "artifact-glyph.svg", literal: SEEDED_ARTIFACT_LOGO_DATA_URI },
] as const;

describe("seeded declared-logo fixtures are real generator output (cinatra#2469)", () => {
  for (const { kind, file, literal } of CASES) {
    it(`${kind}: the seeded data URI is exactly sanitizeSvgToDataUri(${file})`, () => {
      const svg = readFileSync(path.join(LOGO_DIR, file), "utf8");
      expect(sanitizeSvgToDataUri(svg)).toBe(literal);
    });

    it(`${kind}: the source glyph is inside the generator's logo byte budget`, () => {
      const svg = readFileSync(path.join(LOGO_DIR, file), "utf8");
      expect(Buffer.byteLength(svg, "utf8")).toBeLessThanOrEqual(MAX_LOGO_BYTES);
    });

    it(`${kind}: the host render guard admits it (safeManifestLogoSrc passes it through)`, () => {
      // If the guard rejected it the tile would silently skip to the next tier
      // and the render proof would be photographing a fallback, not the logo.
      expect(safeManifestLogoSrc(literal)).toBe(literal);
    });
  }

  it("the three glyphs are mutually distinct, so a cross-wired card cannot pass", () => {
    const uris = CASES.map((c) => c.literal);
    expect(new Set(uris).size).toBe(uris.length);
  });
});

describe("seeded grid declared-logo assignment (cinatra#2469)", () => {
  it("adds no card: the grid cardinality invariant is untouched", () => {
    expect(SEEDED_GRID_CARDS).toHaveLength(SEEDED_GRID_CARD_COUNT);
    expect(SEEDED_GRID_CARD_COUNT).toBe(6);
  });

  it("splits the six cards into 3 declared-logo and 3 absent-logo controls", () => {
    expect(SEEDED_DECLARED_LOGO_CARDS).toHaveLength(3);
    expect(SEEDED_ABSENT_LOGO_CARDS).toHaveLength(3);
    expect(
      SEEDED_DECLARED_LOGO_CARDS.length + SEEDED_ABSENT_LOGO_CARDS.length,
    ).toBe(SEEDED_GRID_CARD_COUNT);
  });

  it("covers exactly the three NON-connector kinds #2469 admitted, one card each", () => {
    expect(SEEDED_DECLARED_LOGO_CARDS.map((c) => c.kindSlug).sort()).toEqual([
      "agent",
      "artifact",
      "skill",
    ]);
    // A connector could always declare one structurally; #2469 is about the
    // other kinds, so no connector card carries a declared logo here.
    expect(SEEDED_DECLARED_LOGO_CARDS.some((c) => c.kindSlug === "connector")).toBe(false);
  });

  it("pins the connector brand gate from BOTH sides on one render", () => {
    const gate = [
      { basename: SEEDED_BRAND_GATE_CONNECTOR_BASENAME, expectKind: "connector" },
      { basename: SEEDED_BRAND_GATE_NON_CONNECTOR_BASENAME, expectKind: "skill" },
    ] as const;

    for (const { basename, expectKind } of gate) {
      const card = SEEDED_GRID_CARDS.find((c) => c.packageName.endsWith(`/${basename}`));
      expect(card, `a seeded card must be named .../${basename}`).toBeTruthy();
      expect(card!.kindSlug).toBe(expectKind);
      // The slug must be DERIVED from the package name — not injected — or a
      // broken derivation could never fail the browser gate test.
      expect(deriveIconSlug(card!.packageName)).toBe(basename);
      // …and it must actually be mapped, or the "gate allows the connector"
      // half would pass vacuously (no mark exists to borrow in the first place).
      expect(connectorBrandIcon(basename)).not.toBeNull();
      // Neither brand-gate card declares a logo — otherwise tier 1 would render
      // and the client-icon tier under test would never be reached.
      expect(card!.manifestLogoUrl).toBeUndefined();
    }
  });

  it("keeps the anti-lookalike rule: no displayName token appears in its package name", () => {
    // The gate rename put a real connector slug in two package names; the kit's
    // founding invariant (a surface bound to the wrong source must go RED, not
    // pass as a lookalike) has to survive it.
    for (const card of SEEDED_GRID_CARDS) {
      const pkg = card.packageName.toLowerCase();
      for (const token of card.displayName.toLowerCase().split(/\W+/).filter(Boolean)) {
        expect(pkg, `${card.displayName} vs ${card.packageName}`).not.toContain(token);
      }
    }
  });
});
