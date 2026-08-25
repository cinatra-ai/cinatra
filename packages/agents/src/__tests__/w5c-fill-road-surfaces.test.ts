// THE FIVE WINDOWS AFTER W5C (cinatra#2934, lifecycle-b W5c).
//
// Acceptance items 2 and 3, and the two invariants of the new road:
//
//   · "The retired route, its four callers and the direct-submit path are gone
//     with their tests."
//   · "Attachments beside a message reach the waiting run; a half-typed message
//     survives a reload in every window that keeps one today."
//
// STRUCTURAL, and deliberately so: what these cases pin is that no surface has a
// second road any more. A rendering test can show one screen behaving; only
// reading all five can show that none of them kept a private path — and a
// private path is exactly the defect the plan's one road removes.

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(join(REPO, rel), "utf8");

/** The five windows the plan names, and the file each one lives in. */
const WINDOWS: ReadonlyArray<{ surface: string; file: string }> = [
  { surface: "run-page", file: "packages/agents/src/agentic-run-panel.tsx" },
  { surface: "step-by-step", file: "packages/agents/src/orchestrator-stepper-panel.tsx" },
  { surface: "schedule", file: "packages/agents/src/trigger-screen-client.tsx" },
  // THE ARMED SCHEDULE'S WINDOW MOVED FILE (cinatra#3004): the Trigger tab
  // that used to draw it is retired, and `SchedulePromptWindow` is the one
  // component both of its hosts mount. Same window, same reading, same rule.
  { surface: "armed-trigger", file: "packages/agents/src/schedule-prompt-window.tsx" },
  {
    surface: "review",
    file: "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-prompt-window.tsx",
  },
];

// ---------------------------------------------------------------------------
// AC2 — the retired route, its four callers and the direct submit are gone.
// ---------------------------------------------------------------------------
describe("the field-assist route and its four callers are gone", () => {
  it("the route file itself no longer exists", () => {
    expect(
      existsSync(join(REPO, "src/app/api/agents/builder/[templateId]/hitl-assist/route.ts")),
    ).toBe(false);
  });

  it("its tests are gone with it", () => {
    expect(existsSync(join(REPO, "src/__tests__/hitl-assist-actor-context.test.ts"))).toBe(false);
    expect(existsSync(join(REPO, "src/__tests__/hitl-assist-multi-turn.test.ts"))).toBe(false);
  });

  it("no window posts to it any more", () => {
    for (const w of WINDOWS) {
      // The hyphenated name is the ROUTE. The underscored `cinatra_hitl_assist_*`
      // draft keys deliberately keep their spelling — renaming them would throw
      // away every reader s half-typed message.
      expect(read(w.file), `${w.surface} still names the field-assist route`).not.toContain(
        "hitl-assist",
      );
    }
  });

  it("the review page's typed sentence is no longer filed by the page", () => {
    const src = read(WINDOWS[4]!.file);
    // The direct submit is gone: no disposition is composed here at all.
    expect(src).not.toContain('disposition: "comment"');
    expect(src).not.toContain("submitAction");
    // And the page no longer takes the action as a prop.
    // The DECISION BAR keeps the action — its three buttons are untouched. What
    // must not carry one any more is the WINDOW.
    const page = read(
      "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/page.tsx",
    );
    const mount = page.slice(page.indexOf("<ReviewPromptWindow"));
    expect(mount.slice(0, mount.indexOf("/>"))).not.toContain("submitAction");
    expect(page).toContain("submitAction={submitAction}");
  });

  it("the chat page's own gate readers are gone with their skill call", () => {
    const chat = read("packages/chat/src/chat-page.tsx");
    expect(chat).not.toContain("classifyPromptForGate(");
    expect(chat).not.toContain("extractHitlGateValuesAction(");
    expect(chat).not.toContain("resolveComposerRouting(");
    const actions = read("packages/chat/src/actions.ts");
    expect(actions).not.toContain("export async function extractHitlGateValuesAction");
    expect(actions).not.toContain("runDeterministicLlmTask");
  });
});

