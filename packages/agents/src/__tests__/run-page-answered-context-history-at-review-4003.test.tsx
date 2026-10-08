// @vitest-environment jsdom
// Real run page/frame/panel/rail; mocks are only actor, persistence and transport ports.
// The existing composition apparatus below is reused without copying its old cases.
import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: proof.refresh }),
  usePathname: () => "/agents",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

// This page fixture supplies its store and card answers; extension discovery
// never contributes to its rail. Keep unused package registration at the data
// boundary, while the actual page, panels, frame and rail rows stay real.
vi.mock("@/lib/generated/extensions.server", () => ({
  STATIC_EXTENSION_MANIFEST: {}, STATIC_EXTENSION_RECORDS: [],
  GENERATED_EXTENSION_SERVER_ENTRIES: {}, GENERATED_CONNECTOR_ENTRY_MODULES: {},
  GENERATED_CONNECTOR_MCP_MODULES: {}, GENERATED_CONNECTOR_PRIMITIVE_HANDLERS: {},
  GENERATED_EXTERNAL_MCP_TOOLBOXES: {}, GENERATED_WIDGET_STREAM_AGENTS: {},
  GENERATED_CHAT_WIDGET_MODULES: {}, GENERATED_CHAT_WIDGET_MANIFEST_MODULES: {},
  GENERATED_DEV_SETUP_MODULES: {},
}));
vi.mock("@/lib/generated/field-renderer-components", () => ({
  GENERATED_FIELD_RENDERER_COMPONENTS: {},
}));

const RUN_ID = "run-4003";
const proof=vi.hoisted(()=>({rows:[] as Record<string,unknown>[],session:true,readable:true,historyThrows:false,refresh:vi.fn(),interrupt:null as Record<string,unknown>|null, approve:vi.fn()}));
vi.mock("../hitl-actions",()=>({approveReviewTask:(...args:unknown[])=>proof.approve(...args)}));
vi.mock("../run-name-actions",()=>({ensureOrCheckRunNameAction:async()=>({ok:true,title:"Run"})}));
vi.mock("../use-ag-ui-run-stream",()=>({useAgUiRunStream:(_runId:string,options:{initialStatus:string})=>({
 status:options.initialStatus,interruptContext:proof.interrupt,messages:[],streamedText:"",presentationHint:null,
 dataPartFrames:[],isLive:true,error:null,
})}));
vi.mock("../db", ()=>({agentBuilderPool:{query:async()=>({rows:proof.rows}),on:()=>{},listenerCount:()=>1},db:{}}));

const artifactReads = vi.hoisted(() => ({ live: vi.fn(), historical: vi.fn() }));
vi.mock("@/lib/artifacts/artifact-service", () => ({
  readArtifactForDetail: artifactReads.live,
  readArtifactForSettledReview: artifactReads.historical,
}));

/**
 * THE RUN, AS THE STORE HOLDS IT — one row, mutated per reading, because the
 * two readings below are the SAME run at two moments of its life.
 */
const row = vi.hoisted(() => ({
  templateType: "orchestrator" as "orchestrator" | "agent",
  status: "pending_approval" as string,
  lifecycleMoment: "hitl" as string | null,
  lifecycleCardKind: "agent_hitl_screen" as string | null,
  lifecycleCardRef: "wayflow-task-1" as string | null,
  hitlContext: null as unknown,
  /** The input forms the agent declares — none for the finished-run reading. */
  required: ["idea", "audience"] as string[],
  /**
   * THE FIELDS THE AGENT DECLARES, WITH THE TITLES IT MAPS TO THEM
   * (cinatra#3243). A field whose title only restates its own key declares no
   * name of its own, and `run-input-steps.ts` merges every such form into the
   * run's one setup entry — which is the reading every case above takes. A
   * field that declares a real name is its own step, which is what a run with
   * a form it is standing at and a form it has not been asked needs.
   */
  properties: {
    idea: { type: "string", title: "idea" },
    audience: { type: "string", title: "audience" },
  } as Record<string, unknown>,
  /** The values the run carries for those fields — none before it is asked. */
  inputParams: { idea: "a post about rails", audience: "developers" } as Record<
    string,
    unknown
  >,
  producedReviewPark: null as string | null,
}));

