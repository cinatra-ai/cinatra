/**
 * Status-glyph scope — NEGATIVE locks for cinatra#2356 (epic #2353).
 *
 * design/specs/app-connectors.html version 0.7.0 (pinned at design@3d33cc800) replaces
 * the CONNECTED STATUS glyph with the first-party joined plug (`PlugConnected`,
 * defined once in `@cinatra-ai/sdk-ui/icons`, the bare barrel specifier — every
 * real status-glyph site imports it that way, never through a subpath). #2356
 * scope 3 draws the boundary explicitly: the swap is a STATUS-glyph swap, and
 * two plug-shaped marks in this repo are deliberately NOT status glyphs and
 * must not follow it:
 *
 *   1. `src/components/connector-brand-icons.tsx` — the /connectors grid's
 *      IDENTITY fallback tile. It answers "which service is this?" for a
 *      connector whose brand mark is not mapped yet (#1482 maps the real
 *      logos), never "is it connected?". Swapping it in would put the connected
 *      mark on DISCONNECTED cards, whose badge simultaneously reads Unplug.
 *   2. `src/components/extension-kind-emblem.tsx` — the extension-KIND emblem.
 *      Its connector arm says "this extension is a connector" alongside
 *      Bot / FileText / Package / Sparkles / Workflow for the other kinds;
 *      connection state is not in its vocabulary at all.
 *
 * A regression here is a plausible one (both files draw a plug and a
 * find-and-replace sweep would take them), and it is invisible to the four
 * positive per-site locks — which is exactly what a negative lock is for.
 *
 * #2364 (epic #2360, landing AFTER this lock) adds a THIRD, sibling joined-plug
 * mark for site 2: `PlugConnectorKind` — the KIND glyph epic #2360 mandates for
 * "what kind of extension is this", drawn in the SAME sdk-ui glyph registry
 * (`@cinatra-ai/sdk-ui/icons`, single module owner per #2364) as a distinct
 * export beside the STATUS glyph, so the two read as one icon family without
 * collapsing into the same component. Site 2's lock below therefore reduces to
 * the boundary that actually matters: the connector arm renders the KIND
 * export `PlugConnectorKind` — never lucide's generic `Plug` and never the
 * STATUS export `PlugConnected`. The registry entrypoint itself is a
 * legitimate import for site 2 now; the ban is on the status TOKEN, not the
 * specifier.
 * Source-text assertions: the root vitest env is "node" (no DOM render).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const BRAND_ICONS_SRC = read("src/components/connector-brand-icons.tsx");
const KIND_EMBLEM_SRC = read("src/components/extension-kind-emblem.tsx");

describe("cinatra#2356 — the identity fallback is NOT swapped to the status glyph", () => {
  it("keeps the neutral lucide PlugZap tile as the unmapped-brand fallback", () => {
    expect(BRAND_ICONS_SRC).toMatch(
      /<PlugZap className="h-5 w-5 text-muted-foreground" aria-hidden="true" \/>/,
    );
    expect(BRAND_ICONS_SRC).toMatch(/import \{ PlugZap \} from "lucide-react"/);
  });

  it("never reaches for the connected-status glyph", () => {
    expect(BRAND_ICONS_SRC).not.toContain("PlugConnected");
    expect(BRAND_ICONS_SRC).not.toContain("@cinatra-ai/sdk-ui/icons");
  });

  it("stays an identity surface: it renders no connection-status badge", () => {
    // Guards the inverse regression — pulling status rendering INTO the
    // identity leaf would make the boundary meaningless.
    expect(BRAND_ICONS_SRC).not.toContain("ConnectorBadge");
    expect(BRAND_ICONS_SRC).not.toContain("ConnectionStatusBadge");
  });
});

describe("cinatra#2356 — the extension-kind emblem is NOT swapped to the status glyph", () => {
  it("renders the dedicated connector KIND glyph (cinatra#2364) — never lucide's generic `Plug`", () => {
    // One assertion, not two: `PlugConnectorKind` must be a NAMED IMPORT from
    // the shared glyph registry entrypoint (exactly `.../icons`, the closing
    // quote pinning it — a nested-subpath parallel module would not match).
    // Asserting "an sdk-ui import exists" and "the token PlugConnectorKind
    // appears" separately would pass on a locally-defined `PlugConnectorKind`
    // beside an unrelated import — exactly the substitution this lock exists
    // to catch.
    expect(KIND_EMBLEM_SRC).toMatch(
      /import \{ PlugConnectorKind \} from "@cinatra-ai\/sdk-ui\/icons"/,
    );
    expect(KIND_EMBLEM_SRC).toMatch(
      /case "connector":\s*\n\s*return <PlugConnectorKind className=\{className\} \/>/,
    );
    // The lucide `Plug` import this arm used before #2364 must be gone, not
    // merely unused — a leftover import would be exactly the kind of
    // half-finished swap this scope lock exists to catch.
    expect(KIND_EMBLEM_SRC).not.toMatch(/import \{[^}]*\bPlug\b[^}]*\} from "lucide-react"/);
  });

  it("never reaches for the connected-status glyph", () => {
    // The STATUS boundary reduces to the token ban (cinatra#2364): the
    // registry entrypoint is a LEGITIMATE import for the KIND glyph now, so
    // banning the specifier would forbid the conformant arrangement. What must
    // never appear is the status export itself.
    expect(KIND_EMBLEM_SRC).not.toContain("PlugConnected");
  });

  it("keeps one emblem per extension kind — the vocabulary is kinds, not states", () => {
    for (const kind of ["Bot", "FileText", "Package", "Sparkles", "Workflow"]) {
      expect(KIND_EMBLEM_SRC).toContain(kind);
    }
    expect(KIND_EMBLEM_SRC).not.toContain("connected");
  });
});
