/**
 * Exercises the mock client's state transitions for the 4 mutation methods
 * added in P6c-3: withdraw, approve, reject, promotion-retry.
 *
 * The mock is the drop-in for tests + dev compose, so its state-machine
 * behavior MUST mirror what the marketplace would do — otherwise downstream
 * tests using it would land on a different shape than production.
 */

import { describe, it, expect, beforeEach } from "vitest";

import { createMockMarketplaceMcpClient } from "../src/client";
import type { MarketplaceMcpClient } from "../src/client";

describe("mock client — submission mutations", () => {
  let client: MarketplaceMcpClient;

  beforeEach(() => {
    client = createMockMarketplaceMcpClient();
  });

  async function submit(): Promise<string> {
    const out = await client.extensionSubmitForReview({
      namespace: "@acme",
      extension_name: "foo",
      version: "1.0.0",
      artifact_digest_sha256: "0".repeat(64),
      artifact_size_bytes: 100,
      tarball_base64: "AAAA",
    });
    return out.submission_id;
  }

  it("submit creates a row with promotion_state='none' and no final digest yet", async () => {
    await submit();
    const out = await client.extensionSubmissionListSelf();
    expect(out.submissions).toHaveLength(1);
    const row = out.submissions[0];
    expect(row.status).toBe("pending");
    expect(row.promotion_state).toBe("none");
    expect(row.final_artifact_digest).toBeNull();
    expect(row.promotion_error).toBeNull();
  });

  it("withdraw transitions pending → withdrawn", async () => {
    const id = await submit();
    const out = await client.extensionSubmissionWithdraw({ submission_id: id });
    expect(out.status).toBe("withdrawn");
    const list = await client.extensionSubmissionListSelf();
    expect(list.submissions[0].status).toBe("withdrawn");
  });

  it("withdraw on a non-pending submission throws", async () => {
    const id = await submit();
    await client.extensionSubmissionApprove({ submission_id: id }); // → promoted
    await expect(
      client.extensionSubmissionWithdraw({ submission_id: id }),
    ).rejects.toThrow(/not pending/);
  });

  it("approve transitions pending → promoted + complete (mock shortcuts the saga)", async () => {
    const id = await submit();
    const out = await client.extensionSubmissionApprove({ submission_id: id });
    expect(out.status).toBe("promoted");
    expect(out.promotion_state).toBe("complete");
    expect(out.promotion_error).toBeNull();
  });

  it("reject transitions pending → rejected with a stored reason", async () => {
    const id = await submit();
    const out = await client.extensionSubmissionReject({
      submission_id: id,
      reason: "Missing license headers.",
    });
    expect(out.status).toBe("rejected");
    const list = await client.extensionSubmissionListSelf();
    expect(list.submissions[0].decision_reason).toBe("Missing license headers.");
  });

  it("reject with empty reason throws", async () => {
    const id = await submit();
    await expect(
      client.extensionSubmissionReject({ submission_id: id, reason: "   " }),
    ).rejects.toThrow(/reason/);
  });

  it("approve on a non-pending submission throws", async () => {
    const id = await submit();
    await client.extensionSubmissionApprove({ submission_id: id });
    await expect(
      client.extensionSubmissionApprove({ submission_id: id }),
    ).rejects.toThrow(/not pending/);
  });

  it("promotion-retry refuses unless status=approved + promotion_state=failed", async () => {
    const id = await submit();
    // Fresh-pending → not retryable
    await expect(
      client.extensionSubmissionPromotionRetry({ submission_id: id }),
    ).rejects.toThrow(/not retryable/);
    // After approval, mock jumps straight to promoted+complete (not the
    // failed state retry would target), so retry still refuses.
    await client.extensionSubmissionApprove({ submission_id: id });
    await expect(
      client.extensionSubmissionPromotionRetry({ submission_id: id }),
    ).rejects.toThrow(/not retryable/);
  });

  it("admin list filters by status", async () => {
    const a = await submit();
    const _b = await submit();
    await client.extensionSubmissionApprove({ submission_id: a });
    const promoted = await client.extensionSubmissionListAdmin({ status: "promoted" });
    expect(promoted.submissions).toHaveLength(1);
    expect(promoted.submissions[0].submission_id).toBe(a);
    const pending = await client.extensionSubmissionListAdmin({ status: "pending" });
    expect(pending.submissions).toHaveLength(1);
  });
});
