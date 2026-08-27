// `memory sync` end-to-end ACROSS both packages (cinatra#1378 AC1, epic #1373).
//
// The two halves of this feature are tested apart everywhere else — the client
// against a stub endpoint in `packages/memory`, the server gates against hand-
// built envelopes here. Apart, each half can be right about a contract the
// other half does not actually speak. This suite closes that gap: it runs the
// REAL sync client (`runMemorySync`: bundle load, secret scan, envelope build,
// preflight classification, ledger) against the REAL objects primitives
// (`objects_save` / `objects_list` / `objects_get`: schema validation, the
// fail-closed ingest secret scan, size caps, `externalId` recomputation,
// ownership derivation, the per-row read gate), over an in-memory store double
// that keeps the store's own org / ownership / collision-guard semantics.
//
// The acceptance criterion's own sequence is what runs:
//   author → dry-run (classification shown, nothing written) → sync (rows
//   visible via objects_get / objects_list) → a second sync writes NOTHING.
//
// Plus the three properties the direction of this feature rests on:
//   - ONE-WAY: no concept file and no `bundle.yaml` byte changes across a run;
//   - untrusted end-to-end: a forged bundle field steers no identity and
//     widens no scope, and the server's own recomputation is what decides;
//   - no remote deletion: a deleted file leaves its row alone.
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

vi.mock("server-only", () => ({}));

// The store double. `vi.hoisted` because a `vi.mock` factory is hoisted above
// every module-scope binding, and the suite has to reach the same row map the
// handlers write through.
const store = vi.hoisted(() => {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    rows,
    /** Every write the run made, so "wrote nothing" is an assertion, not a hope. */
    writes: [] as Array<{ id: string; version: number }>,
    reset() {
      rows.clear();
      store.writes.length = 0;
    },
  };
});

vi.mock("@/lib/objects-store", () => {
  // Faithful to the three behaviours this path depends on:
  //   - org scoping: a row of another org is invisible, not merely filtered;
  //   - the ownership filter: a user-owned private row answers only its owner,
  //     so an unauthorized preflight looks exactly like a missing row;
  //   - the collision guard: the writer's DO UPDATE arm is pinned to the row
  //     version the handler's probe authorized.
  const rowOrgOf = (row: Record<string, unknown>) => row["orgId"] as string | null;
  /**
   * `buildOwnershipFilter`, in miniature: a user-owned private row answers its
   * OWNER and nobody else, so an unauthorized preflight looks exactly like a
   * missing row rather than like a refusal.
   *
   * The caller's identity is the canonical `ActorContext`'s `principalId`, NOT
   * a raw `userId`. Reading the wrong key would drop every row and turn a
   * resync into a duplicate write — the exact failure this suite exists to
   * catch, so the key is taken from the real shape rather than guessed.
   */
  const ownershipReaches = (
    row: Record<string, unknown>,
    actor: { principalId?: string | null },
  ): boolean =>
    row["ownerLevel"] !== "user" ||
    row["visibility"] !== "private" ||
    row["ownerId"] === (actor.principalId ?? null);
  return {
    getObjectById: vi.fn(
      (
        id: string,
        scope: { orgId: string | null },
        actor?: { principalId?: string | null },
        options?: { allowDeleted?: boolean },
      ) => {
        const row = store.rows.get(id);
        if (!row) return null;
        if (scope.orgId !== null && rowOrgOf(row) !== scope.orgId) return null;
        if (!options?.allowDeleted && row["deletedAt"] !== null) return null;
        // The ownership filter is spliced only when an ACTOR is supplied —
        // the same rule the real function follows. `objects_save`'s collision
        // probe passes none on purpose (it must see a row it may not read, so
        // it can refuse instead of silently forking a second row).
        if (actor !== undefined && !ownershipReaches(row, actor)) return null;
        return row;
      },
    ),
    listObjectsByFilter: vi.fn(
      (
        filter: {
          orgId: string | null;
          type?: string;
          externalIds?: ReadonlyArray<string>;
          limit?: number;
        },
        actor?: { principalId?: string | null },
      ) => {
        const wanted =
          filter.externalIds && filter.externalIds.length > 0
            ? new Set(filter.externalIds)
            : null;
        const out: Array<Record<string, unknown>> = [];
        for (const row of store.rows.values()) {
          if (row["deletedAt"] !== null) continue;
          if (filter.orgId !== null && rowOrgOf(row) !== filter.orgId) continue;
          if (filter.type !== undefined && row["type"] !== filter.type) continue;
          const data = row["data"] as Record<string, unknown>;
          if (wanted !== null && !wanted.has(data["externalId"] as string)) continue;
          if (actor !== undefined && !ownershipReaches(row, actor)) continue;
          out.push(row);
        }
        return out.slice(0, filter.limit ?? 100);
      },
    ),
    softDeleteObject: vi.fn(() => {
      throw new Error("a sync run must never delete a row");
    }),
    upsertObjectAndEnqueue: vi.fn(
      (input: {
        upsertInput: Record<string, unknown>;
        collisionGuard?: { expectedVersion: number | null; expectedProjectId: string | null };
        explicitProjectBinding?: string | null;
      }) => {
        const id = input.upsertInput["id"] as string;
        const existing = store.rows.get(id);
        const guard = input.collisionGuard;
        if (guard && (existing?.["version"] ?? null) !== guard.expectedVersion) {
          const err = new Error("write precondition failed") as Error & { code: string };
          err.code = "OBJECTS_WRITE_PRECONDITION_FAILED";
          throw err;
        }
        const version = ((existing?.["version"] as number | undefined) ?? 0) + 1;
        const projectId =
          input.explicitProjectBinding !== undefined
            ? input.explicitProjectBinding
            : ((existing?.["projectId"] as string | null | undefined) ?? null);
        const record = {
          ...input.upsertInput,
          version,
          projectId,
          deletedAt: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          agentSpecVersion: input.upsertInput["agentSpecVersion"] ?? null,
          changeSetId: `cs-${id}-${version}`,
        };
        store.rows.set(id, record);
        store.writes.push({ id, version });
        return record;
      },
    ),
  };
});

