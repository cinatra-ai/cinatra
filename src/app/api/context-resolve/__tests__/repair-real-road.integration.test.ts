/**
 * THE SEAM THAT PARKED THE REPAIR (cinatra#3080, fix leg 3), against a real
 * Postgres and with the decision UN-STUBBED.
 *
 * The child context flow asks this route one question and branches on the
 * answer: `selectionMode` "autonomous" takes the no-person road, anything else
 * opens the screen. That single field is what decided every measured press —
 * the repair run reached the screen, parked at pending_approval, filed no
 * revision, and the settled review never got its successor.
 *
 * Leg 2's route-level suite mocked `resolveInheritedContextSelection` and
 * asserted what the route does with an answer handed to it, so it could not see
 * that the real decision, against the real store, went the other way. Here the
 * route, the leaf and the audit store are all real; only the three reads that
 * need bridge auth and an on-disk OAS are stood in for.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import type { ContextCandidate } from "@/lib/artifacts/context-route-support";

const TEST_SCHEMA = "cinatra_test_context_route_3080";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !DB_URL.includes("unused:unused");
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-3080-context-route";
const SLOT = "draftContext";
const PACKAGE = "@cinatra-ai/blog-draft-writer-agent";

vi.mock("server-only", () => ({}));

const deriveContextRouteContext = vi.fn();
const loadTrustedSlot = vi.fn();
const resolveCandidates = vi.fn();

vi.mock("@/lib/artifacts/context-route-io", () => ({
  deriveContextRouteContext: (...a: unknown[]) => deriveContextRouteContext(...a),
  loadTrustedSlot: (...a: unknown[]) => loadTrustedSlot(...a),
  resolveCandidates: (...a: unknown[]) => resolveCandidates(...a),
}));

let POST: (req: Request) => Promise<Response>;
let client: Client;

/** The one context slot the measured producing template declares: it admits an
 *  empty selection and it is the ONLY one, which is exactly why nothing else
 *  could vouch for the producing run having reached the end of the flow. */
function theOneSlot(over: Record<string, unknown> = {}) {
  return {
    slotId: SLOT,
    acceptedArtifactExtensions: [
      "@cinatra-ai/brand-voice-artifact",
      "@cinatra-ai/blog-idea-artifact",
    ],
    selectionMode: "interactive",
    resolutionMode: "accumulate",
    minItems: 0,
    maxItems: 5,
    readableOnly: true,
    ...over,
  };
}

function candidate(): ContextCandidate {
  return {
    artifactId: `art-${randomUUID()}`,
    representationRevisionId: `rev-${randomUUID()}`,
    semanticAssertionId: `sem-${randomUUID()}`,
    extension: "@cinatra-ai/brand-voice-artifact",
    sourceScope: "organization",
    ownerId: ORG,
  };
}

/** The run row the dispatch drain mints for a repair, as the route reads it. */
function repairRun(
  producingRunId: string,
  over: { baseTarget?: { artifactId: string; representationRevisionId: string } | null } = {},
) {
  const baseTarget =
    over.baseTarget === undefined
      ? { artifactId: `art-${randomUUID()}`, representationRevisionId: `rev-${randomUUID()}` }
      : over.baseTarget;
  return {
    id: `lifecycle-repair-run:${randomUUID()}`,
    orgId: ORG,
    runBy: "user-1",
    sourceType: "lifecycle_repair",
    parentRunId: producingRunId,
    inputParams: {
      idea: { title: "an idea" },
      lifecycleRepairRequest: {
        kind: "lifecycle_repair_request",
        repairId: randomUUID(),
        ...(baseTarget
          ? { baseTarget, expectedBaseRevisionId: baseTarget.representationRevisionId }
          : {}),
      },
    },
  };
}

function bind(run: ReturnType<typeof repairRun>, candidates: ContextCandidate[], slot = theOneSlot()) {
  deriveContextRouteContext.mockResolvedValue({
    actor: { sub: "user-1", organizationId: ORG },
    run,
    servedBy: "run_token",
    projectId: undefined,
    trustedPackageName: PACKAGE,
    trustedSlotPackageName: PACKAGE,
  });
  loadTrustedSlot.mockResolvedValue(slot);
  resolveCandidates.mockResolvedValue(candidates);
}

function resolveRequest(run: ReturnType<typeof repairRun>): Request {
  return new Request("http://localhost/api/context-resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      parentRunId: run.id,
      parentPackageName: PACKAGE,
      slotId: SLOT,
    }),
  });
}

