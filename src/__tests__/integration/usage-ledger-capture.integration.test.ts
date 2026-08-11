/**
 * cinatra#2578 — the usage ledger's CAPTURE, proved against a real `usage_events`
 * table.
 *
 * WHY THIS TIER EXISTS. The defect this issue reported was measured as ~36
 * billed gpt-5.5 requests against **1** ledger row, and its mechanism was a row
 * the DATABASE threw away: `insertUsageEvent` does
 * `onConflictDoNothing(idempotency_key)`, and the streaming emitter reused ONE
 * key for every step of a turn, so every step after the first was dropped at the
 * unique index. #2585 / #2588 / #2595 fixed the four paths — but every test
 * covering them mocks either `emitUsageEvent` or `insertUsageEvent`, and the
 * root vitest config replaces the whole bus with a no-op stub. A mocked store
 * CANNOT observe a conflict drop, which is to say: the exact failure mode that
 * cost the money had, and until this file still has, no regression pin at the
 * layer it happened on.
 *
 * WHAT IS REAL HERE. The metering proxy, the attribution frame, the batch
 * orchestrator, the admin key-probe route, the Graphiti episode seam, the
 * in-process bus, the cost subscriber, the pricing card, `insertUsageEvent`, and
 * a real Postgres table carrying the real unique index. What is faked is only
 * what a real provider key or a live network would otherwise be needed for: the
 * connector adapter surface, the MCP transport, the Better-Auth token exchange
 * and the admin session. NO provider key of any kind is used.
 *
 * WHAT IS PINNED
 *   1. CHAT (streaming, the biggest leak): a 14-step turn — the shape the issue
 *      measured as `chat-step-1..14` — writes FOURTEEN rows carrying the true
 *      per-step tokens, and the pre-fix shared-key call shape is replayed to
 *      show the same 14 reports collapsing to ONE row at the index. That
 *      contrast IS the ~10x, reproduced.
 *   2. CHAT (synchronous): one row per call, with the cached-input and
 *      reasoning-output counters preserved rather than zeroed.
 *   3. BATCH: one row per succeeded outcome, and a RE-DOWNLOAD of the same ended
 *      batch adds nothing — proved by the real index, not by a mock.
 *   4. TEST-KEY ROUTE: one `models.list` row per probe press.
 *   5. IMAGE (cinatra#2641): one row per `generateImage()` call, counted with
 *      cost NULL — the method is billed per image and reports no usage at all,
 *      so the call is visible and the dollars stay honestly unknown.
 *   6. GRAPHITI: one row per episode handed over, counted with cost NULL (its
 *      dollars are unknown, and a 0 would read as "free").
 *   7. ACCOUNTING: a mixed workload's ledger totals equal the driven truth, read
 *      back through the same store functions `/analytics/llm` uses.
 *
 * RUNNER (real DB required — the suite self-skips without one):
 *   SUPABASE_DB_URL=postgres://…@127.0.0.1:5634/postgres SUPABASE_SCHEMA=lane_2578x \
 *     pnpm exec vitest run --config vitest.integration-2578.config.ts
 * The schema is CREATED in beforeAll and DROPPED in afterAll.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { Client } from "pg";

// ---------------------------------------------------------------------------
// Fail-closed real-DB fence
// ---------------------------------------------------------------------------

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const SCHEMA = (process.env.SUPABASE_SCHEMA ?? "").trim();

// This suite CREATEs and DROPs a schema `… CASCADE`. That is destructive, so it
// is fenced three ways:
//
//   1. NAME. Only a LANE-OWNED, identifier-safe name is accepted — the regex IS
//      the identifier escape (only [a-z0-9_] survives it, so the `"${SCHEMA}"`
//      interpolations below carry no injection surface) — and known shared
//      schemas are denied on top of it.
//   2. OWNERSHIP. A name matching the prefix is not proof the schema is ours.
//      The suite REFUSES to run against a schema that already exists rather
//      than dropping it, and drops only what this process itself created. A
//      lane name is a convention; someone else's data must not depend on it.
//   3. FAIL-CLOSED. Anything unresolvable ⇒ skip (or, in the dedicated lane
//      below, THROW) — never a destructive guess.
const SAFE_LANE_SCHEMA = /^lane_2578[a-z0-9_]*$/;
const SHARED_SCHEMAS = new Set([
  "public",
  "cinatra",
  "information_schema",
  "pg_catalog",
  "pg_toast",
]);
const HAS_REAL_DB =
  DB_URL !== "" &&
  !DB_URL.includes("unused:unused@") &&
  SAFE_LANE_SCHEMA.test(SCHEMA) &&
  !SHARED_SCHEMAS.has(SCHEMA.toLowerCase());

/**
 * Set by `vitest.integration-2578.config.ts` and by nothing else.
 *
 * A suite whose only failure mode is "skipped" is not a gate — it reports
 * success by doing nothing, which is the same shape of silence this whole issue
 * is about. So the DEDICATED lane refuses to skip: with the flag set, a missing
 * or unusable database is a hard failure that names what is wrong. Under any
 * other config (the root run, an IDE) the flag is absent and the suite skips as
 * a DB-integration tier is expected to.
 */
const IN_DEDICATED_LANE = process.env.CINATRA_USAGE_LEDGER_REALDB === "1";

if (IN_DEDICATED_LANE && !HAS_REAL_DB) {
  throw new Error(
    "the real-ledger lane needs a live Postgres and a lane-owned schema: set " +
      "SUPABASE_DB_URL to a real connection and SUPABASE_SCHEMA to a name " +
      "matching /^lane_2578[a-z0-9_]*$/ that does NOT already exist. " +
      "Refusing to skip — a skipped ledger proof proves nothing.",
  );
}