// A read/write path must never resolve a model. The double fails loudly if one
// ever does — the memory type takes the deterministic static-type path.
vi.mock("@cinatra-ai/llm", () => ({
  resolveConfiguredLlmRuntime: vi.fn(async () => {
    throw new Error("the memory sync path must not resolve an LLM runtime");
  }),
  runResolvedDeterministicLlmTask: vi.fn(),
  parseStructuredJson: vi.fn(),
}));

vi.mock("../graphiti-client", () => ({
  addEpisode: vi.fn(async () => ({ uuid: "ep-1" })),
  deleteEpisode: vi.fn(async () => ({ ok: true })),
  searchNodes: vi.fn(async () => ({ nodes: [] })),
  getEpisodes: vi.fn(async () => ({ episodes: [] })),
  // The GROUP is part of the id, exactly as the real function makes it: a row
  // id is a function of (identity hash, group), and the group is org-derived.
  // A double that dropped the group would mint one id for two organizations
  // and make this suite's cross-tenant assertion accidental rather than real.
  identityHashToUuid: (h: string, g: string) => `uuid-${g}-${h}`,
}));

import { createObjectsPrimitiveHandlers } from "../mcp/handlers";
import { listObjectsByFilter } from "@/lib/objects-store";
import { objectTypeRegistry } from "../registry";
import {
  registerAllObjectTypes,
  MEMORY_CONCEPT_TYPE_ID,
  computeMemoryConceptExternalId,
} from "../integration/register-types";

// The REAL client half, by relative path — the same way this package's tests
// already reach `packages/llm`. Importing the workspace name would put a
// server-side package in the leaf package's dependency graph, which its own
// purity test exists to prevent.
import { runMemorySync } from "../../../memory/src/sync.ts";
import { initMemoryBundle } from "../../../memory/src/bundle.ts";
import { addMemoryConcept } from "../../../memory/src/write.ts";
import { MEMORY_SYNC_LEDGER_FILENAME } from "../../../memory/src/sync-ledger.ts";
import type { MemorySyncTransport } from "../../../memory/src/sync-transport.ts";

const mockList = listObjectsByFilter as unknown as ReturnType<typeof vi.fn>;

const ACTOR = {
  actorType: "model",
  source: "agent",
  ...({
    orgId: "org-1",
    userId: "user-1",
    agentId: "coding-agent",
    runId: "run-42",
    packageVersion: "0.1.0",
  } as unknown as Record<string, unknown>),
} as never;

/** A caller in a DIFFERENT organization. The org axis is actor-derived. */
const OTHER_ORG_ACTOR = {
  actorType: "model",
  source: "agent",
  ...({ orgId: "org-2", userId: "user-9" } as unknown as Record<string, unknown>),
} as never;

/**
 * The transport, wired straight onto the real primitives.
 *
 * `runMemorySync` reaches the server through this interface and nothing else,
 * so what runs below is the production call sequence with the network removed
 * — the same `objects_list` preflight and the same `objects_save` payloads the
 * HTTP transport would put on the wire.
 */
