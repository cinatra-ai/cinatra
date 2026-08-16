import { describe, it, expect, vi, afterEach } from "vitest";
import type { Actor } from "@cinatra-ai/extension-types";
import type { InstalledExtension } from "../canonical-types";
import {
  describeLifecycleCapabilities,
  evaluateLifecycleCapability,
  evaluateLifecycleCapabilities,
  resolveLifecycleScope,
  pickLifecycleTargetRow,
  assertActorWriteStandingOverRow,
  NoAddressableRowError,
  AmbiguousLifecycleTargetError,
  LifecycleStandingError,
  PlatformAdminRequiredError,
  LIFECYCLE_CAPABILITY_OPS,
  type LifecycleCapabilityOp,
} from "../lifecycle-target-resolver";

// ---------------------------------------------------------------------------
// cinatra#2416 — the SERVER-DERIVED per-affordance capability, and the parity
// between it and the enforcement it is derived from.
//
// The whole point of the fix is that there is exactly ONE implementation of the
// addressing rule. These tests therefore assert two things:
//   1. the capability verdict AGREES, op by op, with what the enforcement path
//      (pickLifecycleTargetRow + assertActorWriteStandingOverRow, or the
//      platform-admin gate for force_delete) actually does with the same input;
//   2. `pickLifecycleTargetRow`'s observable behaviour — error classes, message
//      text, package-name selection — is byte-identical after being re-expressed
//      as a wrapper over the shared `resolveLifecycleScope`.
// ---------------------------------------------------------------------------

const PKG = "@acme/thing";

function row(
  id: string,
  organizationId: string | null,
  extra: Partial<InstalledExtension> = {},
): InstalledExtension {
  return {
    id,
    packageName: PKG,
    ownerLevel: organizationId == null ? "platform" : "organization",
    ownerId: organizationId,
    organizationId,
    kind: "agent",
    status: "active",
    source: { type: "verdaccio", version: "1.0.0" } as InstalledExtension["source"],
    requiredInProd: false,
    dependencies: [],
    manifestHash: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...extra,
  };
}

const platformAdmin = (orgId: string | null = null): Actor => ({
  actorType: "human",
  userId: "u-admin",
  source: "ui",
  platformRole: "platform_admin",
  ...(orgId != null ? { orgId } : {}),
});
const orgAdmin = (orgId: string): Actor => ({
  actorType: "human",
  userId: "u-org",
  source: "ui",
  orgId,
  orgRole: "org_admin",
});
const member = (orgId: string): Actor => ({
  actorType: "human",
  userId: "u-mem",
  source: "ui",
  orgId,
  orgRole: "member",
});
/** A PLATFORM-scoped session (no active org) holding NEITHER platform-admin
 *  standing NOR any org role: the second refused session shape. It is refused
 *  on a platform row exactly like an org-active session is, just through the
 *  STANDING gate instead of the scope gate. */
const noStanding = (): Actor => ({
  actorType: "human",
  userId: "u-none",
  source: "ui",
});

/** The row-scoped ops — every op whose dispatcher runs the row resolver. */
const ROW_SCOPED_OPS = ["archive", "activate", "uninstall"] as const;

// ---------------------------------------------------------------------------
// The defect this issue reports.
// ---------------------------------------------------------------------------

