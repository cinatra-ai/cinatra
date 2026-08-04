/**
 * Status-glyph scope — NEGATIVE locks for cinatra#2356 (epic #2353).
 *
 * design/specs/app-connectors.html version 0.7.0 (pinned at design@3d33cc800) replaces
 * the CONNECTED STATUS glyph with the first-party joined plug (`PlugConnected`,
 * defined once in `@cinatra-ai/sdk-ui/icons`). #2356 scope 3 draws the boundary
 * explicitly: the swap is a STATUS-glyph swap, and two plug-shaped marks in this
 * repo are deliberately NOT status glyphs and must not follow it:
 *
 *   1. `src/components/connector-brand-icons.tsx` — the /connectors grid's
 *      IDENTITY fallback tile. It answers "which service is this?" for a
 *      connector whose brand mark is not mapped yet (#1482 maps the real
 *      logos), never "is it connected?". Swapping it in would put the connected
 *      mark on DISCONNECTED cards, whose badge simultaneously reads Unplug.
 *   2. `src/components/extension-kind-emblem.tsx` — the extension-KIND emblem.
 *      Its connector arm says "this extension is a connector" alongside Bot /
 *      FileText / Package / Sparkles / Workflow for the other kinds; connection
 *      state is not in its vocabulary at all.
 *
 * cinatra#2364 (epic #2360) then changed WHAT that second arm draws — lucide
 * `Plug` became the first-party `PlugConnectorKind`, the lower half of the very
 * same joined-plug family, so kind and state read as one family — WITHOUT
 * changing the boundary above. That makes the lock sharper, not looser: the two
 * marks now differ by one glyph name in one module, so "the status glyph leaked
 * into the kind emblem" is a likelier slip than it was, and the assertions
 * below are re-specified to name the mark the arm must carry rather than to ban
 * the module it comes from.
 *
 * A regression here is a plausible one (both files draw a plug and a
 * find-and-replace sweep would take them), and it is invisible to the four
 * positive per-site locks — which is exactly what a negative lock is for.
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
  it("draws the first-party KIND mark, imported from the one shared glyph module", () => {
    // One assertion, not two: `PlugConnectorKind` must be a NAMED IMPORT FROM
    // the shared subpath. Asserting "an icons import exists" and "the token
    // appears" separately would pass on a locally-defined twin beside an
    // unrelated import — exactly the substitution this lock exists to catch,
    // and a parallel glyph module is the failure #2364 was written to prevent.
    expect(KIND_EMBLEM_SRC).toMatch(
      /import \{[^}]*\bPlugConnectorKind\b[^}]*\} from "@cinatra-ai\/sdk-ui\/icons"/,
    );
    expect(KIND_EMBLEM_SRC).toMatch(
      /case "connector":[\s\S]*?return <PlugConnectorKind className=\{className\} \/>/,
    );
    // No hand-rolled <svg> and no second definition of the mark in the host.
    expect(KIND_EMBLEM_SRC).not.toMatch(/<svg[\s>]/);
    expect(KIND_EMBLEM_SRC).not.toMatch(/createLucideIcon/);
  });

  it("never reaches for the connected-status glyph", () => {
    // Unchanged from #2356 and still the point of the file: `PlugConnected` is
    // the STATE mark. It is not a substring of `PlugConnectorKind` (they part
    // company at "Connect|e" vs "Connect|o"), so this stays a real lock.
    expect(KIND_EMBLEM_SRC).not.toContain("PlugConnected");
    expect(KIND_EMBLEM_SRC).not.toContain("PLUG_CONNECTED_ICON_NODE");
  });

  it("leaves the connector arm the ONLY arm reading from the glyph module", () => {
    // The swap is single-arm by design (#2364 scope 2): the other five kinds
    // stay on their lucide marks, so a sweep that pulled another arm into the
    // first-party module would be a silent scope escape.
    //
    // Asserted by naming each surviving arm, NOT by counting occurrences of the
    // new glyph's name — a count would go red on a comment that merely mentions
    // it, which is brittleness rather than protection.
    const LUCIDE_ARMS: ReadonlyArray<readonly [string, string]> = [
      ["skill", "Sparkles"],
      ["artifact", "FileText"],
      ["workflow", "Workflow"],
      ["agent", "Bot"],
      ["unknown", "Package"],
    ];
    for (const [kind, mark] of LUCIDE_ARMS) {
      expect(KIND_EMBLEM_SRC).toMatch(
        new RegExp(`case "${kind}":[\\s\\S]*?return <${mark} className=\\{className\\} />`),
      );
    }
    // "unknown" is the `default` arm's neighbour, so `Package` must be the only
    // mark reachable without a matching case.
    expect(KIND_EMBLEM_SRC).toMatch(
      /case "unknown":\s*\n\s*default:\s*\n\s*return <Package className=\{className\} \/>/,
    );
    // Exactly one import statement pulls from the shared module.
    expect(
      KIND_EMBLEM_SRC.match(/^import .* from "@cinatra-ai\/sdk-ui\/icons";$/gm),
    ).toHaveLength(1);
  });

  it("keeps one emblem per extension kind — the vocabulary is kinds, not states", () => {
    for (const kind of ["Bot", "FileText", "Package", "Sparkles", "Workflow"]) {
      expect(KIND_EMBLEM_SRC).toContain(kind);
    }
    expect(KIND_EMBLEM_SRC).not.toContain("connected");
  });
});