function handlerTransport(actor: unknown = ACTOR): MemorySyncTransport & {
  calls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const handlers = createObjectsPrimitiveHandlers() as unknown as Record<
    string,
    (req: unknown) => Promise<unknown>
  >;
  return {
    calls,
    async callTool(name, args) {
      calls.push({ name, args });
      const handler = handlers[name];
      if (handler === undefined) throw new Error(`no such primitive: ${name}`);
      return handler({ primitiveName: name, input: args, actor, mode: "agentic" });
    },
  };
}

function get(objectId: string, actor: unknown = ACTOR) {
  const handlers = createObjectsPrimitiveHandlers() as unknown as Record<
    string,
    (req: unknown) => Promise<unknown>
  >;
  return handlers["objects_get"]!({
    primitiveName: "objects_get",
    input: { objectId },
    actor,
    mode: "agentic",
  });
}

function list(input: Record<string, unknown>, actor: unknown = ACTOR) {
  const handlers = createObjectsPrimitiveHandlers() as unknown as Record<
    string,
    (req: unknown) => Promise<unknown>
  >;
  return handlers["objects_list"]!({
    primitiveName: "objects_list",
    input,
    actor,
    mode: "agentic",
  }) as Promise<{ items: Array<Record<string, unknown>> }>;
}

/** Byte-level fingerprint of every file in the bundle, ledger excluded. */
function bundleFingerprint(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const abs = path.join(dir, entry);
      const rel = prefix === "" ? entry : `${prefix}/${entry}`;
      if (statSync(abs).isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (rel === MEMORY_SYNC_LEDGER_FILENAME) continue;
      out[rel] = createHash("sha256").update(readFileSync(abs)).digest("hex");
    }
  };
  walk(root, "");
  return out;
}

let tmp: string;
let root: string;
let bundleId: string;

beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "memory-sync-e2e-"));
  root = path.join(tmp, ".memory");
  bundleId = initMemoryBundle(root, { name: "sync e2e" }).bundleId;
  // The author's `sync:` block. `bundle.yaml` carries a scope DEFAULT and
  // nothing that grants anything — the org axis is not nameable here at all.
  appendFileSync(path.join(root, "bundle.yaml"), "sync:\n  ownerLevel: user\n  visibility: private\n");
  addMemoryConcept(root, {
    type: "convention",
    title: "Never commit a key",
    body: "Keys live in the environment, never in a file.\n",
    timestamp: null,
  } as never);
  addMemoryConcept(root, {
    type: "command",
    title: "Run the check after every write",
    body: "Run `memory check` after you add or edit a concept.\n",
    timestamp: null,
  } as never);
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  mockList.mockClear();
  objectTypeRegistry._clearForTests();
  registerAllObjectTypes();
});

