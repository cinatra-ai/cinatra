/**
 * cinatra#3570 — an installed card draws the PLAIN-TEXT MEANING of a markdown
 * description, one rule for every kind and every mount.
 *
 *   pnpm exec vitest run src/components/extensions/__tests__/installed-card-description-plain-text-3570.test.tsx
 *
 * THE DRAWING. specs/app-extensions.html §III gives the installed card as
 * "a white middle carrying the description, then the version with its status
 * beside it" — the description is PROSE. No sentence of §III, of its six status
 * sub-sections or of its spec-line section gives a card description any
 * rich-text treatment; the one panel drawn rich is §II's detail modal, which
 * carries its own README stylesheet for the listing detail embedded there.
 *
 * THE DEFECT. The string the card receives is authored in MARKDOWN for every
 * kind — an agent's and a skill's descriptor description are written in it, and
 * an artifact row carries no native description at all, so it falls back to the
 * registry summary, which the storefront produces by flattening the package's
 * own README into one line. The card drew that string raw, so the author's
 * control characters reached the reader: "an **external pointer**",
 * "`application/json`".
 *
 * WHAT IS PINNED HERE:
 *   - the drawn paragraph holds the WORDS and no asterisk, underscore pair,
 *     backtick or backslash — for each of the four kinds the installed list
 *     draws, iterated from the row road's own exported maps;
 *   - the same reading through all three production mounts of the card, and a
 *     source census requiring the mount list to be exactly those three;
 *   - a plain-prose description is drawn character for character as passed in
 *     (the identity property every existing description reading rests on);
 *   - the paragraph stays ONE text-only paragraph whose class is its only
 *     attribute, carrying the clamp each surface passes today.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { KIND_LABEL, KIND_ORDER } from "@cinatra-ai/extensions/screens/installed-rows";
import { InstalledExtensionCard } from "../installed-extension-card";
import { AgentAllCard, type AgentAllCardRow } from "@/components/extensions/agent-all-card";
import { ScopeAssistantsTab } from "@/components/scope-surfaces/scope-assistants-tab";
import type { ScopeAssistantCardRow } from "@/lib/scope-surface-rows";
import { extensionDescriptionText } from "@/lib/extension-description-text";
import { resolveVendorPresentation, type VendorPresentation } from "@/lib/vendor-presentation";

// The §II detail modal is not under test on either derived mount; the same stub
// the §IV clamp suite uses keeps each render to the card itself.
vi.mock("@/components/extensions/agent-detail-modal", () => ({
  AgentDetailModal: () => null,
}));

// This file mocks one module; it gives it back so the package's full run is
// unaffected by the file's presence.
afterAll(() => {
  vi.doUnmock("@/components/extensions/agent-detail-modal");
  vi.resetModules();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The descriptions under test.
// ---------------------------------------------------------------------------

/**
 * Carries every shape the issue's own three readings carry — strong emphasis,
 * emphasis, an inline code span — plus a backslash escape. The escaped
 * character is deliberately NOT one of the marks asserted absent below, so the
 * "no control character survives" reading stays exact.
 */
const MARKDOWN_DESCRIPTION =
  "Files an **external pointer** to the *canonical node*, accepts " +
  "`application/json` snapshots, keeps them __fully typed__, and reads a " +
  "100\\% faithful copy.";

/** The same sentence as a reader is meant to read it. */
const PLAIN_MEANING =
  "Files an external pointer to the canonical node, accepts " +
  "application/json snapshots, keeps them fully typed, and reads a " +
  "100% faithful copy.";

/** A word present in BOTH forms, so the selector below finds the paragraph
 *  before and after the change. */
const ANCHOR = "snapshots";

/** §III's own first worked example card, drawn as plain prose. */
const PLAIN_PROSE =
  "Gathers sources, summarises, and cites answers grounded in your team's own documents.";

// ---------------------------------------------------------------------------
// Reading the drawn paragraph.
// ---------------------------------------------------------------------------

/**
 * The description <p> as installed-extension-card.test.tsx already selects it:
 * a paragraph whose CLASS IS ITS ONLY ATTRIBUTE and whose content holds NO
 * child element. A markdown renderer would put child elements inside it and an
 * added attribute would put a second attribute before the class, so this
 * pattern is itself the pin that the description stays plain text.
 */
const TEXT_ONLY_PARAGRAPH = /<p class="[^"]*">[^<]*<\/p>/g;

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function descriptionParagraph(html: string, anchor: string): string {
  const hits = (html.match(TEXT_ONLY_PARAGRAPH) ?? []).filter((p) => p.includes(anchor));
  // Exactly ONE text-only paragraph carries the description copy.
  expect(hits).toHaveLength(1);
  return hits[0];
}

