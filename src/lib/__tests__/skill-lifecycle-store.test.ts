import { describe, it, expect, vi, beforeEach } from "vitest";

// SQL-shape proof for the lifecycle DB write primitives (cinatra#1361). No real
// Postgres here — the postgres runner is mocked and we assert the emitted SQL /
// params carry the safety properties codex-round-1 required.
const runPostgresQueriesSync = vi.fn();
vi.mock("@/lib/postgres-sync", () => ({ runPostgresQueriesSync: (...a: unknown[]) => runPostgresQueriesSync(...a) }));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: vi.fn() }));
vi.mock("@/lib/postgres-config", () => ({
  postgresSchema: "cinatra",
  getPostgresConnectionString: () => "postgres://test",
}));

import {
  applySkillLifecycleTransitionInDatabase,
  buildSkillLifecycleRevisionQueries,
  buildSkillRollbackQuery,
  readSkillRevisionContentForRollback,
  readSkillActiveRevisionFromDatabase,
  readSkillLifecycleStates,
  recordSkillRevisionInDatabase,
} from "@/lib/skill-lifecycle-store";

beforeEach(() => runPostgresQueriesSync.mockReset());

describe("buildSkillLifecycleRevisionQueries", () => {
  it("emits a PLAIN revision INSERT (no ON CONFLICT) then an init/pointer UPDATE, ordered", () => {
    const [insert, update] = buildSkillLifecycleRevisionQueries("cinatra", [
      {
        skillId: "s1", revisionId: "r1", contentDigest: "sha", source: "manual",
        basedOnSkillIds: ["b1"], baseDigests: { b1: "d1" }, authorUserId: "u1", initialState: "active",
      },
    ]);
    expect(insert.text).toMatch(/INSERT INTO "cinatra"\."skill_revisions"/);
    expect(insert.text).not.toMatch(/ON CONFLICT/); // collisions must ABORT, not silently no-op
    expect(insert.values?.[0]).toBe("r1");
    // pointer UPDATE preserves an existing state (COALESCE) and moves the pointer
    expect(update.text).toMatch(/SET lifecycle_state = COALESCE\(lifecycle_state, \$2\)/);
    expect(update.text).toMatch(/active_revision_id = \$3/);
    expect(update.values).toEqual(["s1", "active", "r1"]);
  });
});

describe("applySkillLifecycleTransitionInDatabase — race-free CAS + cycle guard", () => {
  it("locks the supersede graph then runs a CAS + WITH RECURSIVE cycle guard + conditional audit", () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [] }, { rows: [{ id: "audit1" }] }]);
    const out = applySkillLifecycleTransitionInDatabase({
      skillId: "a", expectedFrom: "active", to: "deprecated", supersededBy: "b",
      auditId: "audit1", actorUserId: "u1", actorType: "user", reason: "x",
    });
    expect(out).toEqual({ changed: true });
    const { queries } = runPostgresQueriesSync.mock.calls[0][0] as { queries: Array<{ text: string; values?: unknown[] }> };
    // 1) transaction-scoped advisory lock serializes supersede-graph mutations
    expect(queries[0].text).toMatch(/pg_advisory_xact_lock\('cinatra-skill-supersede-graph'\)|pg_advisory_xact_lock\(hashtext\('cinatra-skill-supersede-graph'\)\)/);
    const cas = queries[1].text;
    // 2) CAS on the expected prior state
    expect(cas).toMatch(/WHERE id = \$1 AND lifecycle_state = \$2/);
    // 3) DB-side acyclicity: path-tracking recursive walk flags reaching $1 OR
    // a repeated node (any cycle in the target chain), and the CAS rejects on bad.
    expect(cas).toMatch(/WITH RECURSIVE walk\(id, seen, bad\) AS/);
    expect(cas).toMatch(/sk\.superseded_by = \$1 OR sk\.superseded_by = ANY\(w\.seen\)/);
    expect(cas).toMatch(/NOT EXISTS \(SELECT 1 FROM walk WHERE bad\)/);
    // 4) audit written only when the swap matched
    expect(cas).toMatch(/INSERT INTO "cinatra"\."skill_lifecycle_audit"[\s\S]*SELECT \$5, \$1, \$2, \$3, \$6, \$7, \$8 FROM upd/);
  });

  it("reports changed=false (fail-closed no-op) when the CAS/cycle guard matched nothing", () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [] }, { rows: [] }]);
    const out = applySkillLifecycleTransitionInDatabase({
      skillId: "a", expectedFrom: "active", to: "deprecated", auditId: "x",
    });
    expect(out).toEqual({ changed: false });
  });
});

describe("recordSkillRevisionInDatabase", () => {
  it("runs the revision queries in a transaction", () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [] }, { rows: [] }]);
    recordSkillRevisionInDatabase({
      skillId: "s1", revisionId: "r1", contentDigest: null, source: "hitl",
      basedOnSkillIds: null, baseDigests: null, authorUserId: null, initialState: "active",
    });
    const arg = runPostgresQueriesSync.mock.calls[0][0] as { transaction?: boolean; queries: unknown[] };
    expect(arg.transaction).toBe(true);
    expect(arg.queries).toHaveLength(2);
  });
});

