/**
 * moderationDeleteProject server action unit tests.
 *
 * Hard project deletion was removed — the project lifecycle is archive-only.
 * `moderationDeleteProject` stays exported (admin tooling imports it at the
 * type level), but throws on every call so no audit-then-delete can land. The
 * narrowed public type surface is preserved:
 *   - narrowed `ProjectModerationDeleteReason` (type-only)
 *   - required `ticketRef: string` (type-only)
 */
import { describe, it, expect } from "vitest";

import { moderationDeleteProject } from "@/app/projects/admin-actions";

describe("moderationDeleteProject is archive-only", () => {
  it("throws on every call — project deletion was removed", async () => {
    await expect(
      moderationDeleteProject("p-1", {
        reason: "gdpr_request",
        ticketRef: "TICKET-42",
      }),
    ).rejects.toThrow(/project deletion removed/);

    await expect(
      moderationDeleteProject("p-1", {
        reason: "incident_response",
        ticketRef: "INC-99",
      }),
    ).rejects.toThrow(/project deletion removed/);
  });

  it("narrowed reason union (type-only assertions)", async () => {
    // prettier-ignore
    // @ts-expect-error — "moderation" is in AdminBypassReason but NOT in ProjectModerationDeleteReason
    void (() => moderationDeleteProject("p-1", { reason: "moderation", ticketRef: "T-1" }));
    // prettier-ignore
    // @ts-expect-error — "ownership_transfer" is in AdminBypassReason but NOT in ProjectModerationDeleteReason
    void (() => moderationDeleteProject("p-1", { reason: "ownership_transfer", ticketRef: "T-1" }));
    // prettier-ignore
    // @ts-expect-error — "compliance_audit" is in AdminBypassReason but NOT in ProjectModerationDeleteReason
    void (() => moderationDeleteProject("p-1", { reason: "compliance_audit", ticketRef: "T-1" }));
    // prettier-ignore
    // @ts-expect-error — free-form strings rejected
    void (() => moderationDeleteProject("p-1", { reason: "not-a-reason", ticketRef: "T-1" }));

    // OK — both allowed reasons compile
    void (() => moderationDeleteProject("p-1", { reason: "gdpr_request", ticketRef: "T-1" }));
    void (() => moderationDeleteProject("p-1", { reason: "incident_response", ticketRef: "T-1" }));

    expect(true).toBe(true);
  });

  it("ticketRef required (type-only assertions)", async () => {
    // prettier-ignore
    // @ts-expect-error — ticketRef is required, not optional
    void (() => moderationDeleteProject("p-1", { reason: "gdpr_request" }));
    // prettier-ignore
    // @ts-expect-error — ticketRef must be string, not undefined
    void (() => moderationDeleteProject("p-1", { reason: "gdpr_request", ticketRef: undefined }));

    expect(true).toBe(true);
  });
});
