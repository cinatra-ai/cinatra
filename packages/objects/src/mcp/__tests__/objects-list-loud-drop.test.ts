/**
 * Loud-drop through the REAL `objects_list` handler + REAL `filterByAuthz`
 * (cinatra#1948 (a)).
 *
 * This is the "real-store resolver" coverage the lane mandates: the read runs
 * through the actual handler and its authorization post-filter — NOT a mocked
 * `@cinatra-ai/objects` client (which is exactly what masked the #1946
 * silent-drop). The store DATA layer (`listObjectsByFilter`) is seeded, and the
 * TERMINAL kernel predicate (`@/lib/authz` `can`) is controlled per-test so a
 * row is dropped deterministically — the same seam `handlers-authz.test.ts`
 * uses. The real POLICY decisions (a role-less System is denied; the
 * internal-read authority is granted) are proven against the real kernel in
 * `src/lib/__tests__/register-email-providers-routing.test.ts`.
 *
 * Asserted:
 *   - an INTERNAL/SYSTEM read that drops rows fires the loud diagnostic
 *     (metric increment + structured event), NOT a silent `[]`;
 *   - an INTERACTIVE (UI) read that drops the SAME rows stays silent (that is
 *     the intended authorization post-filter, not an anomaly);
 *   - an internal/system read that drops NOTHING fires no diagnostic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const ORG = "org-loud";
const OTHER_USER = "user-other";

function seededRow(id: string) {
  return {
    id,
    type: "@cinatra-ai/email:sender-identity",
    parentId: null,
    parentType: null,
    data: { name: id },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    createdBy: OTHER_USER,
    orgId: ORG,
    source: null,
    runId: null,
    agentId: null,
    packageVersion: null,
    agentSpecVersion: null,
    version: 1,
    deletedAt: null,
    ownerLevel: "user" as const,
    ownerId: OTHER_USER,
    visibility: "private" as const,
    projectId: null,
  };
}

let seededRows: ReturnType<typeof seededRow>[] = [];

vi.mock("server-only", () => ({}));

vi.mock("@/lib/objects-store", () => ({
  upsertObjectAndEnqueue: vi.fn(),
  getObjectById: vi.fn(() => null),
  // The production SQL scopes rows; this stub returns the seeded set
  // unconditionally so the handler's AUTHORIZATION post-filter (filterByAuthz),
  // not the SQL filter, is exercised — the boundary under test.
  listObjectsByFilter: vi.fn(() => seededRows),
  softDeleteObject: vi.fn(),
}));

vi.mock("@/lib/database", () => ({
  readObjectsClassificationModelFromDatabase: vi.fn(() => "openai:gpt-4o-mini"),
}));

vi.mock("../../classifier", () => ({
  classifyObject: vi.fn(),
}));

vi.mock("../../graphiti-client", () => ({
  searchNodes: vi.fn(async () => ({ nodes: [] })),
  identityHashToUuid: (h: string) => h,
}));

vi.mock("../../identity", () => ({
  resolveIdentity: vi.fn(() => null),
  hashIdentity: vi.fn(() => "h"),
}));

// Terminal kernel predicate — controlled per test. The REAL
// enforce-resource-access.ts / decideResourceAccess run; only `can()` (the last
// role-grant step) is stubbed, exactly as handlers-authz.test.ts does.
vi.mock("@/lib/authz", () => ({
  can: vi.fn(() => false),
  canDo: vi.fn(() => false),
  buildActorContext: vi.fn(() => ({})),
  AuthzError: class AuthzError extends Error {
    statusCode: number;
    reason: string;
    constructor(opts: { statusCode: number; reason: string; message?: string }) {
      super(opts.message ?? opts.reason);
      this.statusCode = opts.statusCode;
      this.reason = opts.reason;
    }
  },
  EFFECTIVE_GRANTS: {},
  POLICY_VERSION: "test",
  logAuditEvent: vi.fn(),
}));

// The loud-drop diagnostics are colocated IN the handlers module (next to
// `filterByAuthz`) so a new leaf file does not grow the shrink-only route-graph
// ratchet — hence both the handler map and the metric API import from
// `../handlers`.
import {
  handlers,
  isInternalSystemRead,
  recordInternalReadAuthzDrop,
  getInternalReadAuthzDropMetric,
  resetInternalReadAuthzDropMetric,
  onInternalReadAuthzDrop,
  INTERNAL_READ_AUTHZ_DROP_CODE,
  type InternalReadAuthzDrop,
} from "../handlers";
import { can } from "@/lib/authz";

// The internal/system read shape the routing resolver produces (System +
// worker source). No userId → the owner short-circuit is skipped, so the
// stubbed `can()` is the sole decision.
const systemInternalActor = {
  actorType: "system",
  source: "worker",
  orgId: ORG,
  organizationId: ORG,
} as never;

// An interactive UI user reading the same rows. userId is not the row owner, so
// the owner short-circuit is skipped and `can()` decides — a dropped row here is
// the NORMAL authorization post-filter, and must stay silent.
const interactiveUiActor = {
  actorType: "human",
  source: "ui",
  userId: "user-viewer",
  orgId: ORG,
  organizationId: ORG,
} as never;

async function runList(actor: unknown) {
  return handlers["objects_list"]({
    primitiveName: "objects_list",
    input: {},
    actor,
    mode: "deterministic",
  } as never);
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  seededRows = [seededRow("si-1"), seededRow("si-2")];
  resetInternalReadAuthzDropMetric();
  vi.mocked(can).mockReturnValue(false);
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  warnSpy.mockRestore();
});

describe("objects_list loud-drop (real handler + real filterByAuthz)", () => {
  it("fires the loud diagnostic when an INTERNAL/SYSTEM read drops rows", async () => {
    const events: InternalReadAuthzDrop[] = [];
    const off = onInternalReadAuthzDrop((e) => events.push(e));

    const result = (await runList(systemInternalActor)) as { items: unknown[] };
    off();

    // The silent-drop symptom: an empty list indistinguishable from "no rows".
    expect(result.items).toHaveLength(0);
    // ...but now it is LOUD.
    expect(getInternalReadAuthzDropMetric().dropEvents).toBe(1);
    expect(getInternalReadAuthzDropMetric().droppedRows).toBe(2);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      primitive: "objects_list",
      droppedCount: 2,
      totalCount: 2,
      actorType: "system",
      source: "worker",
      orgId: ORG,
    });
    expect(events[0].droppedTypes).toContain("@cinatra-ai/email:sender-identity");
    expect(warnSpy).toHaveBeenCalled();
  });

  it("stays SILENT when an INTERACTIVE UI read drops the same rows (normal authz filtering)", async () => {
    const result = (await runList(interactiveUiActor)) as { items: unknown[] };
    expect(result.items).toHaveLength(0);
    // No metric, no warn — an interactive user simply cannot see these rows.
    expect(getInternalReadAuthzDropMetric().dropEvents).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("fires NO diagnostic when an internal/system read drops nothing", async () => {
    vi.mocked(can).mockReturnValue(true); // everything readable
    const result = (await runList(systemInternalActor)) as { items: unknown[] };
    expect(result.items).toHaveLength(2);
    expect(getInternalReadAuthzDropMetric().dropEvents).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Unit coverage for the diagnostics primitives (predicate + metric/warn/
// listener), exercised directly — no store, no kernel.
// ---------------------------------------------------------------------------
describe("isInternalSystemRead", () => {
  it("TRUE for a System actor (actorType system) — the role-less-System silent-drop class", () => {
    expect(isInternalSystemRead({ actorType: "system", source: "route" })).toBe(true);
  });
  it("TRUE for a worker source (the resolver's HumanUser owner carries source:worker)", () => {
    expect(isInternalSystemRead({ actorType: "human", source: "worker" })).toBe(true);
  });
  it("FALSE for an interactive UI user (a dropped row is normal authz filtering)", () => {
    expect(isInternalSystemRead({ actorType: "human", source: "ui" })).toBe(false);
  });
  it("FALSE for an agent read (source agent, actorType model)", () => {
    expect(isInternalSystemRead({ actorType: "model", source: "agent" })).toBe(false);
  });
  it("FALSE for a null / undefined actor", () => {
    expect(isInternalSystemRead(null)).toBe(false);
    expect(isInternalSystemRead(undefined)).toBe(false);
  });
});

describe("recordInternalReadAuthzDrop", () => {
  // console.warn is spied+suppressed file-wide by the top-level beforeEach
  // (`warnSpy`), and the metric is reset there too — so these read `warnSpy`
  // directly and start from a zeroed counter.
  const baseEvent: InternalReadAuthzDrop = {
    primitive: "objects_list",
    droppedCount: 3,
    totalCount: 3,
    droppedTypes: ["@cinatra-ai/email:sender-identity"],
    actorType: "system",
    source: "worker",
    orgId: "org-1",
  };

  it("increments both metric counters (dropEvents + droppedRows)", () => {
    recordInternalReadAuthzDrop(baseEvent);
    recordInternalReadAuthzDrop({ ...baseEvent, droppedCount: 2, totalCount: 5 });
    expect(getInternalReadAuthzDropMetric()).toEqual({ dropEvents: 2, droppedRows: 5 });
  });

  it("emits a structured warn carrying the stable diagnostic code + payload", () => {
    recordInternalReadAuthzDrop(baseEvent);
    const [message, payload] = warnSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toContain("filterByAuthz");
    expect(message).toContain("internal/system read");
    expect(payload.code).toBe(INTERNAL_READ_AUTHZ_DROP_CODE);
    expect(payload.droppedTypes).toEqual(["@cinatra-ai/email:sender-identity"]);
  });

  it("notifies subscribers, honours unsubscribe, and survives a throwing listener", () => {
    const received: InternalReadAuthzDrop[] = [];
    const offBad = onInternalReadAuthzDrop(() => {
      throw new Error("sink down");
    });
    const off = onInternalReadAuthzDrop((e) => received.push(e));
    expect(() => recordInternalReadAuthzDrop(baseEvent)).not.toThrow();
    off();
    offBad();
    recordInternalReadAuthzDrop(baseEvent);
    expect(received).toHaveLength(1);
  });
});
