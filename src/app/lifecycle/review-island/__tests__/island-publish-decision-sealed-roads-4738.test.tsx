// cinatra#4738 round 2: A WIDGET READER'S PUBLISH ROW GETS WORKING SEALED ROADS.
//
// Inside a third-party site the reader holds no Cinatra cookie, so a publish row's image, PDF or media target loads only
// through the sealed byte road a review gate's island already gets. This file runs the real island page, the real
// publish-decision loader, the real roads and minters, and then the real serving route for what the page minted. Only the stores under them are doubles (the decision, the run's revisions, the
// live widget token, the blob), plus the one core that prepares a target, which here hands each target to the byte
// minter exactly as the real core does for a file-backed revision.
//
// Pinned here:
//   - the credentialed publish island's file-backed target gets a sealed preview and download, and the byte route
//     SERVES them;
//   - no stored capture pair is read, minted or drawn for it (cinatra#3862 leg 8): the streamed target carries its
//     preparation only, on every target, a floored one included;
//   - they are proven against the row's own set, never a gate's: no gate exists for the run, and a target the row
//     does not show, a decision that is no longer the newest, and a row the reader may not read all serve nothing;
//   - a gate capability sealed with the row's subject key serves nothing either;
//   - a target the reader keeps the run for but may not read as an artifact (`object.read`) serves no bytes, and a
//     target the core floors as `read-denied` gets no bytes minted at all.
// Red first at ffe421ea: a publish row names no sealed road, so the target keeps the session addresses. Before the
// publish row existed at all, the subject key it seals with does not exist:
// red-first-expect: publishDecisionIslandSubjectKey is not a function
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-lifecycle-refs";

type Target = { artifactId: string; representationRevisionId: string };
type Who = { actor: { userId?: string; orgId?: string } };

// ---- the stores under the real code ---------------------------------------------------------------------------------
const state = {
  newestDecisionId: "dec-1",
  readable: true,
  targets: [{ artifactId: "art-1", representationRevisionId: "rev-1" }] as Target[],
  madeByRun: true,
  /** The artifacts `object.read` refuses this reader. */
  objectReadDenied: new Set<string>(),
  /** A target the one core floors as `read-denied`. */
  floorReadDenied: false,
};
const ROW = { runId: "run-1", decisionId: "dec-1", input: "proposedPages" };

// Registered before the tests rather than hoisted, so a tree without this module fails its tests, not the file.
beforeAll(() => vi.doMock("@cinatra-ai/agents/publish-decision-island-subject", () => ({
  readPublishDecisionIslandRows: async ({ runId }: { runId: string; who: Who }) =>
    state.readable && runId === ROW.runId ? { decisionId: state.newestDecisionId, inputs: ["summary", ROW.input] } : null,
  readPublishDecisionIslandSubject: async (input: { runId: string; decisionId: string; input: string; who: Who }) =>
    state.readable && input.runId === ROW.runId && input.decisionId === state.newestDecisionId && input.input === ROW.input
      ? { runId: ROW.runId, orgId: "org-1", decided: false, targets: state.targets }
      : null,
  readRevisionsMadeByRun: async () => state.madeByRun,
})));

const begun: Array<{ byteMinter?: unknown }> = [];
vi.mock("@/app/artifacts/[id]/review-target-prepare", () => ({
  // The one core, reduced to the step this file is about: a FILE-BACKED revision (an image) is handed to the byte
  // minter, and keeps the session addresses when there is none.
  beginArtifactReviewTargets: async (args: {
    input: { targets: Target[] };
    byteMinter?: (input: { artifactId: string; representationRevisionId: string; mime: string | null }) => {
      preview: string | null;
      download: string | null;
    } | null;
  }) => {
    begun.push(args);
    return {
      ok: true,
      targets: args.input.targets.map((target) => {
        if (state.floorReadDenied) {
          // The real core's floor for an artifact `object.read` refuses: no props, no bytes minted.
          const mount = { kind: "floor", slot: "detail", packageName: null, reason: "read-denied" };
          return { target, prepared: Promise.resolve({ target, props: null, mount, bytes: {} }) };
        }
        const minted = args.byteMinter ? args.byteMinter({ ...target, mime: "image/png" }) : null;
        const bytes = minted
          ? { road: "island", ...minted }
          : { road: "session", preview: `/api/artifacts/${target.artifactId}/preview`, download: null };
        return { target, prepared: Promise.resolve({ target, bytes }) };
      }),
    };
  },
}));
vi.mock("@/app/artifacts/[id]/review-gate-ports", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/artifacts/[id]/review-gate-ports")>()),
  loadReviewGateSurface: vi.fn(async () => ({ kind: "refused" })),
}));

