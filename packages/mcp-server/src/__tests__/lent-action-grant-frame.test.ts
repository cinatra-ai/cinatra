// THE GRANT'S CARRIAGE ONTO THE REQUEST FRAME (cinatra#2932, lifecycle-b W5a).
//
// The plan asks for the grant to be "carried to the platform's own tool server
// through the hosted self-MCP reference ... validated in
// packages/mcp-server/src/request-context.ts". This file is that validation's
// contract, tested directly because it is pure.
//
// THE RULE IT ENCODES: a grant is the authority of a person who typed a message
// under a bound card, so it is admitted only on the two delegations that carry
// one — the browser chat's OBO and the site widget's OBO — and dropped
// everywhere else. It is never verified here (that needs the app secret and
// happens app-side); what happens here is refusing to carry an obvious non-grant
// onto a frame, and refusing to carry ANY grant onto a frame that has no person.

import { describe, expect, it } from "vitest";

import {
  LENT_ACTION_GRANT_HEADER,
  resolveRequestLentActionGrant,
  type DelegatedMcpActor,
} from "../request-context";

const GRANT = "AbCd_-1234567890";

const CHAT: DelegatedMcpActor = {
  delegation: "chat",
  userId: "usr_1",
  orgId: "org_1",
  platformRole: "member",
};

const WIDGET: DelegatedMcpActor = {
  delegation: "public_site_widget",
  userId: "usr_1",
  orgId: "org_1",
  instanceId: "inst_1",
  kind: "wordpress",
  jti: "j",
  platformRole: "member",
};

const AGENT_RUN: DelegatedMcpActor = {
  delegation: "agent_run",
  userId: "usr_1",
  orgId: "org_1",
  runId: "run_1",
  platformRole: "member",
  oboCeiling: [] as never,
};

describe("the header name is one definition", () => {
  it("is the lowercase header the transport reads", () => {
    expect(LENT_ACTION_GRANT_HEADER).toBe("x-cinatra-lent-grant");
  });
});

describe("admitted only where a PERSON typed", () => {
  it("admits a chat delegation's grant", () => {
    expect(
      resolveRequestLentActionGrant({ headerValue: GRANT, delegatedActor: CHAT }),
    ).toBe(GRANT);
  });

  it("admits a public-site-widget delegation's grant — the same road", () => {
    expect(
      resolveRequestLentActionGrant({ headerValue: GRANT, delegatedActor: WIDGET }),
    ).toBe(GRANT);
  });

  it("DROPS a grant on an agent-run frame — a machine has no typed message", () => {
    expect(
      resolveRequestLentActionGrant({ headerValue: GRANT, delegatedActor: AGENT_RUN }),
    ).toBeUndefined();
  });

  it("DROPS a grant on a frame with no delegation at all", () => {
    expect(
      resolveRequestLentActionGrant({ headerValue: GRANT, delegatedActor: null }),
    ).toBeUndefined();
    expect(resolveRequestLentActionGrant({ headerValue: GRANT })).toBeUndefined();
  });
});

describe("shape before substance", () => {
  it("drops an absent header", () => {
    expect(
      resolveRequestLentActionGrant({ headerValue: null, delegatedActor: CHAT }),
    ).toBeUndefined();
    expect(resolveRequestLentActionGrant({ delegatedActor: CHAT })).toBeUndefined();
  });

  it("drops an empty or whitespace header", () => {
    for (const v of ["", "   ", "\t"]) {
      expect(
        resolveRequestLentActionGrant({ headerValue: v, delegatedActor: CHAT }),
      ).toBeUndefined();
    }
  });

  it("drops anything outside the codec's alphabet", () => {
    for (const v of ["has spaces", "has.dots", "has/slash", "has=pad", "a,b"]) {
      expect(
        resolveRequestLentActionGrant({ headerValue: v, delegatedActor: CHAT }),
        v,
      ).toBeUndefined();
    }
  });

  it("drops a list-valued header rather than picking one — ONE header, ONE grant", () => {
    expect(
      resolveRequestLentActionGrant({
        headerValue: `${GRANT}, ${GRANT}`,
        delegatedActor: CHAT,
      }),
    ).toBeUndefined();
  });

  it("drops anything longer than the codec's bound", () => {
    expect(
      resolveRequestLentActionGrant({
        headerValue: "a".repeat(513),
        delegatedActor: CHAT,
      }),
    ).toBeUndefined();
    expect(
      resolveRequestLentActionGrant({
        headerValue: "a".repeat(512),
        delegatedActor: CHAT,
      }),
    ).toBe("a".repeat(512));
  });

  it("trims surrounding whitespace a relay may have added", () => {
    expect(
      resolveRequestLentActionGrant({
        headerValue: `  ${GRANT}  `,
        delegatedActor: CHAT,
      }),
    ).toBe(GRANT);
  });
});
