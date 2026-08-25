// THE FIVE WINDOWS ARE ONE WINDOW (cinatra#2933, lifecycle-b W5b).
//
// AC1 asks for the exchange "on each of the five windows"; AC3 asks that "a
// person without respond access never sees the box"; the plan asks for one
// implementation, not five ("no window anywhere reads, re-routes, answers or
// refuses a message before the assistant sees it"), and for the copy to come
// from the ratified drawing rather than from a slice's imagination.
//
// This is a SOURCE-level conformance test, deliberately: what it pins is
// structural — which surface each window declares, that every window goes
// through the one controller and the one server bridge, that no window carries
// a placeholder string of its own, and that the chat mount opens no second
// conversation. A rendering test could not tell a second copy of the controller
// from the shared one.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const WINDOWS: Array<{ name: string; file: string; surface: string }> = [
  { name: "the run page", file: "packages/agents/src/agentic-run-panel.tsx", surface: "run-page" },
  { name: "the step-by-step screen", file: "packages/agents/src/orchestrator-stepper-panel.tsx", surface: "step-by-step" },
  { name: "the schedule screen", file: "packages/agents/src/trigger-screen-client.tsx", surface: "schedule" },
  { name: "the armed-trigger tab", file: "packages/agents/src/trigger-tab-client.tsx", surface: "armed-trigger" },
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
  const gated = [
    ["packages/agents/src/agentic-run-panel.tsx", "canRespondInWindow !== false"],
    ["packages/agents/src/orchestrator-stepper-panel.tsx", "canRespondInWindow !== false"],
    ["packages/agents/src/trigger-screen-client.tsx", "props.canRespondInWindow !== false"],
    ["packages/agents/src/trigger-tab-client.tsx", "props.canRespondInWindow !== false"],
  ] as const;
  for (const [file, guard] of gated) {
    it(`${file.split("/").pop()} gates its box on the run's access`, () => {
      expect(read(file)).toContain(guard);
    });
  }

  it("the schedule screen no longer hides its box behind the platform tier", () => {
    const src = read("packages/agents/src/trigger-screen-client.tsx");
    // It used to read `props.isAdmin !== false` on the window's own visibility.
    expect(src).not.toContain("props.isAdmin !== false");
  });

  it("the run's own access answer is resolved on the server, once", () => {
    const screens = read("packages/agents/src/instance-screens.tsx");
    expect(screens).toContain("canRespondInRunWindow(run.id)");
    expect(screens.match(/canRespondInWindow=\{canRespondInWindow\}/g) ?? []).toHaveLength(4);
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
