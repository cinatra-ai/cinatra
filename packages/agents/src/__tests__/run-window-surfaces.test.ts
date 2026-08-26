// THE FIVE WINDOWS ARE ONE WINDOW (cinatra#2933, lifecycle-b W5b).
//
// AC1 asks for the exchange "on each of the five windows"; AC3 asks that "a
// person without respond access never sees the box"; the plan asks for one
// implementation, not five ("no window anywhere reads, re-routes, answers or
// refuses a message before the assistant sees it"), and for the copy to come
// from the ratified drawing rather than from a slice's imagination.
//
// WHAT THIS SUITE MAY CLAIM, AND WHAT IT MAY NOT.
//
// It reads SOURCE. That is the right instrument for a structural claim — which
// surface each window declares, that every window goes through the one
// controller and the one server bridge, that no window carries a placeholder
// string of its own, that the chat mount opens no second conversation. A render
// could not tell a second copy of the controller from the shared one.
//
// It is the WRONG instrument for "the window is there", and saying so is not a
// theory: this suite reported green on a run page that drew no window at all.
// Every string it looked for was present in `agentic-run-panel.tsx` — the
// surface, the controller, the access gate — and what was missing was a prop at
// the mount, which no string in that file could show. The run page's window was
// simply not on the screen.
//
// So "is it drawn, and is it drawn only for a person the run would answer" is
// now asserted against real DOM, and this suite no longer restates it:
//
//   * `run-window-surfaces.render.test.tsx` (this directory) mounts the run
//     page, the step-by-step screen, the schedule screen and the armed-trigger
//     tab, and reads AC1 and AC3 off the rendered document;
//   * `run-page-window-render.test.tsx` (this directory) mounts the run page's
//     PRODUCTION path — `SetupCompletionWatcher`, the way `instance-screens.tsx`
//     mounts it — with the props the page really passes;
//   * `src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/`
//     `__tests__/review-prompt-window.render.test.tsx` does the same for the
//     fifth window, under the root suite that resolves the host app.
//
// The one claim about drawing that stays here is the one no render can reach:
// `instance-screens.tsx` is an async server component that reads the database,
// so the fact that it hands BOTH values to all five of its windows is checked in
// its source.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const WINDOWS: Array<{ name: string; file: string; surface: string }> = [
  { name: "the run page", file: "packages/agents/src/agentic-run-panel.tsx", surface: "run-page" },
  { name: "the step-by-step screen", file: "packages/agents/src/orchestrator-stepper-panel.tsx", surface: "step-by-step" },
  { name: "the schedule screen", file: "packages/agents/src/trigger-screen-client.tsx", surface: "schedule" },
  // THE ARMED SCHEDULE'S WINDOW MOVED, AND STAYED ONE WINDOW (cinatra#3004).
  // The Trigger tab that used to draw it is retired; `SchedulePromptWindow` is
  // the one component both of its hosts — the run detail's schedule step and
  // the run's schedule tab — now mount, so the same armed schedule is asked
  // about through the same exchange however the reader reached it.
  { name: "the armed schedule's window", file: "packages/agents/src/schedule-prompt-window.tsx", surface: "armed-trigger" },
  {
    name: "the review page",
    file: "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-prompt-window.tsx",
    surface: "review",
  },
];

