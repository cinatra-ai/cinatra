/**
 * Source-text conformance for the lifecycle policy + gate-volume SURFACES
 * (cinatra#2047 defect D-3 + row 9).
 *
 * These are the wiring facts the defect turns on, and each one is a thing a
 * future edit could silently undo: the console tab exists and is reachable, the
 * write path is authorized where it is EXECUTED (not merely where it is
 * rendered), the org is never taken from the client, the volume surface is
 * reviewer-reachable rather than admin-only, and the queue never grows a decision
 * affordance. The repo runs vitest in a node environment for `src/**`, so
 * server-component wiring is pinned by source assertion — the established pattern
 * (see ../../__tests__/surface-conformance.test.ts).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel: string) => existsSync(path.join(ROOT, rel));

const CONSOLE_PAGE = "src/app/configuration/artifacts/page.tsx";
const ACTIONS = "src/app/configuration/artifacts/review-policy-actions.ts";
const TAB = "src/components/artifacts/console/review-policy-tab.tsx";
const EDITOR = "src/components/artifacts/console/review-policy-editor.tsx";
const PANEL = "src/components/artifacts/console/gate-volume-panel.tsx";
const REVIEWS_PAGE = "src/app/agents/reviews/page.tsx";

describe("D-3 — the org policy WRITE path exists and reaches production", () => {
  it("the store's writers now have a production caller (the whole point of the defect)", () => {
    const actions = read(ACTIONS);
    expect(actions).toMatch(/"use server"/);
    expect(actions).toMatch(/upsertLifecyclePolicyRule/);
    expect(actions).toMatch(/deleteLifecyclePolicyRule/);
    expect(actions).toMatch(/@cinatra-ai\/agents\/lifecycle-policy-store/);
  });

  it("BOTH writers are authorized where they EXECUTE, not merely where they render", () => {
    const actions = read(ACTIONS);
    // Two actions, two independent gates — a UI that hides the form is not a gate.
    const gates = actions.match(/resolvePolicyBoundWriteAccess\(\)/g) ?? [];
    expect(gates.length).toBe(2);
    // Each write is preceded by its refusal branch.
    const refusals = actions.match(/if \(!access\.ok\) \{/g) ?? [];
    expect(refusals.length).toBe(2);
    expect(actions).toMatch(/status: "error", message: lifecycleAccessMessage\(access\.reason\)/);
  });

  it("the org is taken from the SESSION — a client-supplied org field is ignored", () => {
    const actions = read(ACTIONS);
    expect(actions).toMatch(/orgId: access\.orgId/);
    // The form parser reads only the lattice-key fields; no org is read at all.
    expect(actions).not.toMatch(/formData\.get\("org/);
  });

  it("the FULL lattice key is carried through the write (exact-beats-* is expressible)", () => {
    const actions = read(ACTIONS);
    for (const field of ["checkpoint", "artifactType", "destinationClass", "originKind"]) {
      expect(actions).toMatch(new RegExp(`formData\\.get\\("${field}"\\)`));
    }
    const editor = read(EDITOR);
    for (const field of ["checkpoint", "artifactType", "destinationClass", "originKind", "bound"]) {
      expect(editor).toMatch(new RegExp(`name="${field}"`));
    }
    // The wildcard is offered, and its precedence is stated on the surface.
    expect(editor).toMatch(/defaultValue="\*"/);
    expect(editor).toMatch(/exact artifact type beats/i);
  });

  it("input is validated against the lattice's own vocabulary before it reaches the table", () => {
    expect(read(ACTIONS)).toMatch(/parsePolicyBoundInput|parsePolicyKeyInput/);
  });
});

describe("the authorization gate is the platform's, not a local copy", () => {
  const ACCESS = "src/lib/artifacts/lifecycle-policy-access.ts";

  it("uses the shared kernel + the shared platform-admin predicate", () => {
    const access = read(ACCESS);
    expect(access).toMatch(/import \{ canDo \} from "@\/lib\/authz\/enforce"/);
    expect(access).toMatch(/isPlatformAdmin/);
    expect(access).toMatch(/from "@\/lib\/auth-session"/);
    // No hand-rolled role parsing / permission table beside the kernel's.
    expect(access).not.toMatch(/DIRECT_GRANTS|roleHasPermission/);
    expect(access).not.toMatch(/\.split\(","\)/);
  });

  it("requires a RESOLVED membership before it trusts the kernel's member floor", () => {
    const access = read(ACCESS);
    expect(access).toMatch(/if \(!opts\.orgRole && !isPlatformAdmin\(session\)\)/);
  });
});

describe("D-3 — the admin console surfaces the tab", () => {
  it("the Review policy tab is registered and dispatched on the console", () => {
    const page = read(CONSOLE_PAGE);
    expect(page).toMatch(/value: "review-policy", label: "Review policy"/);
    expect(page).toMatch(/tab === "review-policy" \? \(\s*<ReviewPolicyTab \/>/);
  });

  it("the Configuration index links to it (the tab is reachable, not orphaned)", () => {
    expect(read("src/app/configuration/page.tsx")).toMatch(
      /href: "\/configuration\/artifacts\?tab=review-policy"/,
    );
  });

  it("the tab resolves its OWN permissions rather than inheriting the page's admin gate", () => {
    const tab = read(TAB);
    expect(tab).toMatch(/resolveGateVolumeReadAccess/);
    expect(tab).toMatch(/resolvePolicyBoundWriteAccess/);
    // A read-only viewer gets the listing with no form, never a broken write.
    expect(tab).toMatch(/canWrite=\{writeAccess\.ok\}/);
  });
});

describe("row 9 — gate volume is visible to a REVIEWER, not only an admin", () => {
  it("the reviewer's queue page exists at /agents/reviews", () => {
    expect(exists(REVIEWS_PAGE)).toBe(true);
    const page = read(REVIEWS_PAGE);
    expect(page).toMatch(/readOrgReviewGateVolume/);
    expect(page).toMatch(/GateVolumePanel/);
  });

  it("it is NOT admin-gated — a plain member reviewer can reach it", () => {
    const page = read(REVIEWS_PAGE);
    expect(page).not.toMatch(/requireAdminSession/);
    expect(page).not.toMatch(/isPlatformAdmin/);
    expect(page).toMatch(/resolveGateVolumeReadAccess/);
  });

  it("the LISTING is re-checked against run access before it names any run", () => {
    const page = read(REVIEWS_PAGE);
    expect(page).toMatch(/enforceReviewRunAccess\(row\.runId, actor, "read", roleHints\)/);
    // Fail-closed: an unresolvable actor or a thrown check drops the row.
    expect(page).toMatch(/if \(!session \|\| !kernel\) return \[\];/);
    expect(page).toMatch(/catch \{\s*return false;/);
    // The rendered listing is the FILTERED set, never the raw read.
    expect(page).toMatch(/openGates: visible/);
  });

  it("it is navigation + volume only — it ships NO decision affordance", () => {
    const page = read(REVIEWS_PAGE);
    const panel = read(PANEL);
    for (const banned of [/commitReviewDecision/, /submitReviewDecision/, /Approve</, /Reject</]) {
      expect(page).not.toMatch(banned);
      expect(panel).not.toMatch(banned);
    }
  });

  it("ONE rollup serves both audiences — the panel is mounted by both surfaces", () => {
    for (const rel of [TAB, REVIEWS_PAGE]) {
      expect(read(rel)).toMatch(/GateVolumePanel/);
    }
    // The admin mount answers "is this survivable?" (rollup only); the reviewer
    // mount also lists the backlog head.
    expect(read(TAB)).toMatch(/showListing=\{false\}/);
    expect(read(REVIEWS_PAGE)).not.toMatch(/showListing/);
  });

  it("the rollup is cut along the POLICY KEY's own axes (that is what makes it tunable)", () => {
    const panel = read(PANEL);
    expect(panel).toMatch(/byArtifactType/);
    expect(panel).toMatch(/byDestinationClass/);
    expect(panel).toMatch(/byOriginKind/);
  });
});

describe("row 9 — the review deep-link keeps the run-embedded route's shape", () => {
  it("builds the five-segment /agents/{vendor}/{pkg}/{runId}/review/{taskId} path", async () => {
    const { gateReviewHref } = await import("../gate-volume-panel");
    expect(gateReviewHref("run-1", "task-1", "@cinatra-ai/blog-draft-writer-agent")).toBe(
      "/agents/cinatra-ai/blog-draft-writer-agent/run-1/review/task-1",
    );
  });

  it("degrades to placeholder segments (never a shorter, 404-ing path) for an orphan run", async () => {
    const { gateReviewHref } = await import("../gate-volume-panel");
    const href = gateReviewHref("run-2", "task-2", null);
    expect(href).toBe("/agents/unknown/unknown/run-2/review/task-2");
    // The page keys ONLY on the run id, so the five-segment shape must survive.
    expect(href.split("/").filter(Boolean)).toHaveLength(6);
  });

  it("encodes ids that would otherwise break the path", async () => {
    const { gateReviewHref } = await import("../gate-volume-panel");
    expect(gateReviewHref("lifecycle-orphan:abc", "auto/review", null)).toBe(
      "/agents/unknown/unknown/lifecycle-orphan%3Aabc/review/auto%2Freview",
    );
  });
});
