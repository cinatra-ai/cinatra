// cinatra#2674 scope addition (2026-08-12) — SERVING an island credential.
//
// The credential authenticates; it authorizes nothing. These cases pin the four
// checks that stand between "this URL was minted by us" and "here is a reader",
// each with its negative control: the ref binding, the live principal, the live
// site/token bindings, and the live org standing. The platform tier is asserted
// unfloored here too — the island and the card must resolve ONE reader.

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-island-serving";

const rows = vi.fn();
const getActiveConnectSiteById = vi.fn();
const resolveActorGrantsForUserInOrg = vi.fn();
const readUserIsPlatformAdmin = vi.fn();
const widgetAuthSessionIsLive = vi.fn();

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (...a: unknown[]) => rows(...a),
  quotePostgresIdentifier: (v: string) => `"${v}"`,
}));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "cinatra",
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));
vi.mock("@/lib/connect-sites-store", () => ({
  getActiveConnectSiteById: (...a: unknown[]) => getActiveConnectSiteById(...a),
}));
vi.mock("@/lib/auth-session", () => ({
  resolveActorGrantsForUserInOrg: (...a: unknown[]) => resolveActorGrantsForUserInOrg(...a),
}));
vi.mock("@/lib/better-auth-db", () => ({
  readUserIsPlatformAdmin: (...a: unknown[]) => readUserIsPlatformAdmin(...a),
}));
vi.mock("@/lib/widget-auth-audit", () => ({ emitWidgetAuthAudit: vi.fn() }));
// cinatra#2684 — the parent-session leaf. Mocked as a data switch, exactly as
// the capture probe's suite mocks it, so a SIGN-OUT is expressible here as what
// it is: the session simply stops being live.
vi.mock("@/lib/widget-session-binding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/widget-session-binding")>();
  return { ...actual, widgetAuthSessionIsLive: (id: unknown) => widgetAuthSessionIsLive(id) };
});

import { encodeLifecycleGateRef } from "../lifecycle-card-ref";
import { mintReviewIslandCredential } from "../review-island-credential";
import { resolveIslandCredentialReader } from "../review-island-serving";
import {
  WIDGET_LIFECYCLE_READ_ROUTE_PATH,
  WIDGET_LIFECYCLE_READ_SCOPE,
} from "@/lib/widget-lifecycle-scope";
import { WIDGET_BROKER_ROUTE_PATH } from "@/lib/widget-broker-route";

const GATE = { runId: "run-1", reviewTaskId: "task-1" };
const PAYLOAD = {
  orgId: "org-A",
  userId: "user-1",
  jti: "jti-1",
  siteId: "site-1",
  client: "wordpress",
  instanceId: "inst-1",
  agentSlug: "wordpress-content-editor",
  ...GATE,
};

const AGENT_SCOPE = `${PAYLOAD.agentSlug}.user`;

/** A live `cwu_` row carrying the lifecycle grant. */
function tokenRow(overrides: Record<string, unknown> = {}) {
  return {
    user_id: PAYLOAD.userId,
    org_id: PAYLOAD.orgId,
    site_id: PAYLOAD.siteId,
    client: PAYLOAD.client,
    instance_id: PAYLOAD.instanceId,
    agent_slug: PAYLOAD.agentSlug,
    site_origin: "https://wp.example.test",
    aud: `${WIDGET_BROKER_ROUTE_PATH} ${WIDGET_LIFECYCLE_READ_ROUTE_PATH}`,
    scope: `${AGENT_SCOPE} ${WIDGET_LIFECYCLE_READ_SCOPE}`,
    credential_version: 3,
    // The parent sign-in this `cwu_` row belongs to (cinatra#2684).
    auth_session_id: "sess-1",
    not_expired: true,
    ...overrides,
  };
}

const SITE_ROW = {
  siteId: PAYLOAD.siteId,
  client: PAYLOAD.client,
  orgId: PAYLOAD.orgId,
  widgetOrigin: "https://wp.example.test",
  credentialVersion: 3,
};

function setTokenRow(row: Record<string, unknown> | null) {
  rows.mockReturnValue([{ rows: row ? [row] : [] }]);
}

const ref = () => encodeLifecycleGateRef(GATE)!;
const credential = () => mintReviewIslandCredential(PAYLOAD)!;

