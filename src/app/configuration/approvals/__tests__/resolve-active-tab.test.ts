/**
 * Unit proof for the approvals default-landing fix (#390).
 *
 * The sidebar pill aggregates pending workflow approvals + admin agent creation
 * requests and links to /configuration/approvals with NO `?tab=`. Before the
 * fix the page always defaulted to the Workflows tab, so a no-tab landing with
 * only a pending AGENT request showed an empty "No pending approvals" view.
 * `resolveApprovalsActiveTab` is the pure decision the page now uses.
 */
import { describe, it, expect } from "vitest";

import { resolveApprovalsActiveTab } from "../resolve-active-tab";

describe("resolveApprovalsActiveTab (#390 default landing)", () => {
  describe("no explicit tab — smart default to the populated inbox", () => {
    it("lands on AGENTS when only an agent request is pending (the #390 bug)", () => {
      expect(
        resolveApprovalsActiveTab({
          explicitTab: undefined,
          pendingWorkflows: 0,
          pendingAgents: 1,
        }),
      ).toBe("agents");
    });

    it("lands on WORKFLOWS when only a workflow approval is pending", () => {
      expect(
        resolveApprovalsActiveTab({
          explicitTab: undefined,
          pendingWorkflows: 2,
          pendingAgents: 0,
        }),
      ).toBe("workflows");
    });

    it("prefers WORKFLOWS when both inboxes have pending items", () => {
      expect(
        resolveApprovalsActiveTab({
          explicitTab: undefined,
          pendingWorkflows: 3,
          pendingAgents: 4,
        }),
      ).toBe("workflows");
    });

    it("falls back to WORKFLOWS when nothing is pending", () => {
      expect(
        resolveApprovalsActiveTab({
          explicitTab: undefined,
          pendingWorkflows: 0,
          pendingAgents: 0,
        }),
      ).toBe("workflows");
    });

    it("never steers a non-admin (pendingAgents always 0) to AGENTS", () => {
      // Non-admin actors get agentRequests=0 from pendingApprovalsCount(), so
      // even with no pending workflow approvals they stay on Workflows.
      expect(
        resolveApprovalsActiveTab({
          explicitTab: undefined,
          pendingWorkflows: 0,
          pendingAgents: 0,
        }),
      ).toBe("workflows");
    });
  });

  describe("explicit tab always wins, regardless of counts", () => {
    it("honors ?tab=agents even when only workflow approvals are pending", () => {
      expect(
        resolveApprovalsActiveTab({
          explicitTab: "agents",
          pendingWorkflows: 5,
          pendingAgents: 0,
        }),
      ).toBe("agents");
    });

    it("honors ?tab=workflows even when only agent requests are pending", () => {
      expect(
        resolveApprovalsActiveTab({
          explicitTab: "workflows",
          pendingWorkflows: 0,
          pendingAgents: 5,
        }),
      ).toBe("workflows");
    });

    it("treats an unknown tab value as no explicit tab (smart default)", () => {
      expect(
        resolveApprovalsActiveTab({
          explicitTab: "bogus",
          pendingWorkflows: 0,
          pendingAgents: 1,
        }),
      ).toBe("agents");
    });
  });
});
