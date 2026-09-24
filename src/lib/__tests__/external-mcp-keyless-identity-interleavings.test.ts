// cinatra#3485 fix leg 5: THE INTERLEAVING HARNESS for the one keyless
// identity lifecycle.
//
// Nine read-only rounds read this road by eye. This file reads it by running
// it: the committed save, delete and collision functions drive an in-memory
// double of the two stores whose every asynchronous call can be paused and
// resumed by the case, so an ordering is written down once and replayed
// exactly, with no wall clock anywhere in it.
//
// THE INVARIANT the harness measures, in four clauses:
//   A. when a save reports success, the live keyless identity on that row
//      belongs to the owner of the row write that stands, or no live identity
//      stands at all;
//   B. a delete never retires the identity of a row that stands again at its
//      id by the moment of the retire;
//   C. a save takes back only an identity its own call inserted, apart from
//      the one its own registration supersedes on its way in;
//   D. a row that stands never points at a stored key a delete took away.
//
// Clauses A, B and C are asserted after EVERY ordering below. Clause D is
// asserted where a fresh read can reach the change; the one window a fresh
// read cannot reach has a case of its own, so a later change to that road is
// visible here rather than silent.
//
// HOW A CASE DRIVES ITS ORDERING. `start` opens a road, `reaches` runs the
// others until a named one is parked at a named boundary, `step` lets one road
// travel to its next boundary, and `finish` lets it run to its end. Each of
// them is tolerant of a road that needs one boundary fewer than it used to, so
// the same case measures the same ordering before a fix and after it.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ExternalMcpServerScope } from "@/lib/external-mcp-registry";

// ---------------------------------------------------------------------------
// The scheduler: one named road per concurrent request.
// ---------------------------------------------------------------------------

const actorStore = new AsyncLocalStorage<string>();

/** The boundaries a case may pause a road at. */
type Boundary =
  /** the road's own authorization read, before it calls the lifecycle */
  | "authorized"
  | "identity:read"
  | "identity:register"
  /** INSIDE the registration: the identity row stands, its grant is still being seeded */
  | "identity:seed"
  | "identity:retire"
  | "credential:revoke";

type Arm = { label: Boundary; nth: number };
const arms = new Map<string, Arm[]>();
const hits = new Map<string, number>();
const parked = new Map<string, { label: Boundary; release: () => void }>();
const finished = new Set<string>();
const failures = new Map<string, unknown>();

/** Pause ROAD the NTH time it reaches LABEL. */
function pauseAt(road: string, label: Boundary, nth = 1): void {
  const list = arms.get(road) ?? [];
  list.push({ label, nth });
  arms.set(road, list);
}

/** The boundary itself, reached from inside a store double or a road body. */
async function boundary(label: Boundary): Promise<void> {
  const road = actorStore.getStore();
  if (road === undefined) return;
  const key = `${road}|${label}`;
  const nth = (hits.get(key) ?? 0) + 1;
  hits.set(key, nth);
  const list = arms.get(road);
  if (list === undefined) return;
  const index = list.findIndex((a) => a.label === label && a.nth === nth);
  if (index < 0) return;
  list.splice(index, 1);
  await new Promise<void>((resolve) => parked.set(road, { label, release: resolve }));
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const TICK_BUDGET = 400;

function release(road: string): void {
  const at = parked.get(road);
  if (at === undefined) throw new Error(`${road} is not parked`);
  parked.delete(road);
  at.release();
}

/** Run every road until ROAD is parked, at LABEL when one is named. */
async function reaches(road: string, label?: Boundary): Promise<void> {
  for (let i = 0; i < TICK_BUDGET; i += 1) {
    const at = parked.get(road);
    if (at && (label === undefined || at.label === label)) return;
    if (finished.has(road)) {
      throw new Error(`${road} finished before it reached ${label ?? "a pause"}`);
    }
    await tick();
  }
  throw new Error(`${road} never reached ${label ?? "a pause"}`);
}

/** Wait until ROAD is parked again or has run to its end. */
async function settles(road: string): Promise<void> {
  for (let i = 0; i < TICK_BUDGET; i += 1) {
    if (parked.has(road) || finished.has(road)) return;
    await tick();
  }
  throw new Error(`${road} neither parked nor finished`);
}

/** Let ROAD travel to its next boundary, or to its end. */
async function step(road: string): Promise<void> {
  if (finished.has(road)) return;
  await settles(road);
  if (finished.has(road)) return;
  release(road);
  await settles(road);
}

/** Let ROAD run to its end, releasing every boundary it reaches. */
async function finish(road: string): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    if (finished.has(road)) return;
    await step(road);
  }
  throw new Error(`${road} never finished`);
}

/** Run a road that the case armed no boundary on. */
async function completes(road: string): Promise<void> {
  for (let i = 0; i < TICK_BUDGET; i += 1) {
    if (finished.has(road)) return;
    const at = parked.get(road);
    if (at) throw new Error(`${road} parked at ${at.label} with no boundary armed`);
    await tick();
  }
  throw new Error(`${road} never completed`);
}

function start(road: string, travel: () => Promise<void>): void {
  void actorStore.run(road, async () => {
    try {
      await travel();
    } catch (err) {
      failures.set(road, err);
    }
    finished.add(road);
  });
}

function refusalOf(road: string): unknown {
  return failures.get(road);
}

// ---------------------------------------------------------------------------
// The two stores, in memory.
// ---------------------------------------------------------------------------

type Row = {
  id: string;
  scope: string;
  userId: string | null;
  nangoConnectionId: string | null;
  /** The person the standing write's own identity names. */
  derivedOwner: string;
  createdAt: string;
  updatedAt: string;
};