/**
 * THE RUN'S RECOMMENDATION PARK, AS THE STORE HOLDS IT (cinatra#3243) — the
 * whole reading of the Skills entry: a `parked` row is the question still held,
 * which is the moment the issue reports, and `null` is a run that never held.
 */
const recommendationPark = vi.hoisted(() => ({
  row: null as { status: string } | null,
  /** What the card's own resolve answers for that park. */
  holdState: { state: "none" } as unknown,
}));

/**
 * THE RUN'S REVIEW SLOT, AS THE READER ANSWERS IT — mutated per reading for the
 * same reason the row above is: a run WAITING at its review gate and a run whose
 * gate is settled are the same run at two moments, and the rail draws the run's
 * own record differently at each (cinatra#3478, third leg).
 */
const reviewSlot = vi.hoisted(() => ({
  awaiting: false,
  reviewTaskId: null as string | null,
}));

/**
 * THE RUN'S REVIEW GATES, AS THE RAIL'S OWN READER LISTS THEM — the gate ROW,
 * which is the thing that outlives the outbox window: `readRunReviewSlot`
 * answers `awaiting: false` the moment this row exists, decided or not, so a
 * run standing in front of an UNDECIDED gate is only visible here.
 */
const reviewGates = vi.hoisted(() => ({
  rows: [] as Array<{
    id: string;
    orgId: string;
    pinnedTargets: Array<{ artifactId: string; representationRevisionId: string }>;
    reviewTaskId: string;
    status: "pending" | "resolved";
    disposition: string | null;
    createdAt: Date;
  }>,
}));

/**
 * THE RUN'S TRIGGER ROW, AS THE STORE HOLDS IT (cinatra#3478, the re-cut's
 * first leg) — the one fact that says whether the run CARRIES A SCHEDULE, and
 * of which kind. `null` is a run that carries none; `releasedAt` is the fired
 * stamp the schedule's own record keeps, for an immediate fire as much as for a
 * scheduled one.
 */
const triggerRow = vi.hoisted(() => ({
  row: null as { triggerType: string; releasedAt: Date | null } | null,
}));

/** The trigger row of a run dispatched with "Run right after setup", fired. */
/** The gate the run is stopped at, as the screen derives it from the row. */
const STORED_IDEAS_GATE = {
  xRenderer: "cinatra/hitl-approval",
  currentValues: { storedIdeas: ["one", "two"] },
  fieldName: "storedIdeas",
  schema: { type: "object", properties: {} },
  reviewTaskId: "task-1",
};

