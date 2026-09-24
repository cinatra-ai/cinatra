// @vitest-environment jsdom
/**
 * The resolved install panel of the Upload Extension screen, against its OWN
 * drawn node (cinatra#3204 criterion 11; design Extensions section VIII).
 *
 *   pnpm --filter ./packages/agents exec vitest run \
 *     src/__tests__/upload-install-scope-panel-drawn-surface.test.tsx
 *
 * THE DRAWING, in its own words. The prose of section VIII reads, of the
 * resolve: "Continue resolves on the screen itself - no popup opens, and
 * nothing is drawn inline in the fields. What it mounts is the same install
 * panel section I.1 already fixes, WITHOUT A CARD." The example's caption
 * repeats it: "The resolved panel is the section I.1 install panel on a
 * mounting with no card - no header band, and so no corner cross: Cancel is
 * the whole of the close."
 *
 * And the example's own conformance-identified node for that panel carries a
 * TOP RULE AND NOTHING ELSE:
 *
 *   <div data-conformance-id="upload-resolved-install-panel"
 *        style="margin-top: 18px; border-top: 1px solid var(--line);
 *               padding-top: 14px; display: flex; flex-direction: column;
 *               gap: 10px;">
 *
 * No box, no radius, no tint. What shipped instead drew that node as
 * `soft-panel flex flex-col gap-3 rounded-card p-4` - a bordered, rounded,
 * tinted container nested inside the one bordered section surface the drawing
 * frames the whole tab's content in. The departure is the INNER box.
 *
 * WHY THIS SUITE ITERATES. The resolved install panel has exactly TWO
 * mountings on this screen, both rendering the one component: the GitHub tab's
 * form (upload-repository-link-form.tsx) and the File tab's form
 * (import-form.tsx). One test drives BOTH to their resolved state and grades
 * each, so a mounting that lacks the drawn treatment fails the suite. The
 * census itself is read from the package's own source rather than trusted: the
 * test lists every file that mounts the component and fails if that set is not
 * the set this suite drives, so a THIRD mounting added later cannot ship
 * un-graded.
 *
 * The two arms below pin what must NOT move: the four readings above the
 * picker with their order and anchors, and the section I.1 panel's own picker,
 * its `Workspace: All` preselection and its Cancel / Install now row. Both are
 * green before this leg's edit and green after it - the edit changes one class
 * list and nothing else.
 *
 * jsdom loads no stylesheet, so the treatment is graded on the rendered node's
 * own class list, which is what carries it: the 1px top rule in the hairline
 * token, the 14px top padding and the 10px column gap.
 *
 * THE TOP MARGIN IS GRADED AS A COMPOSED FIGURE. The drawing's node sits in a
 * parent with no gap, so its 18px top margin IS the drawn separation. Both
 * mountings here place the panel as the last child of a `flex flex-col gap-6`
 * parent, which already puts 24px above it and does not collapse a flex item's
 * margin into it - so a literal `mt-[18px]` would draw 42px. This suite reads
 * the parent's own gap and adds the node's own margin, and requires the SUM to
 * be the drawn 18px, whichever class spells it.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import React from "react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { createZipBuffer } from "../zip-helpers";

const routerState = vi.hoisted(() => ({ push: vi.fn() as ReturnType<typeof vi.fn> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: routerState.push }) }));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) =>
    React.createElement("a", { href, ...rest }, children),
}));

const actions = vi.hoisted(() => ({
  previewSuppliedRepositoryAction: vi.fn(),
  installSuppliedRepositoryAction: vi.fn(),
  installSuppliedArchiveAction: vi.fn(),
  readSuppliedUploadConsentPromptAction: vi.fn(async () => null),
}));
vi.mock("../supplied-install-actions", () => actions);

const toastState = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }));
vi.mock("@/lib/cinatra-toast", () => ({ toast: toastState }));

import { ImportAgentForm } from "../import-form";
import { ImportPackageFromGitHubForm } from "../upload-repository-link-form";

const INSTALL_SCOPE = {
  installTargets: [
    {
      value: "workspace",
      label: "Workspace: All",
      level: "workspace" as const,
      id: "org-1",
      disabled: false,
    },
    {
      value: "org:org-1",
      label: "Acme",
      level: "organization" as const,
      id: "org-1",
      disabled: false,
    },
  ],
  ownerEntityNames: { "org:org-1": "Acme" },
  activeOrgId: "org-1",
  availability: { state: "ready" as const, defaultValue: "workspace" },
};

const SHA = "b".repeat(40);

/** The drawn node's own treatment, one class per drawn declaration. */
const DRAWN_TREATMENT = [
  "border-t", // border-top-width: 1px
  "border-line", // ...in the hairline colour, var(--line)
  "pt-3.5", // padding-top: 14px
  "gap-2.5", // gap: 10px
];

