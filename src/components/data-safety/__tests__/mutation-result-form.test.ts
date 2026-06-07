// MutationResultForm reference wrapper + objects-client
// changeSetId enabler. Source-pin (client component / server-action wiring;
// repo has no RTL at root) + the inventory reflecting the accounts migration.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");

describe("MutationResultForm (reference per-area wrapper)", () => {
  const src = read("src/components/data-safety/mutation-result-form.tsx");

  it("uses useActionState with the (_, fd) => action(fd) adapter", () => {
    expect(src).toMatch(/useActionState/);
    expect(src).toMatch(/\(_prev, formData\) => action\(formData\)/);
  });

  it("fires showUndoToast on the result + navigates on success", () => {
    expect(src).toMatch(/showUndoToast\(state, \{ title: successTitle \}\)/);
    expect(src).toMatch(/router\.push\(href\)/);
    expect(src).toMatch(/router\.refresh\(\)/);
  });

  it("ships a pending-aware MutationResultSubmit (useFormStatus) — double-submit guard", () => {
    expect(src).toMatch(/export function MutationResultSubmit/);
    expect(src).toMatch(/useFormStatus/);
    expect(src).toMatch(/disabled=\{pending\}/);
  });
});

describe("changeSetId enabler (objects-client write path)", () => {
  it("upsertObjectAndEnqueue returns the legacy changeSetId (additive spread)", () => {
    const src = read("src/lib/objects-store.ts");
    expect(src).toMatch(/ObjectRecord & \{ changeSetId: string \}/);
    expect(src).toMatch(/\.\.\.rowToObjectRecord\(row\), changeSetId: legacyChangeSetId/);
  });

  it("objects_update surfaces changeSetId; deterministic client types it optional", () => {
    expect(read("packages/objects/src/mcp/handlers.ts")).toMatch(
      /return \{ ok: true as const, changeSetId: updated\.changeSetId \}/,
    );
    expect(read("packages/objects/src/mcp/client/deterministic-client.ts")).toMatch(
      /\{ ok: true; changeSetId\?: string \}/,
    );
  });
});

// The accounts edit-form + accounts inventory blocks were removed: the
// entity-accounts CRM write surface (pages.tsx + actions.ts) was retired in
// the Twenty migration (CRM records live in Twenty; no cinatra-side UI).
// The generic MutationResultForm + objects-client changeSetId enabler above
// remain the reference per-area pattern for the surviving (non-CRM) object
// write surfaces.