function drawnText(html: string, anchor: string): string {
  const paragraph = descriptionParagraph(html, anchor);
  return decodeEntities(
    paragraph.replace(/^<p class="[^"]*">/, "").replace(/<\/p>$/, ""),
  );
}

function expectNoControlCharacter(text: string): void {
  expect(text).not.toContain("*");
  expect(text).not.toContain("`");
  expect(text).not.toContain("\\");
  // No PAIRED underscore survives (a lone underscore is legitimate prose).
  expect(text).not.toMatch(/_[^_]+_/);
}

// ---------------------------------------------------------------------------
// The three production mounts.
// ---------------------------------------------------------------------------

function knownVendor(displayName: string): VendorPresentation {
  return resolveVendorPresentation(
    { name: displayName, storeUrl: null },
    { surface: "installed-card-description-plain-text-3570", ref: displayName },
  );
}

/** MOUNT 1 — the installed list's own card face (registry-catalog-screen). */
function renderInstalledCard(kindLabel: string, description: string): string {
  return renderToStaticMarkup(
    <InstalledExtensionCard
      name={`${kindLabel} pack`}
      accentColor="green"
      emblem={<svg data-testid="emblem" />}
      kindIcon={<svg data-testid="kind-icon" />}
      kindLabel={kindLabel}
      vendor={knownVendor("cinatra-ai")}
      description={description}
      version="0.4.2"
      status={<span data-testid="status-slot">status</span>}
    />,
  );
}

/** MOUNT 2 — the §IV agent card. */
function renderAgentAllCard(description: string): string {
  const row: AgentAllCardRow = {
    key: "local:agent-1",
    name: "Company Research",
    description,
    host: "local",
    runHref: "/agents/company-research/new",
    packageName: null,
    detailHref: null,
    unavailable: null,
  };
  return renderToStaticMarkup(<AgentAllCard row={row} />);
}

/** MOUNT 3 — the scope Assistants tab. */
function renderScopeAssistantsTab(description: string): string {
  const row: ScopeAssistantCardRow = {
    key: "@acme/research-assistant",
    packageName: "@acme/research-assistant",
    vendor: "acme",
    slug: "research-assistant",
    displayName: "Research Assistant",
    description,
    chatHref: "/workspace/chat",
    settingsHref: "/workspace/assistants/acme/research-assistant/settings?tab=skills",
    remoteCapable: false,
    remoteInstances: [],
    version: null,
    status: "active",
  };
  return renderToStaticMarkup(<ScopeAssistantsTab rows={[row]} />);
}

// ---------------------------------------------------------------------------
// C21 — no installed card shows a markdown control character, every kind.
// ---------------------------------------------------------------------------

describe("cinatra#3570 — the installed card draws the plain-text meaning, every kind", () => {
  // Iterated from the row road's OWN exported maps, never a list written here:
  // KIND_ORDER is the set the installed list draws (the removed "workflow" key
  // of KIND_LABEL is excluded from it and is never collected), KIND_LABEL gives
  // each one its drawn label. A fifth DRAWN kind fails here rather than first
  // in a picture round.
  it("draws the four kinds the installed list draws, and no more", () => {
    expect(KIND_ORDER).toEqual(["agent", "skill", "connector", "artifact"]);
  });

  for (const kind of KIND_ORDER) {
    const kindLabel = KIND_LABEL[kind];

    it(`a ${kind} card holds the words and not one control character`, () => {
      const text = drawnText(renderInstalledCard(kindLabel, MARKDOWN_DESCRIPTION), ANCHOR);

      // The WORDS the author wrote are all there …
      expect(text).toContain("external pointer");
      expect(text).toContain("canonical node");
      expect(text).toContain("application/json");
      expect(text).toContain("fully typed");
      expect(text).toContain("100% faithful copy");
      // … and not one of the marks that carried them.
      expectNoControlCharacter(text);
      // The whole sentence, exactly.
      expect(text).toBe(PLAIN_MEANING);
    });
  }

  it("the drawn description keeps the two-line clamp and its class stays its only attribute", () => {
    const paragraph = descriptionParagraph(
      renderInstalledCard(KIND_LABEL.artifact, MARKDOWN_DESCRIPTION),
      ANCHOR,
    );
    expect(paragraph).toContain("line-clamp-2");
    expect(paragraph).not.toContain("line-clamp-3");
    expect(paragraph).toContain("text-muted-foreground");
    // One attribute only: the pattern that matched already required it, and
    // this states it — no data-slot and no second class attribute is added.
    expect(paragraph).toMatch(/^<p class="[^"]*">[^<]*<\/p>$/);
  });
});

