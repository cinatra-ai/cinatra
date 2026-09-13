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
    expect(SRC).toContain(
      "if (home) redirect(withCompletionReturn(home, readCompletionReturn(searchParams ?? null)));",
    );
    expect(SRC).not.toContain("\n    if (home) redirect(home);");
  });
});
