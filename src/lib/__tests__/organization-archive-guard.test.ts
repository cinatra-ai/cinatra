/**
 * App-native archived-organization write guard (cinatra#1942 archive V2 —
 * the "bypass audit" deliverable's shared helper).
 *
 * Truths locked here:
 *  - active org (archivedAt === null) -> resolves (no-op);
 *  - archived org (archivedAt is a Date/string) -> throws
 *    `OrganizationArchivedError` with `.reason === "org_archived"`;
 *  - a read FAILURE fails CLOSED (throws) — this app-native path has no
 *    kernel/DB backstop, unlike the dispatch-hook's per-endpoint SPLIT
 *    polarity, so "can't verify" must mean "refuse";
 *  - the reader is injectable (default param) so this suite never touches a
 *    real database.
 */
import { describe, expect, it } from "vitest";
import {
  assertTargetOrgNotArchived,
  OrganizationArchivedError,
} from "../organization-archive-guard";

describe("assertTargetOrgNotArchived", () => {
  it("resolves (no-op) when the org is active (archivedAt === null)", async () => {
    await expect(
      assertTargetOrgNotArchived("org-1", async () => null),
    ).resolves.toBeUndefined();
  });

  it("throws OrganizationArchivedError when the org is archived (Date)", async () => {
    const archivedAt = new Date("2026-07-01T00:00:00Z");
    await expect(
      assertTargetOrgNotArchived("org-1", async () => archivedAt),
    ).rejects.toBeInstanceOf(OrganizationArchivedError);
  });

  it("throws OrganizationArchivedError when the org is archived (string timestamp)", async () => {
    await expect(
      assertTargetOrgNotArchived("org-1", async () => "2026-07-01T00:00:00Z"),
    ).rejects.toBeInstanceOf(OrganizationArchivedError);
  });

  it("the thrown error carries reason 'org_archived' and names the org id", async () => {
    const err = await assertTargetOrgNotArchived("org-42", async () => new Date()).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(OrganizationArchivedError);
    expect((err as OrganizationArchivedError).reason).toBe("org_archived");
    expect((err as OrganizationArchivedError).message).toContain("org-42");
  });

  it("FAIL-CLOSED: a read failure throws (refuses) rather than proceeding", async () => {
    await expect(
      assertTargetOrgNotArchived("org-1", async () => {
        throw new Error("connection reset");
      }),
    ).rejects.toThrow(/could not verify archived state/i);
  });

  it("a read failure's thrown error is NOT an OrganizationArchivedError (distinct from the archived case)", async () => {
    const err = await assertTargetOrgNotArchived("org-1", async () => {
      throw new Error("boom");
    }).catch((e) => e);
    expect(err).not.toBeInstanceOf(OrganizationArchivedError);
    expect(err).toBeInstanceOf(Error);
  });
});
