/**
 * `memory sync` — classification and the one-way invariants (cinatra#1378).
 *
 * The invariants under test are the ones the epic fixes, so each has its own
 * case rather than being implied by a happy path:
 *
 *   - a sync run NEVER mutates the bundle (AC: one-way);
 *   - a run with nothing to do writes NOTHING — no `objects_save`, no ledger
 *     (AC1: the second sync is preflight-verified silent);
 *   - a missing local file NEVER deletes a remote row (AC2);
 *   - a run NEVER narrows an existing row's scope: ownership/visibility ride
 *     only on a create (AC2);
 *   - a forged bundle field cannot widen anything, because identity is
 *     recomputed from bundleId + conceptId and the organization is not
 *     expressible at all.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { initMemoryBundle, loadMemoryBundle } from "../src/bundle.ts";
import { MEMORY_SYNC_LEDGER_FILENAME, loadMemorySyncLedger } from "../src/sync-ledger.ts";
import {
  buildMemoryConceptEnvelope,
  computeMemoryConceptExternalId,
  memoryConceptContentDigest,
} from "../src/sync-envelope.ts";
import { planMemorySync, runMemorySync } from "../src/sync.ts";
import type { MemorySyncTransport } from "../src/sync-transport.ts";
import { emptyMemorySyncLedger } from "../src/sync-ledger.ts";

const roots: string[] = [];

const PROVENANCE = { tool: "@cinatra-ai/memory:sync", toolVersion: "0.1.0" };

/** A transport that records every call and answers from a scripted row table. */
function recordingTransport(rows: Record<string, unknown>[] = []) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const refusals = new Map<string, string>();
  const transport: MemorySyncTransport = {
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === "objects_list") {
        const wanted = new Set((args.externalIds as string[]) ?? []);
        return {
          items: rows.filter((row) => {
            const data = row.data as Record<string, unknown> | undefined;
            return typeof data?.externalId === "string" && wanted.has(data.externalId);
          }),
        };
      }
      if (name === "objects_save") {
        const raw = args.rawData as Record<string, unknown>;
        const refusal = refusals.get(raw.conceptId as string);
        if (refusal !== undefined) throw new Error(refusal);
        return { objectId: `obj-${raw.externalId as string}`, isNew: true };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };
  return { transport, calls, refusals };
}

function bundleWith(
  concepts: Array<{ path: string; frontmatter?: string; body?: string }>,
  configYaml?: string,
): string {
  const root = mkdtempSync(path.join(tmpdir(), "memory-sync-"));
  roots.push(root);
  initMemoryBundle(root, { name: "test" });
  if (configYaml !== undefined) {
    writeFileSync(path.join(root, "bundle.yaml"), configYaml, "utf8");
  }
  for (const concept of concepts) {
    const abs = path.join(root, concept.path);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(
      abs,
      `---\ntype: convention\n${concept.frontmatter ?? ""}---\n${concept.body ?? "Body.\n"}`,
      "utf8",
    );
  }
  return root;
}

/** Byte-level snapshot of everything in the bundle EXCEPT the sync ledger. */
function bundleSnapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
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

