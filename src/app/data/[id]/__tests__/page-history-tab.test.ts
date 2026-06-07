import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Contract pin for the /data/[id] History surface. The detail page mounts
// the real `<ObjectHistoryPanel>` (not a false-UI placeholder reading "No
// history yet." / "Temporal history appears after the object is updated at
// least once.") and adds the `?focus=history` anchor. This source pin
// catches any regression that re-introduces the placeholder.
//
// Source pin chosen over a JSX render test because:
//   - `<ObjectDetailPage>` is a server component reading the live DB
//     via `requireAdminSession` + `getObjectById` (heavy infra to mock).
//   - The contract change is wiring — the substrate is well-tested in
//     `src/lib/object-history/__tests__/` and
//     `packages/objects/src/__tests__/`; the page contract is "the
//     placeholder is gone + the real panel imports + the focus prop
//     flows through."

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

describe("/data/[id] History surface", () => {
  describe("placeholder/false-UI removed", () => {
    it("ObjectDetailPage no longer renders the 'No history yet' placeholder", () => {
      const source = readRepoFile(
        "packages/objects/src/screens/object-detail-page.tsx",
      );
      expect(source).not.toMatch(/No history yet/);
      expect(source).not.toMatch(/Temporal history appears after/);
    });
  });

  describe("real <ObjectHistoryPanel> mount", () => {
    it("ObjectDetailPage imports <ObjectHistoryPanel> from the data-safety component path", () => {
      const source = readRepoFile(
        "packages/objects/src/screens/object-detail-page.tsx",
      );
      expect(source).toMatch(
        /from "@\/components\/data-safety\/object-history-panel"/,
      );
      expect(source).toMatch(/<ObjectHistoryPanel\s+objectId=\{id\}\s+orgId=\{orgId\}/);
    });
  });

  describe("?focus=history anchor support", () => {
    it("the /data/[id] route accepts searchParams and forwards focus to the screen", () => {
      const source = readRepoFile("src/app/data/[id]/page.tsx");
      expect(source).toMatch(/searchParams\??\s*:\s*Promise<\{\s*focus\?:\s*string\s*\}>/);
      expect(source).toMatch(/focus={focus}/);
      expect(source).toMatch(
        /sp\?\.focus === "history" \? "history" : undefined/,
      );
    });

    it("ObjectDetailPage swaps Tabs defaultValue to 'history' when focus === 'history'", () => {
      const source = readRepoFile(
        "packages/objects/src/screens/object-detail-page.tsx",
      );
      expect(source).toMatch(
        /defaultValue=\{focus === "history" \? "history" : "details"\}/,
      );
    });
  });

  describe("objects-browser link target — broken /objects/ link replaced with /data/", () => {
    it("ObjectsBrowserScreen rows link to /data/<id>, not the non-existent /objects/<id>", () => {
      const source = readRepoFile(
        "packages/objects/src/screens/objects-browser.tsx",
      );
      expect(source).toMatch(/href=\{`\/data\/\$\{row\.id\}`\}/);
      expect(source).not.toMatch(/href=\{`\/objects\/\$\{row\.id\}`\}/);
    });
  });

  describe("object-detail-drawer — same false-UI pattern eliminated", () => {
    it("drawer History tab no longer renders the 'No history yet' placeholder", () => {
      const source = readRepoFile(
        "packages/objects/src/screens/object-detail-drawer.tsx",
      );
      expect(source).not.toMatch(/No history yet/);
      expect(source).not.toMatch(/has one recorded state/);
    });

    it("drawer History tab links to the canonical /data/<id>?focus=history", () => {
      const source = readRepoFile(
        "packages/objects/src/screens/object-detail-drawer.tsx",
      );
      expect(source).toMatch(
        /href=\{`\/data\/\$\{object\.id\}\?focus=history`\}/,
      );
    });
  });
});
