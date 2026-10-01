/**
 * The §II extension-detail modal is the app's ONLY detail surface (cinatra#2736).
 *
 *   pnpm --filter ./packages/extensions exec vitest run \
 *     src/screens/__tests__/extension-detail-modal-anatomy.test.ts
 *
 * The ratified drawing, §II: "Clicking More details on a ListingCard opens this
 * modal. […] The modal is details-only — it carries no footer and no
 * install/update/restore action of its own (owner ruling, 2026-08-04);
 * install/update/restore run from the §I ListingCard and the §III installed
 * card, never from this dialog." The drawn panel carries
 * `data-conformance-id="extension-detail-modal"` and
 * `data-field="name=manifest.displayName"`.
 *
 * Three of the issue's four acceptance items are source-expressible and pinned
 * here: the §II anatomy (tabs, no footer, no install control, header-only
 * close), the conformance anchor that lets the mechanical check bind the
 * surface, and the title binding. The fourth — that the retired route no longer
 * renders a detail page — is pinned on the route itself.
 *
 * Source-text assertions are this directory's convention for these client
 * screens (see marketplace-detail-modal-contract.test.ts): the package's vitest
 * environment is `node`, so a rendered-DOM interaction test is not expressible
 * here. The rendered anatomy is measured on the live boot in both palettes.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

const MODAL = path.resolve(__dirname, "../marketplace-detail-modal.tsx");
const RAW = readFileSync(MODAL, "utf8");

/**
 * PROSE IS NOT CODE. Every assertion below reads the module with its comments
 * stripped, because a source-text check run over the raw file passes on a
 * sentence that merely QUOTES the thing it demands — deleting the real
 * attribute or control would not fail it.
 */
const SOURCE = RAW.replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");

/** The `<DialogContent …>` opening tag — the drawn modal panel. */
const DIALOG_CONTENT = SOURCE.match(/<DialogContent[\s\S]*?>/)?.[0] ?? "";

/** Everything between `<DialogContent …>` and `</DialogContent>`. */
const DIALOG_BODY = SOURCE.match(/<DialogContent[\s\S]*?<\/DialogContent>/)?.[0] ?? "";

describe("acceptance 3 — the conformance id binds the surface", () => {
  it("carries the drawn `extension-detail-modal` anchor on the dialog panel", () => {
    expect(DIALOG_CONTENT).toBeTruthy();
    expect(
      DIALOG_CONTENT,
      "the drawn panel carries the extension-detail anchor as a real JSX ATTRIBUTE; without it the mechanical conformance check cannot bind this surface",
    ).toMatch(/\sdata-conformance-id="extension-detail-modal"/);
    // Written ONCE, on the attribute. A second copy anywhere in the module — a
    // comment quoting it, say — would satisfy this check AND the mechanical
    // contract's own literal scan with the attribute itself deleted.
    expect(
      RAW.match(/data-conformance-id="extension-detail-modal"/g) ?? [],
      "the anchor literal belongs on the attribute and nowhere else in the module — never quoted in prose",
    ).toHaveLength(1);
  });

  it("is the anchor the mechanical contract requires of this file", () => {
    const contract = JSON.parse(
      readFileSync(
        path.resolve(__dirname, "../../../../../tests/e2e/design/conformance/testid-contract.json"),
        "utf8",
      ),
    ) as {
      surfaces: Record<
        string,
        { requires: Array<{ file: string; literals: string[] }> }
      >;
    };
    const required = contract.surfaces["extension-detail-modal"].requires.find(
      (r) => r.file === "packages/extensions/src/screens/marketplace-detail-modal.tsx",
    );
    expect(required?.literals).toContain('data-conformance-id="extension-detail-modal"');
  });
});

describe("acceptance 4 — the title is the manifest displayName, never the package name", () => {
  it("binds the dialog label and the visible §II title to `card.displayName`", () => {
    expect(SOURCE).toMatch(/<DialogTitle className="sr-only">\{card\.displayName\}<\/DialogTitle>/);
    expect(SOURCE).toMatch(
      /data-slot="marketplace-modal-name"[\s\S]{0,220}\{card\.displayName \|\| detail\.displayName\}/,
    );
  });

  it("never falls back to the raw package slug for either title", () => {
    const title = SOURCE.match(/<DialogTitle[\s\S]*?<\/DialogTitle>/)?.[0] ?? "";
    expect(title).not.toContain("packageName");
    const heroName =
      SOURCE.match(/data-slot="marketplace-modal-name"[\s\S]*?<\/h2>/)?.[0] ?? "";
    expect(heroName).toBeTruthy();
    expect(heroName).not.toContain("packageName");
  });
});

describe("acceptance 1 — the §II anatomy on the click path", () => {
  it("opens from More details on the card, never from a URL", () => {
    // The default trigger is a real modal trigger; the §VI opener's anchor is
    // an in-place `preventDefault()` opener, not a navigation.
    expect(SOURCE).toMatch(/<DialogTrigger asChild>/);
    expect(SOURCE).toMatch(/More details/);
    expect(SOURCE).toMatch(/event\.preventDefault\(\);\s*\n\s*onOpenChange\(true\);/);
  });

  it("renders the three drawn tabs, each with its own content pane", () => {
    for (const [value, label] of [
      ["details", "Details"],
      ["reviews", "Reviews"],
      ["changelog", "Changelog"],
    ] as const) {
      expect(SOURCE).toMatch(
        new RegExp(`<TabsTrigger value="${value}"[\\s\\S]{0,160}${label}`),
      );
      expect(SOURCE).toMatch(new RegExp(`<TabsContent value="${value}"`));
    }
  });

  it('carries no footer — the modal is "details-only"', () => {
    expect(DIALOG_BODY).toBeTruthy();
    // Measured over the WHOLE module, not the DialogContent element: the panel
    // renders `<ModalBody />` and each tab pane as a local component declared
    // further down this file, so a footer added inside one of them would sit
    // outside DIALOG_BODY while still painting inside the dialog.
    expect(SOURCE).not.toMatch(/DialogFooter/);
    expect(SOURCE).not.toMatch(/<footer/);
  });

  it("carries no install / update / restore control inside the dialog", () => {
    // Whole-module, for the same reason: every tab pane is a local component.
    expect(SOURCE).not.toMatch(/Install now/);
    expect(SOURCE).not.toMatch(/Update now/);
    expect(SOURCE).not.toMatch(/\bRestore\b/);
    // Nor the shared in-card install panel, which is the §I surface's own.
    expect(SOURCE).not.toMatch(/ExtensionInstallScopePanel|InstallPanelOpenButton/);
  });

  it("puts the close control in the header and nowhere else", () => {
    // Radix's built-in corner close is off, so the header's own is the only one.
    expect(DIALOG_CONTENT).toContain("showCloseButton={false}");
    // Counted over the whole module: a second DialogClose rendered from one of
    // the local tab components would escape a DIALOG_BODY-scoped count.
    expect(SOURCE.match(/<DialogClose/g) ?? []).toHaveLength(1);
    const header = DIALOG_BODY.match(
      /<div className="flex shrink-0 items-center justify-end border-b[\s\S]*?<\/div>/,
    )?.[0];
    expect(header, "the slim §II header band").toBeTruthy();
    expect(header).toContain("<DialogClose");
  });
});
