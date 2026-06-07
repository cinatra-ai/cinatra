// Delete migration source-pins: the legacy soft-delete
// changeSetId enabler (conditional return), objects_delete surfacing it, the
// objects + lists client delete types, the <DeleteItemForm> client variant
// (refresh-in-place + the no-changeSetId plain-toast branch), the shared
// <ListItemActions> on the MutationResult contract, all four delete actions on
// MutationResult, the dedicated delete forms, and the inventory (3 object
// deletes MIGRATED; skills delete is not an object write).

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");

describe("legacy soft-delete changeSetId enabler (conditional)", () => {
  const store = read("src/lib/objects-store.ts");
  it("softDeleteObject returns the change_set id ONLY when a row transitioned", () => {
    expect(store).toMatch(/softDeleteObject\([\s\S]*?\): \{ changeSetId: string \| null \}/);
    // surfaced from the CTE, not the precomputed UUID (NULL on a no-op delete)
    expect(store).toMatch(/SELECT \(SELECT id FROM new_changeset\) AS change_set_id/);
    expect(store).toMatch(/return \{ changeSetId \}/);
  });
  it("objects_delete surfaces it; the objects client types it optional", () => {
    expect(read("packages/objects/src/mcp/handlers.ts")).toMatch(
      /const \{ changeSetId \} = softDeleteObject\(input\.objectId, \{ orgId \}\)/,
    );
    expect(read("packages/objects/src/mcp/client/deterministic-client.ts")).toMatch(
      /delete: \(objectId: string\) => invoke<\{ ok: true; changeSetId\?: string \}>/,
    );
  });
});

// The "lists delete threads changeSetId through all layers" block was
// removed: the lists MCP handler + deterministic client + actions were
// retired in the Twenty migration (handlers gutted to {}, the
// deterministic client deleted, the actions file deleted). Lists now
// live in Twenty and have no cinatra-side UI; there is no in-cinatra
// lists delete chain to thread changeSetId through. The generic
// <DeleteItemForm> / <ListItemActions> contract below remains valid
// for the surviving (non-CRM) object delete surfaces.

describe("<DeleteItemForm> — the delete variant of the pattern", () => {
  const src = read("src/components/data-safety/delete-item-form.tsx");
  it("is a client component, refreshes in place, and string-only successHref (no RSC island)", () => {
    expect(src).toMatch(/"use client"/);
    expect(src).toMatch(/router\.refresh\(\)/);
    expect(src).toMatch(/successHref\?: string/);
  });
  it("shows a plain toast when there is no changeSetId (non-object deletes like skills)", () => {
    expect(src).toMatch(/if \(state\.ok && !state\.changeSetId\)[\s\S]*toast\.success\(deletedTitle\)/);
    expect(src).toMatch(/showUndoToast\(state, \{ title: deletedTitle \}\)/);
  });
});

describe("shared <ListItemActions> on the MutationResult contract", () => {
  const src = read("src/components/list-item-actions.tsx");
  it("deleteAction returns MutationResult + renders <DeleteItemForm> (no raw <form action={deleteAction}>)", () => {
    expect(src).toMatch(/deleteAction: \(formData: FormData\) => Promise<MutationResult<unknown>>/);
    expect(src).toMatch(/<DeleteItemForm[\s\S]*action=\{deleteAction\}/);
    expect(src).not.toMatch(/<form action=\{deleteAction\}>/);
  });
});

describe("delete actions return MutationResult", () => {
  // The account/contact/list delete-action source-pins were removed: those
  // CRM write actions (packages/entity-{accounts,contacts}/src/actions.ts +
  // packages/lists/src/actions.ts) were retired in the Twenty migration. The
  // skills delete (a non-object write) still exercises the MutationResult
  // contract without a changeSetId, so it stays.
  it("skills delete redirects on success (F1 detail-page race fix) and returns MutationResult on failure", () => {
    const skills = read("packages/skills/src/actions.ts");
    // The return-type annotation stays: the failure path still returns a MutationResult.
    expect(skills).toMatch(/deletePersonalSkillAction\([\s\S]*?\): Promise<MutationResult<\{ skillId: string \}>>/);
    // SUCCESS redirects server-side (mirrors savePersonalSkillAction) so the edit page
    // never re-renders to notFound() under the just-deleted row before the client form's
    // success effect can fire (the detail-page race). The destination shows the toast via ?deleted=1.
    expect(skills).toMatch(/redirect\("\/skills\?scope=personal&deleted=1"\)/);
    // FAILURE still returns a MutationResult so the edit page surfaces an in-place error toast.
    expect(skills).toMatch(/return \{ ok: false, error: "The custom skill could not be deleted\." \}/);
    // The old {ok:true} return is gone (it caused the race), and skills are not
    // cinatra.objects rows so there is no changeSetId / Undo.
    expect(skills).not.toMatch(/return \{ ok: true, data: \{ skillId \} \}/);
    expect(skills).not.toMatch(/data: \{ skillId \}, changeSetId/);
  });
});

// The "dedicated detail-page delete forms" + "inventory reflects the delete
// migration" blocks were removed: the entity-accounts / entity-contacts /
// lists detail pages + delete actions were retired in the Twenty migration
// (CRM records live in Twenty; no cinatra-side UI). The soft-delete
// changeSetId enabler + the generic <DeleteItemForm> / <ListItemActions>
// contract above remain valid for the surviving (non-CRM) object delete
// surfaces. The PENDING=0 inventory invariant is covered by
// inventory-truthup.test.ts.