/** margin-top: 18px on the drawn node, composed with the parent's own gap. */
const DRAWN_TOP_SEPARATION_PX = 18;

/** The card the drawing does not draw for this mounting. */
const THE_CARD = ["soft-panel", "soft-panel-flush", "rounded-card", "p-4"];

/**
 * Anything that would put the box back under another spelling: a fill, a
 * shadow, a ring, a full border, a radius of any scale, or the all-round or
 * horizontal inset a container needs. `pt-` is the drawn top padding and `mt-`
 * the drawn margin, so neither is prohibited here.
 */
function surfaceAdditionsOf(classes: string[]): string[] {
  return classes.filter(
    (name) =>
      /^(bg|shadow|ring|ring-offset|backdrop)-/.test(name) ||
      /^(soft-panel|border|shadow|ring)$/.test(name) ||
      /^rounded/.test(name) ||
      /^-?(p|px|py|pb|pl|pr|ps|pe)-/.test(name),
  );
}

/** Tailwind's spacing scale in this repository is the default 4px step. */
function stepPx(value: string): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n * 4 : null;
}

/** The node's OWN top margin in px, read from its class list. */
function topMarginPx(classes: string[]): number {
  for (const name of classes) {
    const arbitrary = /^(-?)mt-\[(-?\d+(?:\.\d+)?)px\]$/.exec(name);
    if (arbitrary) return (arbitrary[1] === "-" ? -1 : 1) * Number(arbitrary[2]);
    const step = /^(-?)mt-(\d+(?:\.\d+)?)$/.exec(name);
    if (step) {
      const px = stepPx(step[2]!);
      if (px !== null) return (step[1] === "-" ? -1 : 1) * px;
    }
  }
  return 0;
}

/** The gap the mounting's own parent already puts above the panel, in px. */
function parentGapPx(el: Element): number {
  const parent = el.parentElement;
  if (!parent) return 0;
  const classes = Array.from(parent.classList);
  if (!classes.includes("flex")) return 0;
  for (const name of classes) {
    const arbitrary = /^gap(?:-y)?-\[(\d+(?:\.\d+)?)px\]$/.exec(name);
    if (arbitrary) return Number(arbitrary[1]);
    const step = /^gap(?:-y)?-(\d+(?:\.\d+)?)$/.exec(name);
    if (step) {
      const px = stepPx(step[1]!);
      if (px !== null) return px;
    }
  }
  return 0;
}

/**
 * THE CENSUS, read from the package's own source: every file that mounts the
 * resolved install panel. The suite drives this set, so a mounting added in a
 * file this suite does not drive fails here.
 */
function sourceFilesMountingThePanel(): string[] {
  const src = dirname(dirname(fileURLToPath(import.meta.url)));
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".tsx") && readFileSync(full, "utf8").includes("<UploadInstallScopePanel")) {
        found.push(relative(src, full));
      }
    }
  };
  walk(src);
  return found.sort();
}

/** The files the MOUNTINGS below drive, in the same shape. */
const CENSUS_FILES = ["import-form.tsx", "upload-repository-link-form.tsx"];

/** Every class that would re-introduce a bordered box on an ancestor. */
function boxClassesOf(el: Element): string[] {
  return Array.from(el.classList).filter(
    (name) =>
      name === "soft-panel" ||
      name === "soft-panel-flush" ||
      name === "border" ||
      name.startsWith("rounded-card") ||
      /^border-[0-9]/.test(name),
  );
}

function fileInput(): HTMLInputElement {
  const input = document.querySelector('input[type="file"]');
  if (!input) throw new Error("file input not rendered");
  return input as HTMLInputElement;
}

function artifactZip(): File {
  const buf = createZipBuffer([
    {
      name: "package.json",
      content: JSON.stringify({
        name: "@acme/thing-artifact",
        version: "1.0.0",
        cinatra: { kind: "artifact" },
      }),
    },
    { name: "cinatra/artifact.json", content: JSON.stringify({ accepts: [] }) },
  ]);
  return new File([new Uint8Array(buf)], "fixture.zip", { type: "application/zip" });
}