type Identity = {
  id: string;
  connectionId: string;
  ownerUserId: string;
  organizationId: string | null;
  deletedAt: Date | null;
};

const rows = new Map<string, Row>();
const identities = new Map<string, Identity>();
/** Stored keys a delete took away, by connection id. */
const deletedKeys = new Set<string>();
const credentialCalls: Array<string | null> = [];
/** Roads whose next registration inserts and then fails in its grant seed. */
const seedFailsFor = new Set<string>();

let clock = 0;
let identitySeq = 0;
/** A row that was already standing when the case began. */
const PLACED = "2025-12-31T00:00:00.000Z";

function nextStamp(): string {
  clock += 1;
  return new Date(Date.UTC(2026, 0, 1, 0, 0, clock)).toISOString();
}

/** Every store write a road made, in the order the roads made them. */
type Op =
  | { road: string; op: "register"; identityId: string; created: boolean }
  | {
      road: string;
      op: "retire";
      identityId: string;
      identityOwner: string;
      rowStanding: boolean;
      /** was the row that stood at this moment the retiring road's own write? */
      ownWriteStood: boolean;
    }
  | { road: string; op: "rowDelete"; serverId: string };
const ops: Op[] = [];

function currentRoad(): string {
  return actorStore.getStore() ?? "unknown";
}

function keylessIdOf(serverId: string): string {
  return `external-mcp-keyless-${serverId}`;
}

function liveIdentityAt(connectionId: string): Identity | null {
  return (
    [...identities.values()].find((r) => r.connectionId === connectionId && r.deletedAt === null) ??
    null
  );
}

function liveKeylessIdentity(serverId: string): Identity | null {
  return liveIdentityAt(keylessIdOf(serverId));
}

/** A row the case places by hand: it stood there before anything in the case ran. */
function placeRow(row: {
  id: string;
  scope: string;
  userId: string | null;
  derivedOwner: string;
  nangoConnectionId?: string | null;
}): void {
  rows.set(row.id, {
    id: row.id,
    scope: row.scope,
    userId: row.userId,
    nangoConnectionId: row.nangoConnectionId ?? null,
    derivedOwner: row.derivedOwner,
    createdAt: PLACED,
    updatedAt: PLACED,
  });
}

/** An identity the case places by hand, for the same reason. */
function placeIdentity(
  connectionId: string,
  ownerUserId: string,
  organizationId: string | null,
): Identity {
  identitySeq += 1;
  const row: Identity = {
    id: `identity-${identitySeq}`,
    connectionId,
    ownerUserId,
    organizationId,
    deletedAt: null,
  };
  identities.set(row.id, row);
  return row;
}

function serverBehind(identityId: string): boolean {
  const identity = identities.get(identityId);
  if (!identity) return false;
  const prefix = "external-mcp-keyless-";
  if (!identity.connectionId.startsWith(prefix)) return false;
  return rows.has(identity.connectionId.slice(prefix.length));
}

function retireNow(identityId: string): void {
  const row = identities.get(identityId);
  const road = currentRoad();
  ops.push({
    road,
    op: "retire",
    identityId,
    identityOwner: row?.ownerUserId ?? "unknown",
    rowStanding: serverBehind(identityId),
    ownWriteStood: ownWriteStands(road),
  });
  if (row && row.deletedAt === null) row.deletedAt = new Date();
}

/** Is the row that stands the one ROAD's own save wrote, stamps included? */
function ownWriteStands(road: string): boolean {
  const written = lastWriteOf.get(road);
  if (written === undefined) return false;
  const row = rows.get(written.serverId);
  return (
    row !== undefined && row.createdAt === written.createdAt && row.updatedAt === written.updatedAt
  );
}

class WriteConflict extends Error {}

// ---------------------------------------------------------------------------
// The registry double. Every ASYNCHRONOUS call passes a boundary the case can
// pause at; the synchronous row read does not, because no other road can run
// inside one.
// ---------------------------------------------------------------------------