const TEMPLATE = {
  id: "tmpl-3478",
  orgId: "org-1",
  creatorId: "user-1",
  name: "Blog Idea Generator",
  description: "",
  type: "orchestrator",
  sourceNl: "",
  compiledPlan: [],
  inputSchema: {
    properties: {
      idea: { type: "string", title: "idea" },
      audience: { type: "string", title: "audience" },
    },
    required: [] as string[],
  },
  outputSchema: null,
  taskSpec: null,
  status: "published",
  packageName: "@cinatra-ai/blog-idea-generator",
  packageVersion: "1.0.0",
  gatedSteps: [],
  triggerMode: "none",
  approvalPolicy: {
    steps: [
      { stepNumber: 1, xRenderer: "cinatra/review", name: "Draft the post" },
      { stepNumber: 2, xRenderer: "cinatra/review", name: "Pick the image" },
    ],
  },
  agentDependencies: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

/** The template, with the input forms this reading's agent declares. */
function makeTemplate() {
  return {
    ...TEMPLATE,
    type: row.templateType,
    approvalPolicy: row.templateType === "agent" ? null : TEMPLATE.approvalPolicy,
    inputSchema: {
      ...TEMPLATE.inputSchema,
      properties: row.properties,
      required: row.required,
    },
  };
}

function makeRun() {
  return {
    id: RUN_ID,
    templateId: TEMPLATE.id,
    versionId: null,
    runBy: "user-1",
    status: row.status,
    inputParams: row.inputParams,
    stepResults: null,
    startedAt: new Date("2026-01-01"),
    completedAt: null,
    error: null,
    title: "A run",
    createdAt: new Date("2026-01-01"),
    sourceType: "agent_builder",
    sourceId: null,
    packageVersion: "1.0.0",
    a2aTaskId: null,
    a2aContextId: null,
    parentRunId: null,
    agUiEnabled: true,
    lgThreadId: null,
    traceId: null,
    timeoutSeconds: null,
    streamedText: null,
    authPolicy: null,
    orgId: "org-1",
    projectId: null,
    idempotencyKey: null,
    oboCeiling: null,
    dependentInstallId: null,
    humanPresent: true,
    lifecycleMoment: row.lifecycleMoment,
    lifecycleCardKind: row.lifecycleCardKind,
    lifecycleCardRef: row.lifecycleCardRef,
    producedReviewPark: row.producedReviewPark,
    executionAttemptId: null,
    launchScopeAnchor: null,
  };
}

// ── The data layer the screen reads. Nothing of the rail's composition. ──────
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn(async () => ({
    user: { id: "user-1", name: "A", email: "a@b.c" },
    session: { activeOrganizationId: "org-1" },
  })),
  requireAuthSession: async()=>proof.session ? {user:{id:"user-1"}} : null,
  requireActorContext: async()=>({actorType:"human",source:"ui",userId:"user-1",orgId:"org-1"}),
  isPlatformAdmin: () => false,
  resolveOrgRoleForSession: vi.fn(async () => "member"),
}));

vi.mock("@/lib/better-auth-db", () => ({
  betterAuthDb: { select: () => ({ from: () => ({ where: async () => [] }) }) },
  betterAuthUsers: {},
  readOrgsWithTeamsForUserActiveOnly: vi.fn(async () => []),
  readProjectsForUser: vi.fn(async () => []),
}));

vi.mock("../store", () => ({
  readAgentTemplateBySlug: vi.fn(async () => makeTemplate()),
  readAgentRunById: vi.fn(async () => proof.readable ? makeRun() : null),
  readAgentTemplateById: vi.fn(async () => makeTemplate()),
  readAgentRunMessages: vi.fn(async () => []),
  readAgentTemplates: vi.fn(async () => ({ items: [] })),
  ensureRunTitle: vi.fn(async () => "A run"),
  readRunCoOwners: vi.fn(async () => []),
}));

vi.mock("../auth-policy", async () => ({
  buildActorContextFromPrimitive: (await vi.importActual<typeof import("@/lib/authz/build-actor-context")>(
    "@/lib/authz/build-actor-context",
  )).buildActorContextFromPrimitive,
  resolveEffectivePolicy: vi.fn(() => ({ runDataVisibility: "owner" })),
  buildScopeReason: vi.fn(() => null),
  resolveTemplateVisibilityActor: vi.fn(async () => ({})),
}));

vi.mock("../artifact-review-gate-store", async () => {
  // cinatra#3046 — this screen also asks the store whether the run is parked on
  // the review its own output opened. That predicate is PURE: it answers from the
  // run row it is handed, so this factory hands the suite the REAL one (re-exported
  // by the store from its writer) instead of a stub that could answer differently
  // from the page under test.
  const hold = await vi.importActual<typeof import("../run-produced-review-hold")>(
    "../run-produced-review-hold",
  );
  return {
    listReviewGatesForRun: vi.fn(async () => reviewGates.rows),
    readReviewGate: vi.fn(async () => null),
    readRunReviewSlot: vi.fn(async () => ({
      reviewTaskId: reviewSlot.reviewTaskId,
      awaiting: reviewSlot.awaiting,
    })),
    readVerificationRecordsForGates: vi.fn(async () => []),
    isParkedOnProducedReview: hold.isParkedOnProducedReview,
  };
});

vi.mock("../lifecycle-policy-store", () => ({
  readLifecycleDecisionsForRun: vi.fn(async () => []),
}));

vi.mock("../recommendation-hold", () => ({
  readRecommendationParkForRun: vi.fn(async () => recommendationPark.row),
}));