// ---------------------------------------------------------------------------
// C22 — the leading ATX heading marker, with the precedent's exact semantics.
// ---------------------------------------------------------------------------

describe("cinatra#3570 — a leading heading marker is stripped, the precedent's semantics", () => {
  it("strips a leading ATX heading marker from a drawn description", () => {
    const html = renderInstalledCard(
      KIND_LABEL.artifact,
      "# Markdown Artifact It accepts snapshots of every note.",
    );
    expect(drawnText(html, "snapshots")).toBe("Markdown Artifact It accepts snapshots of every note.");
  });

  it("a legitimate lead token survives untouched", () => {
    // Requiring whitespace after the hashes is exactly what the marketplace
    // card model's normalizeCardDescription pins.
    const html = renderInstalledCard(
      KIND_LABEL.agent,
      "#1 ranked outreach agent, filing snapshots nightly.",
    );
    expect(drawnText(html, "snapshots")).toBe("#1 ranked outreach agent, filing snapshots nightly.");
  });
});

// ---------------------------------------------------------------------------
// C23 — one rule, every mount.
// ---------------------------------------------------------------------------

describe("cinatra#3570 — the rule is the card's, so every mount carries it", () => {
  it("the §IV agent card draws the plain-text meaning, three-line clamp intact", () => {
    const html = renderAgentAllCard(MARKDOWN_DESCRIPTION);
    const text = drawnText(html, ANCHOR);
    expect(text).toBe(PLAIN_MEANING);
    expectNoControlCharacter(text);
    expect(descriptionParagraph(html, ANCHOR)).toContain("line-clamp-3");
  });

  it("the scope Assistants tab draws the plain-text meaning", () => {
    const html = renderScopeAssistantsTab(MARKDOWN_DESCRIPTION);
    const text = drawnText(html, ANCHOR);
    expect(text).toBe(PLAIN_MEANING);
    expectNoControlCharacter(text);
  });

  it("there are exactly three production mounts of the card", () => {
    expect(productionMounts()).toEqual([
      "packages/extensions/src/screens/registry-catalog-screen.tsx",
      "src/components/extensions/agent-all-card.tsx",
      "src/components/scope-surfaces/scope-assistants-tab.tsx",
    ]);
  });
});

/**
 * Every PRODUCTION mount of the card under src/ and packages/, by the same
 * source-census idiom the §IV clamp suite uses. Excluded, each for its own
 * stated reason: test directories; build output; and the design-fixtures
 * harness, which is never a product surface and is never a road to a drawn
 * screen. A line whose trimmed form opens a comment is a MENTION, not a mount
 * (packages/agents/src/agent-run-client.tsx names the card in its header
 * comment), so those lines are skipped.
 */
function productionMounts(): string[] {
  const ROOT = join(__dirname, "..", "..", "..", "..");
  const SKIP = new Set(["node_modules", "__tests__", "dist", ".next", ".turbo", "design-fixtures"]);
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".tsx")) continue;
      const mounted = readFileSync(full, "utf8")
        .split("\n")
        .some((line) => {
          const trimmed = line.trim();
          if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
            return false;
          }
          return trimmed.includes("<InstalledExtensionCard");
        });
      if (mounted) hits.push(full.slice(ROOT.length + 1));
    }
  };
  walk(join(ROOT, "src"));
  walk(join(ROOT, "packages"));
  return hits.sort();
}

// ---------------------------------------------------------------------------
// C24 — a plain description is drawn unchanged.
// ---------------------------------------------------------------------------

describe("cinatra#3570 — a plain-prose description is drawn character for character", () => {
  it("the drawn text equals the string passed in", () => {
    expect(drawnText(renderInstalledCard(KIND_LABEL.skill, PLAIN_PROSE), "Gathers sources")).toBe(
      PLAIN_PROSE,
    );
    expect(drawnText(renderAgentAllCard(PLAIN_PROSE), "Gathers sources")).toBe(PLAIN_PROSE);
    expect(drawnText(renderScopeAssistantsTab(PLAIN_PROSE), "Gathers sources")).toBe(PLAIN_PROSE);
  });

  it("an empty description still renders no paragraph at all", () => {
    const html = renderInstalledCard(KIND_LABEL.connector, "");
    expect(html).not.toContain("text-muted-foreground line-clamp-2");
  });
});

// ---------------------------------------------------------------------------
// C26 — the projection itself.
// ---------------------------------------------------------------------------