vi.mock("@/lib/external-mcp-registry", () => ({
  getExternalMcpServerByIdFresh: (id: string) => {
    const row = rows.get(id);
    return row ? { ...row } : null;
  },
  normalizeExternalMcpRowStamp: (value: unknown) => {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
    if (typeof value !== "string" || value.trim() === "") return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  },
  externalMcpKeylessConnectionId: (serverId: string) => keylessIdOf(serverId),

  readExternalMcpKeylessConnectionIdentity: async (connectionId: string) => {
    await boundary("identity:read");
    const found = liveIdentityAt(connectionId);
    return found
      ? { id: found.id, ownerUserId: found.ownerUserId, organizationId: found.organizationId }
      : null;
  },

  // The real seam: an insert that answers with what it did, and the store's
  // own live-unique conflict, which hands back the standing row and hard-fails
  // a save that addressed somebody else's identity.
  registerExternalMcpKeylessConnectionIdentity: async (
    connectionId: string,
    identity: { ownerUserId: string; organizationId: string | null },
    report?: (written: { identityId: string; created: boolean }) => void,
  ) => {
    await boundary("identity:register");
    const road = currentRoad();
    const existing = liveIdentityAt(connectionId);
    if (existing) {
      report?.({ identityId: existing.id, created: false });
      ops.push({ road, op: "register", identityId: existing.id, created: false });
      if (existing.ownerUserId !== identity.ownerUserId) {
        throw new Error(
          `the connection "${connectionId}" is already registered to a different user`,
        );
      }
      if (
        existing.organizationId !== null &&
        identity.organizationId !== null &&
        existing.organizationId !== identity.organizationId
      ) {
        throw new Error(`the connection "${connectionId}" is registered under another workspace`);
      }
      return { created: false };
    }
    identitySeq += 1;
    const row: Identity = {
      id: `identity-${identitySeq}`,
      connectionId,
      ownerUserId: identity.ownerUserId,
      organizationId: identity.organizationId,
      deletedAt: null,
    };
    identities.set(row.id, row);
    report?.({ identityId: row.id, created: true });
    ops.push({ road, op: "register", identityId: row.id, created: true });
    // THE GRANT SEED, the seam's SECOND write. The identity row is standing by
    // now and the seed is a store call of its own, so another road runs right
    // through this point: anything the caller reads after the registration
    // returns is a reading about a later moment than the insert.
    await boundary("identity:seed");
    if (seedFailsFor.has(road)) {
      seedFailsFor.delete(road);
      // The seam writes the identity row and seeds its grant as two writes:
      // this is a failure of the second with the first already standing.
      throw new Error("the grant seed could not be written");
    }
    return { created: true };
  },

  // The store resolves its pool, THEN asks the caller's condition with the
  // query prepared, then writes. The boundary sits where that suspension is,
  // so a case can run another road between the caller's decision to retire and
  // the moment the condition is asked.
  retireExternalMcpKeylessConnectionIdentityRow: async (
    identityId: string,
    onlyWhile?: () => boolean,
  ) => {
    await boundary("identity:retire");
    if (onlyWhile !== undefined && !onlyWhile()) return;
    retireNow(identityId);
  },

  deleteExternalMcpServerGuarded: (
    id: string,
    expected: { scope: string; userId: string | null; nangoConnectionId?: string | null },
  ) => {
    const row = rows.get(id);
    const matches =
      row !== undefined &&
      row.scope === expected.scope &&
      row.userId === expected.userId &&
      (expected.nangoConnectionId === undefined ||
        row.nangoConnectionId === (expected.nangoConnectionId ?? null));
    if (!matches) throw new WriteConflict();
    rows.delete(id);
    ops.push({ road: currentRoad(), op: "rowDelete", serverId: id });
  },

  revokeExternalMcpApiKeyConnection: async (connectionId: string | null | undefined) => {
    credentialCalls.push(connectionId ?? null);
    if (!connectionId) return; // the helper returns before the connection service
    await boundary("credential:revoke");
    deletedKeys.add(connectionId);
    const identity = liveIdentityAt(connectionId);
    if (identity) identity.deletedAt = new Date();
  },

  ExternalMcpServerWriteConflictError: WriteConflict,
}));

const lifecycle = await import("@/lib/external-mcp-keyless-identity");

// ---------------------------------------------------------------------------
// The two roads a case drives, as the production callers drive them.
// ---------------------------------------------------------------------------

/** Every moment a save reported success, with the state at that moment. */
const successReports: Array<{ road: string; breach: string | null }> = [];
/** The person each save road's own identity names. */
const derivedOwnerOf = new Map<string, string>();
/** The stamps each save road's own row write returned. */
const lastWriteOf = new Map<string, { serverId: string; createdAt: string; updatedAt: string }>();

async function saveRoad(input: {
  serverId: string;
  scope: string;
  rowUserId: string | null;
  ownerUserId: string;
  organizationId: string | null;
  actorIsAdmin: boolean;
  storedCredential?: string | null;
  /** An id the caller supplied for a row that is not there yet. */
  create?: boolean;
}): Promise<void> {
  const {
    serverId,
    scope,
    rowUserId,
    ownerUserId,
    organizationId,
    actorIsAdmin,
    storedCredential = null,
  } = input;
  const seed: "owner" | "workspace" = scope === "user" ? "owner" : "workspace";
  derivedOwnerOf.set(currentRoad(), ownerUserId);
  const standing = rows.get(serverId);
  const guard =
    standing === undefined ? undefined : { scope: standing.scope, userId: standing.userId };
  await boundary("authorized");
  if (guard === undefined && input.create === true) {
    // The create road asks whether the supplied id is free before it writes.
    const collision = await lifecycle.keylessIdentityCollisionAtCreate({
      serverId,
      identityOwnerUserId: ownerUserId,
    });
    if (collision) {
      throw new Error(lifecycle.keylessIdentityCollisionMessage(serverId));
    }
  }
  const createdAt = standing?.createdAt ?? nextStamp();
  const updatedAt = nextStamp();
  rows.set(serverId, {
    id: serverId,
    scope,
    userId: rowUserId,
    nangoConnectionId: storedCredential,
    derivedOwner: ownerUserId,
    createdAt,
    updatedAt,
  });
  lastWriteOf.set(currentRoad(), { serverId, createdAt, updatedAt });
  await lifecycle.reconcileKeylessConnectionIdentityAfterSave({
    serverId,
    row: { scope, userId: rowUserId },
    guard,
    written: { createdAt, updatedAt },
    storedCredential,
    identity: { ownerUserId, organizationId, seed },
    actorIsAdmin,
  });
  successReports.push({ road: currentRoad(), breach: clauseABreach(currentRoad(), serverId) });
}

async function deleteRoad(input: {
  serverId: string;
  actorUserId: string;
  actorIsAdmin: boolean;
}): Promise<void> {
  const standing = rows.get(input.serverId);
  if (standing === undefined) throw new Error("no row to delete");
  const witnessed = {
    scope: standing.scope as ExternalMcpServerScope,
    userId: standing.userId,
    nangoConnectionId: standing.nangoConnectionId,
  };
  await boundary("authorized");
  await lifecycle.deleteExternalMcpServerRowWithIdentities({
    serverId: input.serverId,
    row: witnessed,
    actorUserId: input.actorUserId,
    actorIsAdmin: input.actorIsAdmin,
  });
}