// ---- cinatra#1362: content authority + rollback ----

describe("buildSkillLifecycleRevisionQueries — content blob + restores column (#1362)", () => {
  it("stores the content blob BEFORE the revision insert, dedup-safe, and carries restores_revision_id", () => {
    const queries = buildSkillLifecycleRevisionQueries("cinatra", [
      {
        skillId: "s1", revisionId: "r1", contentDigest: "sha", source: "manual",
        basedOnSkillIds: null, baseDigests: null, authorUserId: "u1",
        content: "hello", restoresRevisionId: null, initialState: "active",
      },
    ]);
    // blob first (so the revision's digest resolves), ON CONFLICT DO NOTHING dedup
    expect(queries[0].text).toMatch(/INSERT INTO "cinatra"\."skill_revision_contents" \(content_digest, content, byte_length\)/);
    expect(queries[0].text).toMatch(/octet_length\(\$2\)/);
    expect(queries[0].text).toMatch(/ON CONFLICT \(content_digest\) DO NOTHING/);
    expect(queries[0].values).toEqual(["sha", "hello"]);
    // revision insert now carries the restores_revision_id column
    expect(queries[1].text).toMatch(/INSERT INTO "cinatra"\."skill_revisions"[\s\S]*restores_revision_id/);
    expect(queries[1].values?.[7]).toBeNull();
  });

  it("emits NO blob insert when content is absent (legacy/seed rows)", () => {
    const queries = buildSkillLifecycleRevisionQueries("cinatra", [
      { skillId: "s1", revisionId: "r1", contentDigest: "sha", source: "migration",
        basedOnSkillIds: null, baseDigests: null, authorUserId: null, initialState: "active" },
    ]);
    expect(queries).toHaveLength(2); // revision + pointer only — no blob
    expect(queries[0].text).toMatch(/INSERT INTO "cinatra"\."skill_revisions"/);
  });
});

describe("buildSkillRollbackQuery — atomic compare-and-swap (#1362)", () => {
  const q = buildSkillRollbackQuery("cinatra", {
    skillId: "s1", expectedActiveRevisionId: "head0", newRevisionId: "roll1",
    targetRevisionId: "revPrior", restoredContent: "prior body", restoredContentDigest: "shaPrior",
    restoredPayloadJson: "{\"id\":\"s1\"}", authorUserId: "u1",
    targetBundleDigest: "bundle-digest-prior",
  });

  it("swaps payload + pointer ONLY while active_revision_id still equals the expected head", () => {
    expect(q.text).toMatch(/UPDATE "cinatra"\."skills"[\s\S]*SET payload = \$1, active_revision_id = \$2[\s\S]*WHERE id = \$3 AND active_revision_id = \$4/);
  });

  it("gates the blob + rollback-revision inserts on the CAS (SELECT ... FROM upd) so a miss writes NOTHING", () => {
    expect(q.text).toMatch(/WITH upd AS \(/);
    expect(q.text).toMatch(/INSERT INTO "cinatra"\."skill_revision_contents"[\s\S]*SELECT \$5, \$6, octet_length\(\$6\) FROM upd[\s\S]*ON CONFLICT \(content_digest\) DO NOTHING/);
    expect(q.text).toMatch(/INSERT INTO "cinatra"\."skill_revisions"[\s\S]*SELECT \$2, \$3, \$5, 'rollback', \$7, \$8,/);
    expect(q.text).toMatch(/RETURNING id/);
  });

  it("whole-bundle rollback: copies the target revision's file manifest onto the new rollback revision, gated on the CAS", () => {
    expect(q.text).toMatch(/files AS \(/);
    expect(q.text).toMatch(/INSERT INTO "cinatra"\."skill_revision_files"[\s\S]*SELECT \$2, \$3, f\.path, f\.content_digest, f\.byte_length, f\.mode, f\.is_router[\s\S]*WHERE f\.revision_id = \$7 AND f\.skill_id = \$3 AND EXISTS \(SELECT 1 FROM upd\)/);
    expect(q.text).toMatch(/ON CONFLICT \(revision_id, path\) DO NOTHING/);
  });

  it("whole-bundle rollback: advances the current-bundle head to the rollback revision, gated on the CAS", () => {
    expect(q.text).toMatch(/head AS \(/);
    expect(q.text).toMatch(/INSERT INTO "cinatra"\."skill_bundle_heads" \(skill_id, revision_id, bundle_digest, updated_at\)/);
    expect(q.text).toMatch(/SELECT \$3, \$2, COALESCE\(\$9::text, tr\.bundle_digest\), now\(\)/);
    expect(q.text).toMatch(/AND EXISTS \(SELECT 1 FROM upd\)/);
    expect(q.text).toMatch(/ON CONFLICT \(skill_id\) DO UPDATE/);
  });

  it("orders params: payload, newRev, skill, expectedHead, digest, content, target, author, targetBundleDigest", () => {
    expect(q.values).toEqual([
      "{\"id\":\"s1\"}", "roll1", "s1", "head0", "shaPrior", "prior body", "revPrior", "u1", "bundle-digest-prior",
    ]);
  });
});

describe("readSkillRevisionContentForRollback — same-skill scoped, blob-resolving (#1362)", () => {
  it("matches on (id AND skill_id) and LEFT JOINs the content blob; null row → null", () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [] }]);
    expect(readSkillRevisionContentForRollback("s1", "revX")).toBeNull();
    const { queries } = runPostgresQueriesSync.mock.calls[0][0] as { queries: Array<{ text: string; values?: unknown[] }> };
    expect(queries[0].text).toMatch(/FROM "cinatra"\."skill_revisions" r/);
    expect(queries[0].text).toMatch(/LEFT JOIN "cinatra"\."skill_revision_contents" c ON c\.content_digest = r\.content_digest/);
    expect(queries[0].text).toMatch(/WHERE r\.id = \$1 AND r\.skill_id = \$2/);
    expect(queries[0].values).toEqual(["revX", "s1"]);
  });

  it("returns the resolved content when present", () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [{ revision_id: "revX", content_digest: "sha", content: "body" }] }]);
    expect(readSkillRevisionContentForRollback("s1", "revX")).toEqual({ revisionId: "revX", contentDigest: "sha", content: "body" });
  });

  it("surfaces a blob-less revision as content=null (caller fails closed)", () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [{ revision_id: "revX", content_digest: "sha", content: null }] }]);
    expect(readSkillRevisionContentForRollback("s1", "revX")).toEqual({ revisionId: "revX", contentDigest: "sha", content: null });
  });
});