// ---------------------------------------------------------------------------
// The faked edges — provider transport, auth, MCP. Nothing on the ledger side.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  /** Adapter objects the fake connector surface hands to the registry. */
  adaptersByProvider: {} as Record<string, unknown>,
  /** What `getLlmProviderSurface` answers for the key-probe route. */
  providerSurface: null as unknown,
  /** The admin session the key-probe route sees. */
  session: null as unknown,
  /** MCP tool-call result for the Graphiti hand-over. */
  mcpCallTool: (() => {}) as unknown as (...args: unknown[]) => unknown,
}));

// The connector seam. `resolveProviderAdapter` calls `createAdapter()` on
// whatever this returns and wraps the result in the REAL metering proxy, so the
// adapter below is metered exactly as a shipped connector's would be.
vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderAdapterSurface: vi.fn((providerId: string) => {
    const adapter = h.adaptersByProvider[providerId];
    return adapter
      ? { abiVersion: 1 as const, providerId, createAdapter: async () => adapter }
      : null;
  }),
  getLlmProviderSurface: vi.fn(() => h.providerSurface),
  requireLlmProviderSurface: vi.fn((providerId: string) => {
    throw new Error(`The "${providerId}" LLM provider connector is not installed/active`);
  }),
  listLlmProviderSurfaces: vi.fn(() => []),
}));

// The LLM barrel's own network/DB leaves (mirrors packages/llm's unit harness).
vi.mock("../../../packages/llm/src/mcp-access", () => ({
  withoutReservedFirstPartyLabelTools: vi.fn((tools: unknown[]) => tools),
  buildLlmMcpServerTool: vi.fn(async () => null),
  buildExternalMcpServerTools: vi.fn(async () => []),
  getLlmMcpCredentials: vi.fn(() => ({
    clientId: "probe-client",
    clientSecret: "probe-secret",
    scope: "mcp",
  })),
  hasLlmMcpAccess: vi.fn(() => true),
  getLlmMcpAccessStatus: vi.fn(() => "granted"),
  getPublicMcpServerUrl: vi.fn(() => "https://example.invalid/api/mcp"),
  buildA2aBearerToken: vi.fn(),
}));
vi.mock("@/lib/external-mcp-registry", () => ({
  buildRegisteredExternalMcpServerTools: vi.fn(async () => []),
  buildSingleExternalMcpTool: vi.fn(async () => null),
}));
vi.mock("@/lib/database", () => ({
  readDefaultLlmProviderFromDatabase: vi.fn(() => "openai"),
  readDefaultImageProviderFromDatabase: vi.fn(() => null),
  readLlmProviderFailoverPolicyFromDatabase: vi.fn(() => "exact"),
}));
vi.mock("../../../packages/llm/src/tools/skills", () => ({
  buildSkillTools: vi.fn().mockResolvedValue([]),
  buildSkillContext: vi.fn().mockResolvedValue(""),
  readSkillContent: vi.fn().mockResolvedValue(null),
  createShellTool: vi.fn(),
  createLocalSkillShellTool: vi.fn(),
  createMcpServerTool: vi.fn(),
  createWebSearchTool: vi.fn(),
  buildMcpTools: vi.fn(),
}));

