// @vitest-environment jsdom
/**
 * A FINISHED RUN'S PAGE DRAWS THE OUTPUT ITS OWN RECORD CARRIES (cinatra#3449).
 *
 * WHAT WAS MEASURED. On the proof round of 2026-09-13 a finished List Curator
 * run's page said "This run finished. Its output is still loading." and then
 * "This run finished. Its output was recorded during the run, but it is not
 * part of this run's transcript." — and never drew the output, which existed.
 *
 * WHY. The run page asks TWO roads what the run produced and draws the answer
 * of the one that cannot see it. The page's own record step lists the run's
 * work from the materialization ledger — the finalized
 * `artifact_materializations` rows. The completion card asks a different road:
 * the provenance rows off `objects.run_id`. A run whose writes are recorded in
 * the ledger but carry no `objects.run_id` provenance comes back from the card's
 * road empty, the resolver falls to `step-results`, and the card draws the
 * transcript-denial sentence over an output that is sitting in the run's record.
 *
 * So this suite drives the REAL evidence read (`readRunOutputEvidence`) over a
 * run of exactly that shape and renders the REAL card from what it returns.
 * Only the data layer is stubbed — the session, the run row, the provenance
 * read, the artifact gate and the ledger's own tables; the read's SQL, the
 * selection logic, the resolver and the card's own drawing are the product's
 * own.
 *
 * WHAT EACH CASE PINS, to the sentence of the issue's Expected it is built to
 * ("A finished run's page draws the run's output as the drawing gives it …; no
 * loading sentence and no 'not part of this run' sentence for an output the run
 * recorded"):
 *
 *   1. the recorded row is DRAWN, as a link to the artifact's own page;
 *   2. the transcript-denial sentence is gone — and the rows are there, so it
 *      cannot have been removed by drawing nothing;
 *   3. the settled reading is the run's output, read off the DOM's own
 *      `data-run-completion-evidence` rather than matched as prose;
 *   4. the caller's read is never widened: a row the artifact gate refuses is
 *      dropped exactly as a provenance row is;
 *   5. only what the run WROTE is linked — the rows it merely read stay the
 *      record step's own, marked used there;
 *   6. an artifact both roads can see is ONE row, not two.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-completion-card-record-outputs.test.tsx
 */
import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

const RUN_ID = "run-3449";
const ORG_ID = "org-3449";
const USER_ID = "user-3449";

/** The transcript-denial sentence the issue measured, quoted. */
const TRANSCRIPT_DENIAL =
  "This run finished. Its output was recorded during the run, but it is not part of this run's transcript.";
/** The pending sentence the issue measured, quoted. */
const STILL_LOADING = "This run finished. Its output is still loading.";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/lib/cinatra-toast", () => ({
  toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() },
}));

vi.mock("lucide-react", () => {
  const StubIcon: React.FC = () => null;
  return new Proxy({} as Record<string, React.FC>, {
    get: (_t, prop) => {
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => ["default"],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});

/**
 * THE CALLER'S OWN VIEWER, one object so the gate's `actor` can be asserted by
 * IDENTITY rather than by shape: the security constraint of cinatra#3449 is
 * that every row the record road contributes is put through
 * `readArtifactForDetail` with THE CALLER'S viewer, and an assertion on a
 * freshly-built look-alike would still pass if the read handed the gate some
 * other context — or none, which the artifact service treats as a trusted
 * internal path.
 */
const VIEWER = vi.hoisted(() => ({ principalId: "user-3449" }));

const authSession = vi.hoisted(() => ({
  requireAuthSession: vi.fn(async () => ({
    user: { id: USER_ID },
    session: { activeOrganizationId: ORG_ID },
  })),
  requireActorContext: vi.fn(async () => VIEWER),
  isPlatformAdmin: vi.fn(() => false),
  resolveOrgRoleForSession: vi.fn(async () => "owner"),
}));

const store = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentRunMessages: vi.fn(async (): Promise<{ id: string }[]> => []),
}));

const objectsStore = vi.hoisted(() => ({
  listObjectsByFilter: vi.fn((): Array<{ id: string; type: string; data: unknown }> => []),
}));

const artifactService = vi.hoisted(() => ({ readArtifactForDetail: vi.fn() }));

/**
 * THE LEDGER, as a two-table fake the REAL query is run against.
 *
 * `wrote` holds the finalized `artifact_materializations` rows of this run and
 * `used` the `run_context_selections` rows — the two halves the run page's
 * record step lists. The fake answers whichever table the SQL names, so a case
 * that seeds the used half and sees no link has proven the card's read never
 * asks for it, rather than asserting on the query's text.
 */
