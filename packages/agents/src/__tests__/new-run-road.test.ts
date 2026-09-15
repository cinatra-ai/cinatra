/**
 * cinatra#3358 — THE NEW-RUN ROAD.
 *
 * Two decisions of the generic `/agents/{vendor}/{packageName}/new` launcher,
 * pinned here because both were unreadable while they sat inline in the screen:
 *
 *   (1) A REFUSED launch is not a missing page. Measured on a development boot
 *       with both packages installed: the launcher asked the coordinator to
 *       create-and-trigger a run for a package whose required dependency had no
 *       canonical install record, the coordinator refused with its own
 *       actionable sentence, and the launcher rendered "404 — Page not found".
 *       The same road answered 200 for a package the coordinator accepted. So
 *       the outcome reader must keep a refusal a REFUSAL, carrying its sentence,
 *       for ANY package — no per-package branch exists here or anywhere above.
 *
 *   (2) The completion contract a new-run link carries — the offering step's
 *       name and the parked run's id — survives the launcher's redirect, so the
 *       run the launcher creates knows which run to return to.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// WHERE THE TWO DECISIONS LIVE, and why neither is a module of its own. The
// launcher's reading of the coordinator's answer belongs to the launcher's own
// screen, which already exports its decisions so they can be read and pinned;
// the completion contract is two query keys of the agent-path address and their
// readers, so it belongs to the agent-path grammar. Both files are already
// reached by every route that reaches the launcher, so the road gains its rules
// and the reachable module graph gains nothing.
import { newRunLaunchOutcome, NEW_RUN_REFUSAL_FALLBACK } from "../instance-screens";
import {
  readCompletionReturn,
  withCompletionReturn,
  newRunHrefWithCompletionReturn,
  agentPathScopeBase,
  buildAgentWorkspacePath,
  WORKSPACE_SCOPE_BASE,
  COMPLETION_RETURN_NAME_PARAM,
  COMPLETION_RETURN_RUN_PARAM,
} from "@/lib/agent-url";

describe("newRunLaunchOutcome — a refused launch is never a missing page (cinatra#3358)", () => {
  it("reads an accepted launch as the run it created", () => {
    expect(newRunLaunchOutcome({ ok: true, runId: "run-1" })).toEqual({
      kind: "created",
      runId: "run-1",
    });
  });

  it("keeps the coordinator's own refusal sentence instead of answering not-found", () => {
    const measured =
      "Agent cannot run: @cinatra-ai/list-curator-agent requires List Curation Skill " +
      "(@cinatra-ai/list-curation-skill), which is not installed. Install the missing " +
      "extension from the marketplace first.";
    expect(newRunLaunchOutcome({ ok: false, error: measured })).toEqual({
      kind: "refused",
      message: measured,
    });
  });

  it("refuses with the fallback sentence when the refusal carries no reason", () => {
    expect(newRunLaunchOutcome({ ok: false })).toEqual({
      kind: "refused",
      message: NEW_RUN_REFUSAL_FALLBACK,
    });
    expect(newRunLaunchOutcome({ ok: false, error: "   " })).toEqual({
      kind: "refused",
      message: NEW_RUN_REFUSAL_FALLBACK,
    });
    expect(newRunLaunchOutcome(null)).toEqual({
      kind: "refused",
      message: NEW_RUN_REFUSAL_FALLBACK,
    });
  });

  it("treats an accepted answer with no run id as a refusal, not as a created run", () => {
    expect(newRunLaunchOutcome({ ok: true, runId: "" } as { ok: true; runId: string })).toEqual({
      kind: "refused",
      message: NEW_RUN_REFUSAL_FALLBACK,
    });
  });
});

describe("the completion contract survives the launcher (cinatra#3358)", () => {
  it("reads both halves of the contract out of the screen's search params", () => {
    expect(
      readCompletionReturn({
        [COMPLETION_RETURN_NAME_PARAM]: "list-picker",
        [COMPLETION_RETURN_RUN_PARAM]: "parked-run-1",
      }),
    ).toEqual({ onComplete: "list-picker", returnRunId: "parked-run-1" });
  });

  it("recognizes no contract when either half is missing", () => {
    expect(readCompletionReturn({ [COMPLETION_RETURN_NAME_PARAM]: "list-picker" })).toBeNull();
    expect(readCompletionReturn({ [COMPLETION_RETURN_RUN_PARAM]: "parked-run-1" })).toBeNull();
    expect(readCompletionReturn({})).toBeNull();
    expect(readCompletionReturn(null)).toBeNull();
  });

  it("reads the first value when a param arrives repeated", () => {
    expect(
      readCompletionReturn({
        [COMPLETION_RETURN_NAME_PARAM]: ["list-picker", "other"],
        [COMPLETION_RETURN_RUN_PARAM]: ["parked-run-1"],
      }),
    ).toEqual({ onComplete: "list-picker", returnRunId: "parked-run-1" });
  });

  it("carries the contract onto the address the launcher redirects to", () => {
    expect(
      withCompletionReturn("/agents/cinatra-ai/list-curator-agent/child-run-9", {
        onComplete: "list-picker",
        returnRunId: "parked-run-1",
      }),
    ).toBe(
      "/agents/cinatra-ai/list-curator-agent/child-run-9" +
        "?onComplete=list-picker&onCompleteRunId=parked-run-1",
    );
  });

  it("preserves a query the redirect address already holds", () => {
    const out = withCompletionReturn("/agents/v/p/child-run-9?tab=run", {
      onComplete: "list-picker",
      returnRunId: "parked-run-1",
    });
    const q = new URLSearchParams(out.split("?", 2)[1]);
    expect(q.get("tab")).toBe("run");
    expect(q.get(COMPLETION_RETURN_NAME_PARAM)).toBe("list-picker");
    expect(q.get(COMPLETION_RETURN_RUN_PARAM)).toBe("parked-run-1");
  });

  it("leaves the address untouched when there is no contract to carry", () => {
    expect(withCompletionReturn("/agents/v/p/child-run-9", null)).toBe(
      "/agents/v/p/child-run-9",
    );
  });

  it("builds the offering step's link with the parked run in it", () => {
    expect(
      newRunHrefWithCompletionReturn(
        "/agents/cinatra-ai/list-curator-agent/new",
        "list-picker",
        "parked-run-1",
      ),
    ).toBe(
      "/agents/cinatra-ai/list-curator-agent/new" +
        "?onComplete=list-picker&onCompleteRunId=parked-run-1",
    );
  });

  it("offers the bare road when the step has no run identity in hand", () => {
    expect(
      newRunHrefWithCompletionReturn("/agents/cinatra-ai/list-curator-agent/new", "list-picker", null),
    ).toBe("/agents/cinatra-ai/list-curator-agent/new?onComplete=list-picker");
    expect(
      newRunHrefWithCompletionReturn("/agents/cinatra-ai/list-curator-agent/new", "list-picker", "  "),
    ).toBe("/agents/cinatra-ai/list-curator-agent/new?onComplete=list-picker");
  });

  it("drops a run id the address already carried when there is no identity now", () => {
    // Otherwise the bare road keeps a STALE return and points the reader at
    // another run entirely.
    expect(
      newRunHrefWithCompletionReturn(
        "/agents/cinatra-ai/list-curator-agent/new?onCompleteRunId=some-other-run",
        "list-picker",
        null,
      ),
    ).toBe("/agents/cinatra-ai/list-curator-agent/new?onComplete=list-picker");
  });

  it("the canonical-home redirect carries the contract instead of dropping it", () => {
    // An anchored run opened at its bare address is redirected to its vantage's
    // address BEFORE the return is resolved, so a redirect built without the two
    // query keys would land the reader on a page that can no longer offer the way
    // back. Read off the screen's own source: the redirect is a thrown control
    // transfer inside a server component and cannot be exercised here.
    const SRC = readFileSync(
      fileURLToPath(new URL("../instance-screens.tsx", import.meta.url)),
      "utf8",
    );
    // THE SPELLING MOVED, THE RULE DID NOT (convergence round, cinatra#3448).
    // The redirect now carries a THIRD key — what the finished run produced for
    // the parked step — so it is no longer one line. This pin therefore reads
    // the composition rather than the line: the redirect is built from the
    // contract's writer and never from the bare home.
    const redirectAt = SRC.indexOf("if (home)");
    expect(redirectAt, "the canonical-home redirect is gone").toBeGreaterThan(-1);
    const redirectText = SRC.slice(redirectAt, redirectAt + 600);
    expect(redirectText).toContain("withCompletionReturn(home");
    expect(redirectText).toContain("readCompletionReturn(searchParams ?? null)");
    expect(SRC).not.toContain("\n    if (home) redirect(home);");
  });
});

// ---------------------------------------------------------------------------
// THE LAUNCHER LIVES BELOW A SCOPE BASE (cinatra#2809, per-scope surfaces S3).
//
// MEASURED on a development boot with both packages installed, one session,
// both orders, twice:
//
//   GET /agents/cinatra-ai/list-curator-agent/new?onComplete=list-picker&onCompleteRunId=RUN-ID
//     -> HTTP/1.1 200 OK, no Location, no run created; the page draws the app
//        chrome and the crumb "Agents / New" and nothing else. The bare
//        vendor/package pair carries only `[instanceId]`, so `new` is read as an
//        instance id and the launcher never runs.
//
//   GET /workspace/agents/cinatra-ai/list-curator-agent/new?onComplete=list-picker&onCompleteRunId=RUN-ID
//     -> HTTP/1.1 307 Temporary Redirect
//        location: /workspace/agents/cinatra-ai/list-curator-agent/<fresh run id>?onComplete=list-picker&onCompleteRunId=RUN-ID
//
// So the road a parked step offers is addressed at a SCOPE, which is what the
// resolver in `src/lib/scoped-launch-route.ts` answers to; the scope is the one
// the PARKED RUN itself belongs to, read off its own address. The rule belongs
// to the agent-path grammar beside the rest of the address, and it adds no
// module to any tracked route graph.
// ---------------------------------------------------------------------------
describe("agentPathScopeBase — the scope a parked run's address belongs to (cinatra#2809)", () => {
  it("reads the base each scope's own agent address carries", () => {
    expect(agentPathScopeBase("/workspace/agents/cinatra-ai/outreach-agent/run-1")).toBe("/workspace");
    expect(agentPathScopeBase("/personal/agents/cinatra-ai/outreach-agent/run-1")).toBe("/personal");
    expect(agentPathScopeBase("/organizations/org-7/agents/cinatra-ai/outreach-agent/run-1")).toBe(
      "/organizations/org-7",
    );
    expect(agentPathScopeBase("/teams/t3/agents/cinatra-ai/outreach-agent/run-1")).toBe("/teams/t3");
    expect(agentPathScopeBase("/projects/p9/agents/cinatra-ai/outreach-agent/run-1")).toBe("/projects/p9");
  });

  it("keeps the deeper sub-routes of a run's own address out of the base", () => {
    expect(agentPathScopeBase("/teams/t3/agents/cinatra-ai/outreach-agent/run-1/results")).toBe("/teams/t3");
  });

  it("falls back to the workspace base where the address carries no scope", () => {
    // The bare tree is the measured dead end above: it has no launcher at all,
    // so a step parked there must still offer an address that answers. The
    // workspace is the scope the product's own Agents surface belongs to.
    expect(agentPathScopeBase("/agents/cinatra-ai/outreach-agent/run-1")).toBe(WORKSPACE_SCOPE_BASE);
    expect(agentPathScopeBase("")).toBe(WORKSPACE_SCOPE_BASE);
    expect(agentPathScopeBase("/chat")).toBe(WORKSPACE_SCOPE_BASE);
    expect(agentPathScopeBase("/agentsomething/else")).toBe(WORKSPACE_SCOPE_BASE);
  });

  it("builds the launcher below that base — the address the boot answered 307 on", () => {
    expect(
      buildAgentWorkspacePath("@cinatra-ai/list-curator-agent", {
        scopeBase: agentPathScopeBase("/workspace/agents/cinatra-ai/outreach-agent/run-1"),
      }),
    ).toBe("/workspace/agents/cinatra-ai/list-curator-agent/new");
  });
});
