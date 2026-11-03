// @vitest-environment jsdom
//
// The three marketplace approval pages, run for real against the test-only marketplace stub
// (tests/e2e/marketplace-approvals): the shipped client reads the stub, the page renders its rows
// through the status cells, and the test reads what a viewer sees. Only the session check, the
// admin token, the page chrome and the action buttons (server actions) are replaced.
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("@/lib/auth-session", () => ({ requireAdminSession: async () => undefined }));
vi.mock("@/lib/marketplace-credentials", () => ({ resolveMarketplaceAdminToken: () => "stub-admin" }));
vi.mock("@/components/layout/main", () => ({ Main: ({ children }: { children: ReactNode }) => <main>{children}</main> }));
vi.mock("@/components/page-header", () => ({ PageHeader: ({ title }: { title: string }) => <h1>{title}</h1> }));
vi.mock("@/components/page-content", () => ({ PageContent: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/search-param-toast", () => ({ SearchParamToast: () => null }));
vi.mock("../submissions/admin/status-filter", () => ({ StatusFilter: () => null }));
vi.mock("../submissions/admin/admin-action-buttons", () => ({
  ApproveButton: () => <span>Approve</span>,
  RejectButton: () => <span>Reject</span>,
  RetryPromotionButton: () => <span>Retry promotion</span>,
}));
vi.mock("../submissions/withdraw-submission-button", () => ({ WithdrawSubmissionButton: () => <span>Withdraw</span> }));
vi.mock("../vendor-applications/status-filter", () => ({ VendorApplicationsStatusFilter: () => null }));
vi.mock("../vendor-applications/admin-action-buttons", () => ({
  ApproveButton: () => <span>Approve</span>,
  RejectButton: () => <span>Reject</span>,
  ViewDetailSheet: () => null,
}));

import { createStub, SUBMISSIONS, VENDOR_APPLICATIONS } from "../../../../../tests/e2e/marketplace-approvals/marketplace-mcp-stub.mjs";
import AdminSubmissionsQueuePage from "../submissions/admin/page";
import VendorSubmissionsPage from "../submissions/page";
import VendorApplicationsAdminPage from "../vendor-applications/page";

const REFUSED = { can_approve: false, can_reject: false };
const pending = (id: string, extra: object = {}) => ({
  ...SUBMISSIONS[0],
  submission_id: id,
  target_final_identity: `@acme/${id}`,
  status: "pending",
  promotion_state: "none",
  ...extra,
});
const applied = (id: string, name: string, extra: object = {}) => ({
  ...VENDOR_APPLICATIONS[1],
  application_id: id,
  display_name: name,
  status: "applied",
  ...extra,
});

let server: Server | undefined;
const saved = {
  base: process.env.MARKETPLACE_BASE_URL,
  instance: process.env.MARKETPLACE_INSTANCE_TOKEN,
};

async function serve(data: { applications?: object[]; submissions?: object[] }) {
  await stop();
  server = createStub(data);
  await new Promise<void>((resolve) => server!.listen(0, "localhost", resolve));
  process.env.MARKETPLACE_BASE_URL = `http://localhost:${(server.address() as AddressInfo).port}`;
  process.env.MARKETPLACE_INSTANCE_TOKEN = "stub-instance";
}
async function stop() {
  const running = server;
  server = undefined;
  if (running) await new Promise((resolve) => running.close(resolve));
}

// The status pill labels in the row of the cell text `rowText`.
function pillsOf(root: HTMLElement, rowText: string): string[] {
  const row = [...root.querySelectorAll("tr")].find((tr) => tr.textContent?.includes(rowText));
  expect(row, `no row for ${rowText}`).toBeDefined();
  return [...row!.querySelectorAll('[data-slot="status-pill"]')].map((pill) => pill.textContent ?? "");
}

beforeAll(() => {
  process.env.MARKETPLACE_BASE_URL = saved.base;
});
afterEach(async () => {
  cleanup();
  await stop();
});
afterAll(() => {
  if (saved.base === undefined) delete process.env.MARKETPLACE_BASE_URL;
  else process.env.MARKETPLACE_BASE_URL = saved.base;
  if (saved.instance === undefined) delete process.env.MARKETPLACE_INSTANCE_TOKEN;
  else process.env.MARKETPLACE_INSTANCE_TOKEN = saved.instance;
});

describe("administrator submission queue (submissions/admin/page.tsx)", () => {
  it("draws Awaiting others for a pending row whose eligibility refuses approve and reject, and Awaiting you with no hint", async () => {
    await serve({ submissions: [pending("refused", { eligibility: REFUSED }), pending("open")] });
    const { container } = render(await AdminSubmissionsQueuePage({ searchParams: Promise.resolve({ status: "pending" }) }));
    expect(pillsOf(container, "@acme/refused")).toEqual(["Awaiting others"]);
    expect(pillsOf(container, "@acme/open")).toEqual(["Awaiting you"]);
  });

  it("draws Awaiting you when only one of the two decisions is refused", async () => {
    await serve({ submissions: [pending("half", { eligibility: { can_approve: false, can_reject: true } })] });
    const { container } = render(await AdminSubmissionsQueuePage({ searchParams: Promise.resolve({ status: "pending" }) }));
    expect(pillsOf(container, "@acme/half")).toEqual(["Awaiting you"]);
  });
});

describe("vendor applications queue (vendor-applications/page.tsx)", () => {
  it("draws Awaiting others for an applied row whose eligibility refuses approve and reject, and Awaiting you with no hint", async () => {
    await serve({
      applications: [applied("a-refused", "Refused Labs", { eligibility: REFUSED }), applied("a-open", "Open Labs")],
    });
    const { container } = render(await VendorApplicationsAdminPage({ searchParams: Promise.resolve({ status: "applied" }) }));
    expect(pillsOf(container, "Refused Labs")).toEqual(["Awaiting others"]);
    expect(pillsOf(container, "Open Labs")).toEqual(["Awaiting you"]);
  });

  it("draws the Failed pill and the attempt count of a stuck approved row", async () => {
    await serve({ applications: [{ ...VENDOR_APPLICATIONS[0] }] });
    const { container } = render(await VendorApplicationsAdminPage({ searchParams: Promise.resolve({ status: "approved" }) }));
    expect(pillsOf(container, "Acme Tools")).toEqual(["Approved", "Failed"]);
    expect(container.textContent).toContain("3 attempts");
  });
});

describe("vendor's own submissions (submissions/page.tsx)", () => {
  it("draws Awaiting others for a pending row, even when the row carries an approving eligibility, and offers Withdraw and no retry", async () => {
    await serve({ submissions: [pending("mine", { eligibility: { can_approve: true, can_reject: true } })] });
    const { container } = render(await VendorSubmissionsPage());
    expect(pillsOf(container, "@acme/mine")).toEqual(["Awaiting others"]);
    expect(container.textContent).toContain("Withdraw");
    expect(container.textContent).not.toMatch(/retry/i);
  });

  it("offers no retry on an approved row whose promotion failed", async () => {
    await serve({ submissions: [SUBMISSIONS[1]] });
    const { container } = render(await VendorSubmissionsPage());
    expect(pillsOf(container, "@acme/crm-sync")).toEqual(["Approved"]);
    expect(container.textContent).toContain("Promotion failed");
    expect(container.textContent).not.toMatch(/retry/i);
  });
});
