/**
 * cinatra#1909 — the seven carded empty states adopt the canonical <Empty>
 * primitive. Source locks are scoped to the EMPTY components only (the
 * error-state siblings intentionally keep their old shell — different issue),
 * per the design-review round:
 *   - each converted empty renders <Empty …> with its test/conformance
 *     attributes ON THE PRIMITIVE ROOT (prop pass-through → same node as
 *     data-slot="empty")
 *   - the divergent hand-rolled shell is gone from each empty component
 *   - the flagship keeps both `filtered` copy branches byte-for-byte
 *   - the notifications FILTERED branch stays a non-card muted line (§V)
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const OLD_SHELL = "bg-surface-strong px-5 py-10";

/** Slice a top-level `function Name(...)` body out of a source file. */
function componentSource(file: string, name: string): string {
  const source = readFileSync(file, "utf-8");
  const start = source.indexOf(`function ${name}`);
  expect(start, `${name} in ${file}`).toBeGreaterThan(-1);
  const rest = source.slice(start);
  const end = rest.indexOf("\nfunction ");
  return end === -1 ? rest : rest.slice(0, end);
}

/** The `<Empty …>` OPENING TAG of a component — attrs must live here, on the
 *  primitive root itself (same node as data-slot="empty"), not on a child. */
function emptyRootTag(componentSrc: string): string {
  const match = componentSrc.match(/<Empty\b([\s\S]*?)>/);
  expect(match, "an <Empty> root").not.toBeNull();
  return match![0];
}

const CONVERSIONS: ReadonlyArray<{
  file: string;
  component: string;
  attrs: readonly string[];
}> = [
  {
    file: "src/components/artifacts/library-mode.tsx",
    component: "LibraryEmptyState",
    attrs: [
      'data-testid="artifacts-library-empty"',
      'data-conformance-id="artifacts-library-empty"',
      'data-state="empty"',
    ],
  },
  {
    file: "src/components/artifacts/undo-mode.tsx",
    component: "UndoEmptyState",
    attrs: [
      'data-testid="artifacts-undo"',
      'data-conformance-id="artifacts-undo"',
      'data-state="empty"',
    ],
  },
  {
    file: "src/components/artifacts/console/type-definitions-tab.tsx",
    component: "TypeDefinitionsEmptyState",
    attrs: [
      'data-testid="artifacts-type-definitions"',
      'data-conformance-id="artifacts-type-definitions"',
      'data-state="empty"',
    ],
  },
  {
    file: "src/components/artifacts/console/restore-objects-tab.tsx",
    component: "RestoreEmptyState",
    attrs: [
      'data-testid="artifacts-restore-console"',
      'data-conformance-id="artifacts-restore-console"',
      'data-state="empty"',
    ],
  },
  {
    file: "src/components/artifacts/console/stored-objects-tab.tsx",
    component: "StoredObjectsEmptyState",
    attrs: [
      'data-testid="artifacts-stored-objects"',
      'data-conformance-id="artifacts-stored-objects"',
      'data-state="empty"',
    ],
  },
];

describe("carded empty states adopt <Empty> (#1909)", () => {
  it.each(CONVERSIONS)("$component: attrs ON the primitive root, plain (no className)", (c) => {
    const src = componentSource(c.file, c.component);
    expect(src).not.toContain(OLD_SHELL);
    const root = emptyRootTag(src);
    for (const attr of c.attrs) expect(root).toContain(attr);
    // Plain primitive: a className override could reintroduce the exact
    // divergence this issue removes (codex diff round).
    expect(root).not.toContain("className");
  });

  it("MergeProposalsMode's empty branch uses the primitive with its testid", () => {
    const src = readFileSync("src/components/artifacts/merge-proposals-mode.tsx", "utf-8");
    expect(src).toContain('<Empty data-testid="artifacts-merge-proposals" data-state="empty">');
    // The list shell below legitimately keeps bg-surface-strong; only the
    // old EMPTY shell (px-5 py-10 variant) must be gone.
    expect(src).not.toContain(OLD_SHELL);
  });

  it("flagship keeps both filtered copy branches byte-for-byte", () => {
    const src = componentSource(
      "src/components/artifacts/library-mode.tsx",
      "LibraryEmptyState",
    );
    expect(src).toContain("No artifacts match your filters");
    expect(src).toContain("No artifacts yet");
    expect(src).toContain("Try a different type or clear the search.");
    expect(src).toContain(
      "Artifacts appear here as your agents produce work and as you upload files.",
    );
  });

  it("error-state siblings intentionally keep their shell (out of scope)", () => {
    const src = componentSource(
      "src/components/artifacts/library-mode.tsx",
      "LibraryErrorState",
    );
    expect(src).toContain(OLD_SHELL);
  });

  it("notifications: conformance literal rides the <Empty> root; filtered branch stays a non-card", () => {
    const feed = readFileSync("src/app/notifications/notifications-feed.tsx", "utf-8");
    // Same-node guarantee: the pinned literal is a prop on the primitive
    // root, which is exactly the node stamped data-slot="empty" — and the
    // root stays plain (no className).
    expect(feed).toContain('<Empty data-conformance-id="notifications-empty">');
    const feedRoot = feed.match(/<Empty\b[^>]*data-conformance-id="notifications-empty"[^>]*>/);
    expect(feedRoot).not.toBeNull();
    expect(feedRoot![0]).not.toContain("className");
    expect(feed).toContain("No notifications");
    // §V: a filter that matches nothing on a non-empty feed stays a muted
    // line, never an empty card.
    expect(feed).toContain("Nothing {chipLabel} right now.");
    const filteredBranch = feed.slice(feed.indexOf("const chipLabel"));
    expect(filteredBranch.slice(0, 600)).not.toContain("<Empty");
  });
});