function remoteRow(
  root: string,
  conceptPath: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const bundle = loadMemoryBundle(root);
  const concept = bundle.concepts.find((c) => c.path === conceptPath);
  if (concept === undefined) throw new Error(`no concept at ${conceptPath}`);
  const envelope = buildMemoryConceptEnvelope(
    bundle.config.bundleId,
    concept,
    PROVENANCE,
  );
  return {
    id: `obj-${envelope.externalId}`,
    type: "@cinatra-ai/memory:concept",
    data: envelope,
    ownerLevel: "user",
    ownerId: "user-1",
    visibility: "private",
    projectId: null,
    ...overrides,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("planMemorySync — classification", () => {
  it("classifies an unseen concept as a create", async () => {
    const root = bundleWith([{ path: "a.md" }]);
    const { transport } = recordingTransport();
    const result = await runMemorySync({ root, transport, dryRun: true });
    expect(result.plan.items).toHaveLength(1);
    expect(result.plan.items[0]).toMatchObject({ path: "a.md", action: "create" });
  });

  it("classifies an unchanged concept as a skip and writes NOTHING", async () => {
    const root = bundleWith([{ path: "a.md" }]);
    const { transport, calls } = recordingTransport([remoteRow(root, "a.md")]);
    const result = await runMemorySync({ root, transport });
    expect(result.plan.items[0]).toMatchObject({ action: "skip" });
    expect(result.created + result.updated).toBe(0);
    // The whole point: an unchanged bundle issues the preflight and no save at
    // all, so no row version is bumped and no history row is written.
    expect(calls.map((c) => c.name)).toEqual(["objects_list"]);
  });

  it("classifies a changed concept as an update", async () => {
    const root = bundleWith([{ path: "a.md", body: "Old body.\n" }]);
    const stale = remoteRow(root, "a.md");
    writeFileSync(
      path.join(root, "a.md"),
      "---\ntype: convention\n---\nNew body.\n",
      "utf8",
    );
    const { transport } = recordingTransport([stale]);
    const result = await runMemorySync({ root, transport, dryRun: true });
    expect(result.plan.items[0]).toMatchObject({ action: "update" });
  });

  // Regression: the ledger must never overrule the preflight.
  //
  // An earlier shape skipped whenever EITHER the preflight OR the ledger
  // matched the local digest. That loses a write: once anything changes the
  // row after a sync, the ledger still records the digest THIS bundle last
  // pushed, so every later run skips and the local truth is never restored.
  // Both cases below are that bug, and both must now classify as an update.
  it("does NOT skip on a matching ledger when the ROW has since drifted", () => {
    const root = bundleWith([{ path: "a.md" }]);
    const bundle = loadMemoryBundle(root);
    const concept = bundle.concepts[0]!;
    const envelope = buildMemoryConceptEnvelope(
      bundle.config.bundleId,
      concept,
      PROVENANCE,
    );
    const ledger = emptyMemorySyncLedger(bundle.config.bundleId);
    ledger.entries["a.md"] = {
      sha256: memoryConceptContentDigest(envelope),
      objectId: "obj-1",
    };
    const plan = planMemorySync({
      bundle,
      ledger,
      // The last sync pushed this exact content, and something rewrote the row
      // afterwards, so the preflight reports a DIFFERENT digest.
      remote: new Map([
        [envelope.externalId, { objectId: "obj-1", digest: "f".repeat(64) }],
      ]),
    });
    expect(plan.items[0]).toMatchObject({ action: "update" });
    expect(plan.diagnostics.map((d) => d.code)).toContain("ledger-stale");
  });

  it("does NOT skip on a matching ledger when the stored row is not envelope-shaped", () => {
    const root = bundleWith([{ path: "a.md" }]);
    const bundle = loadMemoryBundle(root);
    const concept = bundle.concepts[0]!;
    const envelope = buildMemoryConceptEnvelope(
      bundle.config.bundleId,
      concept,
      PROVENANCE,
    );
    const ledger = emptyMemorySyncLedger(bundle.config.bundleId);
    ledger.entries["a.md"] = {
      sha256: memoryConceptContentDigest(envelope),
      objectId: "obj-1",
    };
    const plan = planMemorySync({
      bundle,
      ledger,
      // A row that exists but whose stored payload this version cannot digest:
      // it has NOT been shown to carry the local content, so the run writes
      // the local truth over it rather than believing the ledger.
      remote: new Map([[envelope.externalId, { objectId: "obj-1", digest: null }]]),
    });
    expect(plan.items[0]).toMatchObject({ action: "update" });
    expect(plan.items[0]?.reason).toContain("not envelope-shaped");
  });
});

describe("one-way: the bundle is never written by a sync run", () => {
  it("leaves every bundle file byte-identical after a full sync", async () => {
    const root = bundleWith([{ path: "a.md" }, { path: "nested/b.md" }]);
    const before = bundleSnapshot(root);
    const { transport } = recordingTransport();
    await runMemorySync({ root, transport });
    expect(bundleSnapshot(root)).toEqual(before);
  });

  it("writes nothing at all — not even the ledger — on a dry run", async () => {
    const root = bundleWith([{ path: "a.md" }]);
    const { transport, calls } = recordingTransport();
    await runMemorySync({ root, transport, dryRun: true });
    expect(calls.every((c) => c.name === "objects_list")).toBe(true);
    expect(readdirSync(root)).not.toContain(MEMORY_SYNC_LEDGER_FILENAME);
  });

  it("leaves the bundle untouched when a concept is blocked by the secret scan", async () => {
    const root = bundleWith([
      { path: "leak.md", body: "token ghp_0123456789abcdefghijklmnopqrstuvwxyz\n" },
    ]);
    const before = bundleSnapshot(root);
    const { transport, calls } = recordingTransport();
    const result = await runMemorySync({ root, transport });
    expect(result.blocked).toBe(1);
    expect(calls.some((c) => c.name === "objects_save")).toBe(false);
    expect(bundleSnapshot(root)).toEqual(before);
  });
});

describe("no remote deletion, ever", () => {
  it("reports a vanished file as a retained orphan and issues no delete", async () => {
    const root = bundleWith([{ path: "a.md" }, { path: "b.md" }]);
    const { transport, calls } = recordingTransport();
    await runMemorySync({ root, transport });
    rmSync(path.join(root, "b.md"));
    const second = recordingTransport([remoteRow(root, "a.md")]);
    const result = await runMemorySync({ root, transport: second.transport });
    expect(result.plan.orphans).toEqual([
      { path: "b.md", conceptId: "b", objectId: expect.any(String) },
    ]);
    expect(
      result.plan.diagnostics.some((d) => d.code === "orphan-retained"),
    ).toBe(true);
    expect(second.calls.some((c) => c.name === "objects_delete")).toBe(false);
    expect(calls.some((c) => c.name === "objects_delete")).toBe(false);
  });
});

describe("no narrowing: scope rides only on a create", () => {
  const CONFIG = [
    "bundleId: 11111111-2222-4333-8444-555555555555",
    "sync:",
    "  ownerLevel: user",
    "  visibility: private",
    "",
  ].join("\n");

  it("sends the requested scope when creating a row", async () => {
    const root = bundleWith([{ path: "a.md" }], CONFIG);
    const { transport, calls } = recordingTransport();
    await runMemorySync({ root, transport });
    const save = calls.find((c) => c.name === "objects_save");
    expect(save?.args).toMatchObject({ ownerLevel: "user", visibility: "private" });
  });

  it("omits ownership and visibility when updating an existing row", async () => {
    const root = bundleWith([{ path: "a.md", body: "Old.\n" }], CONFIG);
    // The remote row was promoted to organization visibility after the last
    // sync. Omitting the tuple is what lets objects_save's ON CONFLICT arm
    // preserve it; sending the bundle default would be a refused narrowing.
    const promoted = remoteRow(root, "a.md", { visibility: "organization" });
    writeFileSync(path.join(root, "a.md"), "---\ntype: convention\n---\nNew.\n", "utf8");
    const { transport, calls } = recordingTransport([promoted]);
    const result = await runMemorySync({ root, transport });
    const save = calls.find((c) => c.name === "objects_save");
    expect(result.plan.items[0]?.action).toBe("update");
    expect(save?.args).not.toHaveProperty("ownerLevel");
    expect(save?.args).not.toHaveProperty("ownerId");
    expect(save?.args).not.toHaveProperty("visibility");
  });

  it("reports a wider remote row as preserved rather than narrowing it", async () => {
    const root = bundleWith([{ path: "a.md" }], CONFIG);
    const promoted = remoteRow(root, "a.md", { visibility: "organization" });
    const { transport } = recordingTransport([promoted]);
    const result = await runMemorySync({ root, transport, dryRun: true });
    const note = result.plan.diagnostics.find((d) => d.code === "scope-preserved");
    expect(note?.message).toMatch(/never narrows/);
  });
});

describe("the project binding is a request, and a conflict is surfaced", () => {
  const CONFIG = [
    "bundleId: 11111111-2222-4333-8444-555555555555",
    "sync:",
    "  projectId: proj-1",
    "",
  ].join("\n");

  it("sends the bundle's projectId on both a create and an update", async () => {
    const root = bundleWith([{ path: "a.md", body: "Old.\n" }, { path: "b.md" }], CONFIG);
    const stale = remoteRow(root, "a.md", { projectId: "proj-1" });
    writeFileSync(path.join(root, "a.md"), "---\ntype: convention\n---\nNew.\n", "utf8");
    const { transport, calls } = recordingTransport([stale]);
    await runMemorySync({ root, transport });
    const saves = calls.filter((c) => c.name === "objects_save");
    expect(saves).toHaveLength(2);
    for (const save of saves) expect(save.args.projectId).toBe("proj-1");
  });

  it("warns when the existing row is bound to a different project", async () => {
    const root = bundleWith([{ path: "a.md" }], CONFIG);
    const elsewhere = remoteRow(root, "a.md", { projectId: "proj-other" });
    const { transport } = recordingTransport([elsewhere]);
    const result = await runMemorySync({ root, transport, dryRun: true });
    const note = result.plan.diagnostics.find((d) => d.code === "project-binding-conflict");
    expect(note?.severity).toBe("warning");
    expect(note?.message).toMatch(/audited operation sync does not perform/);
  });
});

describe("a forged bundle field cannot widen anything", () => {
  it("derives externalId from bundleId + conceptId, never from frontmatter", () => {
    const root = bundleWith([
      {
        path: "a.md",
        // A concept trying to name the row it wants to overwrite.
        frontmatter: `externalId: ${"f".repeat(64)}\nbundleId: 99999999-9999-4999-8999-999999999999\n`,
      },
    ]);
    const bundle = loadMemoryBundle(root);
    const envelope = buildMemoryConceptEnvelope(
      bundle.config.bundleId,
      bundle.concepts[0]!,
      PROVENANCE,
    );
    expect(envelope.externalId).toBe(
      computeMemoryConceptExternalId(bundle.config.bundleId, "a"),
    );
    expect(envelope.externalId).not.toBe("f".repeat(64));
    expect(envelope.bundleId).toBe(bundle.config.bundleId);
    // The forged keys survive in `frontmatter` (tolerant OKF consumption) but
    // decide nothing — the server recomputes externalId from the fields above
    // and rejects a mismatch.
    expect(envelope.frontmatter.externalId).toBe("f".repeat(64));
  });

  it("carries a frontmatter scope request without granting it", async () => {
    const root = bundleWith([
      { path: "a.md", frontmatter: "visibility: public\nownerLevel: organization\n" },
    ]);
    const { transport, calls } = recordingTransport();
    await runMemorySync({ root, transport });
    const save = calls.find((c) => c.name === "objects_save");
    // It is SENT as an input. Whether it is honoured is the server's decision:
    // `deriveSaveDefaults` plus the `object.create` scope-ceiling probe.
    expect(save?.args).toMatchObject({
      visibility: "public",
      ownerLevel: "organization",
    });
    // And nothing anywhere names an organization.
    expect(JSON.stringify(save?.args)).not.toContain("orgId");
  });
});

describe("a server refusal is surfaced, not swallowed", () => {
  it("records the refusal per concept, keeps going, and omits it from the ledger", async () => {
    const root = bundleWith([{ path: "a.md" }, { path: "b.md" }]);
    const { transport, refusals } = recordingTransport();
    refusals.set("a", "OBJECTS_COLLISION_SCOPE_CHANGE_REJECTED: refused");
    const result = await runMemorySync({ root, transport });
    expect(result.failed).toBe(1);
    expect(result.created).toBe(1);
    const diagnostic = result.diagnostics.find((d) => d.code === "server-refused");
    expect(diagnostic?.path).toBe("a.md");
    expect(diagnostic?.message).toContain("OBJECTS_COLLISION_SCOPE_CHANGE_REJECTED");
    const ledger = loadMemorySyncLedger(root, loadMemoryBundle(root).config.bundleId);
    expect(Object.keys(ledger.entries)).toEqual(["b.md"]);
  });
});

describe("the ledger is bookkeeping, never bundle content", () => {
  it("is not a markdown file, so the bundle walk never reads it as a concept", async () => {
    const root = bundleWith([{ path: "a.md" }]);
    const { transport } = recordingTransport();
    await runMemorySync({ root, transport });
    expect(readdirSync(root)).toContain(MEMORY_SYNC_LEDGER_FILENAME);
    expect(loadMemoryBundle(root).concepts.map((c) => c.path)).toEqual(["a.md"]);
  });

  it("falls back to knowing nothing when it describes a different bundle", async () => {
    const root = bundleWith([{ path: "a.md" }]);
    writeFileSync(
      path.join(root, MEMORY_SYNC_LEDGER_FILENAME),
      JSON.stringify({
        ledgerFormat: 1,
        bundleId: "00000000-0000-4000-8000-000000000000",
        entries: { "a.md": { sha256: "deadbeef", objectId: "obj-foreign" } },
      }),
      "utf8",
    );
    const ledger = loadMemorySyncLedger(root, loadMemoryBundle(root).config.bundleId);
    expect(ledger.entries).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Round-3 review probes (PR #3017), client half.
// ---------------------------------------------------------------------------

/** A synthetic credential shape — an ordered alphabet run, never a real key. */
const SHAPED_PAT = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";

describe("item 12 — the local scan runs BEFORE the preflight", () => {
  it("keeps a blocked concept's key out of the preflight batch", async () => {
    const root = bundleWith([
      { path: "clean.md" },
      { path: "dirty.md", body: `The token is ${SHAPED_PAT}\n` },
    ]);
    const { transport, calls } = recordingTransport();
    await runMemorySync({ root, transport });

    const preflight = calls.filter((c) => c.name === "objects_list");
    expect(preflight).toHaveLength(1);
    const batch = preflight[0]!.args.externalIds as string[];
    const bundle = loadMemoryBundle(root);
    const dirty = bundle.concepts.find((c) => c.path === "dirty.md")!;
    const dirtyKey = buildMemoryConceptEnvelope(
      bundle.config.bundleId,
      dirty,
      PROVENANCE,
    ).externalId;
    // The blocked concept's key never leaves the machine at all.
    expect(batch).not.toContain(dirtyKey);
    expect(batch).toHaveLength(1);
  });

  it("produces the local diagnostic with NO server in reach when every concept is blocked", async () => {
    // The scan-only path. The transport below throws on any call, so a run
    // that still reached the preflight would fail instead of reporting.
    const root = bundleWith([{ path: "dirty.md", body: `The token is ${SHAPED_PAT}\n` }]);
    const unreachable: MemorySyncTransport = {
      async callTool() {
        throw new Error("the endpoint must not be contacted");
      },
    };
    const result = await runMemorySync({ root, transport: unreachable });
    expect(result.blocked).toBe(1);
    expect(result.plan.items[0]).toMatchObject({ path: "dirty.md", action: "blocked" });
    expect(
      result.plan.diagnostics.some((d) => d.code === "secret-detected"),
    ).toBe(true);
  });

  it("blocks a concept whose frontmatter names an owning principal", async () => {
    // cinatra#1378 review item 4, client half: `ownerId` is refused loudly
    // rather than dropped, so the author is never left believing the row landed
    // under an owner it did not.
    const root = bundleWith([
      { path: "owned.md", frontmatter: "ownerId: user-VICTIM\n" },
    ]);
    const { transport, calls } = recordingTransport();
    const result = await runMemorySync({ root, transport });
    expect(result.blocked).toBe(1);
    expect(
      result.plan.diagnostics.some((d) => d.code === "scope-key-refused"),
    ).toBe(true);
    expect(calls.filter((c) => c.name === "objects_save")).toHaveLength(0);
  });
});

describe("round-2 item 5 — planMemorySync has no public off switch", () => {
  it("still blocks a credential-carrying concept when a caller hands in an empty override", () => {
    // `blocked` is no longer part of the public `MemorySyncPlanInput` — the
    // scan runs internally and fresh, every call. A caller reaching past the
    // type system (a stale build, a hand-rolled input object) with an old-shape
    // `blocked: new Map()` must have zero effect: the concept still blocks.
    const root = bundleWith([
      { path: "dirty.md", body: `The token is ${SHAPED_PAT}\n` },
    ]);
    const bundle = loadMemoryBundle(root);
    const ledger = emptyMemorySyncLedger(bundle.config.bundleId);
    const plan = planMemorySync({
      bundle,
      ledger,
      remote: new Map(),
      ...({ blocked: new Map() } as Record<string, unknown>),
    } as never);
    expect(plan.items[0]).toMatchObject({ path: "dirty.md", action: "blocked" });
    expect(plan.diagnostics.some((d) => d.code === "secret-detected")).toBe(true);
  });
});

describe("item 10 — the wire parsing does not fail open in either direction", () => {
  it("aborts rather than reading an unreadable preflight as \"no such row\"", async () => {
    // Read as "no such row", every concept classifies `create` and the run
    // duplicates the whole bundle.
    const root = bundleWith([{ path: "a.md" }]);
    const transport: MemorySyncTransport = {
      async callTool(name) {
        if (name === "objects_list") return { unexpected: true };
        throw new Error("no write may be attempted");
      },
    };
    await expect(runMemorySync({ root, transport })).rejects.toThrow(
      /carried no `items` array/,
    );
  });

  it("aborts on a preflight row it cannot read", async () => {
    const root = bundleWith([{ path: "a.md" }]);
    const transport: MemorySyncTransport = {
      async callTool(name) {
        if (name === "objects_list") return { items: [{ id: "obj-1" }] };
        throw new Error("no write may be attempted");
      },
    };
    await expect(runMemorySync({ root, transport })).rejects.toThrow(
      /without a non-empty `id` and `data.externalId`/,
    );
  });

  // Round-2 item 2: an EMPTY string satisfies `typeof x === "string"` and used
  // to be accepted, keying the row into the remote map under `""` — the same
  // shape as "no such row", one level below where the item-10 fix stopped.
  // Round-3 item 1: each predicate gets a case IT ALONE can fail — a
  // both-empty row lets either half of the check cover for the other, so
  // deleting one half stayed green.
  it("aborts on a preflight row whose externalId alone is an empty string", async () => {
    const root = bundleWith([{ path: "a.md" }]);
    const transport: MemorySyncTransport = {
      async callTool(name) {
        if (name === "objects_list") {
          return { items: [{ id: "row-1", data: { externalId: "" } }] };
        }
        throw new Error("no write may be attempted");
      },
    };
    await expect(runMemorySync({ root, transport })).rejects.toThrow(
      /without a non-empty `id` and `data.externalId`/,
    );
  });

  it("aborts on a preflight row whose id alone is an empty string", async () => {
    const root = bundleWith([{ path: "a.md" }]);
    const transport: MemorySyncTransport = {
      async callTool(name) {
        if (name === "objects_list") {
          return { items: [{ id: "", data: { externalId: "e".repeat(64) } }] };
        }
        throw new Error("no write may be attempted");
      },
    };
    await expect(runMemorySync({ root, transport })).rejects.toThrow(
      /without a non-empty `id` and `data.externalId`/,
    );
  });

  it("aborts rather than counting an unconfirmed save as created", async () => {
    const root = bundleWith([{ path: "a.md" }]);
    const transport: MemorySyncTransport = {
      async callTool(name) {
        if (name === "objects_list") return { items: [] };
        return { acknowledged: true };
      },
    };
    await expect(runMemorySync({ root, transport })).rejects.toThrow(
      /carried no non-empty `objectId`/,
    );
  });

  // Round-2 item 2: a save answering `{ objectId: "" }` used to complete and
  // write a ledger entry pointing at `""` — a row this run never saw.
  it("aborts rather than counting a save answering an empty objectId as created", async () => {
    const root = bundleWith([{ path: "a.md" }]);
    const transport: MemorySyncTransport = {
      async callTool(name) {
        if (name === "objects_list") return { items: [] };
        return { objectId: "" };
      },
    };
    await expect(runMemorySync({ root, transport })).rejects.toThrow(
      /carried no non-empty `objectId`/,
    );
    // The reason the check exists: no ledger entry may point at a row id this
    // run never saw — the empty answer earns NOTHING in the ledger (round-3
    // item 4).
    const bundleId = loadMemoryBundle(root).config.bundleId;
    const ledger = loadMemorySyncLedger(root, bundleId);
    expect(Object.keys(ledger.entries)).toHaveLength(0);
  });

  it("still flushes the ledger for the writes that DID land before the abort", async () => {
    // A ledger entry that was earned and then dropped becomes a duplicate
    // write on the next run, so the abort must not lose it.
    const root = bundleWith([{ path: "a.md" }, { path: "b.md" }]);
    let seen = 0;
    const transport: MemorySyncTransport = {
      async callTool(name, args) {
        if (name === "objects_list") return { items: [] };
        seen += 1;
        if (seen === 1) {
          const raw = args.rawData as Record<string, unknown>;
          return { objectId: `obj-${raw.externalId as string}` };
        }
        // An EMPTY objectId, not a missing one: the exact case the non-empty
        // check was added for is the case this test drives (round-3 item 4).
        return { objectId: "" };
      },
    };
    await expect(runMemorySync({ root, transport })).rejects.toThrow(/objectId/);
    const bundleId = loadMemoryBundle(root).config.bundleId;
    const ledger = loadMemorySyncLedger(root, bundleId);
    expect(Object.keys(ledger.entries)).toHaveLength(1);
  });
});
