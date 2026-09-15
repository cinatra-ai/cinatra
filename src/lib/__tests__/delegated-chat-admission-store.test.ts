import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  DELEGATED_CHAT_ADMISSION_KEY,
  __setDelegatedChatAdmissionStoreIoForTests,
  admitDelegatedChatDeclaration,
  loadDelegatedChatAdmissionSnapshot,
  noteDelegatedChatDeclarationChanged,
  revokeDelegatedChatAdmission,
  revokeDelegatedChatAdmissionsForPackage,
} from "@/lib/delegated-chat-admission-store";
import {
  admissionSnapshotCacheKey,
  computeDeclarationDigest,
} from "@cinatra-ai/mcp-server/delegated-chat-admission";
import {
  HOST_PRIMITIVE_OWNER_PACKAGE,
  HOST_PRIMITIVE_RELEASE_VERSION,
  HOST_PRIMITIVE_DECLARATIONS,
  coreDelegatedChatAdmissionRecords,
} from "@cinatra-ai/mcp-server/capability-plan";
import {
  __resetAdmissionPolicyGenerationForTests,
  __resetAdmissionReviewClockForTests,
  bumpActivationGeneration,
  nextAdmissionReviewMoment,
  __resetActivationGenerationForTests,
} from "@/lib/extension-activation-generation";

// ---------------------------------------------------------------------------
// THE DURABLE ADMISSION STORE (cinatra#2817 slice 2).
//
// Driven through an injected IO seam rather than a database, so the properties
// under test are the STORE's — migration idempotence, revocation, fail-closed
// behaviour on every unreadable state, and the invalidation keying — and not
// the metadata layer's, which has its own tests.
// ---------------------------------------------------------------------------

type Io = Parameters<typeof __setDelegatedChatAdmissionStoreIoForTests>[0];

/** An in-memory metadata row with the same CAS semantics the real store has. */
function memoryIo(initial?: string | null, faults?: { readRaw?: boolean; write?: boolean }) {
  const state = { raw: initial ?? null };
  const io: NonNullable<Io> = {
    readRaw: (key) => {
      if (faults?.readRaw) throw new Error("simulated read fault");
      return key === DELEGATED_CHAT_ADMISSION_KEY ? state.raw : null;
    },
    read: (_key, fallback) => fallback,
    cas: (key, value, expectedRaw) => {
      if (faults?.write) return false;
      if (key !== DELEGATED_CHAT_ADMISSION_KEY || state.raw !== expectedRaw) return false;
      state.raw = JSON.stringify(value);
      return true;
    },
    insertIfAbsent: (key, value) => {
      if (faults?.write) return;
      if (key === DELEGATED_CHAT_ADMISSION_KEY && state.raw === null) {
        state.raw = JSON.stringify(value);
      }
    },
    write: (key, value) => {
      if (faults?.write) throw new Error("simulated write fault");
      if (key === DELEGATED_CHAT_ADMISSION_KEY) state.raw = JSON.stringify(value);
    },
  };
  return { io, state };
}

const EXT_DECL = {
  ownerPackage: "@acme/widgets",
  resolvedVersion: "3.1.4",
  primitiveName: "acme_widget_catalog_list",
  declaredClass: "read",
} as const;

function extKey() {
  return {
    ownerPackage: EXT_DECL.ownerPackage,
    resolvedVersion: EXT_DECL.resolvedVersion,
    primitiveName: EXT_DECL.primitiveName,
    declarationDigest: computeDeclarationDigest(EXT_DECL),
  };
}

beforeEach(() => {
  __setDelegatedChatAdmissionStoreIoForTests(null);
  __resetAdmissionPolicyGenerationForTests();
  __resetActivationGenerationForTests();
});

