/**
 * PER-PRODUCER fixture for the globally mounted command menu
 * (cinatra#2701 change 1b, epic #2699 S2).
 *
 * The palette is mounted in `SearchProvider`, which sits in the app-wide
 * `Providers` tree, so it is reachable from every page by Cmd/Ctrl-K. It listed
 * seven `/configuration` destinations to everyone; each one now answers only to
 * a platform-admin session.
 *
 * Note the issue text names only two of them (`/configuration/llm`,
 * `/configuration/development`). The real menu carries five more, including one
 * in the "Navigate" group ("Artifacts — Restore objects"), so the rule is
 * applied to every entry rather than to the two examples.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { navGroups, navGroupsForViewer } from "../command-menu";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");

const allItems = (groups: typeof navGroups) => groups.flatMap((g) => g.items);

describe("cinatra#2701 — command-menu /configuration entries are admin-only", () => {
  it("the menu really does carry /configuration entries (the fixture is not vacuous)", () => {
    const configEntries = allItems(navGroups).filter((i) =>
      i.href.startsWith("/configuration"),
    );
    expect(configEntries.length).toBeGreaterThanOrEqual(7);
  });

  it("a NON-ADMIN is offered no /configuration destination at all", () => {
    const items = allItems(navGroupsForViewer(false));
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.href.startsWith("/configuration")).toBe(false);
    }
  });

  it("a non-admin keeps every non-configuration destination, unreordered", () => {
    const expected = allItems(navGroups)
      .filter((i) => !i.href.startsWith("/configuration"))
      .map((i) => i.href);
    expect(allItems(navGroupsForViewer(false)).map((i) => i.href)).toEqual(expected);
  });

  it("the Configuration group is dropped rather than rendered empty for a non-admin", () => {
    expect(navGroupsForViewer(false).map((g) => g.heading)).not.toContain("Configuration");
    for (const group of navGroupsForViewer(false)) {
      expect(group.items.length).toBeGreaterThan(0);
    }
  });

  it("an ADMIN sees the menu unchanged — same groups, same items, same order", () => {
    expect(navGroupsForViewer(true)).toEqual(navGroups);
  });

  it("the dialog renders the VIEWER-SCOPED groups, never the raw table", () => {
    const src = read("src/components/command-menu.tsx");
    expect(src).toMatch(/const viewerIsAdmin = useViewerIsAdmin\(\)/);
    expect(src).toMatch(/navGroupsForViewer\(viewerIsAdmin\)/);
    expect(src).toMatch(/\{groups\.map\(\(group\) => \(/);
    // The unfiltered table must not be mapped into the dialog again.
    expect(src).not.toMatch(/\{navGroups\.map\(/);
  });
});