// ---------------------------------------------------------------------------
// The invariant, clause by clause.
// ---------------------------------------------------------------------------

/** The live identity on a row, measured against the write that stands there. */
function ownershipBreach(serverId: string): string | null {
  const live = liveKeylessIdentity(serverId);
  if (live === null) return null;
  const row = rows.get(serverId);
  if (row === undefined) return `the identity of ${live.ownerUserId} is live with no row standing`;
  if (live.ownerUserId !== row.derivedOwner) {
    return `the identity of ${live.ownerUserId} is live on a row ${row.derivedOwner} wrote`;
  }
  return null;
}

/**
 * A: when a save reports success, the identity on ITS row belongs to it, or
 * none stands.
 *
 * Measured for the save whose own write is the one that stands. A save whose
 * write was already superseded when it finished is reporting success over a
 * configuration that is gone, and the identity on that row belongs to the
 * request that won it: holding the loser to the winner's row would force it to
 * take away an identity it merely confirmed, which is the first of the four
 * orderings. The winner's own report and the END STATE carry that row.
 */
function clauseABreach(road: string, serverId: string): string | null {
  if (!ownWriteStands(road)) return null;
  return ownershipBreach(serverId);
}

/** B: a delete never retires the identity of a row standing again at its id. */
function clauseBBreaches(deleteRoads: string[]): string[] {
  return ops.flatMap((op) =>
    op.op === "retire" && deleteRoads.includes(op.road) && op.rowStanding
      ? [`${op.road} retired ${op.identityId} while a row stood at its id`]
      : [],
  );
}

/**
 * C: a save takes back only an identity its own call inserted, and supersedes
 * another person's only while its own write is the one that stands.
 *
 * An identity naming SOMEBODY ELSE is one the ownership rule lets the standing
 * write supersede on its way in. An identity naming the save's OWN person is
 * the one at issue: a save may take that away only when its own call inserted
 * it, because one it merely confirmed was written by an earlier save and
 * carries that save's sharing policy.
 */
function clauseCBreaches(deleteRoads: string[]): string[] {
  const breaches: string[] = [];
  const inserted = new Map<string, Set<string>>();
  for (const op of ops) {
    if (op.op === "register" && op.created) {
      const own = inserted.get(op.road) ?? new Set<string>();
      own.add(op.identityId);
      inserted.set(op.road, own);
    }
  }
  for (const op of ops) {
    if (op.op !== "retire" || deleteRoads.includes(op.road)) continue;
    const ownInsert = inserted.get(op.road)?.has(op.identityId) === true;
    if (op.identityOwner === derivedOwnerOf.get(op.road)) {
      if (!ownInsert) {
        breaches.push(`${op.road} took back ${op.identityId}, which its own call never inserted`);
      }
      continue;
    }
    // Another person's identity: only the standing write supersedes one.
    if (!op.ownWriteStood) {
      breaches.push(
        `${op.road} retired ${op.identityId} of ${op.identityOwner} while its own write did not stand`,
      );
    }
  }
  return breaches;
}

/** D: no standing row points at a stored key a delete took away. */
function clauseDBreaches(): string[] {
  return [...rows.values()].flatMap((row) =>
    row.nangoConnectionId !== null && deletedKeys.has(row.nangoConnectionId)
      ? [`row ${row.id} stands while the key it points at was taken away`]
      : [],
  );
}

/** Clauses A, B and C, plus the ownership of the row each ordering ends on. */
function invariantBreaches(deleteRoads: string[] = [], serverId = "srv"): string[] {
  const ending = ownershipBreach(serverId);
  return [
    ...successReports.filter((r) => r.breach !== null).map((r) => `${r.road}: ${r.breach}`),
    ...(ending === null ? [] : [`end state: ${ending}`]),
    ...clauseBBreaches(deleteRoads),
    ...clauseCBreaches(deleteRoads),
  ];
}

// ---------------------------------------------------------------------------

const ORG = "org-1";
let consoleError: ReturnType<typeof vi.spyOn>;
let consoleWarn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  rows.clear();
  identities.clear();
  deletedKeys.clear();
  credentialCalls.length = 0;
  ops.length = 0;
  successReports.length = 0;
  arms.clear();
  hits.clear();
  parked.clear();
  finished.clear();
  failures.clear();
  seedFailsFor.clear();
  derivedOwnerOf.clear();
  lastWriteOf.clear();
  clock = 0;
  identitySeq = 0;
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
  consoleWarn.mockRestore();
});

/** A save of one shared keyless row by one platform admin. */
function sharedSave(road: string, owner: string, serverId = "srv"): void {
  start(road, () =>
    saveRoad({
      serverId,
      scope: "global",
      rowUserId: null,
      ownerUserId: owner,
      organizationId: ORG,
      actorIsAdmin: true,
    }),
  );
}

function standingIdentityOwner(serverId = "srv"): string | null {
  return liveKeylessIdentity(serverId)?.ownerUserId ?? null;
}

// ---------------------------------------------------------------------------
// The four orderings of the ninth round.
// ---------------------------------------------------------------------------