describe("the core migration", () => {
  it("seeds this release's core records into an EMPTY store", async () => {
    const { io, state } = memoryIo(null);
    __setDelegatedChatAdmissionStoreIoForTests(io);
    const snapshot = await loadDelegatedChatAdmissionSnapshot();
    expect(snapshot.available).toBe(true);
    expect(snapshot.records).toHaveLength(Object.keys(HOST_PRIMITIVE_DECLARATIONS).length);
    expect(JSON.parse(state.raw!).coreMigratedAtRelease).toBe(HOST_PRIMITIVE_RELEASE_VERSION);
  });

  it("is IDEMPOTENT — a second load writes nothing and bumps nothing", async () => {
    const { io, state } = memoryIo(null);
    __setDelegatedChatAdmissionStoreIoForTests(io);
    await loadDelegatedChatAdmissionSnapshot();
    const afterFirst = state.raw;
    const generationAfterFirst = (await loadDelegatedChatAdmissionSnapshot()).admissionGeneration;
    expect(state.raw).toBe(afterFirst);
    expect((await loadDelegatedChatAdmissionSnapshot()).admissionGeneration).toBe(
      generationAfterFirst,
    );
  });

  it("re-migrates when the RELEASE changes, dropping the previous release's core records", async () => {
    const stale = JSON.stringify({
      coreMigratedAtRelease: "0000.0.0",
      records: [
        {
          ownerPackage: HOST_PRIMITIVE_OWNER_PACKAGE,
          resolvedVersion: "0000.0.0",
          primitiveName: "agent_list",
          declarationDigest: "stale",
          admittedClass: "discovery",
          revoked: false,
        },
      ],
    });
    const { io } = memoryIo(stale);
    __setDelegatedChatAdmissionStoreIoForTests(io);
    const snapshot = await loadDelegatedChatAdmissionSnapshot();
    // An admission is bound to the version it reviewed, so the old release's
    // approvals are stale by construction and must not linger.
    expect(snapshot.records.some((r) => r.resolvedVersion === "0000.0.0")).toBe(false);
    expect(snapshot.records.every((r) => r.resolvedVersion === HOST_PRIMITIVE_RELEASE_VERSION)).toBe(
      true,
    );
  });

  it("PRESERVES extension records across a core re-migration — their versions are their own", async () => {
    const { io } = memoryIo(null);
    __setDelegatedChatAdmissionStoreIoForTests(io);
    await loadDelegatedChatAdmissionSnapshot();
    await admitDelegatedChatDeclaration(EXT_DECL);
    // Force a re-migration by rewinding the marker.
    const current = JSON.parse(io.readRaw(DELEGATED_CHAT_ADMISSION_KEY)!);
    io.write(DELEGATED_CHAT_ADMISSION_KEY, { ...current, coreMigratedAtRelease: "0000.0.0" });
    const snapshot = await loadDelegatedChatAdmissionSnapshot();
    expect(snapshot.lookup(extKey())).toMatchObject({ admittedClass: "read" });
  });
});

