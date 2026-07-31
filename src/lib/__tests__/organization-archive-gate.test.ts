// cinatra#1937 (archive S1) — the default-OFF activation gate. Pins:
// fail-CLOSED gate reads (error/absent/non-true → OFF — the deliberate
// inversion of the fail-open instance-mode toggles) and the archive entry
// point refusing with `activation-gate-off` while off, BEFORE anything else
// runs (the stub's invariant, preserved verbatim by the real V5 transaction —
// whose own six-cell/wire-shape suite is organization-archive-tx.test.ts).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const readConnectorConfigFromDatabase = vi.fn();
vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: (...a: unknown[]) =>
    readConnectorConfigFromDatabase(...a),
}));

// The V5 transaction's other collaborators — mocked inert so THIS file stays
// the gate's own unit tier (none of these is ever reached while the gate is
// off; organization-archive-tx.test.ts drives them for real).
vi.mock("@/lib/auth-session", () => ({
  resolveOrgRoleForUser: vi.fn(),
}));
vi.mock("@/lib/authz/instance-mode", () => ({
  isSingleOrgMode: vi.fn(),
  readSingleOrgModeStrict: vi.fn(),
}));
vi.mock("@/lib/better-auth-db", () => ({
  betterAuthOrganizations: {},
  betterAuthDb: {},
}));

import {
  archiveOrganization,
  isArchiveActivationEnabled,
  ORG_ARCHIVE_ACTIVATION_CONFIG_KEY,
} from "@/lib/organization-archive";

beforeEach(() => {
  readConnectorConfigFromDatabase.mockReset();
});

describe("isArchiveActivationEnabled — fail-closed gate", () => {
  it("only a stored literal true enables", async () => {
    readConnectorConfigFromDatabase.mockReturnValue({ enabled: true });
    await expect(isArchiveActivationEnabled()).resolves.toBe(true);
    expect(readConnectorConfigFromDatabase).toHaveBeenCalledWith(
      ORG_ARCHIVE_ACTIVATION_CONFIG_KEY,
      null,
    );
  });

  it.each([
    ["absent row", null],
    ["empty config", {}],
    ["explicit false", { enabled: false }],
    ["truthy non-true string", { enabled: "true" }],
    ["truthy number", { enabled: 1 }],
  ])("OFF for %s", async (_label, cfg) => {
    readConnectorConfigFromDatabase.mockReturnValue(cfg);
    await expect(isArchiveActivationEnabled()).resolves.toBe(false);
  });

  it("OFF when the config read throws (fail closed — never activate on error)", async () => {
    readConnectorConfigFromDatabase.mockImplementation(() => {
      throw new Error("db down");
    });
    await expect(isArchiveActivationEnabled()).resolves.toBe(false);
  });
});

describe("archiveOrganization — the gate check stays FIRST (stub invariant, kept by V5)", () => {
  it("refuses with activation-gate-off while the gate is off — before ANY other read runs", async () => {
    readConnectorConfigFromDatabase.mockReturnValue(null);
    await expect(archiveOrganization("org_1", "user_1")).resolves.toEqual({
      ok: false,
      reason: "activation-gate-off",
    });
  });

  it("refuses gate-off regardless of arguments (no code path reaches the transaction)", async () => {
    readConnectorConfigFromDatabase.mockReturnValue({ enabled: false });
    await expect(archiveOrganization("", "")).resolves.toEqual({
      ok: false,
      reason: "activation-gate-off",
    });
  });
});

// cinatra#1940 P3 (Decision 7, design review) — the compile-time structural
// coupling: this file is the ONE gate every activation consumer flows
// through, so it must statically import the dispatch-freeze module (its
// `DISPATCH_FREEZE_S3` sentinel). This is a SOURCE-TEXT pin, deliberately
// static rather than behavioral: the point is to fail a future refactor that
// silently drops the import edge (which would not necessarily change any
// runtime behavior this file's other tests observe), independent of
// anything the S6 activation runbook does.
describe("organization-archive.ts → dispatch-freeze.ts structural coupling (cinatra#1940 P3, Decision 7)", () => {
  it("statically imports the dispatch-freeze module and references its sentinel", () => {
    const source = readFileSync(
      join(__dirname, "..", "organization-archive.ts"),
      "utf-8",
    );
    expect(source).toMatch(
      /from\s+["']@\/lib\/org-write\/dispatch-freeze["']/,
    );
    expect(source).toMatch(/\bDISPATCH_FREEZE_S3\b/);
  });
});
