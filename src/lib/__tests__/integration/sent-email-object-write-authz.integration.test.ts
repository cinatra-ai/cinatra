/**
 * cinatra#1983 — sent-email semantic-record WRITE, REAL objects_save authz/store
 * boundary (real-DB integration).
 *
 * This is the AC6 load-bearing regression. It drives the REAL host email-routing
 * `saveSentEmailObject` writer → the REAL `createSessionObjectsClient` → the REAL
 * in-process `objects_save` handler → the REAL `enforceResourceAccess` gate → the
 * REAL objects-store, against a REAL Postgres (a lane-unique schema cloned from
 * the migrated `cinatra` schema on the shared verify pg, dropped after). It does
 * NOT mock `objectsClient.save` — a mocked save is exactly what masked this class
 * (the existing src/lib/__tests__/email-transport-correlation-writers.test.ts
 * mocks the client and cannot observe the drop).
 *
 * RED on origin/main: `saveSentEmailObject` writes via the roleless, org-less
 * `objectsClient` singleton, so `objects_save` fails closed (null-org throw) /
 * denies (roleless object.create), the writer's best-effort try/catch swallows it,
 * and NO `@cinatra-ai/email:sent-email` row is persisted — the org-scoped read
 * back returns nothing and the assertions below fail.
 *
 * GREEN after the fix: the writer builds an authorization-bearing, org-scoped
 * actor (the run-owner / session standing) from `routing.orgId` / `routing.userId`,
 * `object.create` is granted (owner short-circuit for the owner's own row), the
 * record persists under the run's org, and the org-scoped list/get reads it back.
 *
 * Runner (real DB required — else the suite self-skips):
 *   SUPABASE_DB_URL=<verify pg conn> SUPABASE_SCHEMA=<lane schema> \
 *     pnpm exec vitest run --config vitest.integration-1983.config.ts
 * (The SUPABASE_SCHEMA schema is CREATED + cloned in beforeAll and DROPPED in
 * afterAll; the store's `@/lib/database` is shimmed to resolve conn/schema from
 * these env vars — see tests/__stubs__/database-realconn-1983.ts.)
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActorContext } from "@/lib/authz/actor-context";
import type { HostEmailRoutingService } from "@cinatra-ai/sdk-extensions";

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const SCHEMA = (process.env.SUPABASE_SCHEMA ?? "").trim();
// This suite CREATEs and, in afterAll, DROPs the supplied SCHEMA `… CASCADE`.
// That is destructive, so the schema is fenced to a LANE-OWNED, identifier-safe
// name and can NEVER be a shared/app schema:
//   - it must match the lane-test prefix `lane_1983…` and contain ONLY
//     [a-z0-9_] (so the `"${SCHEMA}"` interpolation carries no quote/inject
//     surface — the regex IS the identifier escape), and
//   - it is explicitly denied against known shared schemas (a defensive belt on
//     top of the prefix — `public`, `cinatra`, the pg catalogs).
// Fail-closed: anything not matching → the suite self-skips (no CREATE, no DROP,
// no fail-vacuous pass), rather than risk dropping a real schema.
const SAFE_LANE_SCHEMA = /^lane_1983[a-z0-9_]*$/;
const SHARED_SCHEMAS = new Set([
  "public",
  "cinatra",
  "information_schema",
  "pg_catalog",
  "pg_toast",
]);
// A real DB AND a lane-owned, drop-safe schema are required for this suite to run.
const HAS_REAL_DB =
  DB_URL !== "" &&
  !DB_URL.includes("unused:unused@") &&
  SAFE_LANE_SCHEMA.test(SCHEMA) &&
  !SHARED_SCHEMAS.has(SCHEMA.toLowerCase());

const SENT_EMAIL_TYPE = "@cinatra-ai/email:sent-email";
const ORG = "org-1983-write-actor";
const OWNER = "user-owner-1983";
const CONNECTOR = "gmailish";

function ownerReadActor(): ActorContext {
  // The reconcile vantage: the run owner reads back their own sent-email rows
  // via an org-scoped list. HumanUser + member is exactly buildActorContextFromRun's
  // shape for an org member.
  return {
    principalType: "HumanUser",
    principalId: OWNER,
    organizationId: ORG,
    orgRole: "member",
    authSource: "worker",
    policyVersion: "v2",
  };
}

describe.skipIf(!HAS_REAL_DB)(
  "cinatra#1983 — sent-email write drives the real objects_save authz/store boundary",
  () => {
    let admin: Client;
    let routing: HostEmailRoutingService;
    let createSessionObjectsClient: (actor: ActorContext) => {
      list: (inp: { type?: string; limit?: number }) => Promise<{ items: unknown[] }>;
    };

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();

      // Lane-unique schema, cloned from the migrated `cinatra` schema so the real
      // objects-store's full write closure (objects + change_set +
      // object_change_event + graphiti_projection_outbox +
      // artifact_binding_reconcile_queue + the claim/assertion reads) resolves.
      await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await admin.query(`CREATE SCHEMA "${SCHEMA}"`);
      const tables = await admin.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'cinatra'`,
      );
      for (const { tablename } of tables.rows) {
        try {
          await admin.query(
            `CREATE TABLE "${SCHEMA}"."${tablename}" (LIKE "cinatra"."${tablename}" INCLUDING ALL)`,
          );
        } catch {
          // Tolerate a table that won't structurally clone (e.g. an exotic
          // default) — the write/read closure's tables clone cleanly; a failure
          // to reach one surfaces as a clear "relation does not exist" below.
        }
      }

      // The verify pg's base `cinatra` schema is missing part of the objects
      // WRITE closure (`change_set` + `object_change_event` are not present in
      // the live cinatra schema), so a clone alone can't complete a real
      // `objects_save`. Top the clone up with the store's OWN canonical DDL for
      // every schema-local store table it does not already carry — every
      // statement is CREATE … IF NOT EXISTS, so the already-cloned tables
      // (current shape, straight off the live migrated schema) are left
      // untouched and ONLY the genuinely-missing ones are created. Better-Auth
      // `public.*`-referencing statements (e.g. project_grants / run_co_owners
      // FKs — tables the sent-email write path never touches) are skipped: the
      // verify pg carries no `public."user"/"team"/"organization"`. This keeps
      // the real objects_save/authz/store boundary intact while making the suite
      // robust to the base schema being a partial clone.
      const { buildCreateStoreSchemaQueries } = (await import(
        "@/lib/drizzle-store"
      )) as { buildCreateStoreSchemaQueries: (s: string) => Array<{ text: string; values?: unknown[] }> };
      for (const q of buildCreateStoreSchemaQueries(SCHEMA)) {
        const isCreateTable = /^\s*CREATE TABLE IF NOT EXISTS/i.test(q.text);
        const isCreateIndex = /^\s*CREATE (UNIQUE )?INDEX IF NOT EXISTS/i.test(q.text);
        if (!isCreateTable && !isCreateIndex) continue; // skip DO-blocks / ALTER / triggers
        if (/public[."]/i.test(q.text)) continue; // skip Better-Auth public.* deps
        if ((q.values?.length ?? 0) > 0) continue; // pure DDL only
        await admin.query(q.text).catch(() => {});
      }

      // Register the object types so the classifier fast-path resolves the
      // sent-email type WITHOUT an LLM (see the llm shim). Same barrel import the
      // writer uses for createSessionObjectsClient.
      const objects = (await import("@cinatra-ai/objects")) as unknown as {
        registerAllObjectTypes: () => void;
        createSessionObjectsClient: typeof createSessionObjectsClient;
      };
      objects.registerAllObjectTypes();
      createSessionObjectsClient = objects.createSessionObjectsClient;

      // Import the module under test — it auto-registers the host email-routing
      // capability on load. NO mock of @cinatra-ai/objects: the real writer +
      // real objects client + real objects_save run.
      await import("@/lib/register-email-providers");
      const { resolveCapabilityProviders } = await import(
        "@/lib/extension-capabilities-registry"
      );
      const { HOST_CONNECTOR_SERVICE_CAPABILITIES } = await import(
        "@cinatra-ai/sdk-extensions/internal"
      );
      const provider = resolveCapabilityProviders(
        HOST_CONNECTOR_SERVICE_CAPABILITIES.emailRouting,
      )[0];
      if (!provider) throw new Error("email-routing capability not registered");
      routing = provider.impl as HostEmailRoutingService;
    }, 120_000);

    afterAll(async () => {
      if (admin && SCHEMA) {
        await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => {});
      }
      await admin?.end().catch(() => {});
    });

    it("persists the sent-email record under the run's org and reads it back org-scoped (AC2/AC6)", async () => {
      const providerMessageId = `msg-${randomUUID().slice(0, 12)}`;
      const idempotencyKey = `email-send:${CONNECTOR}:${providerMessageId}`;

      // The run-scoped test-send shape: routing carries the run's org + owner.
      await routing.saveSentEmailObject!({
        msg: { fromEmail: "me@x.co", to: ["them@y.co"], subject: "1983 real-store" },
        receipt: {
          providerId: CONNECTOR,
          providerMessageId,
          providerThreadId: "thread-1983",
          internetMessageId: `<${providerMessageId}@mail>`,
          sentAt: "2026-07-22T10:00:00.000Z",
        },
        routing: { connectorId: CONNECTOR, orgId: ORG, userId: OWNER },
        correlation: { campaignId: "camp-1983" },
      });

      // (a) Persisted under the run's org scope — assert the raw row directly.
      const raw = await admin.query<{
        org_id: string | null;
        owner_level: string;
        owner_id: string;
        data: Record<string, unknown>;
      }>(
        `SELECT org_id, owner_level, owner_id, data
           FROM "${SCHEMA}"."objects"
          WHERE type = $1 AND data->>'idempotencyKey' = $2 AND deleted_at IS NULL`,
        [SENT_EMAIL_TYPE, idempotencyKey],
      );
      expect(raw.rows).toHaveLength(1);
      expect(raw.rows[0].org_id).toBe(ORG);
      // The run owner's own scope (the same scope the send/ledger ran under).
      expect(raw.rows[0].owner_level).toBe("user");
      expect(raw.rows[0].owner_id).toBe(OWNER);
      expect(raw.rows[0].data.campaignId).toBe("camp-1983");
      expect(raw.rows[0].data.connectorId).toBe(CONNECTOR);

      // (b) Readable back by an org-scoped list/get for that org (the reconcile
      //     vantage) — the REAL objects_list handler, not a raw query.
      const client = createSessionObjectsClient(ownerReadActor());
      const { items } = await client.list({ type: SENT_EMAIL_TYPE, limit: 100 });
      const match = (items as Array<{ data?: Record<string, unknown> }>).find(
        (i) => i.data?.idempotencyKey === idempotencyKey,
      );
      expect(match, "the sent-email record must be readable back org-scoped").toBeTruthy();
      expect(match!.data!.campaignId).toBe("camp-1983");
    });

    it("a genuinely org-less send persists NO row (AC3)", async () => {
      const providerMessageId = `msg-orgless-${randomUUID().slice(0, 12)}`;
      const idempotencyKey = `email-send:${CONNECTOR}:${providerMessageId}`;

      // sendPlatformEmail's shape: no org, no user (pre-auth platform mail).
      await routing.saveSentEmailObject!({
        msg: { fromEmail: "sys@x.co", to: ["u@y.co"], subject: "platform" },
        receipt: {
          providerId: CONNECTOR,
          providerMessageId,
          sentAt: "2026-07-22T10:05:00.000Z",
        },
        routing: { connectorId: CONNECTOR },
      });

      const raw = await admin.query(
        `SELECT 1 FROM "${SCHEMA}"."objects"
          WHERE type = $1 AND data->>'idempotencyKey' = $2`,
        [SENT_EMAIL_TYPE, idempotencyKey],
      );
      expect(raw.rows).toHaveLength(0);
    });
  },
);