beforeEach(() => {
  vi.clearAllMocks();
  setTokenRow(tokenRow());
  getActiveConnectSiteById.mockReturnValue(SITE_ROW);
  resolveActorGrantsForUserInOrg.mockResolvedValue({
    orgRole: "member",
    teamIds: ["team-1"],
    teamRoles: { "team-1": "member" },
    projectGrants: [],
  });
  readUserIsPlatformAdmin.mockResolvedValue(false);
  widgetAuthSessionIsLive.mockReturnValue(true);
});

describe("the happy path", () => {
  it("resolves a reader whose gate comes from the CREDENTIAL, not from re-reading the ref", async () => {
    const reader = await resolveIslandCredentialReader({
      credential: credential(),
      ref: ref(),
    });
    expect(reader).not.toBeNull();
    expect(reader!.runId).toBe(GATE.runId);
    expect(reader!.reviewTaskId).toBe(GATE.reviewTaskId);
    expect(reader!.actorCtx.orgId).toBe(PAYLOAD.orgId);
    expect(reader!.actorCtx.actor.userId).toBe(PAYLOAD.userId);
  });

  it("carries the live org axes — a team-granted reader is not silently narrowed", async () => {
    const reader = await resolveIslandCredentialReader({
      credential: credential(),
      ref: ref(),
    });
    expect(reader!.actorCtx.roleHints?.teamIds).toEqual(["team-1"]);
    expect(reader!.actorCtx.roleHints?.orgRole).toBe("member");
  });

  it("cinatra#2674: carries the REAL platform tier — no floored axis on the island either", async () => {
    readUserIsPlatformAdmin.mockResolvedValue(true);
    const admin = await resolveIslandCredentialReader({ credential: credential(), ref: ref() });
    expect(admin!.actorCtx.roleHints?.platformRole).toBe("platform_admin");
    // NEGATIVE CONTROL — an ordinary member is not elevated.
    readUserIsPlatformAdmin.mockResolvedValue(false);
    const member = await resolveIslandCredentialReader({ credential: credential(), ref: ref() });
    expect(member!.actorCtx.roleHints?.platformRole).toBe("member");
  });
});

describe("REF BINDING — a credential for gate A cannot paint gate B", () => {
  it("REFUSES a genuine credential presented with ANOTHER gate's genuine ref", async () => {
    const otherRef = encodeLifecycleGateRef({ runId: "run-2", reviewTaskId: "task-2" })!;
    expect(
      await resolveIslandCredentialReader({ credential: credential(), ref: otherRef }),
    ).toBeNull();
    // NEGATIVE CONTROL — the same credential with its own ref resolves.
    expect(
      await resolveIslandCredentialReader({ credential: credential(), ref: ref() }),
    ).not.toBeNull();
  });

  it("REFUSES a missing, empty or undecodable ref", async () => {
    for (const bad of [null, undefined, "", "not-a-ref"]) {
      expect(
        await resolveIslandCredentialReader({ credential: credential(), ref: bad }),
      ).toBeNull();
    }
  });

  it("REFUSES a missing credential outright — the widget path never falls through", async () => {
    for (const bad of [null, undefined, ""]) {
      expect(await resolveIslandCredentialReader({ credential: bad, ref: ref() })).toBeNull();
    }
  });
});