// The Graphiti transport. The indexer is another container; the hand-over is
// the only seam this repo owns and the only one being metered.
vi.mock("@modelcontextprotocol/client", () => ({
  // `function`, not an arrow: the client constructs both of these with `new`.
  Client: vi.fn().mockImplementation(function () {
    return {
      connect: async () => undefined,
      callTool: (...args: unknown[]) => h.mcpCallTool(...args),
      close: async () => undefined,
    };
  }),
  StreamableHTTPClientTransport: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

// The key-probe route's auth + MCP-credential edges.
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn(async () => h.session),
}));
vi.mock("@/lib/auth", () => ({
  auth: {
    handler: vi.fn(
      async () =>
        new Response(JSON.stringify({ access_token: "probe-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ),
  },
}));
vi.mock("@cinatra-ai/mcp-server/credentials", () => ({
  getLocalTokenEndpointUrl: vi.fn(() => "http://127.0.0.1:3000/api/auth/token"),
  getLocalMcpServerUrl: vi.fn(() => "http://127.0.0.1:3000/api/mcp"),
}));
vi.mock("@cinatra-ai/agents", () => ({
  canProviderSatisfyCapability: vi.fn(() => true),
}));

// ---------------------------------------------------------------------------
// The REAL modules under proof
// ---------------------------------------------------------------------------

import { orchestrateDownloadBatchOutcomesV2, resolveProviderAdapter } from "@cinatra-ai/llm";
import { emitLlmUsage, withUsageAttribution } from "../../../packages/llm/src/usage-metering";
import { startUsageEventSubscriber } from "../../../packages/metric-cost-api/src/event-subscriber";
import {
  readCostByAgent,
  readCostByProvider,
  readCostSummary,
} from "../../../packages/metric-cost-api/src/store";
import { usageEvents } from "../../../packages/metric-cost-api/src/schema";
import {
  addEpisode,
  setKnowledgeGraphIndexingProbe,
} from "../../../packages/objects/src/graphiti-client";
import { POST as keyValidationPOST } from "@/app/configuration/mcp/llm-access/test/route";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

type LedgerRow = {
  source: string;
  provider: string;
  model: string | null;
  operation: string | null;
  agent_label: string | null;
  skill_label: string | null;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  reasoning_output_tokens: number;
  cost_usd: string | null;
  idempotency_key: string;
  requested_provider: string | null;
  effective_provider: string | null;
};

/**
 * The ledger table, stated from this repo's own drizzle definition rather than
 * cloned from whatever the verify database happens to carry — the shared verify
 * schema predates `requested_provider` / `effective_provider`, and a clone would
 * have quietly proved the capture against a narrower table than the one the app
 * writes. A parity assertion below keeps this DDL honest as the schema moves.
 */
const USAGE_EVENTS_DDL = `
  CREATE TABLE "%SCHEMA%"."usage_events" (
    id                      text PRIMARY KEY,
    occurred_at             timestamptz NOT NULL,
    created_at              timestamptz NOT NULL DEFAULT now(),
    source                  text NOT NULL,
    provider                text NOT NULL,
    requested_provider      text,
    effective_provider      text,
    model                   text,
    operation               text,
    agent_label             text,
    skill_label             text,
    input_tokens            integer NOT NULL DEFAULT 0,
    output_tokens           integer NOT NULL DEFAULT 0,
    cached_input_tokens     integer NOT NULL DEFAULT 0,
    reasoning_output_tokens integer NOT NULL DEFAULT 0,
    credits_consumed        integer NOT NULL DEFAULT 0,
    cost_usd                numeric(12,8),
    idempotency_key         text NOT NULL
  )`;

/**
 * Drizzle column kind → the `information_schema.columns.data_type` Postgres
 * reports for it. Only the kinds this table uses; an unmapped kind falls
 * through to its drizzle name and fails the comparison loudly rather than
 * silently matching nothing.
 */
const PG_TYPE_BY_DRIZZLE_COLUMN: Record<string, string> = {
  PgText: "text",
  PgInteger: "integer",
  PgNumeric: "numeric",
  PgTimestamp: "timestamp with time zone",
};

/** The index the ~10x loss actually happened on. */
const IDEMPOTENCY_INDEX_DDL = `
  CREATE UNIQUE INDEX usage_events_idempotency_key_idx
    ON "%SCHEMA%"."usage_events" (idempotency_key)`;

/** Pricing is read from this table first, then the in-code card. Empty ⇒ card. */
const MODEL_PRICING_DDL = `
  CREATE TABLE "%SCHEMA%"."model_pricing" (
    id                      text PRIMARY KEY,
    provider                text NOT NULL,
    model_name              text NOT NULL,
    input_cost_per_million  numeric(20,8) NOT NULL,
    output_cost_per_million numeric(20,8) NOT NULL,
    cache_read_per_million  numeric(20,8),
    source                  text NOT NULL DEFAULT 'litellm',
    updated_at              timestamptz NOT NULL DEFAULT now()
  )`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!HAS_REAL_DB)(
  "cinatra#2578 — every instrumented path lands in a real usage_events table",
  () => {
    let admin: Client;
    /** Only a schema this process CREATED may be dropped. */
    let createdSchema = false;

    async function ledgerRows(): Promise<LedgerRow[]> {
      const res = await admin.query<LedgerRow>(
        `SELECT source, provider, model, operation, agent_label, skill_label,
                input_tokens, output_tokens, cached_input_tokens,
                reasoning_output_tokens, cost_usd, idempotency_key,
                requested_provider, effective_provider
           FROM "${SCHEMA}"."usage_events"
          ORDER BY idempotency_key`,
      );
      return res.rows;
    }

    /**
     * Wait until the ledger STOPS CHANGING, not merely until it is big enough.
     *
     * The bus emit is synchronous but its handler is async and deliberately
     * un-awaited by the call path (metering must never block an LLM call), so a
     * settle is the only way a caller observes the write at all. Stopping at the
     * expected count would make the suite blind in the one direction that
     * matters most: a LATE extra row is the double-count class this file exists
     * to catch. So the wait continues until the count has held still for
     * `QUIET_MS` — an extra row that is merely slow still fails the assertion.
     */
    const QUIET_MS = 300;
    async function settledRows(expected: number, timeoutMs = 15_000): Promise<LedgerRow[]> {
      const deadline = Date.now() + timeoutMs;
      let rows = await ledgerRows();
      while (rows.length < expected && Date.now() < deadline) {
        await sleep(20);
        rows = await ledgerRows();
      }
      let lastCount = rows.length;
      let stableSince = Date.now();
      while (Date.now() - stableSince < QUIET_MS && Date.now() < deadline + QUIET_MS) {
        await sleep(25);
        rows = await ledgerRows();
        if (rows.length !== lastCount) {
          lastCount = rows.length;
          stableSince = Date.now();
        }
      }
      return rows;
    }

    /**
     * Drain before truncating.
     *
     * A subscriber still pricing when the next test truncates would land its
     * insert afterwards and contaminate that test's count — a flake that would
     * read as a double-count bug. Waiting for quiescence first makes each test's
     * starting state actually empty.
     */
    async function truncateLedger(): Promise<void> {
      await settledRows(0, 5_000);
      await admin.query(`TRUNCATE "${SCHEMA}"."usage_events"`);
    }

    /**
     * Mint an adapter the way production mints one.
     *
     * `resolveProviderAdapter` is this repo's ONLY caller of a connector's
     * `createAdapter()`, and the wrapping it does there is the whole reason the
     * ledger is structural instead of a convention. A test that called
     * `meterLlmProviderAdapter` itself would keep passing if that wrapping were
     * deleted from the registry — it would prove the proxy while the WIRING
     * rotted, which is the same shape of blind spot this issue is about. So
     * every chat case below is minted through the real seam.
     */
    async function mintAdapter(
      adapter: Record<string, unknown>,
    ): Promise<NonNullable<Awaited<ReturnType<typeof resolveProviderAdapter>>>> {
      h.adaptersByProvider.openai = adapter;
      const minted = await resolveProviderAdapter("openai");
      expect(minted, "the registry did not mint an adapter").not.toBeNull();
      return minted!;
    }

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();

      // Ownership, not naming. `CREATE SCHEMA` without IF NOT EXISTS is the
      // check: an existing schema — someone else's lane, or a leftover holding
      // data — makes this throw instead of being dropped, and `createdSchema`
      // stays false so afterAll leaves it alone.
      await admin.query(`CREATE SCHEMA "${SCHEMA}"`);
      createdSchema = true;
      await admin.query(USAGE_EVENTS_DDL.replaceAll("%SCHEMA%", SCHEMA));
      await admin.query(IDEMPOTENCY_INDEX_DDL.replaceAll("%SCHEMA%", SCHEMA));
      await admin.query(MODEL_PRICING_DDL.replaceAll("%SCHEMA%", SCHEMA));

      // The real subscriber, on the real bus. Idempotent.
      startUsageEventSubscriber();

      // WIRING PRECONDITION. Run under a config that stubs the usage bus — the
      // ROOT config replaces `@cinatra-ai/metric-usage-api` with a NO-OP emitter
      // — and every assertion below fails one at a time with nothing naming the
      // cause. Prove the seam reaches the table once, and say what to fix if it
      // does not, so a misconfigured run reads as a setup error rather than as
      // ten broken capture paths.
      emitLlmUsage({
        provider: "openai",
        model: "gpt-5.5",
        operation: "generate",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
        },
        idempotencyKey: "cinatra-2578-wiring-canary",
      });
      // Short on purpose: the diagnostic has to beat the surrounding config's
      // hook timeout, or the run dies with "hook timed out" and says nothing.
      const canary = await settledRows(1, 3_000);
      if (canary.length !== 1) {
        throw new Error(
          "the usage bus does not reach this schema — the emitter is stubbed or " +
            "SUPABASE_SCHEMA is not the schema this suite created. Run it with " +
            "`--config vitest.integration-2578.config.ts`.",
        );
      }
      await admin.query(`TRUNCATE "${SCHEMA}"."usage_events"`);
    });

    afterAll(async () => {
      setKnowledgeGraphIndexingProbe(null);
      if (admin) {
        // Only what this process created.
        if (createdSchema) await admin.query(`DROP SCHEMA "${SCHEMA}" CASCADE`);
        await admin.end();
      }
    });

    beforeEach(async () => {
      await truncateLedger();
      h.adaptersByProvider = {};
      h.providerSurface = null;
      h.session = null;
      h.mcpCallTool = () => ({
        content: [{ type: "text", text: JSON.stringify({ message: "Episode added" }) }],
      });
      setKnowledgeGraphIndexingProbe(null);
    });

    // -----------------------------------------------------------------------
    // 0. The fixture is the table the app actually writes
    // -----------------------------------------------------------------------

    it("the fixture table matches the shipped schema's columns, types and nullability", async () => {
      // A fixture that drifts from the shipped table turns this whole file into
      // a proof about a table nobody writes. Names alone are not enough: a
      // column that became nullable, or an integer that became numeric, changes
      // what the ledger can hold without changing a single name.
      const declared = Object.values(getTableColumns(usageEvents))
        .map((column) => ({
          name: column.name,
          type: PG_TYPE_BY_DRIZZLE_COLUMN[column.columnType] ?? column.columnType,
          nullable: !column.notNull,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const actual = (
        await admin.query<{
          column_name: string;
          data_type: string;
          is_nullable: string;
        }>(
          `SELECT column_name, data_type, is_nullable
             FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = 'usage_events'`,
          [SCHEMA],
        )
      ).rows
        .map((row) => ({
          name: row.column_name,
          type: row.data_type,
          nullable: row.is_nullable === "YES",
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      expect(actual).toEqual(declared);
    });

    it("the fixture carries the unique index the lost rows were lost on", async () => {
      // The idempotency index is not incidental to this suite — it IS the
      // mechanism the reported ~10x ran through. A fixture without it would let
      // every duplicate assertion below pass for the wrong reason.
      const indexes = (
        await admin.query<{ indexdef: string }>(
          `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'usage_events'`,
          [SCHEMA],
        )
      ).rows.map((row) => row.indexdef);
      expect(
        indexes.some(
          (definition) =>
            /CREATE UNIQUE INDEX/i.test(definition) && /\(idempotency_key\)/.test(definition),
        ),
        `no unique index on idempotency_key: ${indexes.join(" | ")}`,
      ).toBe(true);
    });

    // -----------------------------------------------------------------------
    // 1. CHAT — the biggest leak
    // -----------------------------------------------------------------------

    describe("a streaming chat turn", () => {
      /** The issue's measured shape: labels `chat-step-1` … `chat-step-14`. */
      const STEPS = Array.from({ length: 14 }, (_, index) => ({
        inputTokens: 1000 + index,
        outputTokens: 50 + index,
        cachedInputTokens: 900 + index,
        reasoningOutputTokens: 10 + index,
      }));

      function streamingAdapter() {
        return {
          provider: "openai" as const,
          defaultModel: "gpt-5.5",
          generate: async () => {
            throw new Error("unused in this test");
          },
          stream: async (input: {
            onUsageData?: (usage: (typeof STEPS)[number]) => void;
          }) => {
            for (const step of STEPS) input.onUsageData?.(step);
          },
        };
      }

      it("writes ONE row per step, with that step's true token counts", async () => {
        const adapter = await mintAdapter(streamingAdapter());

        await withUsageAttribution(
          { agentLabel: "chat", skillLabel: "blog-draft-writer", effectiveProvider: "openai" },
          () => adapter.stream({ model: "gpt-5.5", logLabel: "chat-turn" } as never),
        );

        const rows = await settledRows(STEPS.length);
        expect(rows).toHaveLength(STEPS.length);
        expect(new Set(rows.map((row) => row.idempotency_key)).size).toBe(STEPS.length);

        // Every step's tokens are present exactly once — a set comparison, not a
        // sum, because a sum can be reached by the wrong rows.
        const observed = rows
          .map((row) => `${row.input_tokens}/${row.output_tokens}/${row.cached_input_tokens}/${row.reasoning_output_tokens}`)
          .sort();
        const expected = STEPS
          .map((step) => `${step.inputTokens}/${step.outputTokens}/${step.cachedInputTokens}/${step.reasoningOutputTokens}`)
          .sort();
        expect(observed).toEqual(expected);

        for (const row of rows) {
          expect(row.source).toBe("llm");
          expect(row.provider).toBe("openai");
          expect(row.model).toBe("gpt-5.5");
          expect(row.operation).toBe("stream");
          // The frame's agent label WINS over the adapter input's transport label.
          expect(row.agent_label).toBe("chat");
          expect(row.skill_label).toBe("blog-draft-writer");
          expect(row.effective_provider).toBe("openai");
          expect(row.cost_usd).not.toBeNull();
        }
      });

      it("REGRESSION PIN: the pre-fix shared-key shape collapses the same turn to one row", async () => {
        // This is the reported defect, reproduced at the layer it happened on.
        // `createStreamUsageEmitter` minted ONE idempotencyKey per emitter and
        // reused it for every usage report; `insertUsageEvent` conflicts on that
        // column, so steps 2..14 were discarded by Postgres with nothing logged
        // and nothing thrown. No mocked store can see this.
        const sharedKey = "pre-fix-one-key-per-emitter";
        for (const step of STEPS) {
          emitLlmUsage({
            provider: "openai",
            model: "gpt-5.5",
            operation: "stream",
            logLabel: "chat-turn",
            usage: step,
            idempotencyKey: sharedKey,
          });
        }

        const leaked = await settledRows(1);
        expect(leaked).toHaveLength(1);
        // ONE step survived — whichever insert won the race. Which one it is was
        // never determinable, and that is part of the defect: the ledger kept an
        // arbitrary step of the turn and discarded the rest without a trace.
        expect(STEPS.map((step) => step.inputTokens)).toContain(leaked[0]!.input_tokens);

        const leakedTotal = leaked.reduce((sum, row) => sum + row.input_tokens, 0);
        const trueTotal = STEPS.reduce((sum, step) => sum + step.inputTokens, 0);
        expect(leakedTotal).toBeLessThan(trueTotal / 10);

        // And the shipped path, on the same workload, books all of it.
        await truncateLedger();
        const adapter = await mintAdapter(streamingAdapter());
        await adapter.stream({ model: "gpt-5.5", logLabel: "chat-turn" } as never);
        const fixed = await settledRows(STEPS.length);
        expect(fixed.reduce((sum, row) => sum + row.input_tokens, 0)).toBe(trueTotal);
      });

      it("an ERRORED turn still books the steps that were already billed", async () => {
        // The install in the issue recorded 8 assistant turns, THREE of them
        // errors, against one ledger row. A step whose usage the provider already
        // reported was paid for whether or not the turn went on to fail, so the
        // rows must survive the throw — and the throw must still reach the
        // caller unchanged, because metering may never alter what a call does.
        const BILLED_BEFORE_FAILURE = STEPS.slice(0, 3);
        const adapter = await mintAdapter({
          provider: "openai",
          defaultModel: "gpt-5.5",
          generate: async () => {
            throw new Error("unused in this test");
          },
          stream: async (input: { onUsageData?: (usage: unknown) => void }) => {
            for (const step of BILLED_BEFORE_FAILURE) input.onUsageData?.(step);
            throw new Error("upstream stream aborted");
          },
        });

        await expect(
          adapter.stream({ model: "gpt-5.5", logLabel: "chat-turn" } as never),
        ).rejects.toThrow("upstream stream aborted");

        const rows = await settledRows(BILLED_BEFORE_FAILURE.length);
        expect(rows).toHaveLength(BILLED_BEFORE_FAILURE.length);
        expect(rows.reduce((sum, row) => sum + row.input_tokens, 0)).toBe(
          BILLED_BEFORE_FAILURE.reduce((sum, step) => sum + step.inputTokens, 0),
        );
      });

      it("a synchronous generate books one row and keeps the cache/reasoning counters", async () => {
        // The counters a hand-written emitter used to hardcode to zero: on a
        // cached-heavy turn they are most of the bill's shape.
        const adapter = await mintAdapter({
          provider: "openai",
          defaultModel: "gpt-5.5",
          generate: async () => ({
            text: "ok",
            model: "gpt-5.5",
            usage: {
              inputTokens: 43061,
              outputTokens: 721,
              cachedInputTokens: 42368,
              reasoningOutputTokens: 373,
            },
          }),
          stream: async () => undefined,
        });

        await adapter.generate({ model: "gpt-5.5", logLabel: "assistant-turn" } as never);

        const rows = await settledRows(1);
        expect(rows).toHaveLength(1);
        // The numbers from the issue's single surviving row.
        expect(rows[0]).toMatchObject({
          source: "llm",
          operation: "generate",
          model: "gpt-5.5",
          input_tokens: 43061,
          output_tokens: 721,
          cached_input_tokens: 42368,
          reasoning_output_tokens: 373,
        });
      });
    });

    // -----------------------------------------------------------------------
    // 2. BATCH
    // -----------------------------------------------------------------------

    describe("an OpenAI batch download", () => {
      const OUTCOMES = [
        {
          customId: "req-1",
          status: "succeeded" as const,
          model: "gpt-5.5",
          usage: { inputTokens: 120, outputTokens: 40, cachedInputTokens: 30, reasoningOutputTokens: 10 },
        },
        {
          customId: "req-2",
          status: "succeeded" as const,
          model: "gpt-5.5",
          usage: { inputTokens: 200, outputTokens: 60, cachedInputTokens: 0, reasoningOutputTokens: 0 },
        },
        // Neither of these is billed work with usage to book.
        { customId: "req-3", status: "failed" as const, model: "gpt-5.5", usage: undefined },
        { customId: "req-4", status: "succeeded" as const, model: "gpt-5.5", usage: undefined },
      ];

      beforeEach(() => {
        h.adaptersByProvider.openai = {
          provider: "openai",
          defaultModel: "gpt-5.5",
          batchV2: {
            version: 2 as const,
            submit: async () => ({ batchId: "batch-1" }),
            retrieve: async () => ({ batchId: "batch-1", status: "ended" }),
            download: async () => OUTCOMES,
          },
        };
      });

      it("books one row per succeeded outcome and stays flat across a re-download", async () => {
        await orchestrateDownloadBatchOutcomesV2({ provider: "openai", batchId: "batch-1" });
        const first = await settledRows(2);
        expect(first).toHaveLength(2);
        expect(first.map((row) => row.idempotency_key)).toEqual([
          "batch:openai:batch-1:req-1",
          "batch:openai:batch-1:req-2",
        ]);
        expect(first.every((row) => row.operation === "batch")).toBe(true);
        expect(first[0]!.input_tokens).toBe(120);
        expect(first[1]!.input_tokens).toBe(200);

        // A restarted worker re-downloads an ended batch. The derived key means
        // the real unique index — not a mock — refuses to book it twice.
        await orchestrateDownloadBatchOutcomesV2({ provider: "openai", batchId: "batch-1" });
        const second = await settledRows(2);
        expect(second).toHaveLength(2);
      });
    });

    // -----------------------------------------------------------------------
    // 3. THE ADMIN KEY-PROBE ROUTE
    // -----------------------------------------------------------------------

    describe("the LLM-access key-validation probe", () => {
      beforeEach(() => {
        h.session = { user: { role: "admin" } };
        h.providerSurface = {
          getConfiguredConnection: async () => ({ apiKey: "fake-key-never-used-on-a-network" }),
          listAvailableModels: async () => ["gpt-5.5", "gpt-5"],
        };
      });

      it("books exactly one zero-token models.list row per press", async () => {
        const response = await keyValidationPOST(
          new Request("http://127.0.0.1/configuration/mcp/llm-access/test", {
            method: "POST",
            body: JSON.stringify({ provider: "openai" }),
          }),
        );
        expect(response.status).toBe(200);

        const rows = await settledRows(1);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          source: "llm",
          provider: "openai",
          model: "models.list",
          agent_label: "llm-access-key-validation",
          input_tokens: 0,
          output_tokens: 0,
        });
        // A catalog read bills nothing, and "free" here is a PRICED zero: a NULL
        // would land in the dashboard's unknown-cost bucket and read as a
        // pricing gap instead of as a call that costs nothing.
        expect(Number(rows[0]!.cost_usd)).toBe(0);
      });
    });

    // -----------------------------------------------------------------------
    // 3b. IMAGE GENERATION (cinatra#2641)
    // -----------------------------------------------------------------------

    describe("an image-generation call", () => {
      /**
       * The gap: `generateImage()` reached a provider, was billed per image and
       * wrote NO row — the one response-producing adapter method the cinatra#2578
       * seam did not meter. It answers with `{ imageData, mimeType }` and nothing
       * else, so the row it books here is COUNTED and UNPRICED: the call is
       * visible, the dollars stay unknown rather than invented.
       */
      it("books one COUNTED, UNPRICED row per image, through the production seam", async () => {
        const adapter = await mintAdapter({
          provider: "openai",
          defaultModel: "gpt-5.5",
          generate: async () => ({ text: "ok", model: "gpt-5.5", usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0 } }),
          stream: async () => undefined,
          generateImage: async () => ({ imageData: "aGVsbG8=", mimeType: "image/png" }),
        });

        const image = await (
          adapter.generateImage as (input: {
            prompt: string;
            logLabel?: string;
          }) => Promise<{ imageData: string; mimeType: string } | null>
        )({ prompt: "a cover image", logLabel: "blog-post-image" });
        // Metering never changes what the caller observes.
        expect(image).toEqual({ imageData: "aGVsbG8=", mimeType: "image/png" });

        const rows = await settledRows(1);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          source: "llm",
          provider: "openai",
          operation: "image",
          agent_label: "blog-post-image",
          // Zeros the schema requires, not a measurement. The ABI's image
          // response reports no usage at all.
          input_tokens: 0,
          output_tokens: 0,
          // The seam refuses to name the adapter's default TEXT model for a call
          // that model did not answer — and naming it would hand the rate card a
          // model to price.
          model: "unknown",
        });
        // NULL, never 0. `gpt-5.5` is priced; had the row carried that model
        // through the per-token card it would have stored $0.00000000 and read
        // as "this image was free".
        expect(rows[0]!.cost_usd).toBeNull();
      });

      it("gives two images two rows — no key collapses the second at the index", async () => {
        // The cinatra#2578 failure mode, checked on the new path: a shared
        // idempotency key would make the second image vanish at the unique
        // index, which no mocked store can observe.
        const adapter = await mintAdapter({
          provider: "openai",
          defaultModel: "gpt-5.5",
          generate: async () => ({ text: "ok", model: "gpt-5.5", usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0 } }),
          stream: async () => undefined,
          generateImage: async () => ({ imageData: "aGVsbG8=", mimeType: "image/png" }),
        });
        const generateImage = adapter.generateImage as (input: {
          prompt: string;
        }) => Promise<unknown>;

        await generateImage({ prompt: "one" });
        await generateImage({ prompt: "two" });

        const rows = await settledRows(2);
        expect(rows).toHaveLength(2);
        expect(new Set(rows.map((row) => row.idempotency_key)).size).toBe(2);
      });

      it("a group MIXING priced and image rows reports its subtotal as PARTIAL", async () => {
        // The laundering path a per-row NULL does not close. `SUM(cost_usd)`
        // ignores NULLs, so an agent that does both priced work and image work
        // aggregates to a NUMBER — one that used to render exactly like a
        // complete total. The breakdown now carries the count of unpriced rows
        // in the group so the cell can say what the number leaves out.
        const adapter = await mintAdapter({
          provider: "openai",
          defaultModel: "gpt-5.5",
          generate: async () => ({
            text: "ok",
            model: "gpt-5.5",
            usage: { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 0, reasoningOutputTokens: 0 },
          }),
          stream: async () => undefined,
          generateImage: async () => ({ imageData: "aGVsbG8=", mimeType: "image/png" }),
        });

        // SAME agent label on both calls — that is what puts them in one group.
        await adapter.generate({ model: "gpt-5.5", logLabel: "blog-pipeline" } as never);
        await (adapter.generateImage as (input: {
          prompt: string;
          logLabel?: string;
        }) => Promise<unknown>)({ prompt: "p", logLabel: "blog-pipeline" });

        await settledRows(2);

        const byAgent = await readCostByAgent({ days: 30 });
        const group = byAgent.find((row) => row.agentLabel === "blog-pipeline");
        expect(group).toBeDefined();
        expect(group!.callCount).toBe(2);
        // The subtotal is real — and it covers only ONE of the two calls.
        expect(group!.totalCost).toBeGreaterThan(0);
        expect(group!.unknownCostCount).toBe(1);
      });

      it("books nothing when the image call throws — the invocation did not resolve", async () => {
        const adapter = await mintAdapter({
          provider: "openai",
          defaultModel: "gpt-5.5",
          generate: async () => ({ text: "ok", model: "gpt-5.5", usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0 } }),
          stream: async () => undefined,
          generateImage: async () => {
            throw new Error("image provider refused");
          },
        });

        await expect(
          (adapter.generateImage as (input: { prompt: string }) => Promise<unknown>)({
            prompt: "p",
          }),
        ).rejects.toThrow("image provider refused");

        await sleep(300);
        expect(await ledgerRows()).toHaveLength(0);
      });
    });

    // -----------------------------------------------------------------------
    // 4. GRAPHITI
    // -----------------------------------------------------------------------

    describe("a Graphiti episode hand-over", () => {
      beforeEach(() => {
        setKnowledgeGraphIndexingProbe(() => ({
          providerKey: "configured",
          reason: "stored connection carries a key (integration fixture)",
        }));
      });

      it("books one COUNTED, UNPRICED row per episode", async () => {
        await addEpisode({
          name: "Acme Corp",
          episode_body: '{"name":"Acme Corp"}',
          source: "json",
          group_id: "cinatra-org-org-1",
        } as never);

        const rows = await settledRows(1);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          source: "graphiti",
          provider: "openai",
          operation: "episode",
          model: null,
          input_tokens: 0,
          output_tokens: 0,
        });
        // NULL, never 0. The wrapper reports no token usage, so the dollars are
        // unknown — and an unknown rendered as 0 is how a $0 row starts reading
        // as "free". cinatra#2591 owns closing the pricing half.
        expect(rows[0]!.cost_usd).toBeNull();
      });

      it("books nothing when the indexer has no key — no key, no spend", async () => {
        setKnowledgeGraphIndexingProbe(() => ({
          providerKey: "absent",
          reason: "no key in the stored configuration (integration fixture)",
        }));

        await addEpisode({
          name: "Acme Corp",
          episode_body: '{"name":"Acme Corp"}',
          source: "json",
          group_id: "cinatra-org-org-1",
        } as never);

        await sleep(300);
        expect(await ledgerRows()).toHaveLength(0);
      });
    });

    // -----------------------------------------------------------------------
    // 5. ACCOUNTING over a mixed workload
    // -----------------------------------------------------------------------

    describe("a mixed workload accounts end to end", () => {
      it("the ledger's totals equal what was driven, read back through the dashboard's own store", async () => {
        // One turn of each shape, driven through the real seams.
        const CHAT_STEPS = [
          { inputTokens: 800, outputTokens: 40, cachedInputTokens: 700, reasoningOutputTokens: 12 },
          { inputTokens: 810, outputTokens: 44, cachedInputTokens: 705, reasoningOutputTokens: 14 },
          { inputTokens: 820, outputTokens: 48, cachedInputTokens: 710, reasoningOutputTokens: 16 },
        ];
        const SYNC = {
          inputTokens: 500,
          outputTokens: 100,
          cachedInputTokens: 250,
          reasoningOutputTokens: 25,
        };
        const BATCH = [
          {
            customId: "mixed-1",
            status: "succeeded" as const,
            model: "gpt-5.5",
            usage: { inputTokens: 300, outputTokens: 70, cachedInputTokens: 0, reasoningOutputTokens: 0 },
          },
        ];

        // ONE connector adapter serving both shapes, minted once through the
        // production seam — the batch orchestrator resolves this same adapter.
        const chat = await mintAdapter({
          provider: "openai",
          defaultModel: "gpt-5.5",
          generate: async () => ({ text: "ok", model: "gpt-5.5", usage: SYNC }),
          stream: async (input: { onUsageData?: (usage: unknown) => void }) => {
            for (const step of CHAT_STEPS) input.onUsageData?.(step);
          },
          batchV2: {
            version: 2 as const,
            submit: async () => ({ batchId: "mixed-batch" }),
            retrieve: async () => ({ batchId: "mixed-batch", status: "ended" }),
            download: async () => BATCH,
          },
          generateImage: async () => ({ imageData: "aGVsbG8=", mimeType: "image/png" }),
        });
        h.session = { user: { role: "admin" } };
        h.providerSurface = {
          getConfiguredConnection: async () => ({ apiKey: "fake-key-never-used-on-a-network" }),
          listAvailableModels: async () => ["gpt-5.5"],
        };
        setKnowledgeGraphIndexingProbe(() => ({
          providerKey: "configured",
          reason: "stored connection carries a key (integration fixture)",
        }));

        await chat.stream({ model: "gpt-5.5", logLabel: "chat-turn" } as never);
        await chat.generate({ model: "gpt-5.5", logLabel: "assistant-turn" } as never);
        await (chat.generateImage as (input: {
          prompt: string;
          logLabel?: string;
        }) => Promise<unknown>)({ prompt: "a cover image", logLabel: "blog-post-image" });
        await orchestrateDownloadBatchOutcomesV2({ provider: "openai", batchId: "mixed-batch" });
        await keyValidationPOST(
          new Request("http://127.0.0.1/configuration/mcp/llm-access/test", {
            method: "POST",
            body: JSON.stringify({ provider: "openai" }),
          }),
        );
        await addEpisode({
          name: "Acme Corp",
          episode_body: '{"name":"Acme Corp"}',
          source: "json",
          group_id: "cinatra-org-org-1",
        } as never);

        const expectedRows =
          CHAT_STEPS.length +
          1 /* sync */ +
          1 /* image */ +
          BATCH.length +
          1 /* probe */ +
          1; /* episode */
        const rows = await settledRows(expectedRows);
        expect(rows).toHaveLength(expectedRows);

        const drivenInput =
          CHAT_STEPS.reduce((sum, step) => sum + step.inputTokens, 0) +
          SYNC.inputTokens +
          BATCH.reduce((sum, outcome) => sum + outcome.usage.inputTokens, 0);
        const drivenOutput =
          CHAT_STEPS.reduce((sum, step) => sum + step.outputTokens, 0) +
          SYNC.outputTokens +
          BATCH.reduce((sum, outcome) => sum + outcome.usage.outputTokens, 0);

        expect(rows.reduce((sum, row) => sum + row.input_tokens, 0)).toBe(drivenInput);
        expect(rows.reduce((sum, row) => sum + row.output_tokens, 0)).toBe(drivenOutput);

        // Read back through the SAME functions /analytics/llm calls, so the
        // proof covers what an operator is shown, not just what was stored.
        const summary = await readCostSummary();
        expect(summary.eventCount).toBe(expectedRows);
        // Exactly TWO rows carry unknown dollars: the episode and the image.
        // Everything else is priced, including the deliberately-free catalog
        // read. This counter is the dashboard's own honesty surface — the image
        // call reaching it is what an operator sees change (cinatra#2641).
        expect(summary.nullCostCount).toBe(2);
        expect(summary.totalAllTime).toBeGreaterThan(0);

        const byProvider = await readCostByProvider({ days: 30 });
        const sources = new Set(byProvider.map((row) => row.source));
        expect(sources.has("llm")).toBe(true);
        expect(sources.has("graphiti")).toBe(true);

        // The image call as an operator meets it in the breakdown: its own row,
        // one call, and a cost the table renders as "unknown" rather than as a
        // number nobody measured (cinatra#2641).
        const imageGroup = byProvider.find(
          (row) => row.source === "llm" && row.model === "unknown",
        );
        expect(imageGroup, "the image call is missing from the breakdown").toBeDefined();
        expect(imageGroup!.totalCost).toBeNull();
        expect(imageGroup!.callCount).toBe(1);
        expect(
          byProvider
            .filter((row) => row.source === "llm")
            .reduce((sum, row) => sum + row.totalInput, 0),
        ).toBe(drivenInput);
      });
    });
  },
);