describe("evaluateLifecycleCapability — platform-anchored row, org-active session", () => {
  const rows = [row("iext-platform", null)];
  // cinatra#2698 dropped the "with no active organization" clause: a platform
  // admin now addresses an org-NULL row from ANY session, so telling an
  // administrator to clear their active organization would be a false
  // instruction. The principal named is unchanged.
  const PLATFORM_ROW_REASON =
    "Installed for the whole platform. Only a platform administrator can act on it.";

  // cinatra#2698 (S4): the org-active PLATFORM ADMIN is the case that FLIPPED.
  // Before this slice they were refused `no_addressable_row` on an org-NULL
  // row, which left the app-wide "Workspace: All" row they had installed
  // unmanageable from the very session they installed it in. `#2416`'s point —
  // that the rendered affordance and the enforced refusal come from ONE
  // implementation — is unaffected: both moved together.
  it.each(ROW_SCOPED_OPS)(
    "%s is ALLOWED for an org-active PLATFORM ADMIN — the org-NULL fallback",
    (op) => {
      const cap = evaluateLifecycleCapability(rows, platformAdmin("org-x"), op);
      expect(cap).toEqual({ op, allowed: true, code: "ok", reason: null });
    },
  );

  it.each(ROW_SCOPED_OPS)(
    "%s is DENIED for an org-active session WITHOUT platform standing (the #2416 refusal)",
    (op) => {
      const cap = evaluateLifecycleCapability(rows, orgAdmin("org-x"), op);
      expect(cap).toEqual({
        op,
        allowed: false,
        code: "no_addressable_row",
        reason: PLATFORM_ROW_REASON,
      });
    },
  );

  // The copy used to blame "an organization-scoped session" as though
  // clearing the active org were sufficient. It is not: a PLATFORM-scoped
  // session (orgId null) with no platform-admin standing is refused just as
  // hard, through the STANDING gate rather than the scope gate. Both session
  // shapes now read the SAME accurate reason.
  it.each(ROW_SCOPED_OPS)(
    "%s is ALSO DENIED for a platform-scoped, non-platform-admin session — the SAME reason",
    (op) => {
      const cap = evaluateLifecycleCapability(rows, noStanding(), op);
      expect(cap).toEqual({
        op,
        allowed: false,
        code: "no_write_standing",
        reason: PLATFORM_ROW_REASON,
      });
    },
  );

  it("force_delete stays ALLOWED — its dispatcher gate is platform standing, not row scope", () => {
    // Regression pin for the #2400 fix: that submission SUCCEEDS end to end
    // (forceDelete is package-global and takes no resolver), so disabling it
    // here would mint a new UI/dispatcher disagreement.
    const cap = evaluateLifecycleCapability(rows, platformAdmin("org-x"), "force_delete");
    expect(cap).toEqual({ op: "force_delete", allowed: true, code: "ok", reason: null });
  });

  it("an ORG admin is denied force_delete with the app's existing standing copy", () => {
    const cap = evaluateLifecycleCapability(rows, orgAdmin("org-x"), "force_delete");
    expect(cap).toEqual({
      op: "force_delete",
      allowed: false,
      code: "platform_admin_required",
      reason: "Requires platform admin.",
    });
  });
});

describe("evaluateLifecycleCapability — the ADDRESSABLE cases stay live", () => {
  it("a platform-scoped session (no active org) CAN address the platform row", () => {
    const rows = [row("iext-platform", null)];
    for (const op of LIFECYCLE_CAPABILITY_OPS) {
      expect(evaluateLifecycleCapability(rows, platformAdmin(null), op).allowed).toBe(true);
    }
  });

  it("an org-active session CAN address its OWN org's row", () => {
    const rows = [row("iext-orgx", "org-x")];
    for (const op of LIFECYCLE_CAPABILITY_OPS) {
      expect(evaluateLifecycleCapability(rows, platformAdmin("org-x"), op).allowed).toBe(true);
      // …and so does a plain org admin, for every row-scoped op.
      if (op !== "force_delete") {
        expect(evaluateLifecycleCapability(rows, orgAdmin("org-x"), op).allowed).toBe(true);
      }
    }
  });

  it("mixed platform + org rows: the org session addresses ITS row, not the platform one", () => {
    const rows = [row("iext-platform", null), row("iext-orgx", "org-x")];
    const resolution = resolveLifecycleScope(rows, orgAdmin("org-x"));
    expect(resolution.ok && resolution.row.id).toBe("iext-orgx");
    expect(evaluateLifecycleCapability(rows, orgAdmin("org-x"), "archive").allowed).toBe(true);
  });

  it("another org's row is NOT addressable — the cross-org bound", () => {
    const rows = [row("iext-orgx", "org-x")];
    const cap = evaluateLifecycleCapability(rows, orgAdmin("org-y"), "archive");
    expect(cap.allowed).toBe(false);
    expect(cap.code).toBe("no_addressable_row");
    expect(cap.reason).toBe("Not installed in your current scope.");
  });

  it("a platform-scoped session facing ONLY org rows gets the mirrored reason", () => {
    const rows = [row("iext-orgx", "org-x")];
    const cap = evaluateLifecycleCapability(rows, platformAdmin(null), "archive");
    expect(cap.allowed).toBe(false);
    expect(cap.reason).toBe(
      "Installed by an organization — a platform-scoped session can't act on it.",
    );
  });

  it("a member (no admin standing) over their own org's row is denied on STANDING", () => {
    const rows = [row("iext-orgx", "org-x")];
    const cap = evaluateLifecycleCapability(rows, member("org-x"), "archive");
    expect(cap).toEqual({
      op: "archive",
      allowed: false,
      code: "no_write_standing",
      reason: "Requires organization owner or admin role.",
    });
  });

  it("two rows in ONE scope fail closed as ambiguous, never an arbitrary pick", () => {
    const rows = [row("iext-a", "org-x"), row("iext-b", "org-x")];
    const cap = evaluateLifecycleCapability(rows, orgAdmin("org-x"), "archive");
    expect(cap.allowed).toBe(false);
    expect(cap.code).toBe("ambiguous_target");
  });

  it("a package with NO rows at all is not addressable", () => {
    expect(evaluateLifecycleCapability([], orgAdmin("org-x"), "archive")).toEqual({
      op: "archive",
      allowed: false,
      code: "no_addressable_row",
      reason: "Not installed in your current scope.",
    });
  });
});