// The Skills card resolves its own offer through this module after it mounts,
// and until that answer lands a LIVE hold draws no DOM at all — the card says
// so itself. That read is data layer, so it is stubbed here exactly as every
// other read the page makes; the card, the frame and the rail are the real
// ones.
vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: vi.fn(async () => recommendationPark.holdState),
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
}));

vi.mock("../hitl-context", () => ({
  deriveRunHitlContext: vi.fn(async () => row.hitlContext),
}));

vi.mock("../run-actions", async (orig) => {
  const actual=await orig<typeof import("../run-actions")>();
  return {
  ...actual,
  readAnsweredContextHistory: (id:string)=>{
    if(proof.historyThrows) throw new Error("optional history unavailable");
    return actual.readAnsweredContextHistory(id);
  },
  createAndTriggerRunWithContext: vi.fn(async () => ({ ok: false })),
  buildSubmissionMapByStepIndex: vi.fn(async () => []),
  createAndTriggerRun: vi.fn(async () => ({ ok: false })),
  readRunOutputEvidence: vi.fn(async () => ({ hasOutput: false, hasArtifacts: false })),
};});

vi.mock("../trigger-store", () => ({
  readRunTriggerByRunId: vi.fn(async () => triggerRow.row),
}));

vi.mock("../trigger-schedule-proposal-store", () => ({
  readProposalConsumeByRunId: vi.fn(async () => null),
}));

vi.mock("../input-schema-resolver", () => ({
  resolveTemplateInputSchema: vi.fn(async () => makeTemplate().inputSchema),
}));

// The run's own record reads what the run filed; a finished run asks for it.
vi.mock("@/lib/artifacts/run-made-artifacts", () => ({
  listRunMadeArtifacts: vi.fn(async () => []),
}));

vi.mock("../trigger-duration-estimate", () => ({
  estimateRunDuration: vi.fn(async () => ({ seconds: 60 })),
}));

vi.mock("@/lib/lifecycle/run-window-turn", () => ({
  canRespondInRunWindow: vi.fn(async () => true),
}));

vi.mock("../run-sharing-actions", () => ({ removeRunOwner: vi.fn() }));

vi.mock("../run-recommendation-core", () => ({
  recommendationDecidedForRun: vi.fn(() => false),
  resolveRecommendationHoldStateForActor: vi.fn(async () => null),
}));

import { SetupScreen } from "../instance-screens";

/**
 * The run panel opens the run's event stream on mount. jsdom carries no
 * `EventSource`; the page is what is under test, not the transport, so it is
 * stubbed through vitest's own global stubbing and taken away again in
 * `afterAll` — this file leaves no global behind for the package's other suites
 * (the rail's own rule for a new test file).
 */
class StubEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  onmessage: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onopen: ((e: unknown) => void) | null = null;
  readyState = 0;
  constructor(public url: string) {}
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

