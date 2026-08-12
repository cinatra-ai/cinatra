// cinatra#2674 (epic #2564 S8e) — THE #2574 PARITY CRITERION, WITH NO FLOORED AXIS.
//
// The AC names four actor paths: "A platform-admin widget user retains
// `platform_admin` through the verified widget principal, direct widget MCP
// actor/request frame, carrier-run OBO actor, and assigned-skill actor."
//
// The read-surface leg lives in `lifecycle/__tests__/widget-lifecycle-actor-parity.test.ts`;
// the carrier-run and assigned-skill legs in `agent-run-actor-resolve.test.ts`.
// This file is the STRUCTURAL leg: it proves that no floor REMAINS anywhere on
// those paths — not by re-running each one, but by reading the source of every
// module that used to impose one and asserting the floor is gone and the tier is
// carried. A behavioural test proves one path today; this fails the moment
// anybody re-introduces a floor on any of them.
//
// It is deliberately a source-level assertion, in the manner of the epic's other
// structural bars (the degraded-actor bar, the no-decide bar). A floor is a
// SHAPE in the code — a hardcoded `member` on a widget path — and a shape is
// what this checks for.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "..", "..", rel), "utf8");
}

/** Strip comments so prose ABOUT the removed floor cannot satisfy or trip a
 *  check that is meant to be about code. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

describe("the widget MCP OBO token carries the tier", () => {
  const src = code(read("lib/widget-mcp-actor-token.ts"));

  it("MINTS the `prole` claim from a server-resolved input", () => {
    expect(src).toContain("platformRole?: WidgetMcpPlatformRole");
    expect(src).toContain('prole: "platform_admin"');
  });

  it("VERIFIES it to the real tier, and narrows on anything but the exact literal", () => {
    expect(src).toContain('payload.prole === "platform_admin" ? "platform_admin" : "member"');
  });

  it("no longer hard-codes the actor's tier", () => {
    expect(src).not.toContain('platformRole: "member",');
  });
});

describe("the MCP request frame accepts the tier", () => {
  const src = code(read("../packages/mcp-server/src/request-context.ts"));

  it("the widget delegation's platformRole is the two-value union, not the narrowed literal", () => {
    expect(src).toContain('platformRole: "platform_admin" | "member"');
    // The union-narrowed literal is what the floor looked like here.
    expect(src).not.toMatch(/platformRole:\s*"member";/);
  });
});

describe("the widget principal carries the tier", () => {
  const src = code(read("lib/assistant-runtime/widget-principal.ts"));

  it("declares it as a REQUIRED field, so no construction site can forget it", () => {
    expect(src).toMatch(/platformRole:\s*"platform_admin"\s*\|\s*"member";/);
  });
});

describe("the carrier-run resolver floors no tier", () => {
  const src = code(read("lib/agent-run-actor-resolve.ts"));

  it("the suppressed-source set is gone entirely", () => {
    expect(src).not.toContain("PLATFORM_ADMIN_SUPPRESSED_SOURCE_TYPES");
    expect(src).not.toContain("suppressPlatformAdmin");
  });
});

describe("the connector write authority has no widget-only refusal", () => {
  const src = code(read("lib/connector-instance-write-authority.ts"));

  it("the widget platform-admin deny is gone", () => {
    expect(src).not.toContain("platform_admin_on_public_widget");
    expect(src).not.toContain('sourceType === "public_site_widget" && actor.platformRole');
  });

  it("but the UNIVERSAL controls it sat beside are untouched", () => {
    // Removing the floor must not widen anything else — these are the controls
    // #2674 explicitly requires to survive.
    expect(src).toContain("platform_admin_without_org_membership");
    expect(src).toContain("member_without_org_membership");
    expect(src).toContain("org_membership_resolution_error");
    expect(src).toContain("instance_org_mismatch");
  });
});

// The actor's steps 2-3 — the live standing and the hint assembly — live in the
// LIVE-STANDING LEAF since cinatra#2577 split them out of the token door, so the
// property is asserted against BOTH files: the leaf, which is where the tier is
// now resolved and assembled, and the door, which re-exports it. Asserting only
// the door would pass on a file that no longer contains the assembly at all.
describe("the widget lifecycle actor resolves the tier live", () => {
  const leaf = code(read("lib/lifecycle/widget-lifecycle-frame-actor.ts"));
  const door = code(read("lib/lifecycle/widget-lifecycle-actor.ts"));

  it("the floor constant is gone and the default is a DEFAULT, not a ceiling", () => {
    expect(leaf).not.toContain("WIDGET_LIFECYCLE_PLATFORM_ROLE_FLOOR");
    expect(door).not.toContain("WIDGET_LIFECYCLE_PLATFORM_ROLE_FLOOR");
    expect(leaf).toContain("WIDGET_LIFECYCLE_DEFAULT_PLATFORM_ROLE");
    expect(leaf).toContain("input.platformRole ?? WIDGET_LIFECYCLE_DEFAULT_PLATFORM_ROLE");
  });

  it("the tier is READ, per reader, from the user record", () => {
    expect(leaf).toContain("readUserIsPlatformAdmin(input.userId)");
  });

  // The leaf is the ONE assembly BOTH widget entries go through — the token door
  // and the MCP-frame entry. Resolving the tier there rather than in the door is
  // what stops the two from carrying different tiers for the same person, so the
  // location is part of the property, not an implementation detail.
  it("BOTH widget entries reach that one assembly", () => {
    expect(door).toContain("resolveWidgetLifecycleStanding(");
    expect(leaf).toContain("resolveWidgetLifecycleStanding(");
    expect(leaf).toContain("resolveWidgetLifecycleActorForFrame(");
  });
});

describe("removing the floor did not widen anything else", () => {
  it("the closed widget tool policy is still the widget policy", () => {
    const src = code(read("../packages/mcp-server/src/request-context.ts"));
    expect(src).toContain('toolPolicyMode: "delegated-widget"');
    expect(src).toContain("widgetDelegationKind: delegatedActor.kind");
  });

  it("the OBO token still pins instance, kind, TTL and the turn nonce", () => {
    const src = code(read("lib/widget-mcp-actor-token.ts"));
    expect(src).toContain("if (!isNonBlankString(payload.inst)) return null;");
    expect(src).toContain("if (!isConnectorKind(payload.knd)) return null;");
    expect(src).toContain("if (!isNonBlankString(payload.jti)) return null;");
    expect(src).toContain("payload.exp - payload.iat !== TOKEN_TTL_SECONDS");
  });

  it("the user token still re-checks origin, agent, scope and site liveness", () => {
    const src = code(read("lib/widget-user-auth.ts"));
    expect(src).toContain('reason: "origin_mismatch"');
    expect(src).toContain('reason: "agent_mismatch"');
    expect(src).toContain('reason: "scope_mismatch"');
    expect(src).toContain('reason: "site_revoked"');
  });
});

// ---------------------------------------------------------------------------
// cinatra#2674, codex round 0 finding 5 — THE FLOORS THAT WERE LEFT BEHIND.
//
// Removing a floor in four places and leaving it in two others would have made
// the parity claim quietly false: a platform admin would have been 404'd out of
// an assistant they can select in the app, and refused a thread they can
// continue there. An UNDER-grant is still a divergence.
// ---------------------------------------------------------------------------
describe("the audience selector and the thread gate carry the tier too", () => {
  it("the widget audience caller reads the principal's tier, never a literal", () => {
    const src = code(read("lib/assistant-selector-audience.ts"));
    expect(src).toContain("platformRole: principal.platformRole");
    expect(src).not.toContain('platformRole: "member" }');
  });

  it("the widget thread gate derives isAdmin from the principal", () => {
    const src = code(read("app/api/assistants/chat/route.ts"));
    expect(src).toContain('isAdmin: widgetPrincipal.platformRole === "platform_admin"');
    expect(src).not.toContain("isAdmin: false,");
  });
});

// ---------------------------------------------------------------------------
// cinatra#2674, codex round 0 finding 2 — THE MEMBERSHIP CONTRACT SURVIVED.
//
// Removing the carrier-run suppression must not remove the live-membership
// check it was also, incidentally, providing on the widget path. The behavioural
// cases live in `agent-run-actor-resolve.test.ts`; this pins the shape.
// ---------------------------------------------------------------------------
describe("the widget carrier still requires a live membership row", () => {
  const src = code(read("lib/agent-run-actor-resolve.ts"));

  it("the admin short-circuit is skipped for the widget source type", () => {
    expect(src).toContain("const isWidgetCarrier = input.sourceType === WIDGET_SOURCE_TYPE;");
    expect(src).toContain("if (!isWidgetCarrier && rolesIncludeAdmin(userRow.role))");
  });

  it("and the real tier is carried AFTER the membership row is proven", () => {
    expect(src).toContain(
      'isWidgetCarrier && rolesIncludeAdmin(userRow.role) ? "platform_admin" : "member"',
    );
    expect(src).toContain("if (!memberRow) return null;");
  });
});