/**
 * THE CENSUS. Both mountings of the resolved install panel on this screen,
 * each driven to the state in which the panel is on the screen.
 */
const MOUNTINGS: {
  label: string;
  drive: () => Promise<HTMLElement>;
}[] = [
  {
    label: "the GitHub tab's form (upload-repository-link-form.tsx)",
    drive: async () => {
      actions.previewSuppliedRepositoryAction.mockResolvedValue({
        ok: true,
        preview: {
          kind: "skill",
          packageName: "@cinatra-ai/web-research-skill",
          version: "0.1.0",
          contentDigest: "a".repeat(64),
          resolvedSha: SHA,
          repo: "cinatra-ai/web-research-skill",
          ref: "main",
          archiveUrl: "https://codeload.github.com/cinatra-ai/web-research-skill/zip/main",
        },
      });
      const { container } = render(<ImportPackageFromGitHubForm installScope={INSTALL_SCOPE} />);
      fireEvent.change(screen.getByLabelText("Repository URL"), {
        target: { value: "https://github.com/cinatra-ai/web-research-skill" },
      });
      fireEvent.click(screen.getByTestId("github-upload-submit"));
      await waitFor(() => {
        expect(screen.getByTestId("upload-install-scope")).toBeTruthy();
      });
      return container;
    },
  },
  {
    label: "the File tab's form (import-form.tsx)",
    drive: async () => {
      const { container } = render(<ImportAgentForm installScope={INSTALL_SCOPE} />);
      fireEvent.change(fileInput(), { target: { files: [artifactZip()] } });
      await waitFor(() => {
        expect(screen.getByTestId("upload-install-scope")).toBeTruthy();
      });
      return container;
    },
  },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

afterAll(() => {
  // Vitest isolates this file's module registry already; the calls below are
  // belt and braces, so that the package's full run is the same with this file
  // present as without it.
  vi.doUnmock("next/navigation");
  vi.doUnmock("next/link");
  vi.doUnmock("../supplied-install-actions");
  vi.doUnmock("@/lib/cinatra-toast");
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("the resolved install panel draws WITHOUT a card, on every mounting", () => {
  it("grades every mounting of the resolved install panel against its drawn node", async () => {
    // Every mounting is driven and graded before anything is asserted, so a
    // run at a head where the card is still drawn reports EVERY mounting that
    // departs rather than stopping at the first one.
    const departures: string[] = [];
    const graded: string[] = [];

    for (const mounting of MOUNTINGS) {
      const formRoot = await mounting.drive();
      const panelRoot = screen.getByTestId("upload-install-scope");
      const classes = Array.from(panelRoot.classList);
      const where = `${mounting.label}, class list "${classes.join(" ")}"`;

      // NO CARD: neither the panel box class, nor a card radius, nor the inset
      // a box needs. The drawing draws no box for this mounting at all, so no
      // radius of any scale is drawn on it either.
      for (const cardClass of THE_CARD) {
        if (classes.includes(cardClass)) {
          departures.push(`${where} - still carries the card class ${cardClass}`);
        }
      }
      const radii = classes.filter((name) => name.startsWith("rounded"));
      if (radii.length > 0) {
        departures.push(`${where} - still carries a corner radius (${radii.join(" ")})`);
      }
      // ...and no other spelling of a box either - a fill, a shadow, a ring, a
      // full border or a container inset.
      const additions = surfaceAdditionsOf(classes).filter(
        (name) => !THE_CARD.includes(name) && !name.startsWith("rounded"),
      );
      if (additions.length > 0) {
        departures.push(
          `${where} - re-introduces the surface under another spelling (${additions.join(" ")})`,
        );
      }

      // THE DRAWN TREATMENT: a single top rule in the hairline, the drawn top
      // margin above it, the drawn top padding below it, the drawn 10px gap.
      for (const drawn of DRAWN_TREATMENT) {
        if (!classes.includes(drawn)) {
          departures.push(`${where} - is missing the drawn ${drawn}`);
        }
      }

      // The drawn 18px separation is the COMPOSED figure: whatever gap the
      // mounting's own parent already puts above the panel, plus this node's
      // own top margin. A flex item's margin does not collapse into that gap.
      const gap = parentGapPx(panelRoot);
      const margin = topMarginPx(classes);
      if (gap + margin !== DRAWN_TOP_SEPARATION_PX) {
        departures.push(
          `${where} - draws ${gap + margin}px above the top rule where the drawing draws ` +
            `${DRAWN_TOP_SEPARATION_PX}px (the parent's own gap ${gap}px plus this node's ${margin}px)`,
        );
      }

      // ...and nothing between this root and the form's own root puts the box
      // back, so removing it really does leave the one frame the drawing draws.
      for (let el = panelRoot.parentElement; el && el !== formRoot; el = el.parentElement) {
        const box = boxClassesOf(el);
        if (box.length > 0) {
          departures.push(
            `${mounting.label} - an element between the panel root and the form root ` +
              `re-introduces a bordered box (${box.join(" ")})`,
          );
        }
      }

      graded.push(mounting.label);
      cleanup();
      vi.clearAllMocks();
    }

    // THE CENSUS IS THE ACCEPTANCE, and it is read from the source rather than
    // asserted against itself: every file that mounts the panel must be one
    // this suite drives, so a third mounting added later fails here instead of
    // shipping un-graded.
    expect(sourceFilesMountingThePanel()).toEqual(CENSUS_FILES);
    expect(graded).toHaveLength(MOUNTINGS.length);
    expect(
      departures,
      `${departures.length} departure(s) from the drawn node, across ` +
        `${new Set(departures.map((line) => line.split(",")[0])).size} of ${MOUNTINGS.length} mountings:\n` +
        departures.map((line) => `  - ${line}`).join("\n"),
    ).toEqual([]);
  });
});

/**
 * THE PINNED HALF. Nothing else on the screen moves - green before this leg's
 * edit and green after it.
 */
describe("the readings and the mounted panel are untouched by the drawn-surface fix", () => {
  it("keeps the four readings above the picker in their drawn order, with their faces and anchors", async () => {
    await MOUNTINGS[0]!.drive();

    const readings = screen.getByTestId("upload-resolved-package");
    const kind = screen.getByTestId("upload-resolved-kind");
    const pinned = screen.getByTestId("upload-pinned-sha");
    const provenance = screen.getByTestId("upload-resolved-source");

    // Row one: the outline kind badge, and beside it the package name with its
    // version.
    expect(kind.textContent).toBe("Skill");
    const firstRow = kind.parentElement!;
    expect(firstRow.textContent).toContain("@cinatra-ai/web-research-skill");
    expect(firstRow.textContent).toContain("0.1.0");

    // Row two, monospace: owner/repo pinned at the resolved commit sha.
    expect(pinned.textContent).toBe(`cinatra-ai/web-research-skill pinned at ${SHA}`);
    expect(Array.from(pinned.classList)).toContain("font-mono");

    // Row three, monospace and breaking anywhere: the provenance line.
    expect(provenance.textContent).toContain(
      "https://codeload.github.com/cinatra-ai/web-research-skill/zip/main",
    );
    expect(Array.from(provenance.classList)).toContain("font-mono");
    expect(Array.from(provenance.classList)).toContain("break-all");

    // The order is the drawn order, and the readings sit above the picker.
    const order = [firstRow, pinned, provenance].map((node) =>
      Array.from(readings.children).indexOf(node.closest("div, p") as Element),
    );
    expect(order).toEqual([0, 1, 2]);
    expect(
      readings.compareDocumentPosition(screen.getByTestId("extension-install-panel-picker")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps the section I.1 panel's own picker, its Workspace: All preselection and its action row", async () => {
    for (const mounting of MOUNTINGS) {
      await mounting.drive();

      const body = screen.getByTestId("extension-install-panel-body");
      expect(body.getAttribute("data-availability"), mounting.label).toBe("ready");
      expect(screen.getByTestId("extension-install-panel-picker"), mounting.label).toBeTruthy();
      expect(screen.getByTestId("extension-install-panel-submit"), mounting.label).toBeTruthy();
      expect(screen.getByTestId("extension-install-panel-cancel"), mounting.label).toBeTruthy();
      expect(
        screen.getByTestId("extension-install-panel-picker").textContent,
        mounting.label,
      ).toContain("Workspace: All");

      cleanup();
      vi.clearAllMocks();
    }
  });
});