describe("fail-closed store states", () => {
  it("a READ FAULT yields an UNAVAILABLE snapshot that admits nothing", async () => {
    const { io } = memoryIo(null, { readRaw: true });
    __setDelegatedChatAdmissionStoreIoForTests(io);
    const snapshot = await loadDelegatedChatAdmissionSnapshot();
    expect(snapshot.available).toBe(false);
    expect(snapshot.records).toEqual([]);
    expect(snapshot.lookup(extKey())).toBeUndefined();
  });

  it("a MALFORMED payload yields an UNAVAILABLE snapshot, never an empty-but-available one", async () => {
    // The distinction matters: an empty AVAILABLE store is a legitimate state
    // ("nothing reviewed yet"); an unreadable one is a fault, and conflating
    // them would let a corrupted row read as a deliberate empty policy.
    for (const bad of ["not json", "[]", '"scalar"', '{"records":{}}']) {
      const { io } = memoryIo(bad);
      __setDelegatedChatAdmissionStoreIoForTests(io);
      const snapshot = await loadDelegatedChatAdmissionSnapshot();
      expect(snapshot.available, bad).toBe(false);
    }
  });

  it("a MARKED but INCOMPLETE payload re-migrates rather than serving a hole", async () => {
    // A truncated write, a partially applied concurrent write or a hand-edited
    // row can carry the current marker while missing records. Trusting the
    // marker would serve an AVAILABLE snapshot with core primitives silently
    // absent — every one of them refused as "unadmitted".
    const { io } = memoryIo(
      JSON.stringify({ coreMigratedAtRelease: HOST_PRIMITIVE_RELEASE_VERSION, records: [] }),
    );
    __setDelegatedChatAdmissionStoreIoForTests(io);
    const snapshot = await loadDelegatedChatAdmissionSnapshot();
    expect(snapshot.available).toBe(true);
    expect(snapshot.records).toHaveLength(Object.keys(HOST_PRIMITIVE_DECLARATIONS).length);
  });

  it("a DELIBERATELY REVOKED core record is not mistaken for a broken migration", async () => {
    // Completeness is checked on PRESENCE, not on admission, so an operator's
    // revocation is not silently undone on the next read.
    const { io } = memoryIo(null);
    __setDelegatedChatAdmissionStoreIoForTests(io);
    await loadDelegatedChatAdmissionSnapshot();
    await revokeDelegatedChatAdmissionsForPackage(HOST_PRIMITIVE_OWNER_PACKAGE);
    const snapshot = await loadDelegatedChatAdmissionSnapshot();
    expect(snapshot.records.every((r) => r.revoked)).toBe(true);
  });

  it("a migration that cannot be persisted yields an UNAVAILABLE snapshot", async () => {
    // Serving from an in-memory migration the store never accepted would mean
    // the perimeter and the durable record disagreed about what was reviewed.
    // Reporting it as AVAILABLE-but-empty would be worse still: every core
    // primitive would be refused as "unadmitted" rather than as "the store is
    // unavailable", which is the wrong reason to hand an auditor.
    const { io } = memoryIo('{"records":[]}', { write: true });
    __setDelegatedChatAdmissionStoreIoForTests(io);
    const snapshot = await loadDelegatedChatAdmissionSnapshot();
    expect(snapshot.available).toBe(false);
    expect(snapshot.unavailableReason).toBe("core_migration_failed");
    expect(snapshot.records).toEqual([]);
  });

  it("a CONCURRENT migration that lost the CAS is NOT a fault", async () => {
    // The losing writer must not report a fault: the winner wrote the same
    // records, so the store is correct. Simulated by a CAS that always fails
    // against a row that already carries this release's marker.
    // The winner's row must be COMPLETE, not merely marked: completeness is
    // checked against the core declarations, so a marker over an empty record
    // set now reads as a broken migration (see the next case).
    const winner = JSON.stringify({
      coreMigratedAtRelease: HOST_PRIMITIVE_RELEASE_VERSION,
      records: coreDelegatedChatAdmissionRecords(),
    });
    let first = true;
    __setDelegatedChatAdmissionStoreIoForTests({
      // The first read sees a pre-migration row (so the migration runs); the
      // re-read after the lost CAS sees the winner's row.
      readRaw: () => {
        if (first) {
          first = false;
          return '{"records":[]}';
        }
        return winner;
      },
      read: (_k, fallback) => fallback,
      cas: () => false,
      insertIfAbsent: () => undefined,
      write: () => undefined,
    });
    const snapshot = await loadDelegatedChatAdmissionSnapshot();
    expect(snapshot.available).toBe(true);
  });

  it("a store that resolves no IO at all is unavailable, not permissive", async () => {
    __setDelegatedChatAdmissionStoreIoForTests({
      readRaw: () => {
        throw new Error("no database in this process");
      },
      read: (_k, fallback) => fallback,
      cas: () => false,
      insertIfAbsent: () => undefined,
      write: () => undefined,
    });
    expect((await loadDelegatedChatAdmissionSnapshot()).available).toBe(false);
  });
});

