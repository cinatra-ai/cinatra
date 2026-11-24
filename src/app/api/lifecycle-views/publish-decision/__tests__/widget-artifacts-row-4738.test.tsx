// @vitest-environment jsdom
//
// A publish card's artifacts row on the SITE WIDGET draws its island, on the production path (cinatra#4738 round 1):
// the real `GET /api/lifecycle-views/publish-decision` handler answers the card (the real card core, the real ref codec,
// the real widget mint and credential codec), the real card reads it through its broker read, and the real review-target
// island frames the address. Only the stores under the core and the single-use ledger are stubbed, as in `route.test.ts`.
//
//   - FINDING 1. The core answers `islandSrc: null`, and a widget frame sends no cookie, so before the fix the route
//     handed the card no credential and the island drew its empty region: no widget publish card drew its artifacts row.
//   - FINDING 2. The card re-reads its state while the run is live. Before the fix each read minted a new random ref,
//     and every widget read brings a fresh single-use credential, so the frame's address moved on every read and the
//     preview reloaded. A second read of the same decision must leave the same frame on the same address.
//
// red-first-expect: expected null not to be null

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-publish-decision-widget-wiring";

const resolveWidgetLifecycleActorContext = vi.fn();
const resolveAssistantWidgetBinding = vi.fn();
const readAgentRunById = vi.fn();
const readAgentTemplateById = vi.fn();
const readRunCoOwners = vi.fn();
const readLatestDecisionForRun = vi.fn();
const readDeciderName = vi.fn();
const resolveOrgRoleForUser = vi.fn();
const recordIslandCredentialGrant = vi.fn();

vi.mock("@/lib/lifecycle/widget-lifecycle-actor", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  resolveWidgetLifecycleActorContext: (...a: unknown[]) => resolveWidgetLifecycleActorContext(...a),
}));
vi.mock("@/lib/lifecycle/review-island-grant-store", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  recordIslandCredentialGrant: (...a: unknown[]) => recordIslandCredentialGrant(...a),
}));
// The generated extension manifest names every required extension's register entry; a jsdom suite resolves those
// imports eagerly, and nothing here reads the manifest.
vi.mock("@/lib/generated/extensions.server", () => ({ STATIC_EXTENSION_MANIFEST: {} }));
vi.mock("@/lib/assistant-widget-handles", () => ({
  resolveAssistantWidgetBinding: (...a: unknown[]) => resolveAssistantWidgetBinding(...a),
}));
vi.mock("@cinatra-ai/agents/store", () => ({
  readAgentRunById: (...a: unknown[]) => readAgentRunById(...a),
  readAgentTemplateById: (...a: unknown[]) => readAgentTemplateById(...a),
  readRunCoOwners: (...a: unknown[]) => readRunCoOwners(...a),
}));
vi.mock("../../../../../../packages/agents/src/publish-decision-store", () => ({
  readLatestDecisionForRun: (...a: unknown[]) => readLatestDecisionForRun(...a),
}));
vi.mock("@/lib/lifecycle/lifecycle-settled-outcome", () => ({
  readDeciderName: (...a: unknown[]) => readDeciderName(...a),
}));
vi.mock("@/lib/auth-session", () => ({
  resolveOrgRoleForUser: (...a: unknown[]) => resolveOrgRoleForUser(...a),
}));
// The cookie hosts' server action; the widget never calls it.
vi.mock("../../../../../../packages/agents/src/publish-decision-card-actions", () => ({
  getPublishDecisionCardStateAction: vi.fn(async () => {
    throw new Error("a widget card must read through its broker route");
  }),
}));

import { GET } from "../route";
import { LifecycleCardSurfaceProvider } from "../../../../../../packages/agents/src/lifecycle-card-runtime";
import { PublishDecisionCard } from "../../../../../../packages/agents/src/publish-decision-card-view";
import {
  REVIEW_ISLAND_CREDENTIAL_QUERY_PARAM,
  verifyReviewIslandCredential,
} from "@/lib/lifecycle/review-island-credential";
import { publishDecisionIslandSubjectKey } from "@/lib/lifecycle/lifecycle-card-ref";
import { WIDGET_LIFECYCLE_READ_SCOPE } from "@/lib/widget-lifecycle-scope";