describe("readSkillActiveRevisionFromDatabase — authoritative head resolver (#1362)", () => {
  it("resolves active_revision_id → revision → content blob", () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [{ active_revision_id: "head0", content_digest: "sha", content: "body" }] }]);
    expect(readSkillActiveRevisionFromDatabase("s1")).toEqual({ activeRevisionId: "head0", contentDigest: "sha", content: "body" });
    const { queries } = runPostgresQueriesSync.mock.calls[0][0] as { queries: Array<{ text: string }> };
    expect(queries[0].text).toMatch(/r\.id = s\.active_revision_id AND r\.skill_id = s\.id/);
  });

  it("returns null when the skill row is absent", () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [] }]);
    expect(readSkillActiveRevisionFromDatabase("s1")).toBeNull();
  });
});

describe("readSkillLifecycleStates — fail-closed batch reader (A3, cinatra#1363)", () => {
  it("returns ok:true with a state per FOUND id (string and NULL both preserved)", () => {
    runPostgresQueriesSync.mockReturnValue([
      { rows: [
        { id: "a", lifecycle_state: "active" },
        { id: "b", lifecycle_state: "archived" },
        { id: "c", lifecycle_state: null }, // derived/extension row
      ] },
    ]);
    const r = readSkillLifecycleStates(["a", "b", "c"]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.states.get("a")).toBe("active");
    expect(r.states.get("b")).toBe("archived");
    expect(r.states.has("c")).toBe(true);
    expect(r.states.get("c")).toBeNull();
  });

  it("selects lifecycle_state by id with an IN (...) placeholder list bound to the ids", () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [] }]);
    readSkillLifecycleStates(["x", "y"]);
    const call = runPostgresQueriesSync.mock.calls[0][0];
    expect(call.queries[0].text).toMatch(/SELECT id, lifecycle_state FROM "cinatra"\."skills" WHERE id IN \(\$1, \$2\)/);
    expect(call.queries[0].values).toEqual(["x", "y"]);
  });

  it("leaves an id ABSENT from the map when its row is not returned (caller withholds it)", () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [{ id: "a", lifecycle_state: "active" }] }]);
    const r = readSkillLifecycleStates(["a", "missing"]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.states.has("a")).toBe(true);
    expect(r.states.has("missing")).toBe(false);
  });

  it("short-circuits an empty/whitespace id list to ok:true empty WITHOUT a DB call", () => {
    const r = readSkillLifecycleStates(["", "  " as unknown as string].filter(Boolean).length ? [] : []);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.states.size).toBe(0);
    expect(runPostgresQueriesSync).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED (ok:false) when the postgres read fails / returns a malformed result", () => {
    // A failed or malformed read (here: no results array to index) must be
    // caught and fail closed — the reader's try/catch turns ANY read failure
    // into ok:false so delivery consumers withhold and the sync aborts.
    runPostgresQueriesSync.mockReturnValue(undefined as never);
    expect(readSkillLifecycleStates(["a"])).toEqual({ ok: false });
  });
});