beforeAll(async () => {
  if (!HAS_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;

  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
  await admin.query(`CREATE SCHEMA "${q(TEST_SCHEMA)}"`);
  const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
  for (const qy of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
    const head = qy.text.trim().slice(0, 6).toUpperCase();
    if (head !== "CREATE" && head !== "ALTER " && head !== "DROP T" && head !== "DROP S") continue;
    if (qy.text.includes("user_slug_move_trg")) continue;
    try {
      await admin.query(qy.text, (qy as { values?: unknown[] }).values as never[]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("does not exist") && !msg.includes("already exists")) throw err;
    }
  }
  await admin.end();
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized =
    true;

  ({ POST } = await import("@/app/api/context-resolve/route"));
  client = new Client({ connectionString: DB_URL });
  await client.connect();
}, 90_000);

afterAll(async () => {
  if (!HAS_DB) return;
  await client?.end().catch(() => {});
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean })
    .__cinatraPostgresSchemaInitialized;
});

describe.skipIf(!HAS_DB)(
  "cinatra#3080 — /api/context-resolve answers the child flow for a repair, against the real audit store",
  () => {
    it("routes the repair around the screen when its producing run answered the one slot with nothing", async () => {
      // The producing run left NO audit row: it was shown an empty screen and
      // passed it. This is the state every measured press was made from.
      const run = repairRun(`run-${randomUUID()}`);
      bind(run, [candidate()]);

      const res = await POST(resolveRequest(run));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        selectionMode: string;
        slotMeta: { selectionMode: string };
        selectedRefs: unknown[];
      };
      // The BranchingNode reads this one field, and "autonomous" is the branch
      // with no person on it.
      expect(body.selectionMode).toBe("autonomous");
      expect(body.slotMeta.selectionMode).toBe("autonomous");
      expect(body.selectedRefs).toEqual([]);
    });

    it("keeps the screen for an ordinary run of the very same slot", async () => {
      const ordinary = {
        ...repairRun(`run-${randomUUID()}`),
        id: `run-${randomUUID()}`,
        sourceType: "agent_builder",
      };
      bind(ordinary, [candidate()]);

      const res = await POST(resolveRequest(ordinary));
      expect(res.status).toBe(200);
      expect(((await res.json()) as { selectionMode: string }).selectionMode).toBe("interactive");
    });

    it("keeps the screen for a repair whose delivery names no base revision", async () => {
      const run = repairRun(`run-${randomUUID()}`, { baseTarget: null });
      bind(run, [candidate()]);

      const res = await POST(resolveRequest(run));
      expect(res.status).toBe(200);
      expect(((await res.json()) as { selectionMode: string }).selectionMode).toBe("interactive");
    });

    it("keeps the screen for a slot that requires items", async () => {
      const run = repairRun(`run-${randomUUID()}`);
      bind(run, [candidate()], theOneSlot({ minItems: 1, resolutionMode: "override", maxItems: 1 }));

      const res = await POST(resolveRequest(run));
      expect(res.status).toBe(200);
      expect(((await res.json()) as { selectionMode: string }).selectionMode).toBe("interactive");
    });

    it("hands back the producing run's audited pick when there was one, and still takes the no-person branch", async () => {
      const producingRunId = `run-${randomUUID()}`;
      const picked = candidate();
      await client.query(
        `INSERT INTO "${q(TEST_SCHEMA)}"."run_context_selections"
           (id, org_id, parent_run_id, parent_package_name, slot_id, artifact_id,
            representation_revision_id, semantic_assertion_id, extension, source_scope,
            selected_by, selection_mode)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'user','interactive')`,
        [
          `rcs-${randomUUID()}`,
          ORG,
          producingRunId,
          PACKAGE,
          SLOT,
          picked.artifactId,
          picked.representationRevisionId,
          picked.semanticAssertionId,
          picked.extension,
          picked.sourceScope,
        ],
      );

      const run = repairRun(producingRunId);
      bind(run, [candidate(), picked, candidate()]);

      const res = await POST(resolveRequest(run));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        selectionMode: string;
        selectedRefs: Array<{ artifactId: string }>;
      };
      expect(body.selectionMode).toBe("autonomous");
      expect(body.selectedRefs.map((r) => r.artifactId)).toEqual([picked.artifactId]);
    });
  },
);