describe("AC1 — author → dry-run → sync → resync writes nothing", () => {
  it("classifies both concepts as creates on a dry run and writes NOTHING", async () => {
    store.reset();
    const before = bundleFingerprint(root);
    const transport = handlerTransport();
    const result = await runMemorySync({ root, transport, dryRun: true });

    expect(result.plan.items.map((i) => i.action).sort()).toEqual(["create", "create"]);
    expect(store.writes).toEqual([]);
    expect(transport.calls.map((c) => c.name)).toEqual(["objects_list"]);

    // The preflight is a BATCH KEY LOOKUP, and it has to stay one all the way
    // down. `objectsListSchema` strips an unknown key silently, so a batch that
    // never reached the primitive would degrade into "list every memory row of
    // this type" — which classifies correctly on a two-concept bundle and is an
    // unbounded scan on a real one. Assert the filter actually arrived in SQL.
    const [filter] = mockList.mock.calls.at(-1) as [
      { type?: string; externalIds?: ReadonlyArray<string>; limit?: number },
    ];
    expect(filter.type).toBe(MEMORY_CONCEPT_TYPE_ID);
    expect(filter.externalIds).toEqual(
      result.plan.items.map((i) => i.externalId),
    );
    // A dry run does not even record a ledger.
    expect(() => readFileSync(path.join(root, MEMORY_SYNC_LEDGER_FILENAME))).toThrow();
    expect(bundleFingerprint(root)).toEqual(before);
  });

  it("syncs the rows, and both primitives can then read them back", async () => {
    store.reset();
    const result = await runMemorySync({ root, transport: handlerTransport() });
    expect(result.created).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.failed).toBe(0);
    expect(store.writes).toHaveLength(2);

    const listed = await list({ type: MEMORY_CONCEPT_TYPE_ID, limit: 50 });
    expect(listed.items).toHaveLength(2);

    // objects_get resolves the same rows, and the SERVER's own identity is on
    // them: `externalId` recomputed from bundleId + conceptId.
    for (const item of listed.items) {
      const fetched = (await get(item["id"] as string)) as {
        object: { data: Record<string, unknown> } | null;
      };
      expect(fetched.object).not.toBeNull();
      const data = fetched.object!.data;
      expect(data["bundleId"]).toBe(bundleId);
      expect(data["externalId"]).toBe(
        computeMemoryConceptExternalId(bundleId, data["conceptId"] as string),
      );
    }
  });

  it("a second sync with no changes writes NOTHING (preflight-verified)", async () => {
    // Continues from the run above: the rows and the ledger both exist.
    const writesBefore = store.writes.length;
    const transport = handlerTransport();
    const result = await runMemorySync({ root, transport });

    expect(result.plan.items.map((i) => i.action)).toEqual(["skip", "skip"]);
    expect(result.created + result.updated).toBe(0);
    expect(store.writes).toHaveLength(writesBefore);
    // The preflight ran; no save did. That is the whole point of the ledger +
    // preflight pair — an untouched bundle churns no version and no history.
    expect(transport.calls.map((c) => c.name)).toEqual(["objects_list"]);
  });

  it("an edited concept syncs as an update, and only that one", async () => {
    const conceptPath = path.join(root, "convention", "never-commit-a-key.md");
    const original = readFileSync(conceptPath, "utf8");
    appendFileSync(conceptPath, "\nRotate a key the moment it leaks.\n");
    try {
      const transport = handlerTransport();
      const result = await runMemorySync({ root, transport });
      expect(result.updated).toBe(1);
      expect(result.created).toBe(0);
      expect(result.skipped).toBe(1);
      expect(transport.calls.filter((c) => c.name === "objects_save")).toHaveLength(1);
      // An update carries NO ownership and NO visibility: the row keeps what it
      // has, which is what lets a promoted row stay promoted through a resync.
      const saveArgs = transport.calls.find((c) => c.name === "objects_save")!.args;
      expect(saveArgs["visibility"]).toBeUndefined();
      expect(saveArgs["ownerLevel"]).toBeUndefined();
      // The row was bumped, not duplicated.
      expect(store.rows.size).toBe(2);
    } finally {
      writeFileSync(conceptPath, original);
    }
  });
});

describe("one-way: the server is written, the bundle is not", () => {
  it("leaves every concept file and bundle.yaml byte-identical across a full sync", async () => {
    store.reset();
    rmSync(path.join(root, MEMORY_SYNC_LEDGER_FILENAME), { force: true });
    const before = bundleFingerprint(root);
    await runMemorySync({ root, transport: handlerTransport() });
    const after = bundleFingerprint(root);
    expect(after).toEqual(before);
    // The ONE file a sync run does write is the ledger, and it is deliberately
    // outside the fingerprint above: it is local bookkeeping, not bundle
    // content, and it is not a `.md` file, so the walk never reads it back in
    // as a concept.
    expect(readFileSync(path.join(root, MEMORY_SYNC_LEDGER_FILENAME), "utf8")).toContain(
      bundleId,
    );
  });

  it("never asks the server to delete a row when a local file disappears", async () => {
    const conceptPath = path.join(root, "command", "run-the-check-after-every-write.md");
    const original = readFileSync(conceptPath, "utf8");
    unlinkSync(conceptPath);
    try {
      const transport = handlerTransport();
      const result = await runMemorySync({ root, transport });
      expect(result.plan.orphans.map((o) => o.path)).toEqual([
        "command/run-the-check-after-every-write.md",
      ]);
      expect(transport.calls.map((c) => c.name)).not.toContain("objects_delete");
      // The row is still there, readable, untouched.
      const listed = await list({ type: MEMORY_CONCEPT_TYPE_ID, limit: 50 });
      expect(listed.items).toHaveLength(2);
    } finally {
      writeFileSync(conceptPath, original);
    }
  });
});

