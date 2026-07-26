/**
 * cinatra#1939 S3 — session-mint eligibility for the org-write authority.
 *
 * Pins the transport-side predicate that decides whether the app-wired
 * `mintOrgWriteAuthority` callback runs for a request frame: membership-
 * grounded callers only (cookie session / chat-OBO), NEVER an agent-run
 * delegation (its authority is the run verifier's — minting here would skip
 * the live-attempt check) and NEVER a widget delegation; all three identity
 * fields required. The dashboards seam test
 * (packages/dashboards/src/__tests__/org-write-seam-1939.test.ts) pins the
 * consuming narrow; this file pins the producer gate.
 */
import { describe, expect, it } from "vitest";

import {
  shouldMintSessionOrgWriteAuthority,
  type DelegatedMcpActor,
} from "../request-context";

const CHAT_ACTOR: DelegatedMcpActor = {
  delegation: "chat",
  userId: "u1",
  orgId: "org-1",
  platformRole: "member",
};

const AGENT_RUN_ACTOR: DelegatedMcpActor = {
  delegation: "agent_run",
  userId: "u1",
  orgId: "org-1",
  runId: "run-1",
  platformRole: "member",
  oboCeiling: [{ tier: "organization", id: "org-1" }],
};

const WIDGET_ACTOR: DelegatedMcpActor = {
  delegation: "public_site_widget",
  userId: "u1",
  orgId: "org-1",
  instanceId: "inst-1",
  kind: "wordpress",
  jti: "jti-1",
  platformRole: "member",
};

const FULL_IDS = {
  userId: "u1",
  orgId: "org-1",
  orgRole: "member" as const,
};

describe("shouldMintSessionOrgWriteAuthority (#1939 S3)", () => {
  it("admits a cookie session (no delegation) with a resolved membership role", () => {
    expect(
      shouldMintSessionOrgWriteAuthority({ delegatedActor: null, ...FULL_IDS }),
    ).toBe(true);
    expect(
      shouldMintSessionOrgWriteAuthority({ delegatedActor: undefined, ...FULL_IDS }),
    ).toBe(true);
  });

  it("admits a chat-OBO delegation — the chat relay acts as the human member", () => {
    expect(
      shouldMintSessionOrgWriteAuthority({ delegatedActor: CHAT_ACTOR, ...FULL_IDS }),
    ).toBe(true);
  });

  it("REFUSES an agent-run delegation even with every identity field present — run authority comes from the run verifier, never the session mint", () => {
    expect(
      shouldMintSessionOrgWriteAuthority({
        delegatedActor: AGENT_RUN_ACTOR,
        ...FULL_IDS,
      }),
    ).toBe(false);
  });

  it("REFUSES a public-site widget delegation", () => {
    expect(
      shouldMintSessionOrgWriteAuthority({ delegatedActor: WIDGET_ACTOR, ...FULL_IDS }),
    ).toBe(false);
  });

  it("refuses when any identity field is missing — orgRole is the membership proof", () => {
    for (const gap of [
      { userId: null },
      { userId: undefined },
      { orgId: null },
      { orgId: undefined },
      { orgRole: undefined },
    ]) {
      expect(
        shouldMintSessionOrgWriteAuthority({
          delegatedActor: null,
          ...FULL_IDS,
          ...gap,
        }),
      ).toBe(false);
    }
  });

  it("refuses empty-string ids (never mints an authority bound to no org)", () => {
    expect(
      shouldMintSessionOrgWriteAuthority({
        delegatedActor: null,
        ...FULL_IDS,
        orgId: "",
      }),
    ).toBe(false);
    expect(
      shouldMintSessionOrgWriteAuthority({
        delegatedActor: null,
        ...FULL_IDS,
        userId: "",
      }),
    ).toBe(false);
  });
});