// ---------------------------------------------------------------------------
// PARITY — the capability must never disagree with the enforcement.
// ---------------------------------------------------------------------------

/** Run the REAL enforcement sequence for `op` and report whether it refused. */
function enforcementAllows(
  rows: readonly InstalledExtension[],
  actor: Actor,
  op: LifecycleCapabilityOp,
): boolean {
  if (op === "force_delete") {
    // index.ts forceDelete: `if (!isPlatformAdminActor(actor)) throw`.
    try {
      if (actor.platformRole !== "platform_admin") {
        throw new PlatformAdminRequiredError("force_delete");
      }
      return true;
    } catch {
      return false;
    }
  }
  // index.ts archive / restore / uninstall: resolveLifecycleTargetRow, i.e.
  // pickLifecycleTargetRow then assertActorWriteStandingOverRow.
  try {
    const target = pickLifecycleTargetRow(rows, actor);
    assertActorWriteStandingOverRow(actor, target);
    return true;
  } catch (err) {
    if (
      err instanceof NoAddressableRowError ||
      err instanceof AmbiguousLifecycleTargetError ||
      err instanceof LifecycleStandingError
    ) {
      return false;
    }
    throw err;
  }
}

describe("capability ⇄ enforcement parity", () => {
  const ROW_SETS: Array<[string, InstalledExtension[]]> = [
    ["no rows", []],
    ["platform row only", [row("p", null)]],
    ["org-x row only", [row("x", "org-x")]],
    ["platform + org-x", [row("p", null), row("x", "org-x")]],
    ["org-x + org-y", [row("x", "org-x"), row("y", "org-y")]],
    ["two org-x rows (ambiguous)", [row("x1", "org-x"), row("x2", "org-x")]],
  ];
  const ACTORS: Array<[string, Actor]> = [
    ["platform admin, no org", platformAdmin(null)],
    ["platform admin, org-x active", platformAdmin("org-x")],
    ["platform admin, org-z active", platformAdmin("org-z")],
    ["org admin of org-x", orgAdmin("org-x")],
    ["org admin of org-y", orgAdmin("org-y")],
    ["member of org-x", member("org-x")],
    // The platform-scoped, no-standing shape the copy fix covers.
    ["no org, no standing", noStanding()],
  ];

  for (const [rowsLabel, rows] of ROW_SETS) {
    for (const [actorLabel, actor] of ACTORS) {
      it(`${rowsLabel} × ${actorLabel}: every op's verdict matches the enforcement`, () => {
        const byOp = evaluateLifecycleCapabilities(rows, actor);
        for (const op of LIFECYCLE_CAPABILITY_OPS) {
          expect(
            byOp[op].allowed,
            `${op} capability disagreed with the enforcement`,
          ).toBe(enforcementAllows(rows, actor, op));
        }
      });
    }
  }

  it("a denial ALWAYS carries copy and an allowance NEVER does (the union holds)", () => {
    for (const [, rows] of ROW_SETS) {
      for (const [, actor] of ACTORS) {
        const byOp = evaluateLifecycleCapabilities(rows, actor);
        for (const op of LIFECYCLE_CAPABILITY_OPS) {
          const cap = byOp[op];
          if (cap.allowed) {
            expect(cap.reason).toBeNull();
            expect(cap.code).toBe("ok");
          } else {
            expect(typeof cap.reason).toBe("string");
            expect(cap.reason.length).toBeGreaterThan(0);
            expect(cap.code).not.toBe("ok");
          }
          expect(cap.op).toBe(op);
        }
      }
    }
  });

  it("the capability carries NO row identity, org id or actor scope to the client", () => {
    const rows = [row("iext-secret", "org-secret")];
    const serialized = JSON.stringify(
      evaluateLifecycleCapabilities(rows, orgAdmin("org-other")),
    );
    expect(serialized).not.toContain("iext-secret");
    expect(serialized).not.toContain("org-secret");
    expect(serialized).not.toContain("org-other");
  });
});

