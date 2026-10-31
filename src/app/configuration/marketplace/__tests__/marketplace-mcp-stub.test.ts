// The test-only marketplace MCP stub (tests/e2e/marketplace-approvals) answers the
// shipped client, so a dev-road walk reads the real pages against drawn rows.
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createHttpMarketplaceMcpClient } from "@cinatra-ai/marketplace-mcp-client/http-client";

import { createStub, SUBMISSIONS, VENDOR_APPLICATIONS } from "../../../../../tests/e2e/marketplace-approvals/marketplace-mcp-stub.mjs";

describe("marketplace MCP stub", () => {
  let server: Server;
  let client: ReturnType<typeof createHttpMarketplaceMcpClient>;
  const before = process.env.MARKETPLACE_BASE_URL;

  beforeAll(async () => {
    server = createStub();
    await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
    process.env.MARKETPLACE_BASE_URL = `http://localhost:${(server.address() as AddressInfo).port}`;
    client = createHttpMarketplaceMcpClient({ token: "stub" });
  });
  afterAll(async () => {
    if (before === undefined) delete process.env.MARKETPLACE_BASE_URL;
    else process.env.MARKETPLACE_BASE_URL = before;
    await new Promise((resolve) => server.close(resolve));
  });

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
});