describe("LIVE PRINCIPAL — the token row is the revocation handle", () => {
  it("REFUSES when the row is gone (signed out / swept)", async () => {
    setTokenRow(null);
    expect(
      await resolveIslandCredentialReader({ credential: credential(), ref: ref() }),
    ).toBeNull();
  });

  it("REFUSES an expired row, against the DATABASE clock", async () => {
    setTokenRow(tokenRow({ not_expired: false }));
    expect(
      await resolveIslandCredentialReader({ credential: credential(), ref: ref() }),
    ).toBeNull();
  });

  // cinatra#2684, adopted here at the 2026-08-13 rebase. THIS IS THE CASE THE
  // ORIGINAL SLICE DISCLOSED AND COULD NOT CLOSE: an ordinary Cinatra sign-out
  // did not touch the `cwu_` row, so a copied island URL kept painting for the
  // rest of its 120 seconds. The binding landed separately; the island consults
  // it, so the sign-out now stops the very next paint.
  it("REFUSES once the PARENT SIGN-IN is gone — a copied URL dies with the session", async () => {
    widgetAuthSessionIsLive.mockReturnValue(false); // the sign-out
    expect(
      await resolveIslandCredentialReader({ credential: credential(), ref: ref() }),
    ).toBeNull();
    // Asked about THIS row's session, not some ambient one.
    expect(widgetAuthSessionIsLive).toHaveBeenCalledWith("sess-1");
  });

  it("REFUSES a row that names NO parent session at all", async () => {
    // The predicate answers `dead` for an unbound row, and the island must not
    // treat "nobody recorded a session" as "the session is fine".
    widgetAuthSessionIsLive.mockImplementation((id: unknown) => Boolean(id));
    setTokenRow(tokenRow({ auth_session_id: null }));
    expect(
      await resolveIslandCredentialReader({ credential: credential(), ref: ref() }),
    ).toBeNull();
  });

  // The POSITIVE twin, so the two refusals above are not passing vacuously: the
  // same row with a live parent still resolves a reader.
  it("but the SAME row with a live parent still paints", async () => {
    widgetAuthSessionIsLive.mockReturnValue(true);
    expect(
      await resolveIslandCredentialReader({ credential: credential(), ref: ref() }),
    ).not.toBeNull();
  });

  it("REFUSES a token that does not carry the LIFECYCLE grant", async () => {
    // Audience without the lifecycle route…
    setTokenRow(tokenRow({ aud: WIDGET_BROKER_ROUTE_PATH }));
    expect(
      await resolveIslandCredentialReader({ credential: credential(), ref: ref() }),
    ).toBeNull();
    // …and scope without it.
    setTokenRow(tokenRow({ scope: AGENT_SCOPE }));
    expect(
      await resolveIslandCredentialReader({ credential: credential(), ref: ref() }),
    ).toBeNull();
    // NEGATIVE CONTROL — with both halves present it resolves.
    setTokenRow(tokenRow());
    expect(
      await resolveIslandCredentialReader({ credential: credential(), ref: ref() }),
    ).not.toBeNull();
  });

  it("REFUSES when a store read throws — a failure is never an admission", async () => {
    rows.mockImplementation(() => {
      throw new Error("db down");
    });
    expect(
      await resolveIslandCredentialReader({ credential: credential(), ref: ref() }),
    ).toBeNull();
  });
});

describe("LIVE SITE + SEALED BINDINGS", () => {
  it("REFUSES a revoked site", async () => {
    getActiveConnectSiteById.mockReturnValue(null);
    expect(
      await resolveIslandCredentialReader({ credential: credential(), ref: ref() }),
    ).toBeNull();
  });

  it("REFUSES a ROTATED credential generation — the rotation gate holds here too", async () => {
    getActiveConnectSiteById.mockReturnValue({ ...SITE_ROW, credentialVersion: 4 });
    expect(
      await resolveIslandCredentialReader({ credential: credential(), ref: ref() }),
    ).toBeNull();
  });

  it("REFUSES a site re-bound to another org or origin", async () => {
    getActiveConnectSiteById.mockReturnValue({ ...SITE_ROW, orgId: "org-B" });
    expect(
      await resolveIslandCredentialReader({ credential: credential(), ref: ref() }),
    ).toBeNull();
    getActiveConnectSiteById.mockReturnValue({
      ...SITE_ROW,
      widgetOrigin: "https://elsewhere.example",
    });
    expect(
      await resolveIslandCredentialReader({ credential: credential(), ref: ref() }),
    ).toBeNull();
  });

  it("REFUSES when ANY sealed binding has drifted from the live row", async () => {
    for (const drift of [
      { user_id: "someone-else" },
      { org_id: "org-B" },
      { site_id: "site-2" },
      { client: "drupal" },
      { instance_id: "inst-2" },
      { agent_slug: "drupal-content-editor" },
    ]) {
      setTokenRow(tokenRow(drift));
      expect(
        await resolveIslandCredentialReader({ credential: credential(), ref: ref() }),
      ).toBeNull();
    }
  });
});

describe("LIVE ORG STANDING", () => {
  it("REFUSES a principal who is no longer a member — orgRole IS the membership", async () => {
    resolveActorGrantsForUserInOrg.mockResolvedValue({ teamIds: [], projectGrants: [] });
    expect(
      await resolveIslandCredentialReader({ credential: credential(), ref: ref() }),
    ).toBeNull();
  });

  it("resolves standing in the TOKEN's org, never an active org from elsewhere", async () => {
    await resolveIslandCredentialReader({ credential: credential(), ref: ref() });
    expect(resolveActorGrantsForUserInOrg).toHaveBeenCalledWith(PAYLOAD.userId, PAYLOAD.orgId);
  });
});