const RUN_ID = "00000000-0000-4000-8000-000000004738";
const CLAIMS = {
  userId: "user-widget",
  orgId: "org-widget",
  siteId: "site-1",
  client: "wordpress",
  siteOrigin: "https://wp.example.test",
  agentSlug: "blog",
  instanceId: "inst-1",
  jti: "jti-1",
  grantedScopes: [WIDGET_LIFECYCLE_READ_SCOPE],
};
const ACTOR_CTX = {
  actor: { actorType: "human", source: "a2a", userId: "user-widget", orgId: "org-widget" },
  orgId: "org-widget",
  roleHints: { orgRole: "member", platformRole: "member", actorOrganizationId: "org-widget" },
};
const OWN_RUN = { id: RUN_ID, templateId: "tmpl-blog", runBy: "user-widget", orgId: "org-widget", authPolicy: null, status: "pending_approval" };
const TEMPLATE = {
  id: "tmpl-blog",
  name: "Blog agent",
  publishRows: { post: [{ label: "Title", input: "title" }, { kind: "artifacts", label: "Proposed page", input: "reviewTargets" }] },
};
const PARKED = {
  id: "d1",
  runId: RUN_ID,
  nodeId: "post",
  status: "parked",
  surfacedValues: { title: "Spring launch", reviewTargets: [{ artifactId: "art-1", representationRevisionId: "rev-1" }] },
  decidedBy: null,
  decisionNote: null,
};
const WIDGET_AUTH = {
  headers: () => ({ "X-Cinatra-Widget-User-Token": "cwu_presented", "X-Cinatra-Widget-Assistant": "blog" }),
  credentials: "omit" as const,
};

let container: HTMLDivElement;
let root: Root;
let originalFetch: typeof globalThis.fetch;
let reads = 0;

beforeEach(() => {
  vi.clearAllMocks();
  reads = 0;
  resolveAssistantWidgetBinding.mockReturnValue({ agentSlug: "blog" });
  resolveWidgetLifecycleActorContext.mockResolvedValue({ ok: true, actorCtx: ACTOR_CTX, claims: CLAIMS });
  readAgentRunById.mockResolvedValue(OWN_RUN);
  readAgentTemplateById.mockResolvedValue(TEMPLATE);
  readRunCoOwners.mockResolvedValue([]);
  readLatestDecisionForRun.mockResolvedValue(PARKED);
  readDeciderName.mockResolvedValue(null);
  resolveOrgRoleForUser.mockResolvedValue("member");
  recordIslandCredentialGrant.mockReturnValue(true);
  originalFetch = globalThis.fetch;
  // The card's broker read goes to the REAL route handler, with the headers the card sent.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    reads += 1;
    return GET(new Request(new URL(String(input), "https://app.example"), { method: init?.method, headers: init?.headers }));
  }) as typeof fetch;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = originalFetch;
});

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mountWidgetCard(): Promise<void> {
  await act(async () => {
    root.render(
      <LifecycleCardSurfaceProvider host="site_widget" auth={WIDGET_AUTH} frame={{ assistant: "blog", instanceId: "inst-1" }}>
        <PublishDecisionCard runId={RUN_ID} />
      </LifecycleCardSurfaceProvider>,
    );
  });
  await flush();
}

const itemsRow = () => container.querySelector('[data-conformance-id="publish-row-items"]');
const frame = () => itemsRow()?.querySelector("iframe") ?? null;

describe("a widget publish card's artifacts row, through the real broker route", () => {
  it("frames the island at the credentialed address the route minted for that row", async () => {
    await mountWidgetCard();
    expect(reads).toBe(1);
    expect(itemsRow()).not.toBeNull();
    expect(frame()).not.toBeNull();
    const src = new URL(frame()!.getAttribute("src")!, "https://app.example");
    expect(src.pathname).toBe("/lifecycle/review-island");
    const sealed = verifyReviewIslandCredential(src.searchParams.get(REVIEW_ISLAND_CREDENTIAL_QUERY_PARAM) ?? "");
    expect(sealed).toMatchObject({
      subject: "publish-decision",
      runId: RUN_ID,
      reviewTaskId: publishDecisionIslandSubjectKey({ decisionId: "d1", input: "reviewTargets" }),
      userId: "user-widget",
    });
  });

  it("a second read of the same decision keeps the same frame on the same address", async () => {
    await mountWidgetCard();
    const first = frame();
    expect(first).not.toBeNull();
    const firstSrc = first!.getAttribute("src");
    // A re-read: the same signal the card's tick, focus and reload all ask through.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();
    expect(reads).toBe(2);
    // The route minted a second credential for the second read; the card keeps the frame it already drew.
    expect(recordIslandCredentialGrant).toHaveBeenCalledTimes(2);
    expect(frame()).toBe(first);
    expect(frame()!.getAttribute("src")).toBe(firstSrc);
  });

  it("a run the widget session does not own draws no card at all", async () => {
    readAgentRunById.mockResolvedValue({ ...OWN_RUN, runBy: "someone-else" });
    await mountWidgetCard();
    expect(container.querySelector('[data-lifecycle-card="publish_decision"]')).toBeNull();
    expect(recordIslandCredentialGrant).not.toHaveBeenCalled();
  });
});