const PRINCIPAL = {
  orgId: "org-1",
  userId: "u1",
  jti: "jti-1",
  siteId: "site-1",
  client: "wordpress",
  instanceId: "inst-1",
  agentSlug: "wordpress-assistant",
};
vi.mock("@/lib/lifecycle/widget-capture-principal", () => ({
  readLiveWidgetCapturePrincipal: (jti: string) => (jti === PRINCIPAL.jti ? { ...PRINCIPAL } : null),
}));
const readReviewGate = vi.fn(async () => null);
vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  readReviewGate: () => readReviewGate(),
  enforceReviewRunAccess: async () => ({ ok: state.readable }),
}));
vi.mock("@/lib/artifacts/artifact-read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/artifacts/artifact-read")>()),
  resolveArtifactVersionForServe: (input: { artifactId: string; representationRevisionId: string }) => ({
    mime: "image/png",
    storageKey: `blob/${input.artifactId}/${input.representationRevisionId}`,
    sizeBytes: 4,
  }),
}));
// The reader's live standing and the artifact read (`object.read`) the serving paths re-prove.
const objectReads: Array<{ artifactId: string; orgId: string | null; actor?: { principalId?: string } }> = [];
vi.mock("@/lib/lifecycle/widget-lifecycle-frame-actor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/lifecycle/widget-lifecycle-frame-actor")>()),
  resolveWidgetLifecycleStanding: async ({ userId, orgId }: { userId: string; orgId: string }) => ({
    ok: true,
    actorCtx: {
      actor: { actorType: "human", source: "a2a", userId, orgId },
      orgId,
      roleHints: { actorOrganizationId: orgId, orgRole: "member" },
    },
  }),
}));
vi.mock("@/lib/artifacts/artifact-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/artifacts/artifact-service")>()),
  readArtifactForDetail: (input: { artifactId: string; orgId: string | null; actor?: { principalId?: string } }) => {
    objectReads.push(input);
    return state.objectReadDenied.has(input.artifactId)
      ? { kind: "denied" }
      : { kind: "ok", artifact: { id: input.artifactId } };
  },
}));
vi.mock("@/lib/artifacts/local-disk-blob-store", () => ({
  createLocalDiskBlobStore: () => ({
    openByStorageKey: async ({ storageKey }: { storageKey: string }) => ({
      stream: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(storageKey));
          c.close();
        },
      }),
    }),
  }),
}));

// ---- the page's own edges --------------------------------------------------------------------------------------------
const resolveIslandCredentialReader = vi.fn();
vi.mock("@/lib/lifecycle/review-island-serving", () => ({
  resolveIslandCredentialReader: (args: unknown) => resolveIslandCredentialReader(args),
}));
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: async () => null,
  signInRedirectTarget: async () => "/sign-in",
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock("@/lib/embed/frame-ancestors.server", () => ({ resolveVerifiedWidgetFrameOrigin: () => "https://cms.example" }));
vi.mock("@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-actor", () => ({
  resolveReviewActorContext: async () => null,
}));
vi.mock("@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-target-panel", () => ({
  ReviewTargetPanel: () => createElement("div", null, "panel"),
}));
vi.mock("@cinatra-ai/agents/review-gate-states", () => ({
  ReviewGateLoading: () => createElement("div", null, "island-panel-loading"),
}));

import { encodePublishDecisionIslandRef, publishDecisionIslandSubjectKey } from "@/lib/lifecycle/lifecycle-card-ref";
import { mintReviewIslandByteCapability, reviewIslandByteUrl } from "@/lib/lifecycle/review-island-byte-capability";
// The page and the byte route load inside each test, so a tree without the publish row fails the test that needs it
// rather than the whole file.
const loadPage = async () => (await import("../page")).default;
const getBytes = async (req: Request) => (await import("@/app/api/lifecycle-views/artifact-bytes/route")).GET(req);

const ACTOR = {
  actor: { actorType: "human", userId: "u1", orgId: "org-1", source: "route" },
  orgId: "org-1",
  roleHints: { actorOrganizationId: "org-1" },
};

type Streamed = { prepared: Promise<{ bytes: Record<string, unknown> }> } & Record<string, unknown>;

function streams(node: ReactNode): Streamed[] {
  if (Array.isArray(node)) return node.flatMap(streams);
  if (!isValidElement(node)) return [];
  const props = node.props as { prepared?: unknown; children?: ReactNode };
  if (props.prepared) return [props as never];
  return streams(props.children);
}

// The streamed target's props: its preparation, whether it frames itself, and the trusted organization. Nothing else,
// so no stored capture pair rides along to the panel (cinatra#3862 leg 8).
const STREAMED_PROPS = ["framed", "orgId", "prepared"];

async function paint(): Promise<{ bytes: Record<string, unknown>; props: string[] }> {
  const ref = encodePublishDecisionIslandRef(ROW)!;
  const el = (await (await loadPage())({ searchParams: Promise.resolve({ ref, ic: "sealed-credential" }) })) as ReactElement;
  const [one] = streams(el);
  expect(one, "the island drew no target").toBeDefined();
  return { bytes: (await one.prepared).bytes, props: Object.keys(one).sort() };
}

const fetchHeaders = (dest: string) =>
  new Headers({ "sec-fetch-dest": dest, "sec-fetch-site": "same-origin", "sec-fetch-mode": "no-cors" });
