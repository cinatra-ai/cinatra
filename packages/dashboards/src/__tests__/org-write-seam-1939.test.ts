/**
 * The dashboards org-write seam (cinatra#1939 S3, wave 1) — dark-slice pins.
 *
 * Proves the ONE front door every dashboards writer will convert onto:
 * fail-closed authority extraction, the kernel guard end-to-end (allow /
 * archived-deny / not-found via the kernel's OWN testing fakes), and the
 * load-bearing lock-order property — the ORGANIZATION locks are taken by the
 * kernel BEFORE the callback runs, so a writer's per-dashboard twin advisory
 * lock is always second (the org-first flip, free).
 */
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { OrgWriteAuthority } from "@cinatra-ai/org-write-kernel";
import { OrgWriteRefusedError } from "@cinatra-ai/org-write-kernel";
import {
  answerKernelOrgWriteQuery,
  wrapTxWithOrgWriteKernel,
  type KernelQueryAnswers,
} from "@cinatra-ai/org-write-kernel/testing";

import type { DashboardActor } from "../permissions";
import {
  DashboardOrgWriteAuthorityError,
  guardedDashboardsWrite,
  requireOrgWriteAuthority,
} from "../org-write-seam";

const authorityFor = (orgId: string): OrgWriteAuthority => ({
  orgId,
  can: (capability) => capability === "content.write",
});

const actorFor = (over: Partial<DashboardActor> = {}): DashboardActor => ({
  userId: "u1",
  organizationId: "org-1",
  teamIds: [],
  authority: authorityFor("org-1"),
  ...over,
});

/** Ordered-recording db: kernel queries answered from `answers`, everything
 *  (kernel or writer) appended to `order` so lock ordering is observable. */
function recordingDb(answers: KernelQueryAnswers) {
  const order: string[] = [];
  const base = {
    execute: async (query: unknown) => {
      order.push("writer");
      return { rows: [] };
    },
  };
  const inner = wrapTxWithOrgWriteKernel(base, answers);
  const tx = {
    execute: async (query: unknown) => {
      const answered = answerKernelOrgWriteQuery(query, answers);
      if (answered !== undefined) {
        order.push(
          JSON.stringify(query).includes("pg_advisory_xact_lock") ? "org-lock" : "kernel-read",
        );
        return answered;
      }
      order.push(
        JSON.stringify(query).includes("pg_advisory_xact_lock(hashtext(")
          ? "twin-lock"
          : "writer",
      );
      return inner.execute(query);
    },
  };
  const db = {
    transaction: async <R>(fn: (t: typeof tx) => Promise<R>): Promise<R> => fn(tx),
  };
  return { db, order };
}

describe("requireOrgWriteAuthority (fail-closed)", () => {
  it("refuses an actor with no authority", () => {
    expect(() => requireOrgWriteAuthority(actorFor({ authority: undefined }))).toThrow(
      DashboardOrgWriteAuthorityError,
    );
  });

  it("refuses an authority minted for a different organization", () => {
    expect(() =>
      requireOrgWriteAuthority(actorFor({ authority: authorityFor("org-OTHER") })),
    ).toThrow(/different organization/);
  });

  it("returns the authority when it matches the actor's organization", () => {
    const authority = authorityFor("org-1");
    expect(requireOrgWriteAuthority(actorFor({ authority }))).toBe(authority);
  });
});

describe("guardedDashboardsWrite end-to-end (kernel fakes)", () => {
  it("ACTIVE org: the callback runs inside the guard and its result returns", async () => {
    const { db } = recordingDb({ organization: { archivedAt: null } });
    const out = await guardedDashboardsWrite(
      actorFor(),
      { schema: "cinatra", db },
      async (tx) => {
        await tx.execute(sql`INSERT INTO "cinatra"."dashboards" (id) VALUES (${"d1"})`);
        return "row";
      },
    );
    expect(out).toBe("row");
  });

  it("ORG-FIRST LOCK ORDER: the kernel's org locks precede every writer statement — a twin lock taken in the callback is second", async () => {
    const { db, order } = recordingDb({ organization: { archivedAt: null } });
    await guardedDashboardsWrite(actorFor(), { schema: "cinatra", db }, async (tx) => {
      // The converted writers' first act (acquireTwinLockFirst shape).
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"dash-1"}))`);
      await tx.execute(sql`INSERT INTO "cinatra"."dashboards" (id) VALUES (${"dash-1"})`);
      return null;
    });
    const firstOrgLock = order.indexOf("org-lock");
    const firstTwinLock = order.indexOf("twin-lock");
    expect(firstOrgLock).toBeGreaterThanOrEqual(0);
    expect(firstTwinLock).toBeGreaterThan(firstOrgLock);
    // And the state read sits between the locks and the writer's payload.
    expect(order.indexOf("kernel-read")).toBeGreaterThan(firstOrgLock);
  });

  it("ARCHIVED org: content.write refuses before the callback (kernel capability ruling)", async () => {
    const { db, order } = recordingDb({
      organization: { archivedAt: "2026-07-01T00:00:00Z", archiveEpoch: 1 },
    });
    await expect(
      guardedDashboardsWrite(actorFor(), { schema: "cinatra", db }, async () => "never"),
    ).rejects.toThrow(OrgWriteRefusedError);
    expect(order).not.toContain("writer");
  });

  it("missing authority refuses BEFORE any transaction is opened", async () => {
    let opened = false;
    const db = {
      transaction: async <R>(fn: (t: { execute(q: unknown): Promise<unknown> }) => Promise<R>) => {
        opened = true;
        return fn({ execute: async () => ({ rows: [] }) });
      },
    };
    await expect(
      guardedDashboardsWrite(
        actorFor({ authority: undefined }),
        { schema: "cinatra", db },
        async () => "never",
      ),
    ).rejects.toThrow(DashboardOrgWriteAuthorityError);
    expect(opened).toBe(false);
  });
});

describe("narrowOrgWriteAuthority (the opaque-frame narrow, fail-closed)", async () => {
  const { narrowOrgWriteAuthority } = await import("../mcp/handlers");

  it("accepts a structurally-valid authority", () => {
    const authority = authorityFor("org-1");
    expect(narrowOrgWriteAuthority(authority)).toBe(authority);
  });

  it("reads anything malformed as NO authority (never a partial one)", () => {
    for (const bad of [
      undefined,
      null,
      "authority",
      42,
      {},
      { orgId: "org-1" }, // no can()
      { can: () => true }, // no orgId
      { orgId: 7, can: () => true }, // orgId not a string
    ]) {
      expect(narrowOrgWriteAuthority(bad)).toBeUndefined();
    }
  });
});
