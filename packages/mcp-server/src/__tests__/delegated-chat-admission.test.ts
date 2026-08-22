import { describe, it, expect } from "vitest";
import {
  admissionKey,
  admissionRecordFor,
  admissionSnapshotCacheKey,
  computeDeclarationDigest,
  createDelegatedChatAdmissionSnapshot,
  normalizeAdmissionRecord,
  unavailableDelegatedChatAdmissionSnapshot,
  DECLARATION_DIGEST_VERSION,
  type DelegatedChatAdmissionRecord,
} from "../delegated-chat-admission";
import {
  HOST_PRIMITIVE_OWNER_PACKAGE,
  HOST_PRIMITIVE_RELEASE_VERSION,
} from "../capability-plan";
import {
  HOST_PRIMITIVE_DECLARATIONS,
  coreDelegatedChatAdmissionRecords,
  hostDeclaredDelegatedChatClass,
} from "../host-primitive-declarations";
import { coreDelegatedChatAdmittedNames } from "../core-delegated-chat-surface";

// ---------------------------------------------------------------------------
// VERSION- AND DECLARATION-BOUND ADMISSION (cinatra#2817 slice 2).
//
// The properties under test are the four an admission must have to be worth
// anything: it must not apply to another version, must not transfer across a
// same-name collision, must not survive the declaration it approved changing,
// and must not be forgeable by an author who controls the strings that go into
// the key.
// ---------------------------------------------------------------------------

const READ_DECL = {
  ownerPackage: "@acme/widgets",
  resolvedVersion: "3.1.4",
  primitiveName: "acme_widget_catalog_list",
  declaredClass: "read",
} as const;