describe("extensionDescriptionText — the projection", () => {
  it("is the identity on a string carrying none of the inline marks", () => {
    expect(extensionDescriptionText(PLAIN_PROSE)).toBe(PLAIN_PROSE);
    expect(extensionDescriptionText(PLAIN_MEANING)).toBe(PLAIN_MEANING);
    expect(extensionDescriptionText("Runs a nightly check.")).toBe("Runs a nightly check.");
  });

  it("resolves a paired mark to its inner text", () => {
    expect(extensionDescriptionText("an **external pointer**")).toBe("an external pointer");
    expect(extensionDescriptionText("the *canonical node*")).toBe("the canonical node");
    expect(extensionDescriptionText("__fully typed__ rows")).toBe("fully typed rows");
    expect(extensionDescriptionText("a _single_ mark")).toBe("a single mark");
  });

  it("leaves an unpaired mark, arithmetic and an identifier alone", () => {
    expect(extensionDescriptionText("a lone * asterisk")).toBe("a lone * asterisk");
    expect(extensionDescriptionText("Runs 5 * 3 * 2 checks")).toBe("Runs 5 * 3 * 2 checks");
    expect(extensionDescriptionText("reads snake_case_name fields")).toBe(
      "reads snake_case_name fields",
    );
    expect(extensionDescriptionText("an unclosed `span")).toBe("an unclosed `span");
  });

  it("resolves an inline code span, and a multi-backtick span keeps its backtick", () => {
    expect(extensionDescriptionText("accepts `application/json`")).toBe("accepts application/json");
    expect(extensionDescriptionText("the `` ` `` character")).toBe("the ` character");
  });

  it("resolves a backslash escape to the character it escapes", () => {
    expect(extensionDescriptionText("a 100\\% sample")).toBe("a 100% sample");
    expect(extensionDescriptionText("a literal \\* asterisk")).toBe("a literal * asterisk");
    // A backslash before a non-punctuation character is not an escape.
    expect(extensionDescriptionText("a path C:\\temp")).toBe("a path C:\\temp");
  });

  it("resolves an inline link to its link text", () => {
    expect(extensionDescriptionText("see [the guide](https://example.test/g) first")).toBe(
      "see the guide first",
    );
  });

  // A nested mark must pair with its OWN partner: an earlier single-scan draft
  // let an outer run take the first half of an inner run's closer and left the
  // other half in the drawn text, which is the very defect this leg fixes.
  it("resolves nested emphasis without leaving half a mark behind", () => {
    expect(extensionDescriptionText("*outer **inner** end*")).toBe("outer inner end");
    expect(extensionDescriptionText("**a *b***")).toBe("a b");
    expect(extensionDescriptionText("**bold with *italic* inside** and plain")).toBe(
      "bold with italic inside and plain",
    );
  });

  // A README sentence commonly links a destination that carries its own
  // parentheses; ending the link at the FIRST ")" would spill the rest of the
  // address into the drawn prose.
  it("consumes a link destination with balanced parentheses, and a nested label", () => {
    expect(extensionDescriptionText("[guide](https://example.test/a(b)c) rest")).toBe("guide rest");
    expect(extensionDescriptionText("[a [b] c](https://example.test/g)")).toBe("a [b] c");
  });

  it("resolves an inline image to its alt text, introducer and all", () => {
    expect(extensionDescriptionText("![alt](https://example.test/i.png)")).toBe("alt");
    expect(extensionDescriptionText("![**bold alt**](https://example.test/i.png) after")).toBe(
      "bold alt after",
    );
  });

  // Neither is one of the resolutions this projection is scoped to, and a
  // reference link has no definition to resolve against on a one-line
  // description: both stay the literal text the author wrote.
  it("leaves an autolink and a reference link as literal text", () => {
    expect(extensionDescriptionText("read <https://example.test> now")).toBe(
      "read <https://example.test> now",
    );
    expect(extensionDescriptionText("see [the guide][guide] for more")).toBe(
      "see [the guide][guide] for more",
    );
  });

  it("strips exactly one leading ATX heading marker, the precedent's semantics", () => {
    expect(extensionDescriptionText("# Title rest of prose")).toBe("Title rest of prose");
    expect(extensionDescriptionText("###### Deep heading then text")).toBe("Deep heading then text");
    expect(extensionDescriptionText("   #   Padded heading")).toBe("Padded heading");
    expect(extensionDescriptionText("#1 ranked outreach tool")).toBe("#1 ranked outreach tool");
    expect(extensionDescriptionText("#hashtag heavy copy")).toBe("#hashtag heavy copy");
    expect(extensionDescriptionText("Rated #1 by users")).toBe("Rated #1 by users");
  });

  it("answers a non-string with the empty string", () => {
    expect(extensionDescriptionText(null)).toBe("");
    expect(extensionDescriptionText(undefined)).toBe("");
  });
});
