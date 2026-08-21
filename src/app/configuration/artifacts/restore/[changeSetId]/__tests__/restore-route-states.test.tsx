/**
 * `/configuration/artifacts/restore/[changeSetId]` renders THREE states, one per
 * answer the eligibility gate can give (cinatra#2800).
 *
 * The bug this pins shut: the route used to render the authorization panel for
 * every negative, so an administrator following a stale link was told they were
 * not authorized — for a change set that simply no longer existed. The three
 * states now come from the gate's kind, and the two negatives carry DIFFERENT
 * words and DIFFERENT test ids in the same panel.
 *
 * The gate itself is mocked here on purpose: its own decisions (per-object
 * check, no admin bypass, fail-closed) are pinned in
 * `src/lib/object-history/__tests__/restore-eligibility.test.ts`. What this file
 * asserts is the mapping from answer to screen.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

const mocks = vi.hoisted(() => ({
  requireAdminSession: vi.fn(async () => ({ user: { id: "u1" } })),
  loadAuthorizedTargetedRestore: vi.fn(),
}));

vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: mocks.requireAdminSession,
}));
vi.mock("@/lib/object-history/restore-eligibility", () => ({
  loadAuthorizedTargetedRestore: mocks.loadAuthorizedTargetedRestore,
}));
// The confirmation body is `server-only` and reaches the restore server action;
// the route contract here is "it is mounted with the loaded change set".
vi.mock("@/components/artifacts/targeted-restore-mode", () => ({
  TargetedRestoreMode: ({ loaded }: { loaded: { changeSet: { id: string } } }) => (
    <div data-testid="artifacts-targeted-restore" data-change-set={loaded.changeSet.id} />
  ),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/configuration/artifacts/restore/cs_1",
}));

import TargetedRestorePage from "../page";

const LOADED = {
  changeSet: { id: "cs_1", restorable: true, openedAt: "2026-07-15T00:00:00Z" },
  events: [{ objectId: "obj_1", objectType: "contact", operation: "update" }],
};

async function renderRoute(changeSetId: string) {
  const ui = (await TargetedRestorePage({
    params: Promise.resolve({ changeSetId }),
  })) as ReactElement;
  return renderToStaticMarkup(ui);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdminSession.mockResolvedValue({ user: { id: "u1" } });
});

describe("targeted-restore route — one screen per gate answer (cinatra#2800)", () => {
  it("not_found: says the change set is gone, with no word about authorization", async () => {
    mocks.loadAuthorizedTargetedRestore.mockResolvedValue({ kind: "not_found" });

    const html = await renderRoute("no-such-change-set");

    expect(html).toContain('data-testid="artifacts-restore-route-missing"');
    expect(html).toContain(
      "This change set does not exist or can no longer be restored",
    );
    // THE REGRESSION: the missing case must never borrow the denial's words.
    expect(html).not.toContain('data-testid="artifacts-restore-route-denied"');
    expect(html).not.toMatch(/not authorized/i);
    expect(html).not.toMatch(/authorization/i);
    // ...and it keeps the way back.
    expect(html).toContain("Back to Restore objects");
    expect(html).toContain('href="/configuration/artifacts?tab=restore"');
    // No confirmation is offered for a change set that is not there.
    expect(html).not.toContain('data-testid="artifacts-targeted-restore"');
  });

  it("not_authorized: the change set exists — the authorization panel stays", async () => {
    mocks.loadAuthorizedTargetedRestore.mockResolvedValue({ kind: "not_authorized" });

    const html = await renderRoute("cs_1");

    expect(html).toContain('data-testid="artifacts-restore-route-denied"');
    expect(html).toContain("You&#x27;re not authorized to restore this change");
    expect(html).toContain(
      "Restoring a change set requires authorization for every object it touched.",
    );
    expect(html).toContain("Back to Restore objects");
    // The two negatives are told apart by their test id, never shared.
    expect(html).not.toContain('data-testid="artifacts-restore-route-missing"');
    expect(html).not.toContain('data-testid="artifacts-targeted-restore"');
  });

  it("authorized: renders the confirmation, mounted with the change set that was authorized", async () => {
    mocks.loadAuthorizedTargetedRestore.mockResolvedValue({
      kind: "authorized",
      loaded: LOADED,
    });

    const html = await renderRoute("cs_1");

    expect(html).toContain('data-testid="artifacts-restore-route"');
    expect(html).toContain('data-testid="artifacts-targeted-restore"');
    expect(html).toContain('data-change-set="cs_1"');
    expect(html).toContain("You are authorized to restore every affected object.");
    expect(html).not.toContain('data-testid="artifacts-restore-route-denied"');
    expect(html).not.toContain('data-testid="artifacts-restore-route-missing"');
  });

  it("keeps the admin gate first (cinatra#2700): the gate runs before the id is read", async () => {
    mocks.requireAdminSession.mockRejectedValue(new Error("NEXT_REDIRECT"));

    await expect(
      renderRoute("cs_1"),
    ).rejects.toThrow(/NEXT_REDIRECT/);
    expect(mocks.loadAuthorizedTargetedRestore).not.toHaveBeenCalled();
  });

  it("both negatives wear the same panel — same shape, different words", async () => {
    mocks.loadAuthorizedTargetedRestore.mockResolvedValue({ kind: "not_found" });
    const missing = await renderRoute("gone");
    mocks.loadAuthorizedTargetedRestore.mockResolvedValue({ kind: "not_authorized" });
    const denied = await renderRoute("cs_1");

    // The panel body is written once and worn by both states, so the shape
    // cannot drift apart: same classes, same error state, same way back.
    const PANEL_CLASS =
      'class="flex flex-col items-center gap-3 rounded-lg border border-line bg-surface-strong px-5 py-12 text-center"';
    for (const html of [missing, denied]) {
      expect(html).toContain(PANEL_CLASS);
      expect(html).toContain('data-state="error"');
      expect(html).toContain("Back to Restore objects");
    }
  });
});