// ---------------------------------------------------------------------------
// The FILL ROAD replaced them, on every surface that has a form.
// ---------------------------------------------------------------------------
describe("the fill road is what fills the fields now", () => {
  it("each form window writes the turn's own fill into its own fields", () => {
    for (const file of [
      "packages/agents/src/agentic-run-panel.tsx",
      "packages/agents/src/orchestrator-stepper-panel.tsx",
      "packages/agents/src/trigger-screen-client.tsx",
    ]) {
      const src = read(file);
      expect(src, file).toContain("await runWindow.send(");
      expect(src, file).toContain("effect.fill");
    }
  });

  it("the fill primitive is named in both delegated tool policies and carved out once", () => {
    expect(read("packages/mcp-server/src/delegated-chat-tool-policy.ts")).toContain(
      '"lifecycle_bound_screen_fill"',
    );
    expect(read("packages/mcp-server/src/delegated-widget-tool-policy.ts")).toContain(
      '"lifecycle_bound_screen_fill"',
    );
    const carve = read("src/lib/authz/carve-out.ts");
    expect(carve.split('"lifecycle_bound_screen_fill"').length - 1).toBe(1);
  });

  it("it is registered on the platform's own tool server, beside the lent action", () => {
    const server = read("src/lib/mcp-server.ts");
    expect(server).toContain("createBoundScreenFillMcpModule()");
  });
});

// ---------------------------------------------------------------------------
// A HALF-TYPED MESSAGE SURVIVES A RELOAD — in every window that keeps one.
// ---------------------------------------------------------------------------
describe("drafts survive a reload in every window", () => {
  it("all five windows give the field a persistence key", () => {
    for (const w of WINDOWS) {
      expect(read(w.file), `${w.surface} lost its draft key`).toMatch(/storageKey[=:]/);
    }
  });

  it("the panel hands that key to the field that persists it", () => {
    const panel = read("packages/agents/src/hitl-conversation-panel.tsx");
    expect(panel).toContain("storageKey={storageKey}");
  });

  it("and the field really writes and re-reads it", () => {
    const field = read("packages/sdk-ui/src/prompt-field.tsx");
    expect(field).toContain("localStorage");
  });
});

// ---------------------------------------------------------------------------
// ATTACHMENTS REACH THE WAITING RUN — by both roads.
// ---------------------------------------------------------------------------
describe("a file attached beside a message still reaches the run", () => {
  it("the two windows that offer a paperclip still offer it", () => {
    expect(read("packages/agents/src/agentic-run-panel.tsx")).toContain("enableAttachments=");
    expect(read("packages/agents/src/orchestrator-stepper-panel.tsx")).toContain(
      "enableAttachments=",
    );
  });

  it("they keep them for their own Continue AND send them with the message", () => {
    for (const file of [
      "packages/agents/src/agentic-run-panel.tsx",
      "packages/agents/src/orchestrator-stepper-panel.tsx",
    ]) {
      const src = read(file);
      // The browser's own press keeps working exactly as before.
      expect(src, file).toContain("pendingAttachmentsRef.current = [");
      // And the new road carries them too, so a submit the person ASKS for does
      // not leave them behind.
      expect(src, file).toMatch(/runWindow\.send\(\s*\n?\s*prompt,/);
    }
  });

  it("the turn records them on the person's own row, and the submit reads them back", () => {
    expect(read("src/lib/lifecycle/run-window-turn.ts")).toContain("attachments: input.attachments");
    // And the press reads back THIS MESSAGEs files, never the runs newest.
    expect(read("src/lib/lifecycle/lent-action-mcp.ts")).toContain(
      "readRunWindowAttachmentsForMessage",
    );
  });
});

// ---------------------------------------------------------------------------
// THE WINDOW IS THE SCREEN'S — the server binds it, the page claims nothing.
// ---------------------------------------------------------------------------
describe("the four form windows are bound to the run's own waiting screen", () => {
  it("the turn names the run and the server mints the screen's ref", () => {
    const turn = read("src/lib/lifecycle/run-window-turn.ts");
    expect(turn).toContain('input.surface === "review" ? [] : [input.runId]');
    const binding = read("src/lib/lifecycle/bound-card-binding.ts");
    expect(binding).toContain("mintParkedScreenRef");
    // The review-redirect moment is a REVIEW card and is never bound as a screen.
    expect(binding).toContain("ARTIFACT_REVIEW_REDIRECT_RENDERER_ID");
  });

  it("the chat page names the run its composer sits under", () => {
    const chat = read("packages/chat/src/chat-page.tsx");
    expect(chat).toContain("screenRunIds");
    expect(chat).toContain("getLatestOpenGate()");
  });
});
