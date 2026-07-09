/**
 * Unit proof for the unified approvals active-VIEW resolver (supersedes the
 * old resolve-active-tab resolver when the page moved from source tabs to
 * DIRECTION tabs). Covers the explicit precedence contract:
 *   explicit ?direction= wins  >  legacy ?tab= maps to inbox+anchor  >  smart
 *   default (land on the populated direction, preferring Inbox).
 */
import { describe, it, expect } from "vitest";

import {
  resolveApprovalsActiveView,
  AGENT_SOURCE_ID,
  WORKFLOW_SOURCE_ID,
} from "../resolve-active-view";

describe("resolveApprovalsActiveView", () => {
  describe("explicit ?direction= wins over everything", () => {
    it("honours direction=inbox even when only 'mine' is populated", () => {
      expect(
        resolveApprovalsActiveView({
          explicitDirection: "inbox",
          legacyTab: undefined,
          inboxCount: 0,
          mineCount: 5,
        }),
      ).toEqual({ direction: "inbox" });
    });

    it("honours direction=mine even when only Inbox is populated", () => {
      expect(
        resolveApprovalsActiveView({
          explicitDirection: "mine",
          legacyTab: undefined,
          inboxCount: 9,
          mineCount: 0,
        }),
      ).toEqual({ direction: "mine" });
    });

    it("explicit direction beats a legacy ?tab= (precedence)", () => {
      expect(
        resolveApprovalsActiveView({
          explicitDirection: "mine",
          legacyTab: "agents",
          inboxCount: 3,
          mineCount: 3,
        }),
      ).toEqual({ direction: "mine" });
    });

    it("ignores an unknown direction and falls through", () => {
      // Unknown direction + no legacy tab + only inbox populated → inbox.
      expect(
        resolveApprovalsActiveView({
          explicitDirection: "sideways",
          legacyTab: undefined,
          inboxCount: 2,
          mineCount: 0,
        }),
      ).toEqual({ direction: "inbox" });
    });
  });

  describe("legacy ?tab= maps to Inbox anchored to the source section", () => {
    it("?tab=workflows → inbox anchored to the workflow section", () => {
      expect(
        resolveApprovalsActiveView({
          explicitDirection: undefined,
          legacyTab: "workflows",
          inboxCount: 0,
          mineCount: 4,
        }),
      ).toEqual({ direction: "inbox", anchor: WORKFLOW_SOURCE_ID });
    });

    it("?tab=agents → inbox anchored to the agent section", () => {
      expect(
        resolveApprovalsActiveView({
          explicitDirection: undefined,
          legacyTab: "agents",
          inboxCount: 0,
          mineCount: 4,
        }),
      ).toEqual({ direction: "inbox", anchor: AGENT_SOURCE_ID });
    });

    it("an unknown legacy tab falls through to the smart default", () => {
      expect(
        resolveApprovalsActiveView({
          explicitDirection: undefined,
          legacyTab: "marketplace",
          inboxCount: 0,
          mineCount: 1,
        }),
      ).toEqual({ direction: "mine" });
    });
  });

  describe("smart default lands on the populated direction, preferring Inbox", () => {
    it("only 'mine' populated → mine", () => {
      expect(
        resolveApprovalsActiveView({
          explicitDirection: undefined,
          legacyTab: undefined,
          inboxCount: 0,
          mineCount: 7,
        }),
      ).toEqual({ direction: "mine" });
    });

    it("only Inbox populated → inbox", () => {
      expect(
        resolveApprovalsActiveView({
          explicitDirection: undefined,
          legacyTab: undefined,
          inboxCount: 7,
          mineCount: 0,
        }),
      ).toEqual({ direction: "inbox" });
    });

    it("both populated → inbox (preferred)", () => {
      expect(
        resolveApprovalsActiveView({
          explicitDirection: undefined,
          legacyTab: undefined,
          inboxCount: 3,
          mineCount: 3,
        }),
      ).toEqual({ direction: "inbox" });
    });

    it("nothing populated → inbox (a non-admin with 0 inbox is never steered nowhere)", () => {
      expect(
        resolveApprovalsActiveView({
          explicitDirection: undefined,
          legacyTab: undefined,
          inboxCount: 0,
          mineCount: 0,
        }),
      ).toEqual({ direction: "inbox" });
    });
  });

  it("exposes stable section ids that match the source ids", () => {
    expect(AGENT_SOURCE_ID).toBe("agent-creation-requests");
    expect(WORKFLOW_SOURCE_ID).toBe("workflow-legacy");
  });
});