const serveBytes = (url: string) => getBytes(new Request(`http://localhost:3000${url}`, { headers: fetchHeaders("image") }));

beforeEach(() => {
  begun.length = 0;
  state.newestDecisionId = "dec-1";
  state.readable = true;
  state.targets = [{ artifactId: "art-1", representationRevisionId: "rev-1" }];
  state.madeByRun = true;
  state.objectReadDenied = new Set();
  state.floorReadDenied = false;
  objectReads.length = 0;
  readReviewGate.mockClear();
  resolveIslandCredentialReader.mockResolvedValue({
    actorCtx: ACTOR,
    runId: ROW.runId,
    reviewTaskId: publishDecisionIslandSubjectKey(ROW),
    publishDecision: { decisionId: ROW.decisionId, input: ROW.input },
    principal: PRINCIPAL,
  });
});

describe("a credentialed publish-decision island", () => {
  it("hands its file-backed target sealed byte addresses, and the byte route serves them", async () => {
    const { bytes } = await paint();
    expect(typeof begun[0]?.byteMinter).toBe("function");
    expect(bytes.road).toBe("island");
    expect(bytes.preview).toMatch(/^\/api\/lifecycle-views\/artifact-bytes\?bc=/);
    expect(bytes.download).toMatch(/^\/api\/lifecycle-views\/artifact-bytes\?bc=/);
    const preview = await serveBytes(bytes.preview as string);
    expect(preview.status).toBe(200);
    expect(await preview.text()).toBe("blob/art-1/rev-1");
    expect((await serveBytes(bytes.download as string)).status).toBe(200);
    // Proven against the row, never a gate: the run has no gate, and the gate store was never asked.
    expect(readReviewGate).not.toHaveBeenCalled();
  });

  it("hands its target no stored capture pair: the streamed target carries its preparation only", async () => {
    const { bytes, props } = await paint();
    expect(props).toEqual(STREAMED_PROPS);
    // Only the byte road is minted on; no picture address is handed out beside it.
    expect(Object.keys(bytes).sort()).toEqual(["download", "preview", "road"]);
    expect(readReviewGate).not.toHaveBeenCalled();
  });

  it("serves nothing once the decision is no longer the newest, or the reader may no longer read the run", async () => {
    const { bytes } = await paint();
    expect((await serveBytes(bytes.preview as string)).status).toBe(200);
    state.newestDecisionId = "dec-2";
    expect((await serveBytes(bytes.preview as string)).status).toBe(404);
    state.newestDecisionId = "dec-1";
    state.readable = false;
    expect((await serveBytes(bytes.preview as string)).status).toBe(404);
  });

  it("serves nothing once the row no longer shows the target, or the run did not make it", async () => {
    const { bytes } = await paint();
    expect((await serveBytes(bytes.preview as string)).status).toBe(200);
    state.targets = [{ artifactId: "art-2", representationRevisionId: "rev-2" }];
    expect((await serveBytes(bytes.preview as string)).status).toBe(404);
    state.targets = [{ artifactId: "art-1", representationRevisionId: "rev-1" }];
    state.madeByRun = false;
    expect((await serveBytes(bytes.preview as string)).status).toBe(404);
  });

  it("a GATE capability sealed with the row's subject key serves nothing: the kinds never cross", async () => {
    const sealed = mintReviewIslandByteCapability({
      ...PRINCIPAL,
      runId: ROW.runId,
      reviewTaskId: publishDecisionIslandSubjectKey(ROW),
      artifactId: "art-1",
      representationRevisionId: "rev-1",
      disposition: "preview",
    })!;
    expect((await serveBytes(reviewIslandByteUrl(sealed))).status).toBe(404);
    expect(readReviewGate).toHaveBeenCalled();
  });

  it("serves no bytes for a target the reader keeps the run for but may not read as an artifact", async () => {
    const { bytes } = await paint();
    expect((await serveBytes(bytes.preview as string)).status).toBe(200);
    // The run stays readable; only the artifact's own read (`object.read`) now refuses this reader.
    state.objectReadDenied = new Set(["art-1"]);
    expect((await serveBytes(bytes.preview as string)).status).toBe(404);
    expect((await serveBytes(bytes.download as string)).status).toBe(404);
    // The read ran as the sealed user, in the sealed organization.
    expect(objectReads.some((r) => r.artifactId === "art-1" && r.orgId === "org-1" && r.actor?.principalId === "u1")).toBe(true);
  });

  it("mints nothing for a target the core floors as read-denied, and draws no capture pair for it", async () => {
    // Before cinatra#3862 leg 8 this proved a floored target got no pair while a readable one did; now no target gets
    // one, so it pins that the floored target is drawn with no bytes and with the same pair-less props.
    state.floorReadDenied = true;
    const { bytes, props } = await paint();
    expect(bytes).toEqual({});
    expect(props).toEqual(STREAMED_PROPS);
  });
});