describe("the four orderings the ninth round found (cinatra#3485)", () => {
  it("finding 1: a save never takes back an identity it merely CONFIRMED", async () => {
    // One shared keyless row, no identity yet, two saves by the same admin.
    // The identity ROW is what a sharing policy hangs on, so losing that row
    // loses the policy even when an identity of the same name replaces it.
    placeRow({ id: "srv", scope: "global", userId: null, derivedOwner: "admin-a" });

    pauseAt("a1", "identity:register");
    sharedSave("a1", "admin-a");
    await reaches("a1", "identity:register");

    // The NEWER save writes the row, inserts the identity and completes.
    sharedSave("a2", "admin-a");
    await completes("a2");
    const policyRow = liveKeylessIdentity("srv");
    expect(policyRow).not.toBeNull();

    // The older save resumes and its registration CONFIRMS that very row.
    await finish("a1");

    expect(liveKeylessIdentity("srv")?.id).toBe(policyRow?.id);
    expect(standingIdentityOwner()).toBe("admin-a");
    expect(invariantBreaches()).toEqual([]);
  });

  it("finding 2: three saves never leave the older person holding the newer person's row", async () => {
    // A shared keyless row with A's identity already live on it.
    placeRow({ id: "srv", scope: "global", userId: null, derivedOwner: "admin-a" });
    placeIdentity(keylessIdOf("srv"), "admin-a", ORG);

    pauseAt("a1", "identity:register");
    pauseAt("a2", "identity:register");
    pauseAt("b", "identity:register");
    pauseAt("b", "identity:register", 2);
    sharedSave("a1", "admin-a");
    await reaches("a1", "identity:register");
    sharedSave("a2", "admin-a");
    await reaches("a2", "identity:register");
    // B writes last and retires A's identity on its way in.
    sharedSave("b", "admin-b");
    await reaches("b", "identity:register");

    await finish("a1");
    await step("b");
    await finish("a2");
    await finish("b");

    expect(rows.get("srv")?.derivedOwner).toBe("admin-b");
    const live = standingIdentityOwner();
    expect(live === null || live === "admin-b").toBe(true);
    expect(invariantBreaches()).toEqual([]);
  });

  it("finding 3: a scope change before the delete step refuses the delete with the stored key intact", async () => {
    placeRow({
      id: "srv",
      scope: "user",
      userId: "person-a",
      derivedOwner: "person-a",
      nangoConnectionId: "external-mcp-key",
    });
    pauseAt("d", "authorized");
    start("d", () => deleteRoad({ serverId: "srv", actorUserId: "person-a", actorIsAdmin: false }));
    await reaches("d", "authorized");

    // An administrator promotes the row to shared, keeping its stored key.
    const promoted = rows.get("srv");
    if (promoted) {
      promoted.scope = "global";
      promoted.userId = null;
      promoted.derivedOwner = "admin-b";
      promoted.updatedAt = nextStamp();
    }

    await finish("d");

    expect(refusalOf("d")).toBeInstanceOf(WriteConflict);
    expect(rows.has("srv")).toBe(true);
    expect(deletedKeys.has("external-mcp-key")).toBe(false);
    expect(clauseDBreaches()).toEqual([]);
    expect(invariantBreaches(["d"])).toEqual([]);
  });

  it("finding 4: a delete never retires the identity of a row created again after its absence check", async () => {
    placeRow({ id: "srv", scope: "user", userId: "person-a", derivedOwner: "person-a" });
    placeIdentity(keylessIdOf("srv"), "person-a", null);

    pauseAt("d", "identity:retire");
    start("d", () => deleteRoad({ serverId: "srv", actorUserId: "person-a", actorIsAdmin: false }));
    await reaches("d", "identity:retire");
    expect(rows.has("srv")).toBe(false);

    // The same owner registers the id again: the collision check permits their
    // own identity and the registration confirms it.
    start("re", () =>
      saveRoad({
        serverId: "srv",
        scope: "user",
        rowUserId: "person-a",
        ownerUserId: "person-a",
        organizationId: null,
        actorIsAdmin: false,
        create: true,
      }),
    );
    await completes("re");
    expect(rows.has("srv")).toBe(true);

    await finish("d");

    expect(standingIdentityOwner()).toBe("person-a");
    expect(invariantBreaches(["d"])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The orderings the ninth round traced beside the four findings.
// ---------------------------------------------------------------------------

describe("every other ordering the ninth round traced (cinatra#3485)", () => {
  it("A1, A2 and B all pause before insertion with no identity at the start", async () => {
    placeRow({ id: "srv", scope: "global", userId: null, derivedOwner: "admin-a" });
    pauseAt("a1", "identity:register");
    pauseAt("a2", "identity:register");
    pauseAt("b", "identity:register");
    sharedSave("a1", "admin-a");
    await reaches("a1", "identity:register");
    sharedSave("a2", "admin-a");
    await reaches("a2", "identity:register");
    sharedSave("b", "admin-b");
    await reaches("b", "identity:register");

    await finish("a1");
    await finish("b");
    await finish("a2");

    expect(rows.get("srv")?.derivedOwner).toBe("admin-b");
    expect(standingIdentityOwner()).toBe("admin-b");
    expect(invariantBreaches()).toEqual([]);
  });

  it("two owners, and the NEWER save completes its registration first", async () => {
    placeRow({ id: "srv", scope: "global", userId: null, derivedOwner: "admin-a" });
    pauseAt("older", "identity:register");
    sharedSave("older", "admin-a");
    await reaches("older", "identity:register");
    sharedSave("newer", "admin-b");
    await completes("newer");
    await finish("older");

    expect(rows.get("srv")?.derivedOwner).toBe("admin-b");
    expect(standingIdentityOwner()).toBe("admin-b");
    expect(invariantBreaches()).toEqual([]);
  });

  it("two owners, and the OLDER save's take-back runs before the newer registration", async () => {
    placeRow({ id: "srv", scope: "global", userId: null, derivedOwner: "admin-a" });
    pauseAt("older", "identity:register");
    pauseAt("newer", "identity:register");
    sharedSave("older", "admin-a");
    await reaches("older", "identity:register");
    // The newer save writes the row and stops on the doorstep of its own
    // registration, so the older insert lands on a row it no longer holds.
    sharedSave("newer", "admin-b");
    await reaches("newer", "identity:register");
    await finish("older");
    await finish("newer");

    expect(rows.get("srv")?.derivedOwner).toBe("admin-b");
    expect(standingIdentityOwner()).toBe("admin-b");
    expect(invariantBreaches()).toEqual([]);
  });

  it("the same owner twice, with an identity standing throughout, keeps the row the policy hangs on", async () => {
    placeRow({ id: "srv", scope: "global", userId: null, derivedOwner: "admin-a" });
    const standing = placeIdentity(keylessIdOf("srv"), "admin-a", ORG);
    pauseAt("first", "identity:register");
    sharedSave("first", "admin-a");
    await reaches("first", "identity:register");
    sharedSave("second", "admin-a");
    await completes("second");
    await finish("first");

    expect(liveKeylessIdentity("srv")?.id).toBe(standing.id);
    expect(invariantBreaches()).toEqual([]);
  });

  it("A1 pauses before its take-back while B conflicts and A2 inserts", async () => {
    placeRow({ id: "srv", scope: "global", userId: null, derivedOwner: "admin-a" });
    pauseAt("a1", "identity:register");
    pauseAt("a2", "identity:register");
    pauseAt("b", "identity:register");
    pauseAt("b", "identity:register", 2);
    sharedSave("a1", "admin-a");
    await reaches("a1", "identity:register");
    sharedSave("a2", "admin-a");
    await reaches("a2", "identity:register");
    sharedSave("b", "admin-b");
    await reaches("b", "identity:register");

    // A1 inserts and stops on the doorstep of its own take-back; A2 does the
    // same after B's retry has taken A1's identity away.
    pauseAt("a1", "identity:retire");
    pauseAt("a2", "identity:retire");
    await step("a1");
    await step("b");
    await step("a2");
    await finish("b");
    await finish("a1");
    await finish("a2");

    expect(rows.get("srv")?.derivedOwner).toBe("admin-b");
    const live = standingIdentityOwner();
    expect(live === null || live === "admin-b").toBe(true);
    expect(invariantBreaches()).toEqual([]);
  });

  it("a third save completes BEFORE the losing save reaches its retry", async () => {
    placeRow({ id: "srv", scope: "global", userId: null, derivedOwner: "admin-a" });
    pauseAt("a", "identity:register");
    pauseAt("b", "identity:register");
    sharedSave("a", "admin-a");
    await reaches("a", "identity:register");
    sharedSave("b", "admin-b");
    await reaches("b", "identity:register");
    // A's identity has to be STANDING when B registers, or B never conflicts
    // and never reaches a retry at all: A inserts and stops on the doorstep of
    // its own take-back.
    pauseAt("a", "identity:retire");
    await step("a");
    sharedSave("c", "admin-c");
    await completes("c");
    await finish("b");
    await finish("a");

    expect(rows.get("srv")?.derivedOwner).toBe("admin-c");
    expect(standingIdentityOwner()).toBe("admin-c");
    expect(invariantBreaches()).toEqual([]);
  });

  it("a third save with the SAME derived owner completes between the retry's guard and its insert", async () => {
    placeRow({ id: "srv", scope: "global", userId: null, derivedOwner: "admin-a" });
    pauseAt("a", "identity:register");
    pauseAt("b", "identity:register");
    pauseAt("b", "identity:register", 2);
    sharedSave("a", "admin-a");
    await reaches("a", "identity:register");
    sharedSave("b", "admin-b");
    await reaches("b", "identity:register");
    // A inserts and stops before its take-back, so B's first registration
    // really does meet a foreign identity and really does retry.
    pauseAt("a", "identity:retire");
    await step("a");
    await step("b");
    sharedSave("c", "admin-b");
    await completes("c");
    await finish("b");
    await finish("a");

    expect(rows.get("srv")?.derivedOwner).toBe("admin-b");
    expect(standingIdentityOwner()).toBe("admin-b");
    expect(invariantBreaches()).toEqual([]);
  });

  it("a save that CONFIRMS a standing identity while a later write holds the row leaves it alone", async () => {
    // The losing save can do nothing here that would be right: the identity it
    // confirmed carries an earlier save's sharing policy, and the row belongs
    // to the write that stands, whose own reconciliation is one step away.
    placeRow({ id: "srv", scope: "global", userId: null, derivedOwner: "admin-a" });
    const standing = placeIdentity(keylessIdOf("srv"), "admin-a", ORG);
    pauseAt("a1", "identity:register");
    sharedSave("a1", "admin-a");
    await reaches("a1", "identity:register");
    pauseAt("b", "identity:retire");
    sharedSave("b", "admin-b");
    await reaches("b", "identity:retire");
    await finish("a1");
    // The identity A1 confirmed is untouched by A1.
    expect(identities.get(standing.id)?.deletedAt).toBeNull();
    await finish("b");

    expect(rows.get("srv")?.derivedOwner).toBe("admin-b");
    expect(standingIdentityOwner()).toBe("admin-b");
    expect(invariantBreaches()).toEqual([]);
  });

  it("a supersede never runs once its own save has stopped being the write that stands", async () => {
    placeRow({ id: "srv", scope: "global", userId: null, derivedOwner: "admin-a" });
    const standing = placeIdentity(keylessIdOf("srv"), "admin-a", ORG);
    pauseAt("b", "identity:retire");
    sharedSave("b", "admin-b");
    await reaches("b", "identity:retire");
    // A later save of the same person the standing identity names takes the
    // row back and confirms that identity.
    sharedSave("c", "admin-a");
    await completes("c");
    await finish("b");

    expect(rows.get("srv")?.derivedOwner).toBe("admin-a");
    expect(liveKeylessIdentity("srv")?.id).toBe(standing.id);
    expect(invariantBreaches()).toEqual([]);
  });

  it("more pending saves than the passes: the standing save is outlasted, and the end state still converges", async () => {
    // THE RESIDUE, pinned rather than hidden. The passes and the cleanup are
    // bounded, so enough saves in flight can each land one identity inside one
    // window. The end state converges, because every save takes back what it
    // installed; what the two stores cannot give without one coordination
    // point is the state at the INSTANT the standing save reports success.
    placeRow({ id: "srv", scope: "global", userId: null, derivedOwner: "admin-a" });
    const olders = ["a1", "a2", "a3", "a4", "a5"];
    for (const road of olders) {
      pauseAt(road, "identity:register");
      sharedSave(road, "admin-a");
      await reaches(road, "identity:register");
    }
    for (let pass = 1; pass <= 4; pass += 1) pauseAt("b", "identity:register", pass);
    pauseAt("b", "identity:retire", 4);
    sharedSave("b", "admin-b");
    await reaches("b", "identity:register");

    for (const road of olders) pauseAt(road, "identity:retire");
    for (let i = 0; i < 4; i += 1) {
      await step(olders[i]);
      await step("b");
    }
    await finish("a4");
    await step("a5");
    await finish("b");
    for (const road of olders) await finish(road);

    expect(rows.get("srv")?.derivedOwner).toBe("admin-b");
    expect(standingIdentityOwner()).toBeNull();
    expect(ownershipBreach("srv")).toBeNull();
    expect(clauseBBreaches([])).toEqual([]);
    expect(clauseCBreaches([])).toEqual([]);
    // The one moment the invariant does not hold, named: the standing save
    // reported success while an older save's identity was still live.
    expect(successReports.filter((r) => r.breach !== null).map((r) => r.road)).toEqual(["b"]);
  });

  it("a delete removes the row while a save is paused before its insert", async () => {
    placeRow({ id: "srv", scope: "user", userId: "person-a", derivedOwner: "person-a" });
    pauseAt("s", "identity:register");
    start("s", () =>
      saveRoad({
        serverId: "srv",
        scope: "user",
        rowUserId: "person-a",
        ownerUserId: "person-a",
        organizationId: null,
        actorIsAdmin: false,
      }),
    );
    await reaches("s", "identity:register");
    start("d", () => deleteRoad({ serverId: "srv", actorUserId: "person-a", actorIsAdmin: false }));
    await completes("d");
    await finish("s");

    expect(rows.has("srv")).toBe(false);
    expect(liveKeylessIdentity("srv")).toBeNull();
    expect(invariantBreaches(["d"])).toEqual([]);
  });

  it("a registration that inserts and then fails in its grant seed still takes back what it installed", async () => {
    placeRow({ id: "srv", scope: "global", userId: null, derivedOwner: "admin-a" });
    pauseAt("a", "identity:register");
    pauseAt("b", "identity:register");
    sharedSave("a", "admin-a");
    await reaches("a", "identity:register");
    // B writes the row but stops before its own registration, so nothing stands
    // at the id and A's registration really does INSERT before it fails.
    sharedSave("b", "admin-b");
    await reaches("b", "identity:register");
    seedFailsFor.add("a");
    await finish("a");
    await finish("b");

    expect(rows.get("srv")?.derivedOwner).toBe("admin-b");
    expect(standingIdentityOwner()).toBe("admin-b");
    expect(invariantBreaches()).toEqual([]);
  });

  it("a keyed delete takes the stored key away exactly once and leaves no panel", async () => {
    placeRow({
      id: "srv",
      scope: "user",
      userId: "person-a",
      derivedOwner: "person-a",
      nangoConnectionId: "external-mcp-key",
    });
    placeIdentity("external-mcp-key", "person-a", null);
    start("d", () => deleteRoad({ serverId: "srv", actorUserId: "person-a", actorIsAdmin: false }));
    await completes("d");

    expect(credentialCalls).toEqual(["external-mcp-key"]);
    expect(rows.has("srv")).toBe(false);
    expect(liveIdentityAt("external-mcp-key")).toBeNull();
    expect(clauseDBreaches()).toEqual([]);
    expect(invariantBreaches(["d"])).toEqual([]);
  });

  it("a keyless delete asks the connection service for nothing at all", async () => {
    placeRow({ id: "srv", scope: "user", userId: "person-a", derivedOwner: "person-a" });
    placeIdentity(keylessIdOf("srv"), "person-a", null);
    start("d", () => deleteRoad({ serverId: "srv", actorUserId: "person-a", actorIsAdmin: false }));
    await completes("d");

    expect(credentialCalls).toEqual([null]);
    expect(liveKeylessIdentity("srv")).toBeNull();
    expect(invariantBreaches(["d"])).toEqual([]);
  });

  it("a re-key inside the delete's own credential call still fails the delete closed", async () => {
    // The one window a fresh read cannot reach: the row changes AFTER the
    // delete step re-read it, while its credential call is in flight. The
    // guarded row delete refuses, so the row keeps its NEW stored key and the
    // key it replaced is the only one that goes.
    placeRow({
      id: "srv",
      scope: "user",
      userId: "person-a",
      derivedOwner: "person-a",
      nangoConnectionId: "external-mcp-first",
    });
    placeIdentity("external-mcp-first", "person-a", null);
    pauseAt("d", "credential:revoke");
    start("d", () => deleteRoad({ serverId: "srv", actorUserId: "person-a", actorIsAdmin: false }));
    await reaches("d", "credential:revoke");
    const row = rows.get("srv");
    if (row) {
      row.nangoConnectionId = "external-mcp-second";
      row.updatedAt = nextStamp();
    }
    placeIdentity("external-mcp-second", "person-a", null);
    await finish("d");

    expect(refusalOf("d")).toBeInstanceOf(WriteConflict);
    expect(rows.get("srv")?.nangoConnectionId).toBe("external-mcp-second");
    expect(liveIdentityAt("external-mcp-second")).not.toBeNull();
    expect(credentialCalls).toEqual(["external-mcp-first"]);
    expect(invariantBreaches(["d"])).toEqual([]);
  });

  it("a SCOPE change inside the delete's own key call leaves the documented residue", async () => {
    // THE REFERENCED-BUT-DELETED INTERVAL, written down as it is rather than
    // claimed closed. The delete takes the stored key away first, so a change
    // that lands while that call is in flight is past the fresh pre-delete
    // read: the guarded row delete refuses, and the row survives pointing at a
    // key that is gone. Its owner repairs it by deleting it again or by saving
    // a new key. This case names a PROMOTION, which changes the scope and the
    // owner rather than the stored key, so the interval stays visible for the
    // road it is actually about; a later change to that road shows up here.
    placeRow({
      id: "srv",
      scope: "user",
      userId: "person-a",
      derivedOwner: "person-a",
      nangoConnectionId: "external-mcp-key",
    });
    placeIdentity("external-mcp-key", "person-a", null);
    pauseAt("d", "credential:revoke");
    start("d", () => deleteRoad({ serverId: "srv", actorUserId: "person-a", actorIsAdmin: false }));
    await reaches("d", "credential:revoke");
    const row = rows.get("srv");
    if (row) {
      row.scope = "global";
      row.userId = null;
      row.derivedOwner = "admin-a";
      row.updatedAt = nextStamp();
    }
    await finish("d");

    expect(refusalOf("d")).toBeInstanceOf(WriteConflict);
    // The row stands, promoted, and still points at the key that went.
    expect(rows.get("srv")?.scope).toBe("global");
    expect(rows.get("srv")?.nangoConnectionId).toBe("external-mcp-key");
    expect(deletedKeys.has("external-mcp-key")).toBe(true);
    expect(credentialCalls).toEqual(["external-mcp-key"]);
    expect(clauseDBreaches()).toEqual([
      "row srv stands while the key it points at was taken away",
    ]);
    // Everything else holds: nothing was retired that should not have been.
    expect(clauseBBreaches(["d"])).toEqual([]);
    expect(clauseCBreaches(["d"])).toEqual([]);
  });
});

describe("the two orderings the tenth round found (cinatra#3485)", () => {
  it("finding 1: a save never takes back an identity another save CONFIRMED during its grant seed", async () => {
    // The seam writes the identity row and seeds its grant as two calls, so
    // "did my own write still stand when this identity landed" has to be read
    // at the INSERT. Read after the whole registration returns, it is a reading
    // about a later moment, and the save takes back the very row the next save
    // is relying on, with that save's sharing policy hanging on it.
    placeRow({ id: "srv", scope: "global", userId: null, derivedOwner: "admin-a" });

    // A writes the row and INSERTS the identity while its own write stands,
    // then pauses inside the grant seeding.
    pauseAt("a", "identity:seed");
    sharedSave("a", "admin-a");
    await reaches("a", "identity:seed");
    const policyRow = liveKeylessIdentity("srv");
    expect(policyRow).not.toBeNull();

    // An ordinary next save of the same person writes the row, CONFIRMS that
    // identity, and reports success on it.
    sharedSave("b", "admin-a");
    await completes("b");
    expect(liveKeylessIdentity("srv")?.id).toBe(policyRow?.id);

    await finish("a");

    // The row B confirmed is still the row, so B's policy still governs.
    expect(identities.get(policyRow?.id ?? "")?.deletedAt).toBeNull();
    expect(liveKeylessIdentity("srv")?.id).toBe(policyRow?.id);
    expect(standingIdentityOwner()).toBe("admin-a");
    expect(invariantBreaches()).toEqual([]);
  });

  it("finding 2: a KEYED save never retires an identity once its own write has stopped standing", async () => {
    // A keyed save may retire a keyless identity because no keyless identity
    // may stand for a row that stores a key. That authority is its own row
    // write standing, not the mere fact that some keyed row stands: a keyless
    // save that took the row back and confirmed the identity has to keep it.
    placeRow({ id: "srv", scope: "user", userId: "person-a", derivedOwner: "person-a" });
    const standing = placeIdentity(keylessIdOf("srv"), "person-a", null);

    // K writes the row WITH a stored key, reads the retirable identity, and
    // pauses inside the retire.
    pauseAt("k", "identity:retire");
    start("k", () =>
      saveRoad({
        serverId: "srv",
        scope: "user",
        rowUserId: "person-a",
        ownerUserId: "person-a",
        organizationId: null,
        actorIsAdmin: false,
        storedCredential: "external-mcp-key",
      }),
    );
    await reaches("k", "identity:retire");

    // A keyless save takes the row back and CONFIRMS that identity.
    start("b", () =>
      saveRoad({
        serverId: "srv",
        scope: "user",
        rowUserId: "person-a",
        ownerUserId: "person-a",
        organizationId: null,
        actorIsAdmin: false,
      }),
    );
    await completes("b");

    await finish("k");

    expect(rows.get("srv")?.nangoConnectionId).toBeNull();
    expect(identities.get(standing.id)?.deletedAt).toBeNull();
    expect(liveKeylessIdentity("srv")?.id).toBe(standing.id);
    expect(standingIdentityOwner()).toBe("person-a");
    expect(invariantBreaches()).toEqual([]);
  });
});
