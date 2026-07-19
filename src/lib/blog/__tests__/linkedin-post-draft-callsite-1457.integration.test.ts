/**
 * cinatra#1457 — the CALL-SITE seam proof. The converged publish-prep call-site
 * `projectLinkedinMemberPostDraft` (src/lib/blog/member-post-draft-projection.ts)
 * is driven against a REAL Postgres, proving it produces a typed
 * `@cinatra-ai/linkedin:post-draft` row that the merged draftable-lock gate +
 * publication ledger (#1831/#1450) then GOVERN, and that a retry is idempotent
 * (the deterministic (runId, destinationId) identity — no dup rows).
 *
 * This is the FOCUSED call-site complement to the merged full-lifecycle harness
 * (lane/1457-e2e-proof, PROOF-1..9). It reuses that harness's provisioning + the
 * schedule → locked-edit-rejection governability assertions WITHOUT duplicating
 * the whole battery.
 *
 *   CINATRA_DB_INTEGRATION_TESTS=1 \
 *   SUPABASE_DB_URL=postgres://postgres:postgres@127.0.0.1:5634/verify_1457_callsite \
 *   SUPABASE_SCHEMA=cinatra \
 *     pnpm exec vitest run src/lib/blog/__tests__/linkedin-post-draft-callsite-1457.integration.test.ts
 *
 * The connector's real fail-closed writer is proven in linkedin-connector#59; here
 * a fake writer registered under the REAL capability id does a REAL objects
 * upsert keyed on the (runId, destinationId) identity (the exact dedup contract
 * the host type's identityKey encodes), so idempotency is exercised at the seam.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

const DB_URL = process.env.SUPABASE_DB_URL?.trim() ?? "";
const HAS_REAL_DB =
  process.env.CINATRA_DB_INTEGRATION_TESTS === "1" &&
  DB_URL !== "" &&
  !DB_URL.includes("unused:unused@");

vi.mock("server-only", () => ({}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));
vi.mock("@/lib/database", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const cfg = await import("@/lib/postgres-config");
  return {
    ...actual,
    getPostgresConnectionString: cfg.getPostgresConnectionString,
    postgresSchema: cfg.postgresSchema,
    ensurePostgresSchema: () => {},
  };
});

import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { artifactClaimSchemaQueries } from "@/lib/artifact-claim-schema";
import { semanticAssertionSchemaQueries } from "@/lib/semantic-assertion-schema";
import { publicationOperationLedgerSchemaQueries } from "@/lib/artifacts/publication-operation-schema";
import {
  activateArtifactExtensionClaims,
  type LifecycleClaim,
} from "@/lib/objects/artifact-claim-lifecycle";
import {
  registerAllObjectTypes as registerHostObjectTypes,
  objectTypeRegistry,
} from "@cinatra-ai/objects";
import {
  assertDraftableWriteAllowed,
  DraftLockedError,
} from "@/lib/objects/draftable-lock-gate";
import {
  LINKEDIN_POST_DRAFT_WRITER_CAPABILITY,
  type LinkedinPostDraftWriteRequest,
  type LinkedinPostDraftWriteResult,
} from "@/lib/member-post-draft-writer-provider";
import {
  registerCapabilityProvider,
  __resetCapabilityRegistry,
} from "@/lib/extension-capabilities-registry";
import {
  schedulePublication,
  listPublicationOperationsForArtifact,
} from "@/lib/artifacts/publication-ledger";
import { projectLinkedinMemberPostDraft } from "@/lib/blog/member-post-draft-projection";

const PACK = "@cinatra-ai/linkedin-artifacts";
const LINKEDIN_POST_DRAFT = "@cinatra-ai/linkedin:post-draft";
const S = () => postgresSchema.replaceAll('"', '""');
const orgId = `1457cs-${Date.now()}`;

function exec(text: string, values: unknown[] = []) {
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [{ text, values }],
  });
}
function query(text: string, values: unknown[] = []): Array<Record<string, unknown>> {
  const [res] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [{ text, values }],
  });
  return res?.rows ?? [];
}

const PACK_CLAIMS: LifecycleClaim[] = [
  {
    type: LINKEDIN_POST_DRAFT,
    claim: "dedicated",
    dispositions: {
      projection: "artifact-safe",
      pinnable: true,
      snapshotPolicy: "content",
      sensitivity: "normal",
      mutability: "draftable",
    },
  },
];

/** A fake writer registered under the REAL `linkedin-post-draft-writer`
 * capability id. It does a REAL objects upsert keyed on a DETERMINISTIC id
 * derived from the (runId, destinationId) identity — the exact dedup the host
 * type's identityKey encodes — so a retried call upserts the SAME row. */
