/**
 * PER-PRODUCER fixtures for the RESTORE half of the aligned-affordances sweep
 * (cinatra#2701, epic #2699 S2).
 *
 * Covered here:
 *   • `canRestoreChangeSetAction` — the server truth the toast reads;
 *   • the object-history panel + its "Restore to this version" button, whose
 *     only outward destinations are `/configuration/artifacts` surfaces;
 *   • the object detail drawer's "Open full history" control.
 *
 * The toast host itself has its own suite (`./undo-toast.test.ts`), and the
 * chat undo chip is pinned where its one shared gate lives
 * (`src/lib/chat/__tests__/undo-candidate-admin-gate.test.ts`).
 *
 * The panel and the drawer are async server components that read the session
 * directly, so they are pinned by source here — the repo carries no
 * server-component renderer at root — while the ACTION, which decides, is
 * exercised for real.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");

const mocks = vi.hoisted(() => ({
  getAuthSession: vi.fn(),
  requireAdminSession: vi.fn(),
  isSessionEligibleForTargetedRestore: vi.fn(async () => true),
  resolveSessionRestoreAuthz: vi.fn(async () => ({
    primitiveActor: { userId: "user_1" },
    roleHints: {},
  })),
}));

vi.mock("@/lib/auth-session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth-session")>(
    "@/lib/auth-session",
  );
  return {
    ...actual,
    getAuthSession: mocks.getAuthSession,
    requireAdminSession: mocks.requireAdminSession,
    resolveOrgRoleForSession: vi.fn(async () => "member"),
  };
});
vi.mock("@/lib/object-history", () => ({
  loadChangeSet: vi.fn(),
  restoreChangeSet: vi.fn(),
  resolveExternalFreshness: vi.fn(),
}));
vi.mock("@/lib/object-history/server-views", () => ({
  assertChangeSetRestoreAccess: vi.fn(),
}));
vi.mock("@/lib/object-history/restore-eligibility", () => ({
  resolveSessionRestoreAuthz: mocks.resolveSessionRestoreAuthz,
  isSessionEligibleForTargetedRestore: mocks.isSessionEligibleForTargetedRestore,
}));
vi.mock("@/lib/authz/errors", () => ({ AuthzError: class extends Error {} }));
vi.mock("@/lib/authz/build-actor-context", () => ({ actorFromSession: vi.fn() }));
vi.mock("@/lib/org-write/authority", () => ({ verifySessionAuthority: vi.fn() }));

import { canRestoreChangeSetAction } from "../restore-change-set-action";

const ADMIN = { user: { id: "u1", role: "user,admin" }, session: {} };
const MEMBER = { user: { id: "u2", role: "user" }, session: {} };

describe("cinatra#2701 — canRestoreChangeSetAction reports admin standing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("a NON-ADMIN is never eligible and is told so, WITHOUT the §VI probe running", async () => {
    mocks.getAuthSession.mockResolvedValue(MEMBER);
    await expect(canRestoreChangeSetAction({ changeSetId: "cs_1" })).resolves.toEqual({
      eligible: false,
      admin: false,
    });
    expect(mocks.isSessionEligibleForTargetedRestore).not.toHaveBeenCalled();
  });

  it("an unauthenticated caller is treated exactly as a non-admin (fail-closed)", async () => {
    mocks.getAuthSession.mockResolvedValue(null);
    await expect(canRestoreChangeSetAction({ changeSetId: "cs_1" })).resolves.toEqual({
      eligible: false,
      admin: false,
    });
  });

  it("an ADMIN still has the §VI per-object gate decide — no bypass, unchanged", async () => {
    mocks.getAuthSession.mockResolvedValue(ADMIN);
    mocks.isSessionEligibleForTargetedRestore.mockResolvedValue(false);
    await expect(canRestoreChangeSetAction({ changeSetId: "cs_1" })).resolves.toEqual({
      eligible: false,
      admin: true,
    });
    expect(mocks.isSessionEligibleForTargetedRestore).toHaveBeenCalledWith("cs_1");
  });

  it("an ELIGIBLE admin keeps the affordance", async () => {
    mocks.getAuthSession.mockResolvedValue(ADMIN);
    mocks.isSessionEligibleForTargetedRestore.mockResolvedValue(true);
    await expect(canRestoreChangeSetAction({ changeSetId: "cs_1" })).resolves.toEqual({
      eligible: true,
      admin: true,
    });
  });
});

describe("cinatra#2701 — object-history panel withholds both /configuration affordances", () => {
  const src = read("src/components/data-safety/object-history-panel.tsx");

  it("resolves the viewer's platform-admin standing itself (no caller can forget it)", () => {
    expect(src).toMatch(/isPlatformAdmin\(await getAuthSession\(\)/);
  });

  it("the per-event change-set link renders only for an admin", () => {
    expect(src).toMatch(
      /viewerIsAdmin \? \([\s\S]{0,200}\/configuration\/artifacts\?tab=restore/,
    );
  });

  it("the RestoreVersionButton renders only for an admin, ANDed onto canRestore", () => {
    expect(src).toMatch(/\{viewerIsAdmin &&\s*\n\s*props\.canRestore &&/);
  });

  it("the history events themselves are NOT gated — a member still reads them", () => {
    expect(src).toMatch(/events\.map\(\(event\) => \(/);
  });
});

describe("cinatra#2701 — object detail drawer withholds 'Open full history'", () => {
  const src = read("packages/objects/src/screens/object-detail-drawer.tsx");

  it("resolves platform-admin standing server-side", () => {
    expect(src).toMatch(/isPlatformAdmin\(await getAuthSession\(\)/);
  });

  it("the only /configuration control is behind the admin branch", () => {
    expect(src).toMatch(
      /viewerIsAdmin \? \([\s\S]{0,300}\/configuration\/artifacts\?tab=restore/,
    );
  });

  it("the explanatory copy stays for everyone", () => {
    expect(src).toMatch(/History lives on the canonical data detail page/);
  });
});