beforeEach(() => {
  vi.stubGlobal("EventSource", StubEventSource);
  proof.rows=[];proof.session=true;proof.readable=true;proof.refresh.mockClear();proof.historyThrows=false;proof.interrupt=null;proof.approve.mockReset().mockResolvedValue({ok:true});
  row.templateType = "orchestrator";
  row.status = "pending_approval";
  row.lifecycleMoment = "hitl";
  row.lifecycleCardKind = "agent_hitl_screen";
  row.lifecycleCardRef = "wayflow-task-1";
  row.hitlContext = STORED_IDEAS_GATE;
  row.required = ["idea", "audience"];
  row.properties = {
    idea: { type: "string", title: "idea" },
    audience: { type: "string", title: "audience" },
  };
  row.inputParams = { idea: "a post about rails", audience: "developers" };
  row.producedReviewPark = null;
  recommendationPark.row = null;
  recommendationPark.holdState = { state: "none" };
  reviewSlot.awaiting = false;
  reviewSlot.reviewTaskId = null;
  reviewGates.rows = [];
  triggerRow.row = null;
  artifactReads.live.mockReset().mockReturnValue({ kind: "not-found" });
  artifactReads.historical.mockReset().mockReturnValue({ kind: "not-found" });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

/** Render the REAL run page for the row as it currently stands. */
async function renderRunPage() {
  const tree = await SetupScreen({ agentId: "blog-idea-generator", instanceId: RUN_ID });
  return render(tree as React.ReactElement);
}

/**
 * THE RAIL COLUMNS THE PAGE DRAWS.
 *
 * Every rail carries one of the two markers — `data-run-step-rail-column` (the
 * frame's own column) or `data-run-step-rail` (a rail panel). A rail panel
 * mounted INSIDE the frame's column is one rail drawn in two boxes, not two
 * rails, so a marked element that stands inside another marked element is not
 * counted: what a reader sees as "a column of steps" is a marked element with
 * no marked element above it.
 */
const RAIL_MARKERS = "[data-run-step-rail],[data-run-step-rail-column]";

function railColumns(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(RAIL_MARKERS)).filter(
    (el) => el.parentElement?.closest(RAIL_MARKERS) == null,
  );
}

/** Every entry of a rail column, in the order it is drawn. */
import {continueBindingDigest,continueGateDigest} from "../agent-run-hitl-prompts";
import {readAnsweredContextHistory} from "../run-actions";
const materializedAt="2026-10-08T00:00:00.000Z";
function confirmedContext(answer:Record<string,unknown>={slotId:"draftContext",resolutionMode:"accumulate",selectedRefs:[]}){
  const gate={runId:RUN_ID,reviewTaskId:"wayflow-context-A",xRenderer:"context-selector",materializedAt,
    inputSchema:{type:"object",properties:{selectedRefs:{type:"array"}}},values:{slotMeta:{slotId:"draftContext"}}};
  return {step_key:"context-A",submitted_values:answer,review_task_id:gate.reviewTaskId,x_renderer:gate.xRenderer,
    input_schema:gate.inputSchema,gate_values:gate.values,field_name:null,a2a_context_id:"ctx",materialized_at:materializedAt,
    dispatch_receipt:{version:1,runId:RUN_ID,orgId:"org-1",agentId:TEMPLATE.packageName,
      reviewTaskId:gate.reviewTaskId,contextId:"ctx",returnedTaskId:"review-B",returnedState:"input-required",
      materializedAt,schemaDigest:continueGateDigest(gate),answerDigest:continueBindingDigest(answer),
      acknowledgedAt:"2026-10-08T00:01:00.000Z"}};
}
function atReview(){
  row.required=["idea"];row.properties={idea:{type:"string",title:"Idea"}};
  row.lifecycleMoment=null;row.lifecycleCardKind=null;row.lifecycleCardRef=null;row.hitlContext=null;
  reviewSlot.awaiting=true;reviewSlot.reviewTaskId="review-B";
  proof.rows=[confirmedContext()];
}
describe("confirmed context history remains under the same real run rail",()=>{
  it("keeps answered Setup and context above the pending review; context opens its OWN read-only answer",async()=>{
    atReview();const {container}=await renderRunPage();
    const rows=Array.from(container.querySelectorAll<HTMLElement>("[data-run-surface-rail-step-key]"));
    const context=rows.find(el=>el.dataset.runSurfaceRailStepKey==="context:wayflow-context-A");
    expect(rows.some(el=>el.dataset.runSurfaceRailStepKey==="input:0")).toBe(true);
    expect(context).toBeDefined();expect(context!.dataset.runSurfaceRailSettled).toBe("true");
    fireEvent.click(context!);
    await waitFor(()=>expect(container.textContent).toContain("No context selected"));
    const reading=container.querySelector('[data-run-input-step-reading="answered"]');
    expect(reading?.textContent).toContain("Draft Context");
    expect(reading?.querySelector('button,input,textarea,[data-lifecycle-card]')).toBeNull();
    expect(railColumns(container)).toHaveLength(1);
  });
  it("keeps the old task detail while a different current context gate is live",async()=>{
    atReview();reviewSlot.awaiting=false;reviewSlot.reviewTaskId=null;
    row.lifecycleMoment="hitl";row.lifecycleCardKind="agent_hitl_screen";row.lifecycleCardRef="wayflow-context-C";
    row.hitlContext={...STORED_IDEAS_GATE,reviewTaskId:"wayflow-context-C",currentValues:{slotMeta:{slotId:"laterContext"}}};
    const {container}=await renderRunPage();
    expect(container.querySelector('[data-run-surface-rail-step-key="context:wayflow-context-A"]')).not.toBeNull();
    expect(container.querySelector('[data-run-surface-rail-step-key="gate"]')).not.toBeNull();
    fireEvent.click(container.querySelector('[data-run-surface-rail-step-key="context:wayflow-context-A"]')!);
    await waitFor(()=>expect(container.textContent).toContain("No context selected"));
  });
  it("does not expose history without session or readable run authority",async()=>{
    atReview();proof.session=false;expect(await readAnsweredContextHistory(RUN_ID)).toEqual([]);
    proof.session=true;proof.readable=false;expect(await readAnsweredContextHistory(RUN_ID)).toEqual([]);
  });
  it("does not turn initial values or a legacy pre-send capture into an answer",async()=>{
    atReview();proof.rows=[{...confirmedContext(),dispatch_receipt:null}];
    expect(await readAnsweredContextHistory(RUN_ID)).toEqual([]);
    proof.rows=[{...confirmedContext(),submitted_values:null}];
    expect(await readAnsweredContextHistory(RUN_ID)).toEqual([]);
  });
});

import { OrchestratorStepperPanel } from "../orchestrator-stepper-panel";
import { ARTIFACT_REVIEW_REDIRECT_RENDERER_ID, SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";
it("refreshes the page after the actual Continue action returns with a delayed receipt",async()=>{
  const {ensureDefaultFieldRenderersRegistered}=await import("../register-default-renderers");
  ensureDefaultFieldRenderersRegistered();
  let finish!:()=>void;
  proof.approve.mockImplementation(async()=>{await new Promise<void>(resolve=>{finish=resolve;});proof.rows=[confirmedContext()];return {ok:true};});
  proof.interrupt={schema:{type:"object",properties:{}},xRenderer:SCHEMA_FIELD_FALLBACK_RENDERER_ID,values:{},reviewTaskId:"wayflow-context-A"};
  const props={runId:RUN_ID,initialStatus:"pending_approval" as const,initialError:null,agUiEnabled:true,
    agentPackageName:TEMPLATE.packageName,inputParams:{},stepperSteps:[],agentId:"blog-idea-generator",lgThreadId:null,
    templateId:TEMPLATE.id,templateName:"Blog Idea Generator"};
  const view=render(<OrchestratorStepperPanel {...props}/>);
  const continues=await view.findAllByRole("button",{name:/^Continue$/});
  fireEvent.click(continues[0]);await waitFor(()=>expect(proof.approve).toHaveBeenCalledTimes(1));
  proof.interrupt={schema:{type:"object",properties:{}},xRenderer:ARTIFACT_REVIEW_REDIRECT_RENDERER_ID,
    values:{reviewTaskId:"review-B"},reviewTaskId:"wayflow-review-B"};
  view.rerender(<OrchestratorStepperPanel {...props}/>);
  await waitFor(()=>expect(proof.refresh).toHaveBeenCalled());
  const earlyCount=proof.refresh.mock.calls.length;
  expect(await readAnsweredContextHistory(RUN_ID)).toEqual([]);
  await act(async()=>{finish();});
  await waitFor(()=>expect(proof.refresh.mock.calls.length).toBeGreaterThan(earlyCount));
  expect(await readAnsweredContextHistory(RUN_ID)).toEqual([expect.objectContaining({reviewTaskId:"wayflow-context-A"})]);
});

it("a synchronous optional-history read failure preserves the real page and live review controls",async()=>{
  atReview();proof.historyThrows=true;const {container}=await renderRunPage();
  expect(container.querySelector('[data-run-surface-rail-step-key="input:0"]')).not.toBeNull();
  expect(container.querySelector('[data-run-surface-rail-step-key="context:wayflow-context-A"]')).toBeNull();
  expect(railColumns(container)).toHaveLength(1);
});