function registerFakeWriter(): void {
  registerCapabilityProvider(LINKEDIN_POST_DRAFT_WRITER_CAPABILITY, {
    packageName: "@cinatra-ai/linkedin-connector",
    impl: {
      writeDraft: async (req: LinkedinPostDraftWriteRequest): Promise<LinkedinPostDraftWriteResult> => {
        // (runId, destinationId) identity → stable objectId.
        const identity = `${req.runId}::${req.destination.destinationId}`;
        const objectId = `li-${identity.replace(/[^a-zA-Z0-9]/g, "_")}`;
        const before = query(`SELECT id FROM "${S()}"."objects" WHERE id = $1`, [objectId]);
        const isNew = before.length === 0;
        exec(
          `INSERT INTO "${S()}"."objects" (id, type, data, org_id, source, run_id, version)
             VALUES ($1, $2, $3::jsonb, $4, 'linkedin-connector', $5, 1)
           ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
          [
            objectId,
            LINKEDIN_POST_DRAFT,
            JSON.stringify({
              content: req.content,
              destination: req.destination,
              runId: req.runId,
              orgId: req.orgId,
            }),
            req.orgId,
            req.runId ?? null,
          ],
        );
        return {
          objectId,
          type: LINKEDIN_POST_DRAFT,
          isNew,
          wasMerged: !isNew,
          confidence: 1,
          changeSetId: randomUUID(),
        };
      },
    },
  });
}

const memberInput = {
  projectId: "projX",
  postId: "postY",
  draftId: "draftZ",
  orgId,
  userId: "user-1",
  destinationType: "member" as const,
  accountId: "acct-42",
  destinationId: "urn:li:person:AbC123",
  content: "Excited to share our launch! #buildinpublic",
};

beforeAll(() => {
  if (!HAS_REAL_DB) return;
  const s = S();
  exec(`CREATE SCHEMA IF NOT EXISTS "${s}"`);
  exec(`CREATE TABLE IF NOT EXISTS "${s}"."objects" (
    id text PRIMARY KEY, type text NOT NULL, parent_id text, parent_type text,
    data jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(), created_by text, org_id text,
    source text, version integer NOT NULL DEFAULT 1,
    graphiti_sync_status text DEFAULT 'pending', graphiti_projection_error text,
    owner_level text, owner_id text, visibility text, project_id text,
    run_id text, agent_id text, package_version text, agent_spec_version text,
    deleted_at timestamptz )`);
  for (const q of [
    ...semanticAssertionSchemaQueries(postgresSchema),
    ...artifactClaimSchemaQueries(postgresSchema),
    ...publicationOperationLedgerSchemaQueries(postgresSchema),
  ]) {
    exec(q.text);
  }
  exec(`CREATE TABLE IF NOT EXISTS "${s}"."representation" (
    id text PRIMARY KEY, org_id text NOT NULL, artifact_id text NOT NULL,
    resource_id text NOT NULL, revision integer NOT NULL, form text NOT NULL,
    created_by text, created_by_run_id text,
    created_at timestamptz NOT NULL DEFAULT now(), classifier_signals jsonb,
    CONSTRAINT representation_form_chk CHECK (form IN ('file','connectorRef','dashboard')) )`);
  exec(`CREATE UNIQUE INDEX IF NOT EXISTS representation_artifact_rev_idx ON "${s}"."representation" (org_id, artifact_id, revision)`);

  registerHostObjectTypes();
  activateArtifactExtensionClaims(
    {
      scope: `org:${orgId}`,
      extensionPackage: PACK,
      extensionVersion: "0.1.0",
      actor: "system",
      resolveTypeValidator: (typeId: string) => {
        const def = objectTypeRegistry.resolve(typeId);
        return (data: unknown) => (def ? def.schema.safeParse(data).success : false);
      },
    },
    PACK_CLAIMS,
  );
  __resetCapabilityRegistry();
}, 120_000);

let repSeq = 0;
function seedRepresentation(artifactId: string): string {
  const revId = `rep-${Date.now()}-${repSeq++}`;
  exec(
    `INSERT INTO "${S()}"."representation" (id, org_id, artifact_id, resource_id, revision, form)
       VALUES ($1, $2, $3, $4, ${repSeq + 1}, 'file')`,
    [revId, orgId, artifactId, `res-${revId}`],
  );
  return revId;
}

describe.skipIf(!HAS_REAL_DB)(
  "cinatra#1457 publish-prep CALL-SITE seam — projectLinkedinMemberPostDraft against a real DB",
  () => {
    it("CS-1 (call-site produces a typed draft): the call-site resolves the registered writer and materializes a typed linkedin:post-draft row", async () => {
      __resetCapabilityRegistry();
      registerFakeWriter();
      const outcome = await projectLinkedinMemberPostDraft(memberInput);
      expect(outcome.status).toBe("materialized");
      if (outcome.status !== "materialized") return;
      const persisted = query(`SELECT id, type FROM "${S()}"."objects" WHERE id = $1`, [outcome.objectId]);
      expect(persisted[0]?.type).toBe(LINKEDIN_POST_DRAFT);
    });

    it("CS-2 (idempotent retry — blocker-1): a second call with the same (projectId, postId, draftId) upserts the SAME row (deterministic (runId, destinationId) identity), no dup", async () => {
      __resetCapabilityRegistry();
      registerFakeWriter();
      const first = await projectLinkedinMemberPostDraft(memberInput);
      const second = await projectLinkedinMemberPostDraft(memberInput);
      expect(first.status).toBe("materialized");
      expect(second.status).toBe("materialized");
      if (first.status !== "materialized" || second.status !== "materialized") return;
      expect(second.objectId).toBe(first.objectId);
      const rows = query(`SELECT id FROM "${S()}"."objects" WHERE id = $1`, [first.objectId]);
      expect(rows.length).toBe(1);
    });

    it("CS-3 (ledger/lock GOVERNS the produced row): scheduling a publication for the produced row makes a subsequent content edit fail with DraftLockedError(scheduled)", async () => {
      __resetCapabilityRegistry();
      registerFakeWriter();
      const outcome = await projectLinkedinMemberPostDraft(memberInput);
      expect(outcome.status).toBe("materialized");
      if (outcome.status !== "materialized") return;
      const artifactId = outcome.objectId;

      // While a fresh draft (no ledger op), an edit is allowed by the merged gate.
      await expect(
        assertDraftableWriteAllowed({ orgId, objectTypeId: LINKEDIN_POST_DRAFT, artifactId }),
      ).resolves.toBeUndefined();

      // Schedule via the real ledger — the source-of-truth lock.
      const sched = await schedulePublication({
        orgId,
        artifactId,
        objectTypeId: LINKEDIN_POST_DRAFT,
        pinnedRepresentationRevisionId: seedRepresentation(artifactId),
        destination: { connector: "@cinatra-ai/linkedin-connector", account: "acct-42", ref: "urn:li:person:AbC123" },
      });
      expect(sched.operation.state).toBe("pending");
      const ops = await listPublicationOperationsForArtifact(orgId, artifactId);
      expect(ops.some((o) => o.state === "pending")).toBe(true);

      // The produced row is now ledger/lock-governed: an edit is refused fail-closed.
      let thrown: unknown;
      try {
        await assertDraftableWriteAllowed({ orgId, objectTypeId: LINKEDIN_POST_DRAFT, artifactId });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(DraftLockedError);
      expect((thrown as DraftLockedError).lockState).toBe("scheduled");
      expect((thrown as DraftLockedError).artifactId).toBe(artifactId);
    });

    it("CS-4 (member-only + degraded — criteria d & c): an organization draft is skipped with no write; and with the writer absent the member call degrades (no throw) and writes nothing", async () => {
      // (d) org-page destination is #1767 — skipped, never written.
      __resetCapabilityRegistry();
      registerFakeWriter();
      const orgOutcome = await projectLinkedinMemberPostDraft({
        ...memberInput,
        projectId: "orgProj",
        destinationType: "organization",
      });
      expect(orgOutcome.status).toBe("skipped");

      // (c) writer absent → degraded (surfaced), never throws, no row.
      __resetCapabilityRegistry(); // no writer registered
      const degradedOutcome = await projectLinkedinMemberPostDraft({
        ...memberInput,
        projectId: "absentProj",
      });
      expect(degradedOutcome.status).toBe("degraded");
      const runId = "blog-linkedin-absentProj-postY-draftZ";
      const objectId = `li-${`${runId}::urn:li:person:AbC123`.replace(/[^a-zA-Z0-9]/g, "_")}`;
      const rows = query(`SELECT id FROM "${S()}"."objects" WHERE id = $1`, [objectId]);
      expect(rows.length).toBe(0);
    });
  },
);
