/**
 * Run-token spine — persist + verify on the REAL store (#1193, W1).
 *
 * Drives the exact dispatch seam (mint → setAgentRunTokenHash before sendTask →
 * buildWayflowInitialMessagePayload) against the verify-stack Postgres, then
 * resolves the run through the one verifier. Proves:
 *   - a dispatched run CARRIES the raw credential while only its hash is stored;
 *   - the verifier resolves the run end-to-end from the presented token;
 *   - absent ⇒ 'absent', a non-matching token ⇒ 'unresolvable' (no body fallback);
 *   - resume/clone no-copy: a child run never inherits the parent's hash;
 *   - the partial unique index forbids two runs sharing a token hash.
 *
 * DB-gated: skips when SUPABASE_DB_URL is unset (mirrors the idempotency test).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  mintRunToken,
  hashRunToken,
  verifyRunToken,
  CINATRA_RUN_TOKEN_MESSAGE_KEY,
} from "@/lib/agent-run-token";
import { buildWayflowInitialMessagePayload } from "../wayflow-dispatch-payload";

const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";
const dbUrl = process.env.SUPABASE_DB_URL;
const hasDb =
  typeof dbUrl === "string" &&
  dbUrl.length > 0 &&
  !dbUrl.includes("unused:unused@localhost:5432/unused");
const q = (s: string) => s.replaceAll('"', '""');

beforeAll(async () => {
  if (!hasDb) return;
  // Defensive: ensure the run-token column + partial unique index exist
  // (mirrors src/lib/drizzle-store.ts + core__0019; idempotent).
  const c = new Client({ connectionString: dbUrl });
  await c.connect();
  await c.query(`ALTER TABLE "${q(SCHEMA)}"."agent_runs" ADD COLUMN IF NOT EXISTS run_token_hash text`);
  await c.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_run_token_hash_uniq ON "${q(SCHEMA)}"."agent_runs" (run_token_hash) WHERE run_token_hash IS NOT NULL`,
  );
  await c.end();
}, 30_000);

async function makeTemplate(): Promise<string> {
  const { createAgentTemplate } = await import("../store");
  const templateId = `t_${randomUUID()}`;
  await createAgentTemplate({
    id: templateId,
    name: `runtoken-${randomUUID().slice(0, 8)}`,
    sourceNl: "test",
    compiledPlan: [],
    inputSchema: {},
    approvalPolicy: { steps: [] },
  });
  return templateId;
}

describe.skipIf(!hasDb)("run-token spine — dispatch seam persist + verify", () => {
  it("a dispatched run CARRIES the credential and the verifier resolves it end-to-end", async () => {
    const { createAgentRun, setAgentRunTokenHash, readAgentRunByTokenHash } = await import("../store");
    const templateId = await makeTemplate();
    const run = await createAgentRun({
      id: `r_${randomUUID()}`,
      templateId,
      inputParams: { foo: "bar" },
      orgId: "org-runtoken",
      runBy: "user-1",
    });

    // The exact dispatch seam: mint, persist ONLY the hash (before sendTask),
    // build the initial message carrying the raw token.
    const runToken = mintRunToken();
    await setAgentRunTokenHash(run.id, runToken.tokenHash);
    const payload = buildWayflowInitialMessagePayload({
      inputParams: run.inputParams,
      runId: run.id,
      runToken: runToken.token,
    });

    // The message carries the RAW token; only its hash is persisted.
    expect(payload[CINATRA_RUN_TOKEN_MESSAGE_KEY]).toBe(runToken.token);
    expect(hashRunToken(payload[CINATRA_RUN_TOKEN_MESSAGE_KEY] as string)).toBe(runToken.tokenHash);

    // The raw token is NOT written to the row (only the hash is).
    const c = new Client({ connectionString: dbUrl });
    await c.connect();
    const { rows } = await c.query(
      `SELECT run_token_hash FROM "${q(SCHEMA)}"."agent_runs" WHERE id = $1`,
      [run.id],
    );
    await c.end();
    expect(rows[0].run_token_hash).toBe(runToken.tokenHash);
    expect(rows[0].run_token_hash).not.toBe(runToken.token);

    // The one verifier resolves the run from the presented token.
    const res = await verifyRunToken(runToken.token, readAgentRunByTokenHash);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.run.id).toBe(run.id);
      expect(res.run.orgId).toBe("org-runtoken");
      expect(res.run.runBy).toBe("user-1");
    }
  });

  it("absent ⇒ 'absent'; a non-matching token ⇒ 'unresolvable' (no body fallback)", async () => {
    const { readAgentRunByTokenHash } = await import("../store");
    await expect(verifyRunToken("", readAgentRunByTokenHash)).resolves.toEqual({
      ok: false,
      reason: "absent",
    });
    await expect(
      verifyRunToken(mintRunToken().token, readAgentRunByTokenHash),
    ).resolves.toEqual({ ok: false, reason: "unresolvable" });
  });

  it("resume/clone no-copy: a child run never inherits the parent's token hash", async () => {
    const { createAgentRun, setAgentRunTokenHash, readAgentRunByTokenHash } = await import("../store");
    const templateId = await makeTemplate();
    const parent = await createAgentRun({
      id: `r_${randomUUID()}`,
      templateId,
      inputParams: {},
      orgId: "org-runtoken",
    });
    const parentToken = mintRunToken();
    await setAgentRunTokenHash(parent.id, parentToken.tokenHash);

    const child = await createAgentRun({
      id: `r_${randomUUID()}`,
      templateId,
      inputParams: {},
      orgId: "org-runtoken",
      parentRunId: parent.id,
    });

    // The explicit-whitelist insert must NOT have propagated the parent's hash.
    const c = new Client({ connectionString: dbUrl });
    await c.connect();
    const { rows } = await c.query(
      `SELECT run_token_hash FROM "${q(SCHEMA)}"."agent_runs" WHERE id = $1`,
      [child.id],
    );
    await c.end();
    expect(rows[0].run_token_hash).toBeNull();

    // The parent's token still resolves ONLY the parent.
    const res = await verifyRunToken(parentToken.token, readAgentRunByTokenHash);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.run.id).toBe(parent.id);
  });

  it("the partial unique index forbids two runs sharing a token hash", async () => {
    const { createAgentRun, setAgentRunTokenHash } = await import("../store");
    const templateId = await makeTemplate();
    const a = await createAgentRun({ id: `r_${randomUUID()}`, templateId, inputParams: {}, orgId: "org-runtoken" });
    const b = await createAgentRun({ id: `r_${randomUUID()}`, templateId, inputParams: {}, orgId: "org-runtoken" });
    const shared = mintRunToken().tokenHash;
    await setAgentRunTokenHash(a.id, shared);
    let thrown: unknown = null;
    try {
      await setAgentRunTokenHash(b.id, shared);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeNull();
    const e = thrown as { code?: string; cause?: { code?: string } };
    expect(e?.code ?? e?.cause?.code).toBe("23505");
  });

  it("setAgentRunTokenHash fails closed: throws on empty input and on a zero-row update", async () => {
    const { setAgentRunTokenHash } = await import("../store");
    // Empty input must never silently succeed.
    await expect(setAgentRunTokenHash("", "somehash")).rejects.toThrow(/non-empty/);
    await expect(setAgentRunTokenHash(`r_${randomUUID()}`, "")).rejects.toThrow(/non-empty/);
    // A WHERE that matches no run must throw (dispatch must not proceed to
    // sendTask with an unpersisted hash).
    await expect(
      setAgentRunTokenHash(`r_${randomUUID()}`, mintRunToken().tokenHash),
    ).rejects.toThrow(/exactly one run/);
  });
});
