// The test-only marketplace MCP stub (tests/e2e/marketplace-approvals) answers the
// shipped client, so a dev-road walk reads the real pages against drawn rows.
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createHttpMarketplaceMcpClient } from "@cinatra-ai/marketplace-mcp-client/http-client";
import type {
  MarketplaceAdminSubmission,
  MarketplaceVendorApplicationAdminRow,
  MarketplaceVendorApplicationStatusOutput,
  MarketplaceVendorSubmission,
} from "@cinatra-ai/marketplace-mcp-client";

import { createStub, SUBMISSIONS, VENDOR_APPLICATIONS } from "../../../../../tests/e2e/marketplace-approvals/marketplace-mcp-stub.mjs";

// Each key list is checked by the compiler against the client's own type: a key the type
// gains or loses makes this file fail to compile, so the runtime checks below cannot drift.
const SUBMISSION_KEYS = {
  submission_id: true, namespace: true, extension_name: true, version: true, status: true, target_final_identity: true,
  artifact_digest: true, submitted_at: true, decided_at: true, decision_reason: true, promotion_state: true,
  promotion_error: true, final_artifact_digest: true,
} satisfies Record<keyof MarketplaceVendorSubmission, true>;
const ADMIN_ONLY_KEYS = {
  vendor_id: true, staging_artifact_path: true, artifact_size_bytes: true, submitter_id: true, decided_by_admin_id: true,
  description: true, deps_json: true,
} satisfies Record<Exclude<keyof MarketplaceAdminSubmission, keyof MarketplaceVendorSubmission | "eligibility">, true>;
const APPLICATION_KEYS = {
  application_id: true, scope: true, vendor_id: true, status: true, tier: true, terms_version: true, terms_digest: true,
  display_name: true, applicant_user_id: true, applied_at: true, decided_at: true, decided_by_admin_id: true,
  decision_reason: true, reserved_at: true, recovery_attempts: true, repair_stuck_at: true,
} satisfies Record<Exclude<keyof MarketplaceVendorApplicationAdminRow, "eligibility">, true>;
const STATUS_KEYS: string[] = ["state", "scope", "application_id", "tier", "repair_stuck_at"] satisfies Array<keyof MarketplaceVendorApplicationStatusOutput>;

const TIERS = ["free", "commercial"];
const APPLICATION_STATUSES = ["applied", "approved", "rejected", "cancelled", "reset"];
const STATUS_STATES = ["none", "applied", "approved", "rejected", "cancelled", "reset"];

function expectRow(row: object, required: object) {
  for (const key of Object.keys(required)) expect(row, `missing ${key}`).toHaveProperty(key);
}

