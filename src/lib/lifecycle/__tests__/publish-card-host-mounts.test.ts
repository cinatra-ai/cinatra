// The publish card on all four hosts -- the MOUNT inventory (cinatra#4150).
//
// The per-host RENDER is pinned in the card's own suite (every host draws exactly one card with an open decision and
// nothing without one) and in the conversation-mount suite (the real column on /chat and the widget). This file pins
// the INVENTORY of the page hosts and the column, by reading source: the two run panels (the agentic panel, and the
// stepper panel the run page serves a flow or orchestrator run with) and the review page are large trees (the review page an async SERVER component with a session and stores), and standing them up would prove
// more about a harness than about the mount. What must not rot silently is the SHAPE: each mount keyed by the run
// alone, under a real host declaration, passing no decide door (so its controls stay disabled), and the run panel's
// mount standing down inside a conversation host, where the column's card owns the run.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const PANEL = "packages/agents/src/agentic-run-panel.tsx";
const STEPPER = "packages/agents/src/orchestrator-stepper-panel.tsx";
const REVIEW_PAGE = "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/page.tsx";
const COLUMN = "packages/chat/src/chat-messages-view.tsx";

/** Every `<PublishDecisionCard ... />` element in a source, verbatim. */
function cardElements(source: string): string[] {
  return [...source.matchAll(/<PublishDecisionCard\b[^>]*\/>/g)].map((m) => m[0]);
}

/** The body of the FIRST host provider that encloses `index`, or null when none does. */
function enclosingHost(source: string, index: number): string | null {
  const open = /<LifecycleCardSurfaceProvider\b[^>]*host="([a-z_]+)"[^>]*>/g;
  let found: string | null = null;
  for (let m = open.exec(source); m !== null; m = open.exec(source)) {
    if (m.index > index) break;
    const close = source.indexOf("</LifecycleCardSurfaceProvider>", m.index);
    if (close > index) found = m[1]!;
  }
  return found;
}