describe("untrusted end-to-end: what the bundle claims decides nothing", () => {
  it("refuses a forged externalId — the server recomputes identity for itself", async () => {
    store.reset();
    const forging: MemorySyncTransport = {
      async callTool(name, args) {
        if (name === "objects_save") {
          const raw = args["rawData"] as Record<string, unknown>;
          // The forgery a malicious bundle would attempt: point this concept's
          // identity at ANOTHER bundle's row.
          raw["externalId"] = computeMemoryConceptExternalId("other-bundle", "convention/theirs");
        }
        return handlerTransport().callTool(name, args);
      },
    };
    const result = await runMemorySync({ root, transport: forging });
    expect(result.created + result.updated).toBe(0);
    expect(result.failed).toBeGreaterThan(0);
    expect(result.diagnostics.every((d) => d.code === "server-refused")).toBe(true);
    expect(store.writes).toEqual([]);
  });

  it("cannot reach another organization's rows — the org axis is actor-derived", async () => {
    store.reset();
    await runMemorySync({ root, transport: handlerTransport() });
    expect(store.rows.size).toBe(2);

    // The same bundle, synced by a caller in another org. Its preflight finds
    // nothing — not "exists but forbidden", simply nothing — so it creates its
    // OWN rows and leaves org-1's alone.
    const stranger = handlerTransport(OTHER_ORG_ACTOR);
    const result = await runMemorySync({ root, transport: stranger });
    expect(result.plan.items.map((i) => i.action)).toEqual(["create", "create"]);
    const org1Rows = [...store.rows.values()].filter((r) => r["orgId"] === "org-1");
    const org2Rows = [...store.rows.values()].filter((r) => r["orgId"] === "org-2");
    expect(org1Rows).toHaveLength(2);
    expect(org2Rows).toHaveLength(2);
    // org-1's rows were not rewritten by the stranger's run.
    expect(org1Rows.every((r) => r["version"] === 1)).toBe(true);

    // And the stranger's own list answers only its own org.
    const listed = await list({ type: MEMORY_CONCEPT_TYPE_ID, limit: 50 }, OTHER_ORG_ACTOR);
    expect(listed.items).toHaveLength(2);
    expect(
      [...store.rows.values()].filter((r) =>
        listed.items.some((i) => i["id"] === r["id"]),
      ).every((r) => r["orgId"] === "org-2"),
    ).toBe(true);
  });

  it("refuses a credential a CLIENT never scanned — the server gate decides", async () => {
    // The client scans first, so its own refusal is what an author normally
    // sees. That is a courtesy, not the boundary. Here the payload is poisoned
    // AFTER the client cleared it — exactly what a modified or third-party
    // client would send — and the server refuses it anyway, with a code, and
    // without echoing the literal into the diagnostic.
    store.reset();
    const poisoning: MemorySyncTransport = {
      async callTool(name, args) {
        if (name === "objects_save") {
          const raw = args["rawData"] as Record<string, unknown>;
          raw["bodyMarkdown"] = `${raw["bodyMarkdown"] as string}\nkey: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345\n`;
        }
        return handlerTransport().callTool(name, args);
      },
    };
    const result = await runMemorySync({ root, transport: poisoning });
    expect(result.created + result.updated).toBe(0);
    expect(result.failed).toBe(2);
    expect(store.writes).toEqual([]);
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.code).toBe("server-refused");
      expect(diagnostic.message).toContain("credential-shaped literal");
      expect(diagnostic.message).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
    }
  });

  it("blocks a credential LOCALLY too, and still syncs the rest of the bundle", async () => {
    store.reset();
    const conceptPath = path.join(root, "convention", "leaky.md");
    writeFileSync(
      conceptPath,
      "---\ntype: convention\ntitle: Leaky\n---\n\nUse ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 for the API.\n",
    );
    try {
      // The client blocks it first, which is the local diagnostic the issue
      // asks for. The SERVER-side proof that the same payload is refused even
      // when a client does not scan is the ingest suite; here we assert the
      // client's refusal never reaches a write, and the rest of the bundle
      // still syncs.
      const transport = handlerTransport();
      const result = await runMemorySync({ root, transport });
      expect(result.blocked).toBe(1);
      expect(
        result.plan.items.find((i) => i.path === "convention/leaky.md")?.action,
      ).toBe("blocked");
      const savedPaths = transport.calls
        .filter((c) => c.name === "objects_save")
        .map((c) => (c.args["rawData"] as Record<string, unknown>)["conceptId"]);
      expect(savedPaths).not.toContain("convention/leaky");
      // And the refusal names the shape, never the literal.
      const hit = result.plan.diagnostics.find((d) => d.code === "secret-detected");
      expect(hit?.message).toContain("github-pat");
      expect(hit?.message).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
    } finally {
      rmSync(conceptPath, { force: true });
      rmSync(path.join(root, MEMORY_SYNC_LEDGER_FILENAME), { force: true });
    }
  });
});