describe("marketplace MCP stub", () => {
  let server: Server;
  let base: string;
  let client: ReturnType<typeof createHttpMarketplaceMcpClient>;
  const before = process.env.MARKETPLACE_BASE_URL;

  beforeAll(async () => {
    server = createStub();
    await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
    process.env.MARKETPLACE_BASE_URL = base;
    client = createHttpMarketplaceMcpClient({ token: "stub" });
  });
  afterAll(async () => {
    if (before === undefined) delete process.env.MARKETPLACE_BASE_URL;
    else process.env.MARKETPLACE_BASE_URL = before;
    await new Promise((resolve) => server.close(resolve));
  });

  const post = (body: string, path = "/wp-json/cinatra/mcp") =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body });
  const rpc = async (id: number, method: string, params?: object) =>
    (await (await post(JSON.stringify({ jsonrpc: "2.0", id, method, params }))).json()) as {
      id: number;
      error?: { code: number; message: string };
      result?: { structuredContent: Record<string, unknown[]> };
    };

  it("answers the vendor application list, by its status filter", async () => {
    expect((await client.vendorApplicationListAdmin({ status: ["applied"], limit: 50 })).rows.map((row) => row.display_name)).toEqual(["Northwind Labs"]);
    expect((await client.vendorApplicationListAdmin({ status: ["stuck"], limit: 50 } as never)).rows.map((row) => row.display_name)).toEqual(["Acme Tools"]);
    expect(VENDOR_APPLICATIONS).toHaveLength(2);
  });

  it("answers both submission lists", async () => {
    const identities = SUBMISSIONS.map((row: { target_final_identity: string }) => row.target_final_identity);
    expect((await client.extensionSubmissionListSelf()).submissions.map((row) => row.target_final_identity)).toEqual(identities);
    const admin = await client.extensionSubmissionListAdmin({ status: "approved" } as never);
    expect(admin.submissions.map((row) => row.promotion_state)).toEqual(["in_flight", "failed"]);
  });

  it("answers the instance's own application status", async () => {
    expect((await client.vendorApplicationStatus()).state).toBe("approved");
  });

  describe("replies match the client's types, tool by tool", () => {
    it("vendor application list: every row field, the tier, the status and next_cursor", async () => {
      const out = await client.vendorApplicationListAdmin({ limit: 50 });
      expect(out).toHaveProperty("next_cursor", null);
      expect(out.rows.length).toBeGreaterThan(0);
      for (const row of out.rows) {
        expectRow(row, APPLICATION_KEYS);
        expect(TIERS).toContain(row.tier);
        expect(APPLICATION_STATUSES).toContain(row.status);
        expect(typeof row.recovery_attempts).toBe("number");
        expect(row.repair_stuck_at === null || typeof row.repair_stuck_at === "string").toBe(true);
      }
    });

    it("both submission lists: every row field, digests included, and the admin-only fields on the admin list only", async () => {
      const own = await client.extensionSubmissionListSelf();
      expect(own.submissions.length).toBeGreaterThan(0);
      for (const row of own.submissions) {
        expectRow(row, SUBMISSION_KEYS);
        expect(typeof row.artifact_digest).toBe("string");
        expect(row.final_artifact_digest === null || typeof row.final_artifact_digest === "string").toBe(true);
      }
      const admin = await client.extensionSubmissionListAdmin({});
      for (const row of admin.submissions) {
        expectRow(row, SUBMISSION_KEYS);
        expectRow(row, ADMIN_ONLY_KEYS);
      }
    });

    it("application status: only the fields of its output type, with a valid state and tier", async () => {
      const out = await client.vendorApplicationStatus();
      expect(STATUS_STATES).toContain(out.state);
      expect(TIERS).toContain(out.tier);
      for (const key of Object.keys(out)) expect(STATUS_KEYS, `unknown ${key}`).toContain(key);
    });
  });

  describe("refusal and malformed branches", () => {
    it("answers an unknown tool with a JSON-RPC error and no result", async () => {
      const reply = await rpc(7, "tools/call", { name: "cinatra-unexpected", arguments: {} });
      expect(reply.id).toBe(7);
      expect(reply.error?.code).toBe(-32601);
      expect(reply.error?.message).toContain("cinatra-unexpected");
      expect(reply.result).toBeUndefined();
    });

    it("answers an unknown method with a JSON-RPC error", async () => {
      const reply = await rpc(8, "resources/list");
      expect(reply.error?.code).toBe(-32601);
      expect(reply.result).toBeUndefined();
    });

    it("answers another path with 404 and a GET on the MCP path with 405", async () => {
      expect((await post("{}", "/elsewhere")).status).toBe(404);
      expect((await fetch(`${base}/elsewhere`)).status).toBe(404);
      expect((await fetch(`${base}/wp-json/cinatra/mcp`)).status).toBe(405);
    });

    it("answers invalid JSON with 400", async () => {
      expect((await post("{not json")).status).toBe(400);
    });

    it("answers a notification with 202 and no body", async () => {
      const response = await post(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
      expect(response.status).toBe(202);
      expect(await response.text()).toBe("");
    });

    it("returns every row of an unfiltered list", async () => {
      const apps = await rpc(9, "tools/call", { name: "cinatra-vendor-application-list-admin", arguments: {} });
      expect(apps.result?.structuredContent.rows).toHaveLength(VENDOR_APPLICATIONS.length);
      const subs = await rpc(10, "tools/call", { name: "cinatra-extension-submission-list-admin", arguments: {} });
      expect(subs.result?.structuredContent.submissions).toHaveLength(SUBMISSIONS.length);
    });
  });
});