describe("the publish card's mounts (cinatra#4150)", () => {
  it.each([
    // The panel hands the card the ONE read its approval banner is decided from, so the card reads nothing itself.
    [PANEL, "run_card", "<PublishDecisionCard runId={runId} read={publishRead} />"],
    // The stepper panel (a publishing FLOW run on the run page) hands its card the ONE read its stage card is decided from.
    [STEPPER, "run_card", "<PublishDecisionCard runId={runId} read={publishRead} />"],
    [REVIEW_PAGE, "page_gate_region", "<PublishDecisionCard runId={runId} />"],
  ])("%s mounts the card ONCE, keyed by the run, under %s", (file, host, element) => {
    const source = read(file);
    const elements = cardElements(source);
    expect(elements).toEqual([element]);
    expect(enclosingHost(source, source.indexOf(elements[0]!))).toBe(host);
  });

  it("the run panel's mount stands down inside a conversation host, on the hitl screen's own switch", () => {
    const source = read(PANEL);
    const at = source.indexOf("<PublishDecisionCard runId={runId} read={publishRead} />");
    const guard = source.lastIndexOf("const publishCard = panelMountsHitlScreenCard ? (", at);
    expect(guard).toBeGreaterThan(-1);
    // The switch opens right before this mount's own provider, with nothing between them.
    const between = source.slice(guard, at);
    expect(between.match(/<LifecycleCardSurfaceProvider host="run_card">/g)).toHaveLength(1);
    expect(between).toMatch(/^const publishCard = panelMountsHitlScreenCard \? \(\s*<LifecycleCardSurfaceProvider host="run_card">\s*$/);
    expect(source).toMatch(/const panelMountsHitlScreenCard = runCardOwnsLifecycleCopy\(ambientLifecycleHost\);/);
  });

  it("the run panel keeps a SETTLED decision's card beside its working and review surface, as the stepper does", () => {
    // A settled decision is a record, not a held card: the arm that returns the working or review surface draws the
    // one card element above its box once the read has answered anything but `none`, and the plate draws it otherwise.
    const source = read(PANEL);
    const arm = source.indexOf("if (!parkedAtPublishGate && (reviewScreenNode !== null || runIsWorking)) {");
    const element = source.indexOf("const publishCard = panelMountsHitlScreenCard ? (");
    expect(element).toBeGreaterThan(-1);
    expect(element).toBeLessThan(arm);
    const box = source.indexOf("data-run-review-slot={reviewCardDrawn ? \"review\" : \"working\"}", arm);
    const armHead = source.slice(arm, box);
    expect(armHead).toMatch(
      /const settledPublishCard =\s*publishRead\.state !== null && publishRead\.state\.state !== "none" \? publishCard : null;\s*return \(\s*<>\s*\{settledPublishCard\}\s*<section/,
    );
    // The plate draws the same element, and it is the panel's only other use of it.
    expect(source.match(/\{publishCard\}/g)).toHaveLength(1);
    expect(source.indexOf("{publishCard}")).toBeGreaterThan(box);
  });

  it("the column mounts the card beside the hitl screen in every placement, with no decide door", () => {
    const source = read(COLUMN);
    expect(source).toContain(
      'import {\n  PublishDecisionCard,\n  publishGateIsOpen,\n  usePublishDecisionCardRead,\n} from "@cinatra-ai/agents/publish-decision-card-view";',
    );
    // ONE HELD-RUN CARD: while the shared read is an open publish gate the turn's hitl screen is withheld, by the
    // panels' own rule, so a stale screen never draws beside the publish card.
    expect(source).toMatch(/const hitlScreen = publishGateIsOpen\(publishRead\) \? null : \(\s*<AgentHitlScreenCard /);
    // The turn reads ONCE, keyed on the change signal the panel reports (status, gate, readings at a pause with no gate
    // context), and hands that read to its card and to the panel, so the card and the banner stand on one answer.
    expect(cardElements(source)).toEqual(["<PublishDecisionCard runId={runId} read={publishRead} />"]);
    expect(source).toContain("wireRef: runChange?.signal ?? null,");
    // The panel's run status rides beside the signal, so the shared read keeps re-reading until the run finishes.
    expect(source).toContain("runStatus: runChange?.status ?? null,");
    expect(source).toContain("onRunChangeSignal={onRunChangeSignal}");
    expect(source).toContain("publishRead={publishRead}");
    // The turn's own placement and both moved placements draw it, exactly where they draw the hitl screen.
    expect(source).toContain("{turnCarriesSettledSchedule ? null : publishCard}");
    expect(source.match(/<div data-agent-run-screen-slot=\{runId\}>\{hitlScreen\}\{publishCard\}<\/div>/g)).toHaveLength(2);
  });

  it("the run panel asks the publish arm before its review screen, its working box and its review report", () => {
    // ONE HELD-RUN CARD: the review screen and the working placeholder return BEFORE the plate that holds the publish
    // card, and a produced-review park or ref the shared reader retains is stale at an open publish gate.
    const source = read(PANEL);
    expect(source).toMatch(/const parkedAtPublishGate = isPendingApproval && publishGateIsOpen\(publishRead\);/);
    expect(source).toContain("const reviewScreenNode: ReactNode = reviewRefInTheBox && !parkedAtPublishGate ? (");
    expect(source).toContain("if (!parkedAtPublishGate && (reviewScreenNode !== null || runIsWorking)) {");
    expect(source).not.toContain("  if (reviewScreenNode !== null || runIsWorking) {");
    expect(source).toContain("const panelDrawsReview = Boolean(reviewRefInTheBox) && !parkedAtPublishGate;");
    // Every early return of the render that draws a held-run surface comes after the publish reading is taken.
    const decided = source.indexOf("const parkedAtPublishGate = ");
    expect(decided).toBeLessThan(source.indexOf("if (!parkedAtPublishGate && (reviewScreenNode !== null || runIsWorking)) {"));
  });

  it("the column's review reveal stands down at an open publish decision", () => {
    const source = read(COLUMN);
    expect(source).toContain("const publishDecisionIsOpen = publishGateIsOpen(publishRead);");
    expect(source).toMatch(
      /const turnOwesTheReaderAReview =\s*!publishDecisionIsOpen && \(panelDrawsReview \|\| runCardDrawsAReview\);/,
    );
  });

  it("the run panel keys its publish read on the gate, not on the status alone, and reports that signal", () => {
    // A run can move between two pauses with no status change any reading sees, so a status-keyed read keeps its
    // earlier answer. The panel's own read and the signal it hands the column are the SAME per-gate value.
    const source = read(PANEL);
    expect(source).not.toMatch(/wireRef: status,/);
    expect(source).toContain("wireRef: publishReadSignal,");
    expect(source).toContain("onRunChangeSignalRef.current?.(runId, publishReadSignal, status);");
    expect(source).toMatch(/wireRef: publishReadSignal,\s*runStatus: status,/);
    expect(source).toMatch(/`\$\{status\}:no-gate:\$\{heardFromRun\}`/);
  });

  it("the stepper panel swaps the card in for the waiting spinner at an open publish gate, on one per-gate read", () => {
    // A publishing flow run parks with no interrupt, which this panel's ladder otherwise draws as "Processing
    // response…". The card's own arm must come BEFORE the resume reading and the spinner, and stand on the same read.
    const source = read(STEPPER);
    expect(source).toContain("const panelMountsPublishCard = runCardOwnsLifecycleCopy(ambientLifecycleHost);");
    expect(source).toMatch(/const publishCard = panelMountsPublishCard \? \(\s*<LifecycleCardSurfaceProvider host="run_card">/);
    // ONE HELD-RUN CARD: an open publish gate wins over any held-run reading the panel still holds (a stream gate, or a
    // produced-review park and ref the shared reader retains): all stale, so the card's arm is the ladder's FIRST arm.
    expect(source).toMatch(/const parkedAtPublishGate = status === "pending_approval" && publishGateIsOpen\(publishRead\);/);
    const ladder = source.indexOf("  let stageCard: ReactNode = null;");
    expect(ladder).toBeGreaterThan(-1);
    const arm = source.indexOf("  if (parkedAtPublishGate) {\n    stageCard = publishCard;\n  } else if (", ladder);
    expect(arm).toBeGreaterThan(-1);
    // Nothing between the ladder's start and the publish arm assigns the stage card or branches.
    expect(source.slice(ladder, arm)).not.toMatch(/stageCard =|\bif \(/);
    expect(arm).toBeLessThan(
      source.indexOf("} else if (parkedOnProducedReview && (reviewSlot.ref !== null || reviewStillReading)) {"),
    );
    expect(arm).toBeLessThan(source.indexOf('} else if (status === "failed") {'));
    expect(source).not.toContain("} else if (parkedAtPublishGate) {");
    // The read-only replay and the interrupt separator do not draw over the open decision either.
    expect(source).toContain("} else if (replayStepIndex !== null && !parkedOnProducedReview && !parkedAtPublishGate) {");
    expect(source).toContain(
      '{status === "pending_approval" && effectiveInterruptContext !== null && !parkedAtPublishGate && (',
    );
    expect(arm).toBeLessThan(source.indexOf("} else if (parkedWithNoGate && gateGoneOnResume && !awaitingNextStep) {"));
    expect(arm).toBeLessThan(source.indexOf("    awaitingNextStep ||\n    status === \"queued\" ||"));
    expect(arm).toBeLessThan(
      source.indexOf("  } else if (status === \"pending_approval\" && effectiveInterruptContext !== null && !awaitingNextStep) {"),
    );
    expect(arm).toBeLessThan(source.indexOf("    effectiveInterruptContext.xRenderer === ARTIFACT_REVIEW_REDIRECT_RENDERER_ID\n  ) {"));
    expect(source).toContain("wireRef: publishReadSignal,");
    expect(source).toMatch(/wireRef: publishReadSignal,\s*runStatus: status,/);
    expect(source).not.toMatch(/wireRef: status,/);
    expect(source).toMatch(/`\$\{status\}:no-gate:\$\{heardFromRun\}`/);
  });

  it("every run panel a product host renders is in this inventory, and every run host reaches one of them", () => {
    // A new panel that can render a run would draw it without the card; this fails until it is mounted and listed.
    const inventoried = new Set(["AgenticRunPanel", "OrchestratorStepperPanel"]);
    const rendered = new Set<string>();
    const walk = (rel: string) => {
      for (const name of readdirSync(path.join(ROOT, rel))) {
        const child = `${rel}/${name}`;
        if (name === "node_modules" || name === "__tests__" || name === "design-fixtures") continue;
        if (statSync(path.join(ROOT, child)).isDirectory()) walk(child);
        else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) {
          for (const m of read(child).matchAll(/<([A-Z]\w*(?:RunPanel|StepperPanel))\b/g)) rendered.add(m[1]!);
        }
      }
    };
    walk("src");
    for (const pkg of readdirSync(path.join(ROOT, "packages"))) {
      const rel = `packages/${pkg}/src`;
      try {
        if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
      } catch {
        // a package with no src tree renders nothing
      }
    }
    // The ONE other run-shaped panel is the orchestrator ledger's, drawn only by `OrchestratorRunScreen`, which no app
    // route serves (instance-screens routes every flow and orchestrator run to the stepper panel above), and which
    // shows an orchestrator's child ledger, never a publishing flow's own run. Should a route ever serve it, this
    // fails and the panel joins the inventory with a mount.
    const notARunHost = new Set(["OrchestratorRunPanel"]);
    const appReferences: string[] = [];
    const scanApp = (rel: string) => {
      for (const name of readdirSync(path.join(ROOT, rel))) {
        const child = `${rel}/${name}`;
        if (name === "node_modules" || name === "__tests__") continue;
        if (statSync(path.join(ROOT, child)).isDirectory()) scanApp(child);
        else if (/\.tsx?$/.test(name) && /\bOrchestratorRunScreen\b/.test(read(child))) appReferences.push(child);
      }
    };
    scanApp("src");
    expect(appReferences).toEqual([]);
    expect([...rendered].filter((name) => !notARunHost.has(name)).sort()).toEqual([...inventoried].sort());
    // The run page picks between the two by run type (`runDetailPanelKind`: a flow or orchestrator run gets the
    // stepper), the agentic branch through the setup watcher; the conversation (chat and the site widget) renders the
    // agentic panel inside its inline run card, beside the column's own card.
    const screens = read("packages/agents/src/instance-screens.tsx");
    expect(screens).toContain('runDetailPanel === "stepper" ? (\n                  <OrchestratorStepperPanel');
    expect(screens).toContain("<SetupCompletionWatcher");
    expect(read("packages/agents/src/setup-completion-watcher.tsx")).toContain("<AgenticRunPanel");
    expect(read("packages/chat/src/inline-agent-run-card.tsx")).toContain("<AgenticRunPanel");
    expect(read(COLUMN)).toContain("<InlineAgentRunCard");
  });

  it("no mount passes a decide door: the card's controls stay disabled until one is built", () => {
    for (const file of [PANEL, STEPPER, REVIEW_PAGE, COLUMN]) {
      for (const element of cardElements(read(file))) expect(element, file).not.toMatch(/\bdecide=/);
    }
  });
});
