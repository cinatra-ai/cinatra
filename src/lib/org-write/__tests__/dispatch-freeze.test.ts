// cinatra#1940 P3 (Decision 1) — the dispatch-freeze leaf module. Pins:
// readOrgArchivedAtForDispatch's three outcomes (active → false, archived →
// true, unknown/error → null — NEVER a fabricated refusal on a read
// failure), and OrganizationArchivedDispatchError's typed shape + the
// product-clear message every caller surfaces verbatim.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const dialect = new PgDialect();

let orgRowExists: boolean;
let orgArchivedAt: Date | string | null;
let throwOnExecute: Error | null;

function fakeExecute(
  query: unknown,
): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
  if (throwOnExecute) return Promise.reject(throwOnExecute);
  const rendered = dialect.sqlToQuery(
    query as Parameters<PgDialect["sqlToQuery"]>[0],
  );
  const text = rendered.sql.replace(/\s+/g, " ").trim();
  if (text.includes('FROM public."organization"')) {
    return Promise.resolve({
      rows: orgRowExists ? [{ archivedAt: orgArchivedAt }] : [],
      rowCount: orgRowExists ? 1 : 0,
    });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}

vi.mock("@/lib/better-auth-db", () => ({
  betterAuthDb: { execute: (q: unknown) => fakeExecute(q) },
}));

import {
  readOrgArchivedAtForDispatch,
  OrganizationArchivedDispatchError,
  DISPATCH_FREEZE_S3,
} from "../dispatch-freeze";

beforeEach(() => {
  orgRowExists = true;
  orgArchivedAt = null;
  throwOnExecute = null;
});

describe("readOrgArchivedAtForDispatch — advisory (no-lock) pre-check read", () => {
  it("returns false for an active org (archivedAt null)", async () => {
    orgArchivedAt = null;
    await expect(readOrgArchivedAtForDispatch("org_1")).resolves.toBe(false);
  });

  it("returns true for an archived org (archivedAt set)", async () => {
    orgArchivedAt = new Date("2026-01-01T00:00:00Z");
    await expect(readOrgArchivedAtForDispatch("org_1")).resolves.toBe(true);
  });

  it("returns null (unknown) when the organization row is missing — never a fabricated refusal", async () => {
    orgRowExists = false;
    await expect(readOrgArchivedAtForDispatch("org_missing")).resolves.toBeNull();
  });

  it("returns null (unknown) on a read error — fail-open, never a fabricated refusal", async () => {
    throwOnExecute = new Error("connection reset");
    await expect(readOrgArchivedAtForDispatch("org_1")).resolves.toBeNull();
  });
});

describe("OrganizationArchivedDispatchError — the typed refusal", () => {
  it("carries a product-clear message + the typed fields every caller relies on", () => {
    const err = new OrganizationArchivedDispatchError("org_1", "enqueue");
    expect(err.name).toBe("OrganizationArchivedDispatchError");
    expect(err.code).toBe("ORG_ARCHIVED_DISPATCH_REFUSED");
    expect(err.orgId).toBe("org_1");
    expect(err.surface).toBe("enqueue");
    expect(err.message).toBe(
      "This organization is archived — agents cannot start new work.",
    );
    expect(err).toBeInstanceOf(Error);
  });

  it.each([
    "run-creation",
    "enqueue",
    "trigger-release",
    "worker-start",
    "content-editor",
  ] as const)("accepts the %s surface", (surface) => {
    const err = new OrganizationArchivedDispatchError("org_1", surface);
    expect(err.surface).toBe(surface);
  });
});

describe("DISPATCH_FREEZE_S3 — the structural-coupling sentinel", () => {
  it("is a truthy const (imported statically by organization-archive.ts)", () => {
    expect(DISPATCH_FREEZE_S3).toBe(true);
  });
});
