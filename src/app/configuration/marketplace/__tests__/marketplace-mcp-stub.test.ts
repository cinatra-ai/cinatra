// The test-only marketplace MCP stub (tests/e2e/marketplace-approvals) answers the
// shipped client, so a dev-road walk reads the real pages against drawn rows.
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createHttpMarketplaceMcpClient } from "@cinatra-ai/marketplace-mcp-client/http-client";
import type {
  MarketplaceAdminSubmission,
  MarketplaceExtensionSubmissionListAdminOutput,
  MarketplaceExtensionSubmissionListSelfOutput,
  MarketplaceVendorApplicationAdminRow,
  MarketplaceVendorApplicationListAdminOutput,
  MarketplaceVendorApplicationStatusOutput,
  MarketplaceVendorSubmission,
} from "@cinatra-ai/marketplace-mcp-client";

import {
  ADMIN_SUBMISSION_FIELDS,
  APPLICATION_ROW_FIELDS,
  createStub,
  SUBMISSIONS,
  VENDOR_APPLICATIONS,
  VENDOR_SUBMISSION_FIELDS,
} from "../../../../../tests/e2e/marketplace-approvals/marketplace-mcp-stub.mjs";

// A key map names every key of one client type and marks it required or optional, as the type does.
// `satisfies KeyMap<T>` fails to compile when the type has a key that the map lacks (the mapped type
// makes every key required), when the map has a key that the type lacks (the excess-property check of
// the object literal), and when the map marks a key required that the type makes optional, or the reverse.
type KeyMap<T> = { [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? "optional" : "required" };
type Keys = Record<string, "required" | "optional">;

const SUBMISSION_KEYS = {
  submission_id: "required", namespace: "required", extension_name: "required", version: "required", status: "required",
  target_final_identity: "required", artifact_digest: "required", submitted_at: "required", decided_at: "required",
  decision_reason: "required", promotion_state: "required", promotion_error: "required", final_artifact_digest: "required",
} satisfies KeyMap<MarketplaceVendorSubmission>;
const ADMIN_SUBMISSION_KEYS = {
  ...SUBMISSION_KEYS,
  vendor_id: "required", staging_artifact_path: "required", artifact_size_bytes: "required", submitter_id: "required",
  decided_by_admin_id: "required", description: "required", deps_json: "required", eligibility: "optional",
} satisfies KeyMap<MarketplaceAdminSubmission>;
const APPLICATION_KEYS = {
  application_id: "required", scope: "required", vendor_id: "required", status: "required", tier: "required",
  terms_version: "required", terms_digest: "required", display_name: "required", applicant_user_id: "required",
  applied_at: "required", decided_at: "required", decided_by_admin_id: "required", decision_reason: "required",
  reserved_at: "required", recovery_attempts: "required", repair_stuck_at: "required", eligibility: "optional",
} satisfies KeyMap<MarketplaceVendorApplicationAdminRow>;
const STATUS_KEYS = {
  state: "required", scope: "optional", application_id: "optional", tier: "optional", decided_at: "optional",
  decision_reason: "optional", terms_version: "optional", repair_stuck_at: "optional",
} satisfies KeyMap<MarketplaceVendorApplicationStatusOutput>;
const APPLICATION_LIST_KEYS = { rows: "required", next_cursor: "required" } satisfies KeyMap<MarketplaceVendorApplicationListAdminOutput>;
const OWN_SUBMISSION_LIST_KEYS = { submissions: "required" } satisfies KeyMap<MarketplaceExtensionSubmissionListSelfOutput>;
const ADMIN_SUBMISSION_LIST_KEYS = { submissions: "required" } satisfies KeyMap<MarketplaceExtensionSubmissionListAdminOutput>;

const TIERS = ["free", "commercial"];
const APPLICATION_STATUSES = ["applied", "approved", "rejected", "cancelled", "reset"];
const STATUS_STATES = ["none", "applied", "approved", "rejected", "cancelled", "reset"];

// The value carries every required key of its map and no key that the map lacks.
function expectExact(value: object, keys: Keys, what: string) {
  for (const key of Object.keys(value)) expect(Object.hasOwn(keys, key), `${what}: extra key ${key}`).toBe(true);
  for (const [key, kind] of Object.entries(keys)) {
    if (kind === "required") expect(Object.hasOwn(value, key), `${what}: missing key ${key}`).toBe(true);
  }
}
const sorted = (keys: Iterable<string>) => [...keys].sort();

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
      expectExact(out, APPLICATION_LIST_KEYS, "application list");
      expect(out.rows.length).toBeGreaterThan(0);
      for (const row of out.rows) {
        expectExact(row, APPLICATION_KEYS, `application ${row.application_id}`);
        expect(TIERS).toContain(row.tier);
        expect(APPLICATION_STATUSES).toContain(row.status);
        expect(typeof row.recovery_attempts).toBe("number");
        expect(row.repair_stuck_at === null || typeof row.repair_stuck_at === "string").toBe(true);
      }
    });

    it("both submission lists: the output keys, every row's keys, digests included, and the admin-only keys on the admin list only", async () => {
      const own = await client.extensionSubmissionListSelf();
      expectExact(own, OWN_SUBMISSION_LIST_KEYS, "own submission list");
      expect(own.submissions.length).toBeGreaterThan(0);
      for (const row of own.submissions) {
        expectExact(row, SUBMISSION_KEYS, `own submission ${row.submission_id}`);
        expect(typeof row.artifact_digest).toBe("string");
        expect(row.final_artifact_digest === null || typeof row.final_artifact_digest === "string").toBe(true);
      }
      const admin = await client.extensionSubmissionListAdmin({});
      expectExact(admin, ADMIN_SUBMISSION_LIST_KEYS, "admin submission list");
      expect(admin.submissions.length).toBeGreaterThan(0);
      for (const row of admin.submissions) expectExact(row, ADMIN_SUBMISSION_KEYS, `admin submission ${row.submission_id}`);
    });

    it("application status: only the keys of its output type, with a valid state and tier", async () => {
      const out = await client.vendorApplicationStatus();
      expectExact(out, STATUS_KEYS, "application status");
      expect(STATUS_STATES).toContain(out.state);
      expect(TIERS).toContain(out.tier);
    });

    it("cuts each list row to the field list of its type", () => {
      expect(sorted(VENDOR_SUBMISSION_FIELDS)).toEqual(sorted(Object.keys(SUBMISSION_KEYS)));
      expect(sorted(ADMIN_SUBMISSION_FIELDS)).toEqual(sorted(Object.keys(ADMIN_SUBMISSION_KEYS)));
      expect(sorted(APPLICATION_ROW_FIELDS)).toEqual(sorted(Object.keys(APPLICATION_KEYS)));
    });
  });

  describe("rows that a test passes in", () => {
    const hint = { can_approve: false, can_reject: false };
    let injected: Server;
    let at: string;
    beforeAll(async () => {
      injected = createStub({
        applications: [{ ...VENDOR_APPLICATIONS[1], eligibility: hint, debug: true }],
        submissions: [{ ...SUBMISSIONS[0], eligibility: hint, debug: true }],
      });
      await new Promise<void>((resolve) => injected.listen(0, "localhost", resolve));
      at = `http://localhost:${(injected.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      await new Promise((resolve) => injected.close(resolve));
    });
    const onlyRow = async (name: string, list: string) => {
      const response = await fetch(`${at}/wp-json/cinatra/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }),
      });
      const reply = (await response.json()) as { result: { structuredContent: Record<string, Array<Record<string, unknown>>> } };
      const rows = reply.result.structuredContent[list];
      expect(rows).toHaveLength(1);
      return rows[0];
    };

    it("the application list keeps eligibility and drops a key that no type has", async () => {
      const row = await onlyRow("cinatra-vendor-application-list-admin", "rows");
      expectExact(row, APPLICATION_KEYS, "injected application");
      expect(row.eligibility).toEqual(hint);
    });

    it("the vendor's own list drops eligibility, the admin-only keys and a key that no type has", async () => {
      const row = await onlyRow("cinatra-extension-submission-list-self", "submissions");
      expectExact(row, SUBMISSION_KEYS, "injected own submission");
      expect(row).not.toHaveProperty("eligibility");
    });

    it("the admin submission list keeps eligibility and drops a key that no type has", async () => {
      const row = await onlyRow("cinatra-extension-submission-list-admin", "submissions");
      expectExact(row, ADMIN_SUBMISSION_KEYS, "injected admin submission");
      expect(row.eligibility).toEqual(hint);
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