const ledger = vi.hoisted(() => {
  const state = {
    wrote: [] as string[],
    used: [] as string[],
    queries: [] as Array<{ sql: string; params: unknown[] }>,
  };
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    state.queries.push({ sql, params });
    if (sql.includes("run_context_selections")) {
      return { rows: state.used.map((artifact_id) => ({ artifact_id })) };
    }
    if (sql.includes("artifact_materializations")) {
      return { rows: state.wrote.map((artifact_id) => ({ artifact_id })) };
    }
    throw new Error(`the card read a table this fake does not carry: ${sql}`);
  });
  return { state, query };
});

vi.mock("@/lib/auth-session", () => authSession);
vi.mock("@/lib/authz", () => ({ AuthzError: class AuthzError extends Error {} }));
vi.mock("../store", () => store);
vi.mock("@/lib/objects-store", () => objectsStore);
vi.mock("@/lib/artifacts/artifact-service", () => artifactService);
vi.mock("@/lib/db/pooled", () => ({ getPooledDb: () => ({ query: ledger.query }) }));
vi.mock("@/lib/postgres-config", () => ({
  postgresSchema: "cinatra",
  getPostgresConnectionString: () => "postgres://test",
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));

/** The artifacts this run WROTE, as its record carries them. */
function runWrote(...artifactIds: string[]) {
  ledger.state.wrote = artifactIds;
}

/** The artifacts this run READ to make them — the record step's "used" half. */
function runUsed(...artifactIds: string[]) {
  ledger.state.used = artifactIds;
}

beforeEach(() => {
  vi.clearAllMocks();
  // The run the issue measured: completed, no transcript, ONE step result —
  // the shape that resolved to the transcript-denial sentence.
  store.readAgentRunById.mockResolvedValue({
    id: RUN_ID,
    runBy: USER_ID,
    orgId: ORG_ID,
    status: "completed",
    stepResults: [{ step: 1 }],
    streamedText: null,
  });
  store.readAgentRunMessages.mockResolvedValue([]);
  objectsStore.listObjectsByFilter.mockImplementation(() => []);
  artifactService.readArtifactForDetail.mockImplementation(
    ({ artifactId }: { artifactId: string }) => ({
      kind: "ok",
      artifact: { title: `Artifact ${artifactId}`, artifactType: "blog_post" },
    }),
  );
  ledger.state.wrote = [];
  ledger.state.used = [];
  ledger.state.queries = [];
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

/** Mount the real card with no pre-resolved evidence, and let its read settle. */
async function drawSettledCard() {
  const { RunCompletionCard } = await import("../run-completion-affordances");
  const view = render(
    <RunCompletionCard
      runId={RUN_ID}
      agentId="cinatra-ai/list-curator-agent"
      outputHint="transcript"
    />,
  );
  await waitFor(() => {
    expect(
      document
        .querySelector("[data-run-completion-evidence]")
        ?.getAttribute("data-run-completion-evidence"),
    ).not.toBe("pending");
  });
  return view;
}

/** Every artifact id the card linked, in the order it drew them. */
function drawnOutputIds(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-run-output-link]"),
  ).map((el) => el.getAttribute("data-run-output-link") ?? "");
}

describe("the finished run's card draws the output its record carries (cinatra#3449)", () => {
  it("draws a finalized written ledger row as a link to the artifact's own page", async () => {
    runWrote("art-post-1");

    await drawSettledCard();

    expect(document.querySelector("[data-run-outputs]")).not.toBeNull();
    expect(drawnOutputIds()).toEqual(["art-post-1"]);
    const link = document.querySelector<HTMLAnchorElement>(
      '[data-run-output-link="art-post-1"]',
    );
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe("/artifacts/art-post-1");
    // And the record was read for THIS run in THIS org, bounded by the scan
    // window — never wider than the provenance read it joins.
    expect(ledger.state.queries[0]?.params).toEqual([ORG_ID, RUN_ID, 100]);
    // THE QUERY CONTRACT, asserted rather than assumed (convergence round): the
    // fake answers any SQL that names the ledger table, so without these the
    // suite would stay green if the read dropped its org/run predicates, its
    // finalized filter, its per-artifact grouping, its first-write order or its
    // bound. A live-database proof of the same clauses needs the hosted
    // integration database, which this leg has none of.
    const recordSql = ledger.state.queries[0]?.sql ?? "";
    expect(recordSql).toContain('"artifact_materializations"');
    expect(recordSql).toContain("m.org_id = $1");
    expect(recordSql).toContain("m.run_id = $2");
    expect(recordSql).toContain("m.phase = 'finalized'");
    expect(recordSql).toContain("GROUP BY m.artifact_id");
    expect(recordSql).toContain("ORDER BY first_written_at ASC");
    expect(recordSql).toContain("LIMIT $3");
    // THE CALLER'S OWN VIEWER reached the gate, for this run's org — the read
    // never widens what its caller may already read.
    const gateCalls = artifactService.readArtifactForDetail.mock.calls.map(
      (call: unknown[]) => call[0] as { artifactId: string; orgId: string; actor: unknown },
    );
    expect(gateCalls.map((call) => call.artifactId)).toContain("art-post-1");
    for (const call of gateCalls) {
      expect(call.orgId).toBe(ORG_ID);
      expect(call.actor).toBe(VIEWER);
    }
  });

  it("never denies an output the run recorded — and draws the rows instead", async () => {
    runWrote("art-post-1");

    const { container } = await drawSettledCard();

    // The sentence the issue measured is gone…
    expect(container.textContent).not.toContain(TRANSCRIPT_DENIAL);
    // …and it did not go by the card drawing nothing.
    expect(drawnOutputIds()).toEqual(["art-post-1"]);
  });

  it("settles on the run's output rather than on the loading sentence", async () => {
    runWrote("art-post-1");

    const { container } = await drawSettledCard();

    const card = document.querySelector<HTMLElement>("[data-run-completion]");
    expect(card).not.toBeNull();
    expect(card!.getAttribute("data-run-completion")).toBe("with-output");
    expect(card!.getAttribute("data-run-completion-evidence")).toBe("outputs");
    expect(container.textContent).not.toContain(STILL_LOADING);
  });

  it("drops a recorded row the caller may not read, and keeps the one it may", async () => {
    runWrote("art-denied", "art-readable");
    artifactService.readArtifactForDetail.mockImplementation(
      ({ artifactId }: { artifactId: string }) =>
        artifactId === "art-denied"
          ? { kind: "denied" }
          : { kind: "ok", artifact: { title: "The post", artifactType: "blog_post" } },
    );

    await drawSettledCard();

    expect(drawnOutputIds()).toEqual(["art-readable"]);
    // The REFUSED row went through the same gate with the same viewer: it was
    // dropped by the gate's answer, not by being read differently.
    const denied = artifactService.readArtifactForDetail.mock.calls
      .map((call: unknown[]) => call[0] as { artifactId: string; orgId: string; actor: unknown })
      .find((call) => call.artifactId === "art-denied");
    expect(denied).toBeDefined();
    expect(denied!.orgId).toBe(ORG_ID);
    expect(denied!.actor).toBe(VIEWER);
  });

  it("links what the run WROTE and leaves what it read to the record step", async () => {
    runWrote("art-post-1");
    runUsed("art-source-1");

    await drawSettledCard();

    expect(drawnOutputIds()).toEqual(["art-post-1"]);
    // The used half was never asked for: the card links what the run PRODUCED,
    // and what it started from stays the record step's own row, marked used
    // there.
    const asked = ledger.state.queries.map((q) => q.sql);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.some((sql) => sql.includes("run_context_selections"))).toBe(false);
    expect(asked.every((sql) => sql.includes("phase = 'finalized'"))).toBe(true);
  });

  it("draws one row per artifact when both roads can see the same one", async () => {
    objectsStore.listObjectsByFilter.mockImplementation(() => [
      { id: "art-both", type: "@cinatra-ai/blog-post-artifact:post", data: { title: "Both" } },
    ]);
    runWrote("art-both", "art-ledger-only");

    await drawSettledCard();

    expect(drawnOutputIds()).toEqual(["art-both", "art-ledger-only"]);
  });

  it("keeps the rows the first road linked when the record read fails", async () => {
    // CONVERGENCE-ROUND FINDING. The record read joins a road that already
    // works, so its failure must never take that road's rows down with it: the
    // block's shared catch would have emptied `outputs` and put the
    // transcript-denial sentence back over a run whose output was read
    // successfully one line earlier.
    objectsStore.listObjectsByFilter.mockImplementation(() => [
      {
        id: "art-provenance",
        type: "@cinatra-ai/blog-post-artifact:post",
        data: { title: "From provenance" },
      },
    ]);
    ledger.query.mockRejectedValueOnce(new Error("the ledger read failed"));

    const { container } = await drawSettledCard();

    expect(drawnOutputIds()).toEqual(["art-provenance"]);
    expect(container.textContent).not.toContain(TRANSCRIPT_DENIAL);
    expect(container.textContent).not.toContain(STILL_LOADING);
  });

  it("spends ONE scan window across both roads", async () => {
    // The provenance read considers up to MAX_OUTPUT_SCAN candidates; the
    // record read takes what is left of that one window, never a second one.
    objectsStore.listObjectsByFilter.mockImplementation(() =>
      Array.from({ length: 60 }, (_, i) => ({
        id: `art-prov-${i}`,
        type: "@cinatra-ai/blog-post-artifact:post",
        data: { title: `Provenance ${i}` },
      })),
    );
    artifactService.readArtifactForDetail.mockImplementation(
      ({ artifactId }: { artifactId: string }) =>
        artifactId.startsWith("art-prov-") ? { kind: "denied" } : { kind: "ok", artifact: { title: "The post", artifactType: "blog_post" } },
    );
    runWrote("art-post-1");

    await drawSettledCard();

    expect(ledger.state.queries[0]?.params).toEqual([ORG_ID, RUN_ID, 40]);
  });
});
