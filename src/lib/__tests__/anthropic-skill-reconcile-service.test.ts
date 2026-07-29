/**
 * Upload-on-install reconcile DRAIN (cinatra#2092, epic #2086 S5).
 *
 * Behavioural unit coverage over a stubbed SQL runner — the durable-row
 * semantics themselves are proven against a real Postgres in
 * `__tests__/integration/anthropic-skill-upload-outbox.integration.test.ts`.
 * What is asserted HERE is the drain's decision logic, which SQL alone cannot
 * show:
 *
 *   - opt-in OFF / no API key ⇒ ZERO engine work and the no-op RECORDED on
 *     every claimed row (an S5 acceptance criterion is that the no-op is
 *     recorded, not merely that nothing egresses);
 *   - a duplicate drain of an already-reconciled catalog completes WITHOUT
 *     engine work (namespace + catalog-digest idempotency key);
 *   - a failed run releases its rows with backoff and only NOTIFIES once a row
 *     exhausts its retries.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const queries: Array<{ text: string; values?: unknown[] }> = [];
let claimRows: Array<Record<string, unknown>> = [];

const strictSync = vi.fn();
const reclaim = vi.fn();
const notify = vi.fn();
const metadata = new Map<string, unknown>();
let optIn = true;
let fingerprint: string | null = "fp-1";

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (input: { queries: Array<{ text: string; values?: unknown[] }> }) => {
    for (const q of input.queries) queries.push(q);
    // Only the CLAIM statement returns rows in this drain.
    return input.queries.map((q) =>
      /SET status = 'running'/.test(q.text) ? { rows: claimRows } : { rows: [] },
    );
  },
}));

vi.mock("@/lib/database", () => ({
  getPostgresConnectionString: () => "postgres://stub",
  postgresSchema: "cinatra",
  ensurePostgresSchema: () => {},
  readSkillCatalogFromDatabase: () => ({
    skillPackages: [{ id: "github:acme/pack" }],
    skills: [{ id: "github:acme/pack:alpha", allowAnthropicUpload: true }],
  }),
  readAnthropicSkillSyncEnabledFromDatabase: () => optIn,
  readMetadataValueFromDatabase: (key: string, fallback: unknown) =>
    metadata.has(key) ? metadata.get(key) : fallback,
  writeMetadataValueToDatabase: (key: string, value: unknown) => {
    metadata.set(key, value);
  },
}));

vi.mock("@/lib/notifications", () => ({
  createNotification: (...args: unknown[]) => {
    notify(...args);
    return Promise.resolve();
  },
}));

vi.mock("@/lib/anthropic-skill-sync-service", () => ({
  deriveApiKeyFingerprint: () => fingerprint,
  deriveEnvironmentNamespace: () => "test-env",
  syncCatalogSkillsToAnthropicStrict: () => strictSync(),
}));

vi.mock("@/lib/anthropic-skill-gc-service", () => ({
  reclaimStaleAnthropicSkills: () => reclaim(),
}));

const pendingRow = (over: Record<string, unknown> = {}) => ({
  id: "row-1",
  kind: "reconcile",
  reason: "skill-extension-install",
  attempts: 1,
  ...over,
});

function completedOutcomes(): string[] {
  return queries
    .filter((q) => /SET status = 'done'/.test(q.text))
    .map((q) => String((q.values ?? [])[1] ?? ""));
}

async function drain(options?: { gcSweep?: boolean }) {
  const mod = await import("@/lib/anthropic-skill-reconcile-service");
  return mod.runAnthropicSkillUploadReconcile(options);
}

beforeEach(() => {
  queries.length = 0;
  claimRows = [];
  metadata.clear();
  optIn = true;
  fingerprint = "fp-1";
  strictSync.mockReset().mockResolvedValue({ ok: true, outcomes: [] });
  reclaim.mockReset().mockResolvedValue({ ok: true, reclaimed: [], skipped: [], errors: [] });
  notify.mockReset();
  vi.resetModules();
});

describe("runAnthropicSkillUploadReconcile", () => {
  it("no due rows ⇒ no engine work at all", async () => {
    const summary = await drain();
    expect(summary.claimed).toBe(0);
    expect(strictSync).not.toHaveBeenCalled();
  });

  it("opt-in OFF ⇒ zero egress and the no-op is RECORDED on every claimed row", async () => {
    optIn = false;
    claimRows = [pendingRow()];
    const summary = await drain();
    expect(strictSync).not.toHaveBeenCalled();
    expect(summary.noop).toBe(1);
    expect(completedOutcomes()).toEqual(["noop-opt-in-off"]);
  });

  it("no API key ⇒ same recorded no-op, distinct reason", async () => {
    fingerprint = null;
    claimRows = [pendingRow()];
    const summary = await drain();
    expect(strictSync).not.toHaveBeenCalled();
    expect(summary.noop).toBe(1);
    expect(completedOutcomes()).toEqual(["noop-no-api-key"]);
  });

  it("a due reconcile row runs the STRICT orchestrator and records the digest", async () => {
    claimRows = [pendingRow()];
    const summary = await drain();
    expect(strictSync).toHaveBeenCalledTimes(1);
    expect(summary.reconciled).toBe(1);
    expect(completedOutcomes()[0]).toMatch(/^reconciled digest=/);
  });

  it("a DUPLICATE drain of an already-reconciled catalog does no engine work (idempotency key)", async () => {
    claimRows = [pendingRow()];
    await drain();
    expect(strictSync).toHaveBeenCalledTimes(1);

    // Same namespace, same catalog digest → the second drain completes the row
    // without touching the engine.
    queries.length = 0;
    claimRows = [pendingRow({ id: "row-2" })];
    const second = await drain();
    expect(strictSync).toHaveBeenCalledTimes(1);
    expect(second.skippedAlreadyReconciled).toBe(1);
    expect(completedOutcomes()[0]).toMatch(/^already-reconciled digest=/);
  });

  it("a failing run releases the row with BACKOFF and does not notify before exhaustion", async () => {
    strictSync.mockRejectedValue(new Error("anthropic 503"));
    claimRows = [pendingRow({ attempts: 2 })];
    const summary = await drain();
    expect(summary.failed).toBe(1);
    expect(summary.exhausted).toBe(0);
    const release = queries.find((q) => /SET status = 'pending'/.test(q.text));
    expect(release).toBeDefined();
    expect(Number((release!.values ?? [])[1])).toBeGreaterThan(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it("a row at the attempt cap flips to `exhausted` (kept visible) and notifies admins", async () => {
    strictSync.mockRejectedValue(new Error("anthropic 503"));
    claimRows = [pendingRow({ attempts: 5 })];
    const summary = await drain();
    expect(summary.exhausted).toBe(1);
    expect(queries.some((q) => /SET status = 'exhausted'/.test(q.text))).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String((notify.mock.calls[0][0] as { title: string }).title)).toMatch(
      /gave up after/i,
    );
  });

  it("the periodic sweep runs the stale-GC reclaim even with no GC row due", async () => {
    await drain({ gcSweep: true });
    expect(reclaim).toHaveBeenCalledTimes(1);
  });

  it("a due GC row is served and completed", async () => {
    claimRows = [pendingRow({ id: "gc-1", kind: "gc", reason: "skill-extension-uninstall" })];
    const summary = await drain();
    expect(reclaim).toHaveBeenCalledTimes(1);
    expect(summary.gcCompleted).toBe(1);
    expect(completedOutcomes()[0]).toMatch(/^gc reclaimed=/);
  });

  it("a GC failure is a retryable drain failure, not a silent success", async () => {
    reclaim.mockResolvedValue({
      ok: false,
      reclaimed: [],
      skipped: [],
      errors: [{ anthropicSkillId: "sk_1", message: "409" }],
      namespaceError: null,
    });
    claimRows = [pendingRow({ id: "gc-1", kind: "gc", reason: "uninstall" })];
    const summary = await drain();
    expect(summary.gcCompleted).toBe(0);
    expect(summary.failed + summary.exhausted).toBe(1);
  });
});
