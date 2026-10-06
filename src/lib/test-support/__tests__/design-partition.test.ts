import { afterEach, describe, it, expect, vi } from "vitest";
import { designPartition } from "../design-partition";
const env = (current: number) => ({
  CINATRA_DESIGN_HEAD_SHA: "a".repeat(40),
  CINATRA_DESIGN_PARTITION: `${current}/2`,
  CINATRA_DESIGN_PARTITION_RUN_ID: "coverage-trial",
  CINATRA_DESIGN_PARTITION_BASE_PORT: "3150",
  SUPABASE_DB_URL: `postgresql://test:test@127.0.0.1:5433/cinatra_design_coverage_trial_p${current}`,
  REDIS_URL: `redis://127.0.0.1:6380/${current}`,
});
describe("opt-in design partition isolation", () => {
  it("leaves the current serial contract unchanged by default", () => expect(designPartition({})).toBeUndefined());
  it("gives the two partitions distinct stores, namespaces and ports", () => {
    const a = designPartition(env(1))!;
    const b = designPartition(env(2))!;
    for (const key of ["database", "runId", "port", "baseURL"] as const) expect(a[key]).not.toBe(b[key]);
    expect([a.current, b.current]).toEqual([1, 2]);
    expect(a.total).toBe(2);
  });
  it.each(["CINATRA_DESIGN_HEAD_SHA", "SUPABASE_DB_URL", "REDIS_URL", "CINATRA_DESIGN_PARTITION_RUN_ID", "CINATRA_DESIGN_PARTITION_BASE_PORT"])("refuses missing isolation prerequisite %s", (key) => {
    expect(() => designPartition({ ...env(1), [key]: undefined })).toThrow();
  });
  it("refuses sharing either substrate or targeting another partition server", () => {
    expect(() => designPartition({ ...env(2), SUPABASE_DB_URL: env(1).SUPABASE_DB_URL })).toThrow(/own database/);
    expect(() => designPartition({ ...env(2), REDIS_URL: env(1).REDIS_URL })).toThrow(/Redis database 2/);
    expect(() => designPartition({ ...env(2), E2E_DESIGN_BASE_URL: "http://127.0.0.1:3150" })).toThrow(/own server/);
    expect(() => designPartition({ ...env(1), PORT: "3151" })).toThrow(/PORT/);
    expect(() => designPartition({ ...env(1), CINATRA_CONFORMANCE_RUN_ID: "coverage-trial-p2" })).toThrow(/namespace/);
  });
  it("refuses malformed topology before launching any tests", () => {
    expect(() => designPartition({ ...env(1), CINATRA_DESIGN_PARTITION: "1/4" })).toThrow(/1\/2 or 2\/2/);
    expect(() => designPartition({ ...env(1), CINATRA_DESIGN_PARTITION_RUN_ID: "X" })).toThrow();
  });
});


afterEach(() => vi.unstubAllEnvs());
describe("the real seed handlers enforce partition ownership before store mutation", () => {
  it("rejects another partition on both POST and DELETE", async () => {
    const { NextRequest } = await import("next/server");
    const handlers = await import("@/app/design-fixtures/conformance/seed/route");
    for (const [key, value] of Object.entries(env(1))) vi.stubEnv(key, value);
    const token = "partition-isolation-test-capability-0123456789";
    vi.stubEnv("CINATRA_CONFORMANCE_SEED_TOKEN", token);
    for (const method of ["POST", "DELETE"] as const) {
      const response = await handlers[method](new NextRequest("http://127.0.0.1:3150/design-fixtures/conformance/seed", {
        method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ runId: "coverage-trial-p2" }),
      }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "run namespace does not match this isolated partition" });
    }
  });
});


describe("the real identity handler is capability-gated", () => {
  it("returns the current partition identity only to an authorized caller", async () => {
    const { NextRequest } = await import("next/server");
    const { GET } = await import("@/app/design-fixtures/conformance/seed/route");
    for (const [key, value] of Object.entries(env(1))) vi.stubEnv(key, value);
    const token = "partition-isolation-test-capability-0123456789";
    vi.stubEnv("CINATRA_CONFORMANCE_SEED_TOKEN", token);
    const url = "http://127.0.0.1:3150/design-fixtures/conformance/seed";
    expect((await GET(new NextRequest(url))).status).toBe(404);
    expect((await GET(new NextRequest(url, { headers: { authorization: "Bearer wrong" } }))).status).toBe(404);
    const response = await GET(new NextRequest(url, { headers: { authorization: `Bearer ${token}` } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ partition: designPartition(env(1)) });
  });
});
