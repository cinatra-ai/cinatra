// Bidirectional nav + URL-addressable modal wiring.
// Source-text contract test: the repo's vitest runs
// in a node environment without @testing-library/react, so client-component
// behaviour is pinned via source assertions (the established repo pattern —
// see access-combobox-disabled-scopes.test.ts). The pure URL logic is unit-
// tested separately in url-params.test.ts.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

describe("RestoreModal URL-addressable open", () => {
  const SRC = "src/components/data-safety/restore-modal.tsx";

  it("accepts a defaultOpen prop and seeds the open state from it", () => {
    const src = read(SRC);
    expect(src).toMatch(/defaultOpen\?:\s*boolean/);
    expect(src).toMatch(/useState\(props\.defaultOpen\s*\?\?\s*false\)/);
  });

  it("strips ?openRestore on close via router.replace (idempotent + back-safe)", () => {
    const src = read(SRC);
    expect(src).toMatch(/function handleOpenChange/);
    expect(src).toMatch(/stripOpenRestoreParam/);
    expect(src).toMatch(/router\.replace\(/);
    // replace, never push — leaves no history entry so back/forward won't reopen.
    expect(src).not.toMatch(/router\.push\(/);
  });

  it("routes both the Dialog onOpenChange and Cancel through handleOpenChange", () => {
    const src = read(SRC);
    expect(src).toMatch(/onOpenChange=\{handleOpenChange\}/);
    expect(src).toMatch(/onClick=\{\(\) => handleOpenChange\(false\)\}/);
  });
});

// The former `/data-safety/change-sets/[changeSetId]` detail route (with its
// per-event read redaction + auto-open restore) was retired in cinatra#1431
// §VII: undo is now the flat, admin-only `/artifacts?mode=undo` list, whose
// per-row RestoreModal re-checks per-object authorization on confirm. There is
// no longer a change-set detail page to assert here.