describe("each of the five windows outside the chat is a per-run conversation", () => {
  for (const w of WINDOWS) {
    it(`${w.name} opens the run's conversation as "${w.surface}"`, () => {
      const src = read(w.file);
      expect(src).toContain("useRunWindowConversation");
      expect(src).toContain(`surface: "${w.surface}"`);
      // The panel is fed the STORE's entries, never a local transcript.
      expect(src).toContain("conversation={");
      expect(src).toMatch(/conversation=\{\[?\.\.\.?runWindow\.entries|conversation=\{runWindow\.entries/);
    });

    // cinatra#3016 — THE MOUNT NAMES ITS RUN. The frame the assistant is handed
    // is built in the one road from the run the window declares, so a window
    // that opens the controller without a run is a window whose assistant
    // cannot know what it sits under — which is exactly the defect the real-run
    // pictures caught on two of these five screens.
    it(`${w.name} gives the controller the run it sits under`, () => {
      const src = read(w.file);
      const call = src.slice(src.indexOf("useRunWindowConversation({"));
      // COMMENTS STRIPPED FIRST: a mention of the word in a note above the call
      // is not an argument, and this claim is about the argument. What is
      // asserted is exactly what source can carry — the controller is opened
      // with a `runId` PROPERTY.
      //
      // WHERE THE VALUE'S PROVENANCE IS CHECKED INSTEAD, because this line
      // cannot check it: the screen that mounts these windows resolves the run
      // once and hands the SAME id to every one of them, which is asserted two
      // cases below ("the screen hands BOTH values to every window it mounts");
      // and that a window is drawn at all is read off real DOM by the render
      // suites named at the top of this file.
      const args = call
        .slice(0, call.indexOf(`surface: "${w.surface}"`))
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      expect(args).toMatch(/\brunId\b\s*[,:]/);
    });

    it(`${w.name} holds no window transcript of its own`, () => {
      const src = read(w.file);
      // The exchange is the run's. No window keeps a parallel copy it could
      // show instead — the one thing a window may still hold locally is the
      // PLATFORM's own outcome line on the review page, which is not the
      // conversation and is named as such where it lives.
      expect(src).not.toContain("setConversation");
      expect(src).not.toMatch(/const \[conversation, /);
    });

    it(`${w.name} states no placeholder of its own`, () => {
      const src = read(w.file);
      // The ratified drawing (design fe2182547d4a, app-artifact-review.html §IX)
      // fixes ONE placeholder for this window and says "nothing about it moves".
      // A per-surface WORDING has no drawing, so no window invents one: the
      // mechanism is shipped, the copy is the drawing's.
      expect(src).not.toContain('placeholder="');
      expect(src).not.toContain("placeholder={");
    });
  }

  it("names all five surfaces, and only those five", () => {
    const store = read("packages/agents/src/run-window-conversation-store.ts");
    for (const w of WINDOWS) expect(store).toContain(`"${w.surface}"`);
    const listed = store
      .slice(store.indexOf("RUN_WINDOW_SURFACES = ["), store.indexOf("] as const"))
      .match(/"[a-z-]+"/g);
    expect(listed).toHaveLength(5);
  });
});

describe("the window is drawn only for a person the run would answer", () => {
  // The four per-window guards that used to be matched here as strings are now
  // read off the rendered DOM by `run-window-surfaces.render.test.tsx`, which
  // mounts each window twice and requires the two answers to DIFFER — a window
  // that draws no box at all can no longer pass the refusal reading.

  it("the retired Trigger tab took no second window with it", () => {
    // The tab's own file is gone (cinatra#3004). What must NOT have gone with
    // it is the armed schedule's window: it is one of the five, and it is now
    // drawn by `SchedulePromptWindow` for both of that schedule's hosts.
    expect(() => read("packages/agents/src/trigger-tab-client.tsx")).toThrow();
    const win = read("packages/agents/src/schedule-prompt-window.tsx");
    expect(win).toContain('surface: "armed-trigger"');
    expect(win).toContain("canRespondInWindow !== false");
  });

  it("the schedule screen no longer hides its box behind the platform tier", () => {
    const src = read("packages/agents/src/trigger-screen-client.tsx");
    // It used to read `props.isAdmin !== false` on the window's own visibility.
    expect(src).not.toContain("props.isAdmin !== false");
  });

  it("the run's own access answer is resolved on the server, once", () => {
    const screens = read("packages/agents/src/instance-screens.tsx");
    expect(screens).toContain("canRespondInRunWindow(run.id)");
  });

  it("the screen hands BOTH values to every window it mounts — five, not four", () => {
    // THE DEFECT THIS PINS, so it cannot come back.
    //
    // The run page's window is drawn by AgenticRunPanel, whose only production
    // mount outside the chat is SetupCompletionWatcher. That mount was given
    // NEITHER value: no `templateId`, so the panel's box was gated false on
    // every real run and no window was ever drawn; and no `canRespondInWindow`,
    // so had one been drawn its access gate would have read the panel's
    // "absent ⇒ shown" default instead of the run's answer.
    //
    // Both are counted, and both counts are FIVE, because the two travel
    // together: a window addressed to a template nobody may answer in is the
    // thing AC3 forbids, and a window with access but no template cannot be
    // drawn at all.
    const screens = read("packages/agents/src/instance-screens.tsx");
    // SIX passes for FIVE windows: the armed schedule's window has two hosts on
    // this screen — the run detail's schedule step and the run's schedule tab —
    // and both mount the SAME component for the SAME run, which is why they
    // read as one exchange (cinatra#3004). Every other window has one host.
    const accessPasses = screens.match(/canRespondInWindow=\{canRespondInWindow\}/g) ?? [];
    expect(accessPasses).toHaveLength(6);
    // The template travels under two prop names because the schedule's hosts
    // name it for the window they compose rather than for themselves.
    const templatePasses = screens.match(/templateId=\{template\.id\}/g) ?? [];
    const scheduleWindowPasses =
      screens.match(/promptWindowTemplateId=\{template\.id\}/g) ?? [];
    expect(templatePasses).toHaveLength(4);
    expect(scheduleWindowPasses).toHaveLength(2);
  });

  it("the two values are on the RUN PAGE'S OWN mount, not merely somewhere in the file", () => {
    // A COUNT ALONE WOULD NOT HAVE CAUGHT THIS. The screen already passed both
    // values five times over before the fix — just never at the watcher — so a
    // total says nothing about which mount got them. This reads the
    // SetupCompletionWatcher element itself and requires both inside it.
    const screens = read("packages/agents/src/instance-screens.tsx");
    const open = screens.indexOf("<SetupCompletionWatcher");
    expect(open).toBeGreaterThan(-1);
    const close = screens.indexOf("/>", open);
    expect(close).toBeGreaterThan(open);
    const mount = screens.slice(open, close);
    expect(mount).toContain("templateId={template.id}");
    expect(mount).toContain("canRespondInWindow={canRespondInWindow}");
  });

  it("the run page's panel can be given a template at all", () => {
    // The prop's ABSENCE from the watcher was the mechanical cause: the page
    // had nowhere to put the id even had it tried.
    const watcher = read("packages/agents/src/setup-completion-watcher.tsx");
    expect(watcher).toContain("templateId?: string;");
    expect(watcher).toContain("templateId={templateId}");
  });

  it("the field-assist route asks the run, not the platform tier, when a run is named", () => {
    const route = read("src/app/api/agents/builder/[templateId]/hitl-assist/route.ts");
    expect(route).toContain("canRespondInRunWindow(runId, templateId)");
    // The administrator check survives ONLY for the pre-run screen that has no
    // run to ask.
    expect(route).toContain("requireAdminSession()");
    // The LAST occurrence is the call itself; the earlier ones are the import
    // and the comment that explains what it replaced.
    const adminIdx = route.lastIndexOf("requireAdminSession()");
    expect(route.slice(0, adminIdx)).toContain("if (runId) {");
  });
});

describe("a window that is a second view of a run a thread already shows hands off", () => {
  it("the chat mount opens no window at all", () => {
    const src = read("packages/agents/src/agentic-run-panel.tsx");
    expect(src).toContain('surface !== "chat" &&');
  });
});

describe("the window's copy is the ratified drawing's", () => {
  it("lives in ONE place, as the default of the shared panel's prop", () => {
    const panel = read("packages/agents/src/hitl-conversation-panel.tsx");
    expect(panel).toContain(
      'export const RUN_WINDOW_PLACEHOLDER =\n  "Ask Cinatra to suggest edits to the fields above…";',
    );
    expect(panel).toContain("placeholder = RUN_WINDOW_PLACEHOLDER");
    expect(panel).toContain("placeholder={placeholder}");
  });
});

describe("the run's own replay thread is unchanged by the second use", () => {
  it("the replay reader excludes the window rows by the writer's own predicate", () => {
    const store = read("packages/agents/src/store.ts");
    expect(store).toContain("notARunWindowRow");
    const readerIdx = store.indexOf("export async function readAgentRunMessages");
    const body = store.slice(readerIdx, readerIdx + 900);
    expect(body).toContain("notARunWindowRow");
  });
});