describe("computeDeclarationDigest", () => {
  it("is stable for the same declaration", () => {
    expect(computeDeclarationDigest(READ_DECL)).toBe(computeDeclarationDigest({ ...READ_DECL }));
  });

  it("changes when the CLASS changes — an admission cannot survive a re-declaration", () => {
    expect(computeDeclarationDigest({ ...READ_DECL, declaredClass: "dispatch" })).not.toBe(
      computeDeclarationDigest(READ_DECL),
    );
  });

  it("changes when the VERSION changes — an admission cannot cross a version", () => {
    expect(computeDeclarationDigest({ ...READ_DECL, resolvedVersion: "3.1.5" })).not.toBe(
      computeDeclarationDigest(READ_DECL),
    );
  });

  it("changes when the OWNER changes — an admission cannot transfer across a collision", () => {
    expect(computeDeclarationDigest({ ...READ_DECL, ownerPackage: "@evil/widgets" })).not.toBe(
      computeDeclarationDigest(READ_DECL),
    );
  });

  it("is case-insensitive in the primitive name only", () => {
    expect(computeDeclarationDigest({ ...READ_DECL, primitiveName: "ACME_Widget_Catalog_List" })).toBe(
      computeDeclarationDigest(READ_DECL),
    );
  });

  it("cannot be steered by DELIMITER INJECTION into an adjacent field", () => {
    // Without length-prefixed encoding, a package named `a|b` with primitive `c`
    // and a package `a` with primitive `b|c` would digest identically — and one
    // package's reviewed admission would authorize another's primitive.
    const a = computeDeclarationDigest({
      ownerPackage: "a:b",
      resolvedVersion: "1",
      primitiveName: "c",
      declaredClass: "read",
    });
    const b = computeDeclarationDigest({
      ownerPackage: "a",
      resolvedVersion: "1",
      primitiveName: "b:c",
      declaredClass: "read",
    });
    expect(a).not.toBe(b);
  });

  it("is domain-separated by the digest version", () => {
    // The version rides INSIDE the hash, so widening the input set later
    // invalidates every record rather than silently re-interpreting it.
    expect(DECLARATION_DIGEST_VERSION).toBe("v1");
    expect(computeDeclarationDigest(READ_DECL)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("admissionKey", () => {
  it("is injection-proof across its four fields", () => {
    const a = admissionKey({
      ownerPackage: "a:b",
      resolvedVersion: "1",
      primitiveName: "c",
      declarationDigest: "d",
    });
    const b = admissionKey({
      ownerPackage: "a",
      resolvedVersion: "b:1",
      primitiveName: "c",
      declarationDigest: "d",
    });
    expect(a).not.toBe(b);
  });
});

describe("normalizeAdmissionRecord", () => {
  const good = {
    ownerPackage: "@acme/widgets",
    resolvedVersion: "3.1.4",
    primitiveName: "acme_widget_catalog_list",
    declarationDigest: "deadbeef",
    admittedClass: "read",
    revoked: false,
  };

  it("accepts a well-formed record", () => {
    expect(normalizeAdmissionRecord(good)).toMatchObject({ admittedClass: "read", revoked: false });
  });

  it("REFUSES a record that admits `none` — an admission approving nothing is a contradiction", () => {
    expect(normalizeAdmissionRecord({ ...good, admittedClass: "none" })).toBeNull();
  });

  it("REFUSES a structurally broken record rather than reading a default", () => {
    for (const bad of [
      null,
      7,
      "x",
      { ...good, ownerPackage: "" },
      { ...good, resolvedVersion: 1 },
      { ...good, primitiveName: undefined },
      { ...good, declarationDigest: "" },
      { ...good, admittedClass: "wat" },
    ]) {
      expect(normalizeAdmissionRecord(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("the revocation state must be STATED — an absent or unreadable flag is unusable", () => {
    // Reading an omission as "not revoked" would turn a truncated write, a
    // downgraded writer or a hand-edited row into an ACTIVE admission.
    const { revoked: _dropped, ...withoutFlag } = good;
    void _dropped;
    expect(normalizeAdmissionRecord(withoutFlag)).toBeNull();
    expect(normalizeAdmissionRecord({ ...good, revoked: "no" })).toBeNull();
    expect(normalizeAdmissionRecord({ ...good, revoked: 0 })).toBeNull();
    expect(normalizeAdmissionRecord({ ...good, revoked: null })).toBeNull();
    // The two values that ARE readable read as themselves.
    expect(normalizeAdmissionRecord({ ...good, revoked: false })?.revoked).toBe(false);
    expect(normalizeAdmissionRecord({ ...good, revoked: true })?.revoked).toBe(true);
  });
});

describe("the snapshot", () => {
  const record = admissionRecordFor(READ_DECL);

  function snapshotOf(rawRecords: readonly unknown[]) {
    return createDelegatedChatAdmissionSnapshot({
      rawRecords,
      activationGeneration: 1,
      admissionGeneration: 2,
    });
  }

  it("finds an admitted record by its exact tuple", () => {
    expect(snapshotOf([record]).lookup(record)).toMatchObject({ admittedClass: "read" });
  });

  it("MISSES the same primitive at another version", () => {
    const snapshot = snapshotOf([record]);
    expect(
      snapshot.lookup({ ...record, resolvedVersion: "3.1.5" }),
    ).toBeUndefined();
  });

  it("MISSES the same name owned by another package", () => {
    expect(snapshotOf([record]).lookup({ ...record, ownerPackage: "@evil/widgets" })).toBeUndefined();
  });

  it("MISSES a changed declaration (a different digest)", () => {
    const changed = computeDeclarationDigest({ ...READ_DECL, declaredClass: "dispatch" });
    expect(snapshotOf([record]).lookup({ ...record, declarationDigest: changed })).toBeUndefined();
  });

  it("drops a malformed record and COUNTS it, rather than reading a default", () => {
    const snapshot = snapshotOf([record, { ownerPackage: "@x/y" }, 7]);
    expect(snapshot.malformedRecordCount).toBe(2);
    expect(snapshot.records).toHaveLength(1);
  });

  it("DUPLICATE tuples fail toward REVOKED rather than picking a winner", () => {
    const snapshot = snapshotOf([record, { ...record, reviewedAt: "2020-01-01T00:00:00.000Z" }]);
    expect(snapshot.lookup(record)?.revoked).toBe(true);
  });

  it("an UNAVAILABLE snapshot admits nothing and says why", () => {
    const snapshot = unavailableDelegatedChatAdmissionSnapshot({
      reason: "store_io_unavailable",
      activationGeneration: 1,
      admissionGeneration: 2,
    });
    expect(snapshot.available).toBe(false);
    expect(snapshot.unavailableReason).toBe("store_io_unavailable");
    expect(snapshot.lookup(record)).toBeUndefined();
    expect(snapshot.records).toEqual([]);
  });

  it("the cache key covers BOTH generations AND the content digest", () => {
    const base = snapshotOf([record]);
    const otherActivation = createDelegatedChatAdmissionSnapshot({
      rawRecords: [record],
      activationGeneration: 2,
      admissionGeneration: 2,
    });
    const otherAdmission = createDelegatedChatAdmissionSnapshot({
      rawRecords: [record],
      activationGeneration: 1,
      admissionGeneration: 3,
    });
    const otherContent = createDelegatedChatAdmissionSnapshot({
      rawRecords: [{ ...record, revoked: true }],
      activationGeneration: 1,
      admissionGeneration: 2,
    });
    const keys = [base, otherActivation, otherAdmission, otherContent].map(
      admissionSnapshotCacheKey,
    );
    expect(new Set(keys).size).toBe(4);
  });

  it("the policy digest is a function of the SET, not of row order", () => {
    const other = admissionRecordFor({ ...READ_DECL, primitiveName: "acme_widget_get" });
    expect(snapshotOf([record, other]).policyDigest).toBe(
      snapshotOf([other, record]).policyDigest,
    );
  });

  it("an unavailable snapshot never shares a cache key with an available one", () => {
    const unavailable = unavailableDelegatedChatAdmissionSnapshot({
      reason: "x",
      activationGeneration: 1,
      admissionGeneration: 2,
    });
    expect(admissionSnapshotCacheKey(unavailable)).not.toBe(
      admissionSnapshotCacheKey(snapshotOf([])),
    );
  });
});

// ---------------------------------------------------------------------------
// THE CORE MIGRATION. Core/bundled primitives have no package of their own, so
// the host declares for them and the migration writes release-versioned
// records. The invariant that matters: the migrated set is EXACTLY today's
// admitted catalog, so slice 3's swap changes what the perimeter reads, not
// what it lets through.
// ---------------------------------------------------------------------------
describe("core host-owned declarations and their migrated admissions", () => {
  it("declares exactly the names the legacy allowlist admits, in both directions", () => {
    expect(Object.keys(HOST_PRIMITIVE_DECLARATIONS).sort()).toEqual(
      [...coreDelegatedChatAdmittedNames()].sort(),
    );
  });

  it("declares only real classes, and never `none`", () => {
    for (const [name, cls] of Object.entries(HOST_PRIMITIVE_DECLARATIONS)) {
      expect(["read", "discovery", "dispatch"], name).toContain(cls);
    }
  });

  it("resolves a declaration case-insensitively and only for core names", () => {
    expect(hostDeclaredDelegatedChatClass("AGENT_LIST")).toBe("discovery");
    expect(hostDeclaredDelegatedChatClass("acme_widget_catalog_list")).toBeUndefined();
  });

  it("mints one release-versioned record per declaration, bound to the host identity", () => {
    const records = coreDelegatedChatAdmissionRecords();
    expect(records).toHaveLength(Object.keys(HOST_PRIMITIVE_DECLARATIONS).length);
    for (const record of records) {
      expect(record.ownerPackage).toBe(HOST_PRIMITIVE_OWNER_PACKAGE);
      expect(record.resolvedVersion).toBe(HOST_PRIMITIVE_RELEASE_VERSION);
      expect(record.revoked).toBe(false);
      expect(record.admittedClass).toBe(HOST_PRIMITIVE_DECLARATIONS[record.primitiveName]);
    }
  });

  it("a core record does NOT match the same primitive claimed by an extension", () => {
    const snapshot = createDelegatedChatAdmissionSnapshot({
      rawRecords: coreDelegatedChatAdmissionRecords(),
      activationGeneration: 0,
      admissionGeneration: 0,
    });
    const core = snapshot.records.find((r) => r.primitiveName === "agent_list")!;
    expect(snapshot.lookup(core)).toBeDefined();
    // Same name, same class, same digest string attempted — different owner.
    expect(snapshot.lookup({ ...core, ownerPackage: "@evil/agents" })).toBeUndefined();
    // Same owner, different version.
    expect(snapshot.lookup({ ...core, resolvedVersion: "0.0.0" })).toBeUndefined();
  });

  it("a core record's digest is over the CORE declaration — an extension cannot recompute it into a match", () => {
    const forged: DelegatedChatAdmissionRecord = {
      ownerPackage: "@evil/agents",
      resolvedVersion: HOST_PRIMITIVE_RELEASE_VERSION,
      primitiveName: "agent_list",
      declarationDigest: computeDeclarationDigest({
        ownerPackage: HOST_PRIMITIVE_OWNER_PACKAGE,
        resolvedVersion: HOST_PRIMITIVE_RELEASE_VERSION,
        primitiveName: "agent_list",
        declaredClass: "discovery",
      }),
      admittedClass: "discovery",
      revoked: false,
    };
    const snapshot = createDelegatedChatAdmissionSnapshot({
      rawRecords: coreDelegatedChatAdmissionRecords(),
      activationGeneration: 0,
      admissionGeneration: 0,
    });
    // Copying the host's digest buys nothing: the OWNER is part of the lookup
    // key, so the forged tuple is simply a tuple no review ever produced.
    expect(snapshot.lookup(forged)).toBeUndefined();
  });
});
