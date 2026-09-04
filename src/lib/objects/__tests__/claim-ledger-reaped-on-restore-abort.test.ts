// ---------------------------------------------------------------------------
// THE CLAIM LEDGER IS REAPED ON *EVERY* DE-REGISTRATION ROAD (cinatra#3033,
// convergence review).
//
// The central teardown (`invalidateObjectTypesForPackage`) reaps the ledger at
// parity with the object types. It is not the only road: a restore abort
// de-registers the package's bridge surface through `deregisterIfOwned`, which
// removes object types and the matcher manifest DIRECTLY. A pack that only
// CLAIMS another namespace's type id registers neither of those, so both reaps
// there are no-ops for it — and without the ledger reap the aborted pack stays
// on the books as a claimant and the console goes on naming a gap for a pack
// that is not installed.
//
// Read as SOURCE TEXT deliberately: the wiring module is `server-only` and its
// hooks fire inside the extension lifecycle, so what is pinned here is that the
// reap sits on this road at all, beside the two it is at parity with.
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
  join(process.cwd(), "src/lib/objects/extension-artifact-claim-archival-wiring.ts"),
  "utf8",
);

function deregisterIfOwnedBody(): string {
  const start = source.indexOf("async function deregisterIfOwned(");
  expect(start).toBeGreaterThan(-1);
  const next = source.indexOf("\n// ---", start);
  return source.slice(start, next === -1 ? undefined : next);
}

describe("the restore-abort de-registration road", () => {
  it("reaps the cross-namespace claim ledger, not only the types and the matcher manifest", () => {
    const body = deregisterIfOwnedBody();
    expect(body).toContain("objectTypeRegistry.removeByPackage(packageName)");
    expect(body).toContain("matcherManifestRegistry.removeByPackage(packageName)");
    expect(body).toContain("forgetCrossNamespaceClaimsOf(packageName)");
  });

  it("reaps it AT PARITY — after the two registry reaps, inside the same best-effort block", () => {
    const body = deregisterIfOwnedBody();
    const matcher = body.indexOf("matcherManifestRegistry.removeByPackage(packageName)");
    const ledger = body.indexOf("forgetCrossNamespaceClaimsOf(packageName)");
    const catchAt = body.indexOf("} catch (err) {");
    expect(matcher).toBeGreaterThan(-1);
    expect(ledger).toBeGreaterThan(matcher);
    expect(catchAt).toBeGreaterThan(ledger);
  });
});