describe("review, revocation and invalidation", () => {
  it("an admission records the DECLARED class and nothing else", async () => {
    const { io } = memoryIo(null);
    __setDelegatedChatAdmissionStoreIoForTests(io);
    await loadDelegatedChatAdmissionSnapshot();
    expect(await admitDelegatedChatDeclaration(EXT_DECL)).toBe(true);
    const snapshot = await loadDelegatedChatAdmissionSnapshot();
    const record = snapshot.lookup(extKey());
    expect(record).toMatchObject({ admittedClass: "read", revoked: false });
    // There is no API by which a reviewer could approve a class the declaration
    // did not request: the record is minted FROM the declaration.
    expect(record!.declarationDigest).toBe(computeDeclarationDigest(EXT_DECL));
  });

  it("a revocation MARKS the record rather than deleting it", async () => {
    const { io } = memoryIo(null);
    __setDelegatedChatAdmissionStoreIoForTests(io);
    await loadDelegatedChatAdmissionSnapshot();
    await admitDelegatedChatDeclaration(EXT_DECL);
    expect(await revokeDelegatedChatAdmission(extKey())).toBe(true);
    const record = (await loadDelegatedChatAdmissionSnapshot()).lookup(extKey());
    // Retained, so the refusal can NAME revocation instead of degrading into
    // the indistinguishable "no record" case.
    expect(record).toMatchObject({ revoked: true });
  });

  it("a package-wide revocation withdraws every version", async () => {
    const { io } = memoryIo(null);
    __setDelegatedChatAdmissionStoreIoForTests(io);
    await loadDelegatedChatAdmissionSnapshot();
    await admitDelegatedChatDeclaration(EXT_DECL);
    await admitDelegatedChatDeclaration({ ...EXT_DECL, resolvedVersion: "4.0.0" });
    expect(await revokeDelegatedChatAdmissionsForPackage("@acme/widgets")).toBe(true);
    const snapshot = await loadDelegatedChatAdmissionSnapshot();
    for (const record of snapshot.records.filter((r) => r.ownerPackage === "@acme/widgets")) {
      expect(record.revoked).toBe(true);
    }
    // The core records are untouched.
    expect(
      snapshot.records.filter((r) => r.ownerPackage === HOST_PRIMITIVE_OWNER_PACKAGE).every(
        (r) => !r.revoked,
      ),
    ).toBe(true);
  });

  it("a REVOCATION changes the snapshot cache key — the invalidation cannot be missed", async () => {
    const { io } = memoryIo(null);
    __setDelegatedChatAdmissionStoreIoForTests(io);
    await loadDelegatedChatAdmissionSnapshot();
    await admitDelegatedChatDeclaration(EXT_DECL);
    const before = admissionSnapshotCacheKey(await loadDelegatedChatAdmissionSnapshot());
    await revokeDelegatedChatAdmission(extKey());
    const after = admissionSnapshotCacheKey(await loadDelegatedChatAdmissionSnapshot());
    expect(after).not.toBe(before);
  });

  it("an ACTIVATION transition changes the snapshot cache key too", async () => {
    const { io } = memoryIo(null);
    __setDelegatedChatAdmissionStoreIoForTests(io);
    const before = admissionSnapshotCacheKey(await loadDelegatedChatAdmissionSnapshot());
    bumpActivationGeneration("hot-update", "@acme/widgets");
    const after = admissionSnapshotCacheKey(await loadDelegatedChatAdmissionSnapshot());
    expect(after).not.toBe(before);
  });

  it("a DECLARATION CHANGE changes the cache key without editing any record", async () => {
    const { io } = memoryIo(null);
    __setDelegatedChatAdmissionStoreIoForTests(io);
    await loadDelegatedChatAdmissionSnapshot();
    await admitDelegatedChatDeclaration(EXT_DECL);
    const before = await loadDelegatedChatAdmissionSnapshot();
    noteDelegatedChatDeclarationChanged("@acme/widgets");
    const after = await loadDelegatedChatAdmissionSnapshot();
    expect(admissionSnapshotCacheKey(after)).not.toBe(admissionSnapshotCacheKey(before));
    // The old record is untouched — it simply stops matching, because the new
    // declaration produces a different digest.
    expect(after.lookup(extKey())).toMatchObject({ revoked: false });
    expect(
      after.lookup({
        ...extKey(),
        declarationDigest: computeDeclarationDigest({ ...EXT_DECL, declaredClass: "dispatch" }),
      }),
    ).toBeUndefined();
  });

  it("re-admitting the SAME tuple replaces rather than duplicating", async () => {
    const { io } = memoryIo(null);
    __setDelegatedChatAdmissionStoreIoForTests(io);
    await loadDelegatedChatAdmissionSnapshot();
    await admitDelegatedChatDeclaration(EXT_DECL);
    await revokeDelegatedChatAdmission(extKey());
    await admitDelegatedChatDeclaration(EXT_DECL);
    // A duplicate would have failed toward REVOKED; a replacement re-admits.
    expect((await loadDelegatedChatAdmissionSnapshot()).lookup(extKey())?.revoked).toBe(false);
  });
});

