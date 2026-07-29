/**
 * Pins for the kernel-aware test fakes (src/testing.ts, cinatra#1939 S3).
 *
 * These prove the fakes satisfy `guardOrgMutation` END-TO-END — allow,
 * capability-deny, and organization-not-found — and that the content matcher
 * is precise: a writer's own statements (even ones mentioning
 * "organization") delegate to the wrapped fake untouched. If a kernel query
 * shape ever changes, these tests and testing.ts change in the same commit.
 */
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import {
  guardOrgMutation,
  OrgWriteRefusedError,
  type OrgWriteAuthority,
} from "../src/index";
import {
  answerKernelOrgWriteQuery,
  fakeOrgWriteDb,
  isKernelOrgWriteQuery,
  wrapTxWithOrgWriteKernel,
} from "../src/testing";

const authority = (orgId: string, caps: string[]): OrgWriteAuthority => ({
  orgId,
  can: (c) => caps.includes(c),
});

describe("fakeOrgWriteDb + guardOrgMutation end-to-end", () => {
  it("ACTIVE org + capable authority: callback runs; writer queries land on `executed`, kernel queries do not", async () => {
    const { db, executed } = fakeOrgWriteDb({ organization: { archivedAt: null } });
    const out = await guardOrgMutation(
      db,
      { orgId: "org-1", capability: "content.write", authority: authority("org-1", ["content.write"]) },
      async (tx) => {
        await tx.execute(sql`INSERT INTO "app"."dashboards" (id) VALUES (${"d1"})`);
        return "wrote";
      },
    );
    expect(out).toBe("wrote");
    // Only the writer's own statement reached the underlying fake — the org
    // locks and the state read were intercepted and answered.
    expect(executed).toHaveLength(1);
    expect(JSON.stringify(executed[0])).toContain("dashboards");
  });

  it("ARCHIVED org: content.write refuses (capability-denied) before the callback", async () => {
    const { db, executed } = fakeOrgWriteDb({
      organization: { archivedAt: "2026-07-01T00:00:00Z", archiveEpoch: 2 },
    });
    await expect(
      guardOrgMutation(
        db,
        { orgId: "org-1", capability: "content.write", authority: authority("org-1", ["content.write"]) },
        async () => "never",
      ),
    ).rejects.toThrow(OrgWriteRefusedError);
    expect(executed).toHaveLength(0);
  });

  it("organization: null refuses organization-not-found", async () => {
    const { db } = fakeOrgWriteDb({ organization: null });
    await expect(
      guardOrgMutation(
        db,
        { orgId: "org-x", capability: "content.write", authority: authority("org-x", ["content.write"]) },
        async () => "never",
      ),
    ).rejects.toThrow(/organization-not-found/);
  });
});

describe("wrapTxWithOrgWriteKernel composition", () => {
  it("layers execute over an existing fake and preserves its other members", async () => {
    const calls: unknown[] = [];
    const suiteFake = {
      execute: async (q: unknown) => {
        calls.push(q);
        return { rows: [{ own: true }] };
      },
      select: () => "builder-untouched",
    };
    const tx = wrapTxWithOrgWriteKernel(suiteFake, { organization: { archivedAt: null } });

    // Kernel query → answered, never reaches the suite fake.
    const state = await tx.execute(
      sql`SELECT "archivedAt", COALESCE("archiveEpoch", 0)::int AS "archiveEpoch" FROM public."organization" WHERE id = ${"o"} FOR SHARE`,
    );
    expect(JSON.stringify(state)).toContain("archiveEpoch");
    expect(calls).toHaveLength(0);

    // Writer query → delegated verbatim; non-execute members untouched.
    const own = await tx.execute(sql`UPDATE "app"."x" SET y = 1`);
    expect(own).toEqual({ rows: [{ own: true }] });
    expect(calls).toHaveLength(1);
    expect(tx.select()).toBe("builder-untouched");
  });
});

describe("matcher precision (the needles are kernel-distinctive)", () => {
  it("recognizes exactly the kernel's three query families", () => {
    expect(isKernelOrgWriteQuery(sql`SELECT pg_advisory_xact_lock(hashtext(${"a"}), hashtext(${"b"}))`)).toBe(true);
    expect(
      isKernelOrgWriteQuery(
        sql`SELECT "archivedAt", COALESCE("archiveEpoch", 0)::int AS "archiveEpoch" FROM public."organization" WHERE id = ${"o"} FOR SHARE`,
      ),
    ).toBe(true);
    expect(
      isKernelOrgWriteQuery(sql`SELECT 1 FROM ${sql.raw('"app"."org_archive_lease"')} WHERE org_id = ${"o"}`),
    ).toBe(true);
  });

  it("does NOT intercept writer statements that merely mention organizations", () => {
    for (const q of [
      sql`SELECT * FROM "app"."organization_settings" WHERE org = ${"o"}`,
      sql`UPDATE "app"."dashboards" SET "organizationId" = ${"o"}`,
      sql`SELECT "archiveEpoch" FROM "app"."snapshots"`, // no COALESCE shape
      { text: "SELECT 1 FROM organization" },
    ]) {
      expect(isKernelOrgWriteQuery(q)).toBe(false);
      expect(answerKernelOrgWriteQuery(q, { organization: { archivedAt: null } })).toBeUndefined();
    }
  });

  it("does NOT intercept a writer's SINGLE-ARG advisory lock (mutation-service's per-id twin lock)", () => {
    const twinLock = sql`SELECT pg_advisory_xact_lock(hashtext(${"dash-1"}))`;
    expect(isKernelOrgWriteQuery(twinLock)).toBe(false);
    expect(
      answerKernelOrgWriteQuery(twinLock, { organization: { archivedAt: null } }),
    ).toBeUndefined();
  });

  it("lease probe answers held/not-held from the flag (fail-closed default)", () => {
    const probe = sql`SELECT 1 FROM ${sql.raw('"app"."org_archive_lease"')} WHERE org_id = ${"o"}`;
    expect(answerKernelOrgWriteQuery(probe, { organization: {} })?.rows).toHaveLength(0);
    expect(
      answerKernelOrgWriteQuery(probe, { organization: {}, leaseHeld: true })?.rows,
    ).toHaveLength(1);
  });
});
