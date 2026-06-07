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

describe("change-set detail bidirectional nav", () => {
  const SRC = "src/app/data-safety/change-sets/[changeSetId]/page.tsx";

  it("uses partitionEventsByReadAccess to get per-event read verdicts", () => {
    const src = read(SRC);
    expect(src).toMatch(/partitionEventsByReadAccess/);
    expect(src).toMatch(/canReadByEventId/);
  });

  it("renders the object deep-link ONLY for readable events (redacted = omitted)", () => {
    const src = read(SRC);
    expect(src).toMatch(/canReadByEventId\.get\(event\.id\)\s*\?/);
    expect(src).toMatch(/href=\{`\/data\/\$\{event\.objectId\}\?focus=history`\}/);
  });

  it("auto-opens the restore modal only when restorable + eligible + actor passes per-event restore authz", () => {
    const src = read(SRC);
    expect(src).toMatch(/defaultOpen=\{/);
    expect(src).toMatch(/sp\.openRestore === "1"/);
    expect(src).toMatch(/loaded\.changeSet\.restorable/);
    expect(src).toMatch(/eligibility\.eligible/);
    // The actor must pass the SAME per-event restore authz the confirm path
    // runs before auto-open.
    expect(src).toMatch(/actorCanRestore/);
    expect(src).toMatch(/canActorRestoreChangeSet\(/);
  });
});
