/**
 * Customer / external grant store tests.
 *
 * Verifies the grant writes BOTH a role_grant (customer/project) AND a
 * project_access(read) row, revoke removes both, and list maps rows.
 * The drizzle layer is mocked.
 */
import "server-only";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const insertOnConflict = vi.fn();
const insertValues = vi.fn(() => ({ onConflictDoUpdate: insertOnConflict }));
const insertMock = vi.fn(() => ({ values: insertValues }));
const executeMock = vi.fn();
const deleteReturning = vi.fn();
const deleteWhere = vi.fn(() => ({ returning: deleteReturning }));
const deleteMock = vi.fn(() => ({ where: deleteWhere }));
const selectWhere = vi.fn();
const selectFrom = vi.fn(() => ({ where: selectWhere }));
const selectMock = vi.fn(() => ({ from: selectFrom }));

// grant/revoke run inside ONE transaction (cinatra#1501: the same-org trigger
// must see the backing role_grant; no orphan on partial failure) — the mock tx
// exposes the same statement surface.
const dbShape = {
  insert: insertMock,
  execute: executeMock,
  delete: deleteMock,
  select: selectMock,
  transaction: (cb: (tx: unknown) => Promise<unknown>) => cb(dbShape),
};
vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: () => dbShape,
}));
vi.mock("pg", () => ({ Pool: class {} }));

import {
  grantCustomerAccess,
  revokeCustomerAccess,
  listCustomerGrantsForProject,
} from "../customer-grant-store";

describe("customer-grant-store", () => {
  beforeEach(() => {
    [insertOnConflict, insertValues, insertMock, executeMock, deleteReturning, deleteWhere, deleteMock, selectWhere, selectFrom, selectMock].forEach((m) => m.mockReset());
    insertValues.mockReturnValue({ onConflictDoUpdate: insertOnConflict });
    insertMock.mockReturnValue({ values: insertValues });
    deleteWhere.mockReturnValue({ returning: deleteReturning });
    deleteMock.mockReturnValue({ where: deleteWhere });
    selectFrom.mockReturnValue({ where: selectWhere });
    selectMock.mockReturnValue({ from: selectFrom });
    executeMock.mockResolvedValue({ rows: [] });
  });
  afterEach(() => vi.restoreAllMocks());

  it("grant writes a customer role_grant AND a project_access read row", async () => {
    insertOnConflict.mockResolvedValue(undefined);
    await grantCustomerAccess({ subjectUserId: "u1", projectId: "p1", orgId: "org-1", grantedBy: "admin", expiresAt: null });
    // role_grant insert
    expect(insertMock).toHaveBeenCalledTimes(1);
    const values = (insertValues.mock.calls as unknown as Array<[Record<string, unknown>]>)[0][0];
    expect(values).toMatchObject({ subjectUserId: "u1", role: "customer", scopeLevel: "project", scopeRecordId: "p1" });
    // project_access execute
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("revoke removes the role_grant AND the project_access row", async () => {
    deleteReturning.mockResolvedValue([{ subjectUserId: "u1" }]);
    const r = await revokeCustomerAccess({ subjectUserId: "u1", projectId: "p1" });
    expect(r).toEqual({ revoked: true });
    expect(deleteMock).toHaveBeenCalledTimes(1); // role_grant delete
    expect(executeMock).toHaveBeenCalledTimes(1); // project_access delete
  });

  it("revoke reports revoked:false when no role_grant row existed", async () => {
    deleteReturning.mockResolvedValue([]);
    const r = await revokeCustomerAccess({ subjectUserId: "ghost", projectId: "p1" });
    expect(r).toEqual({ revoked: false });
  });

  it("list maps role_grant rows to customer grant rows", async () => {
    const now = new Date("2026-05-20T00:00:00Z");
    selectWhere.mockResolvedValue([
      { subjectUserId: "u1", role: "customer", scopeLevel: "project", scopeRecordId: "p1", orgId: "org-1", grantedBy: "admin", grantedAt: now, expiresAt: null },
    ]);
    const rows = await listCustomerGrantsForProject("p1");
    expect(rows).toEqual([{ subjectUserId: "u1", projectId: "p1", grantedBy: "admin", grantedAt: now, expiresAt: null }]);
  });
});
