/**
 * Pure-helper tests for the grant-form principal helpers
 * (cinatra#1505 / #1509 §4.2 — `grant-candidates.ts`).
 *
 * Locks the explicit #1505 AC:
 *  - the principal label map is static Title Case (`User`, never `user id` —
 *    no enum interpolation into labels, §3.2),
 *  - the ILIKE pattern escaping (clone-basis searchWorkspaceUsersForProject:
 *    backslash first, then `%`/`_`, via the single `[\\%_]` class),
 *  - the already-granted marking/exclusion semantics over access rows.
 */
import { describe, it, expect } from "vitest";

import {
  PRINCIPAL_LEVEL_LABELS,
  WORKSPACE_PRINCIPAL_ID,
  alreadyGrantedRole,
  grantedPrincipalIds,
  toIlikePattern,
  withoutGrantedPrincipal,
  type GrantedPrincipalRef,
} from "../grant-candidates";

describe("PRINCIPAL_LEVEL_LABELS (cinatra#1505 label casing AC)", () => {
  it("is the static Title-Case noun map — User, not `user id`", () => {
    expect(PRINCIPAL_LEVEL_LABELS).toEqual({
      user: "User",
      team: "Team",
      organization: "Organization",
      workspace: "Workspace",
    });
  });

  it("no label contains an id suffix or lowercase level noun", () => {
    for (const label of Object.values(PRINCIPAL_LEVEL_LABELS)) {
      expect(label).not.toMatch(/id/i);
      // Title Case: first character upper, and never the raw enum value.
      expect(label[0]).toBe(label[0]?.toUpperCase());
    }
    expect(Object.values(PRINCIPAL_LEVEL_LABELS)).not.toContain("user id");
  });

  it("workspace sentinel is unchanged (§4.2: `__workspace__` stays)", () => {
    expect(WORKSPACE_PRINCIPAL_ID).toBe("__workspace__");
  });
});

describe("toIlikePattern (§3.5 ILIKE wildcard + escape-char escaping)", () => {
  it("returns null for blank queries (callers skip the predicate)", () => {
    expect(toIlikePattern("")).toBeNull();
    expect(toIlikePattern("   ")).toBeNull();
  });

  it("wraps trimmed terms in wildcards", () => {
    expect(toIlikePattern("ada")).toBe("%ada%");
    expect(toIlikePattern("  ada ")).toBe("%ada%");
  });

  it("escapes %, _ and the backslash ESCAPE char itself", () => {
    expect(toIlikePattern("50%")).toBe("%50\\%%");
    expect(toIlikePattern("a_b")).toBe("%a\\_b%");
    expect(toIlikePattern("a\\b")).toBe("%a\\\\b%");
    // Backslash-then-wildcard stays a literal match: `\%` → `\\` + `\%`.
    expect(toIlikePattern("\\%")).toBe("%\\\\\\%%");
  });
});

describe("already-granted marking/exclusion (§4.2 exclude-or-mark)", () => {
  const rows: GrantedPrincipalRef[] = [
    { principalLevel: "user", principalId: "user-owner", role: "owner" },
    { principalLevel: "user", principalId: "user-reader", role: "read" },
    { principalLevel: "team", principalId: "team-1", role: "write" },
    { principalLevel: "workspace", principalId: "__workspace__", role: "read" },
  ];

  it("alreadyGrantedRole returns the granted role for a matching principal", () => {
    expect(alreadyGrantedRole(rows, "team", "team-1")).toBe("write");
    expect(
      alreadyGrantedRole(rows, "workspace", WORKSPACE_PRINCIPAL_ID),
    ).toBe("read");
  });

  it("the synthesized implicit-owner row counts as granted", () => {
    expect(alreadyGrantedRole(rows, "user", "user-owner")).toBe("owner");
  });

  it("returns null when the principal holds no row (level must match too)", () => {
    expect(alreadyGrantedRole(rows, "user", "user-new")).toBeNull();
    expect(alreadyGrantedRole(rows, "organization", "team-1")).toBeNull();
    expect(alreadyGrantedRole([], "workspace", WORKSPACE_PRINCIPAL_ID)).toBeNull();
  });

  it("grantedPrincipalIds feeds the user picker's excludeIds", () => {
    expect(grantedPrincipalIds(rows, "user")).toEqual([
      "user-owner",
      "user-reader",
    ]);
    expect(grantedPrincipalIds(rows, "organization")).toEqual([]);
  });

  it("grant → revoke in one session makes the principal grantable again", () => {
    // Grant: the session echo marks the principal as already granted…
    let echo: GrantedPrincipalRef[] = [];
    echo = [...echo, { principalLevel: "user", principalId: "user-new", role: "read" }];
    expect(alreadyGrantedRole(echo, "user", "user-new")).toBe("read");
    expect(grantedPrincipalIds(echo, "user")).toContain("user-new");

    // …revoke: the echo entry is removed (NOT append-only), so the principal
    // is grantable again immediately.
    echo = withoutGrantedPrincipal(echo, "user", "user-new");
    expect(alreadyGrantedRole(echo, "user", "user-new")).toBeNull();
    expect(grantedPrincipalIds(echo, "user")).not.toContain("user-new");
  });

  it("withoutGrantedPrincipal only drops the exact level+id match", () => {
    const after = withoutGrantedPrincipal(rows, "user", "user-reader");
    expect(alreadyGrantedRole(after, "user", "user-reader")).toBeNull();
    // Other levels / other users untouched.
    expect(alreadyGrantedRole(after, "user", "user-owner")).toBe("owner");
    expect(alreadyGrantedRole(after, "team", "team-1")).toBe("write");
    // Level must match: revoking a team id at user level is a no-op — and a
    // no-op returns the SAME array (no needless state write).
    expect(withoutGrantedPrincipal(rows, "user", "team-1")).toBe(rows);
  });
});