describe("the uninstall race", () => {
  it("a LATE-landing teardown revocation does not withdraw a FRESH re-admission", async () => {
    // The teardown chokepoint is a sync hook, so its durable withdrawal is
    // detached. Without the cutoff, a same-version reinstall re-admitted while
    // that write was still in flight would be silently withdrawn by a teardown
    // that predates it.
    const { io } = memoryIo(null);
    __setDelegatedChatAdmissionStoreIoForTests(io);
    await loadDelegatedChatAdmissionSnapshot();
    const teardownAt = { at: "2020-01-01T00:00:00.000Z", mint: "old-epoch.1" };
    await admitDelegatedChatDeclaration(EXT_DECL); // reviewedAt = now, > teardownAt
    await revokeDelegatedChatAdmissionsForPackage("@acme/widgets", {
      reviewedNotAfter: teardownAt,
    });
    expect((await loadDelegatedChatAdmissionSnapshot()).lookup(extKey())?.revoked).toBe(false);
  });

  it("an admission reviewed BEFORE the teardown IS withdrawn", async () => {
    const { io } = memoryIo(null);
    __setDelegatedChatAdmissionStoreIoForTests(io);
    await loadDelegatedChatAdmissionSnapshot();
    await admitDelegatedChatDeclaration(EXT_DECL);
    await revokeDelegatedChatAdmissionsForPackage("@acme/widgets", {
      reviewedNotAfter: {
        at: new Date(Date.now() + 60_000).toISOString(),
        mint: "later-epoch.1",
      },
    });
    expect((await loadDelegatedChatAdmissionSnapshot()).lookup(extKey())?.revoked).toBe(true);
  });

  // -------------------------------------------------------------------------
  // THE BOUNDARY. The two tests above stand a whole minute either side of the
  // cutoff, so neither ever asked what happens AT it — and at it was where the
  // guarantee failed. The stamp and the cutoff were both
  // `new Date().toISOString()`, so an uninstall and a reinstall's re-review
  // inside ONE millisecond minted equal strings and the strict comparison
  // withdrew the fresh review. The wall clock is frozen in these tests to hold
  // the whole sequence inside one millisecond.
  // -------------------------------------------------------------------------
  it("a re-admission in the SAME millisecond as the teardown SURVIVES", async () => {
    const { io } = memoryIo(null);
    __setDelegatedChatAdmissionStoreIoForTests(io);
    await loadDelegatedChatAdmissionSnapshot();

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));
      __resetAdmissionReviewClockForTests();
      // The pre-uninstall review, the uninstall, and the reinstall's re-review
      // — all three inside ONE frozen millisecond.
      await admitDelegatedChatDeclaration(EXT_DECL);
      const teardownAt = nextAdmissionReviewMoment();
      await admitDelegatedChatDeclaration(EXT_DECL);
      // The detached teardown write lands LAST, after the re-admission.
      await revokeDelegatedChatAdmissionsForPackage("@acme/widgets", {
        reviewedNotAfter: teardownAt,
      });
    } finally {
      vi.useRealTimers();
    }

    expect((await loadDelegatedChatAdmissionSnapshot()).lookup(extKey())?.revoked).toBe(false);
  });

  it("an admission in the same millisecond that PRECEDES the teardown is still withdrawn", async () => {
    // The mirror, and the reason the repair is an ordering and not a relaxed
    // comparison: keeping every same-instant record would let an admission that
    // genuinely precedes an uninstall outlive it.
    const { io } = memoryIo(null);
    __setDelegatedChatAdmissionStoreIoForTests(io);
    await loadDelegatedChatAdmissionSnapshot();

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));
      __resetAdmissionReviewClockForTests();
      await admitDelegatedChatDeclaration(EXT_DECL);
      const teardownAt = nextAdmissionReviewMoment();
      await revokeDelegatedChatAdmissionsForPackage("@acme/widgets", {
        reviewedNotAfter: teardownAt,
      });
    } finally {
      vi.useRealTimers();
    }

    expect((await loadDelegatedChatAdmissionSnapshot()).lookup(extKey())?.revoked).toBe(true);
  });

  it("a same-millisecond tie this process cannot own is withdrawn, not kept", async () => {
    // A teardown minted by ANOTHER process carries an epoch this store's
    // sequence cannot be compared against. Unorderable resolves to REVOKE: an
    // uninstalled package keeping its approval is the outcome this perimeter
    // may not produce, and a re-review is the cheap side of the trade.
    const { io } = memoryIo(null);
    __setDelegatedChatAdmissionStoreIoForTests(io);
    await loadDelegatedChatAdmissionSnapshot();

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));
      __resetAdmissionReviewClockForTests();
      await admitDelegatedChatDeclaration(EXT_DECL);
      await revokeDelegatedChatAdmissionsForPackage("@acme/widgets", {
        // Same instant, a sequence far ahead of ours — but a foreign epoch.
        reviewedNotAfter: { at: "2026-05-01T12:00:00.000Z", mint: "another-process.1" },
      });
    } finally {
      vi.useRealTimers();
    }

    expect((await loadDelegatedChatAdmissionSnapshot()).lookup(extKey())?.revoked).toBe(true);
  });
});