// ---------------------------------------------------------------------------
// pickLifecycleTargetRow behaviour is UNCHANGED by the refactor.
// ---------------------------------------------------------------------------

describe("pickLifecycleTargetRow parity after the resolveLifecycleScope extraction", () => {
  it("no rows at all → the '<unknown>' package name is preserved", () => {
    try {
      pickLifecycleTargetRow([], orgAdmin("org-x"));
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(NoAddressableRowError);
      expect((err as NoAddressableRowError).packageName).toBe("<unknown>");
      expect((err as NoAddressableRowError).message).toBe(
        'No addressable installed_extension row for "<unknown>" in scope org org-x — refusing (the actor\'s scope has no row to act on).',
      );
    }
  });

  it("rows exist but none match → the FIRST row's package name is used", () => {
    const rows = [row("p", null)];
    try {
      pickLifecycleTargetRow(rows, orgAdmin("org-x"));
      throw new Error("expected a refusal");
    } catch (err) {
      expect((err as NoAddressableRowError).packageName).toBe(PKG);
      expect((err as NoAddressableRowError).scope).toBe("org org-x");
    }
  });

  it("a platform actor's scope label is unchanged", () => {
    try {
      pickLifecycleTargetRow([row("x", "org-x")], platformAdmin(null));
      throw new Error("expected a refusal");
    } catch (err) {
      expect((err as NoAddressableRowError).scope).toBe("platform (NULL-org)");
    }
  });

  it("ambiguity uses the FIRST CANDIDATE's package name + the candidate count", () => {
    const rows = [row("x1", "org-x"), row("x2", "org-x")];
    try {
      pickLifecycleTargetRow(rows, orgAdmin("org-x"));
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(AmbiguousLifecycleTargetError);
      expect((err as AmbiguousLifecycleTargetError).packageName).toBe(PKG);
      expect((err as AmbiguousLifecycleTargetError).count).toBe(2);
    }
  });

  it("returns the SAME row object (identity, not a copy)", () => {
    const target = row("x", "org-x");
    expect(pickLifecycleTargetRow([row("p", null), target], orgAdmin("org-x"))).toBe(target);
  });

  it("an undefined organizationId is treated as NULL (nullish parity)", () => {
    const rows = [row("p", null as unknown as string)];
    expect(resolveLifecycleScope(rows, platformAdmin(null)).ok).toBe(true);
  });

  it("an EMPTY-STRING org id keeps today's behaviour (a falsy-but-non-null org)", () => {
    // The actor's orgId is only ever set from a non-empty activeOrganizationId,
    // but pin the comparison so a future `|| null` coercion is caught.
    const rows = [row("e", "")];
    expect(resolveLifecycleScope(rows, { ...orgAdmin("org-x"), orgId: "" }).ok).toBe(true);
    expect(resolveLifecycleScope(rows, platformAdmin(null)).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// describeLifecycleCapabilities — the IO wrapper.
// ---------------------------------------------------------------------------

vi.mock("../canonical-store", () => ({
  readInstalledExtensionsByPackageName: vi.fn(),
}));

async function mockedStore() {
  return (await import("../canonical-store")) as unknown as {
    readInstalledExtensionsByPackageName: ReturnType<typeof vi.fn>;
  };
}

describe("describeLifecycleCapabilities", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports the PACKAGE-WIDE locked row, scope-blind (mirrors assertNoLockedCanonicalRow)", async () => {
    const locked = row("iext-platform", null, { status: "locked" });
    const target = row("iext-orgx", "org-x");
    const store = await mockedStore();
    store.readInstalledExtensionsByPackageName.mockResolvedValue([locked, target]);

    const d = await describeLifecycleCapabilities(PKG, orgAdmin("org-x"));
    expect(d.resolution.ok && d.resolution.row.id).toBe("iext-orgx");
    // The locked row is in ANOTHER scope, and it still surfaces — the caller
    // must be able to grey the affordances the dispatcher will refuse.
    expect(d.lockedRow?.id).toBe("iext-platform");
  });

  it("reports no locked row when none exists", async () => {
    const store = await mockedStore();
    store.readInstalledExtensionsByPackageName.mockResolvedValue([row("iext-orgx", "org-x")]);
    expect((await describeLifecycleCapabilities(PKG, orgAdmin("org-x"))).lockedRow).toBeNull();
  });

  it("a canonical-read failure fails CLOSED for the row-scoped ops and leaves force_delete role-derived", async () => {
    const store = await mockedStore();
    store.readInstalledExtensionsByPackageName.mockRejectedValue(new Error("db down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const admin = await describeLifecycleCapabilities(PKG, platformAdmin("org-x"));
    for (const op of ROW_SCOPED_OPS) {
      expect(admin.byOp[op]).toEqual({
        op,
        allowed: false,
        code: "indeterminate",
        reason: "Couldn't check this extension's install scope. Try again.",
      });
    }
    // force_delete never consulted the row scope, so reporting a scope-check
    // failure for it would be a lie — it keeps its honest platform-role verdict.
    expect(admin.byOp.force_delete).toEqual({
      op: "force_delete",
      allowed: true,
      code: "ok",
      reason: null,
    });
    expect(admin.lockedRow).toBeNull();
    expect(warn).toHaveBeenCalled();

    // …and a non-platform actor is still denied force_delete on standing.
    store.readInstalledExtensionsByPackageName.mockRejectedValue(new Error("db down"));
    const org = await describeLifecycleCapabilities(PKG, orgAdmin("org-x"));
    expect(org.byOp.force_delete.allowed).toBe(false);
    expect(org.byOp.force_delete.code).toBe("platform_admin_required");
  });

  it("an evaluation-time defect is NOT masked as `indeterminate` (only the READ is guarded)", async () => {
    const store = await mockedStore();
    // A row set that makes the pure evaluator throw would be a programming
    // defect; prove the guard is narrow by asserting a POISONED row propagates.
    store.readInstalledExtensionsByPackageName.mockResolvedValue([
      new Proxy(row("iext-orgx", "org-x"), {
        get(t, k) {
          if (k === "organizationId") throw new Error("poisoned row");
          return Reflect.get(t, k);
        },
      }),
    ]);
    await expect(describeLifecycleCapabilities(PKG, orgAdmin("org-x"))).rejects.toThrow(
      "poisoned row",
    );
  });
});

// ---------------------------------------------------------------------------
// Stable error codes (AC3's "expected error code").
// ---------------------------------------------------------------------------

describe("stable refusal codes", () => {
  it("each refusal carries its stable, duck-typable code", () => {
    expect(new NoAddressableRowError(PKG, "org x").code).toBe("NO_ADDRESSABLE_ROW");
    expect(new AmbiguousLifecycleTargetError(PKG, "org x", 2).code).toBe(
      "AMBIGUOUS_LIFECYCLE_TARGET",
    );
    expect(new LifecycleStandingError(PKG, "iext-1").code).toBe(
      "NO_LIFECYCLE_WRITE_STANDING",
    );
    expect(new PlatformAdminRequiredError("force_delete").code).toBe(
      "PLATFORM_ADMIN_REQUIRED",
    );
  });

  it("the code survives the dynamic-import boundary (duck-typed, not instanceof)", () => {
    const thrown: unknown = new NoAddressableRowError(PKG, "org x");
    const structural = JSON.parse(
      JSON.stringify({ code: (thrown as { code: string }).code, name: (thrown as Error).name }),
    );
    expect(structural).toEqual({
      code: "NO_ADDRESSABLE_ROW",
      name: "NoAddressableRowError",
    });
  });
});
